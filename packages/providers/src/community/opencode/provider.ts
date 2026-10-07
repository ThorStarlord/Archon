import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { getOrderedAgents } from './agent-config';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseModelRef, parseOpencodeConfig } from './config';
import { classifyOpencodeError, enrichOpencodeError } from './errors';
import { materializeAgents } from './agent-fs';
import { streamMultiAgentOpencodeSession } from './multi-agent';
import {
  acquireEmbeddedRuntime,
  disposeInstanceForDirectory,
  releaseEmbeddedRuntime,
} from './runtime';
import { resolveSessionId, streamOpencodeSession } from './session';
import {
  FINALIZE_PROMPT,
  MAX_SESSION_RESTARTS,
  OpencodeSessionRestartError,
} from './session-health';
import { withResumedOutcome, resumedOutcome } from '../../shared/resumed';

export { parseModelRef } from './config';
export { resetEmbeddedRuntime } from './runtime';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

const execFileAsync = promisify(execFile);
const GIT_STATE_MAX_CHARS = 4000;

/**
 * The deterministic state a restarted session must continue from: the working tree itself.
 * Best effort (a non-git directory simply yields no state) and capped so the re-grounding
 * note cannot itself bloat the fresh context.
 */
async function worktreeState(cwd: string): Promise<string> {
  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  const [status, diffStat] = await Promise.all([
    run(['status', '--short']),
    run(['diff', '--stat', 'HEAD']),
  ]);
  const parts = [
    status ? `git status --short:\n${status}` : 'git status --short: (clean or unavailable)',
    diffStat ? `git diff --stat HEAD:\n${diffStat}` : '',
  ].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > GIT_STATE_MAX_CHARS
    ? `${text.slice(0, GIT_STATE_MAX_CHARS)}\n... (truncated)`
    : text;
}

/** The original task plus an honest account of why the previous session ended. */
export function buildRestartPrompt(
  originalPrompt: string,
  restart: OpencodeSessionRestartError,
  state: string,
  restartNumber: number
): string {
  const why =
    restart.reason === 'context_boundary'
      ? 'the previous agent session grew too large to keep producing reliable tool calls, so it was ended'
      : 'the previous agent session started producing malformed tool calls, so it was ended';
  return [
    originalPrompt,
    `--- SESSION RESTART ${String(restartNumber)}/${String(MAX_SESSION_RESTARTS)} ---`,
    `This is a fresh session: ${why} (${restart.detail}). The working directory is the source ` +
      'of truth. Work already on disk is done; continue the original task from this state ' +
      'without redoing it. Be selective: search narrowly, read only the ranges you need, ' +
      'avoid re-reading files, and prefer small targeted edits and bounded writes.',
    state,
  ].join('\n\n');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class OpencodeProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = parseOpencodeConfig(requestOptions?.assistantConfig ?? {});
    const modelRef = requestOptions?.model ?? assistantConfig.model;
    const parsedModelOrNull = modelRef ? parseModelRef(modelRef) : undefined;

    if (modelRef && !parsedModelOrNull) {
      throw new Error(
        `Invalid OpenCode model ref: '${modelRef}'. Expected format '<provider>/<model>' (for example 'anthropic/claude-3-5-sonnet').`
      );
    }

    if (!parsedModelOrNull) {
      throw new Error(
        'OpenCode requires a model to be specified. ' +
          'Set model in assistants config (e.g., model: anthropic/claude-3-5-sonnet).'
      );
    }

    const parsedModel = parsedModelOrNull;

    const nodeAgents = requestOptions?.nodeConfig?.agents;
    const nodeId = requestOptions?.nodeConfig?.nodeId;
    const orderedAgents = getOrderedAgents(requestOptions?.nodeConfig);
    const hasAgentConfig = orderedAgents.length > 0;
    const isMultiAgent = orderedAgents.length > 1;
    const usingExternalBaseUrl = Boolean(assistantConfig.baseUrl);
    if (usingExternalBaseUrl) {
      throw new Error(
        'OpenCode external baseUrl mode is no longer supported. ' +
          'Archon now requires managed embedded OpenCode runtime for fully controlled agent lifecycle.'
      );
    }

    const sessionCwd =
      hasAgentConfig && nodeId && !usingExternalBaseUrl
        ? join(cwd, '.archon-opencode', nodeId)
        : cwd;

    let lastError: Error | undefined;
    let recoveredAgentNotFound = false;
    let sessionRestarts = 0;
    let finalizing = false;
    let effectivePrompt = prompt;
    let effectiveResumeSessionId = resumeSessionId;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('OpenCode query aborted');
      }

      const runtime = await (async (): Promise<{
        client: import('./runtime').OpencodeClientLike;
        release: () => void;
      }> => {
        const embedded = await acquireEmbeddedRuntime(requestOptions?.abortSignal);
        return {
          client: embedded.client,
          release: (): void => {
            releaseEmbeddedRuntime(embedded);
          },
        };
      })();

      try {
        // When agents are defined, use a per-node session directory so each node
        // gets its own OpenCode InstanceState — preventing stale agent cache from
        // previous nodes in the same workflow run.
        // For multi-agent, materialize each agent in its own subdirectory.
        if (hasAgentConfig) {
          if (isMultiAgent) {
            // Materialize all agents in the shared sessionCwd so the single
            // event subscription catches events from every child session.
            await materializeAgents(sessionCwd, nodeAgents ?? {});
            await disposeInstanceForDirectory(runtime.client, sessionCwd);
          } else if (nodeAgents) {
            await materializeAgents(sessionCwd, nodeAgents);
            await disposeInstanceForDirectory(runtime.client, sessionCwd);
          }
        }

        if (isMultiAgent) {
          if (!nodeId) {
            throw new Error(
              'OpenCode multi-agent execution requires a nodeId in nodeConfig. ' +
                'Ensure the workflow node sets nodeConfig.nodeId.'
            );
          }
          // Multi-agent always starts fresh — it resolves its own per-node
          // sessions internally and cannot resume a single prior session. If a
          // resume was requested, report it as cold (false) so the executor
          // surfaces the lost continuity instead of silently starting fresh.
          yield* withResumedOutcome(
            streamMultiAgentOpencodeSession(
              runtime.client,
              sessionCwd,
              nodeId,
              prompt,
              parsedModel,
              requestOptions
            ),
            resumedOutcome(resumeSessionId, false)
          );
          return;
        }

        const { sessionId, resumed } = await resolveSessionId(
          runtime.client,
          sessionCwd,
          effectiveResumeSessionId
        );
        if (effectiveResumeSessionId && !resumed) {
          yield {
            type: 'system',
            content: '⚠️ Could not resume OpenCode session. Starting fresh conversation.',
          };
        }

        yield* withResumedOutcome(
          streamOpencodeSession(
            runtime.client,
            sessionCwd,
            sessionId,
            effectivePrompt,
            parsedModel,
            requestOptions,
            { ignoreContextBoundary: finalizing }
          ),
          resumedOutcome(resumeSessionId, resumed)
        );
        return;
      } catch (error) {
        if (
          error instanceof OpencodeSessionRestartError &&
          error.reason === 'context_boundary' &&
          requestOptions?.readOnly === true &&
          requestOptions.outputFormat !== undefined &&
          error.sessionId !== undefined &&
          !finalizing
        ) {
          // A read-only exploration has nothing on disk to carry into a fresh session; a restart
          // would re-read the same files and hit the boundary again. Ask the same session to
          // conclude with what it has read, once. Not a restart and not a transport retry.
          finalizing = true;
          getLog().warn(
            { sessionId: error.sessionId, detail: error.detail },
            'opencode.read_only_finalize'
          );
          yield {
            type: 'system',
            content: `⚠️ Context budget spent on a read-only node (${error.detail}) — asking the session to conclude.`,
          };
          effectivePrompt = FINALIZE_PROMPT;
          effectiveResumeSessionId = error.sessionId;
          attempt -= 1;
          continue;
        }
        if (error instanceof OpencodeSessionRestartError) {
          // A deliberate, bounded stop (context boundary or degraded generation): continue
          // in a fresh session over the same working tree. Not a transport retry, so it does
          // not consume the retry budget; MAX_SESSION_RESTARTS bounds it independently.
          if (sessionRestarts >= MAX_SESSION_RESTARTS) {
            throw new Error(
              `OpenCode session restarted ${String(MAX_SESSION_RESTARTS)} times without finishing ` +
                `(provider_failure:session_unhealthy): ${error.message}`,
              { cause: error }
            );
          }
          sessionRestarts += 1;
          getLog().warn(
            { reason: error.reason, detail: error.detail, restart: sessionRestarts },
            'opencode.session_restarting'
          );
          yield {
            type: 'system',
            content: `⚠️ Restarting OpenCode session (${error.reason}: ${error.detail}) — restart ${String(sessionRestarts)}/${String(MAX_SESSION_RESTARTS)}.`,
          };
          effectivePrompt = buildRestartPrompt(
            prompt,
            error,
            await worktreeState(sessionCwd),
            sessionRestarts
          );
          effectiveResumeSessionId = undefined;
          attempt -= 1;
          continue;
        }
        const errorClass = classifyOpencodeError(
          error,
          requestOptions?.abortSignal?.aborted === true
        );
        const enrichedError = enrichOpencodeError(error, errorClass);
        const shouldRetry =
          errorClass === 'rate_limit' ||
          errorClass === 'crash' ||
          (errorClass === 'agent_not_found' && hasAgentConfig && !recoveredAgentNotFound);

        getLog().error(
          {
            err: error,
            errorClass,
            attempt,
            maxRetries: MAX_RETRIES,
          },
          'opencode.query_failed'
        );

        if (!shouldRetry || attempt >= MAX_RETRIES - 1) {
          throw enrichedError;
        }

        if (errorClass === 'agent_not_found') {
          recoveredAgentNotFound = true;
          getLog().info({ attempt, sessionCwd }, 'opencode.retrying_after_agent_refresh');
        }

        const delayMs = this.retryBaseDelayMs * 2 ** attempt;
        getLog().info({ attempt, delayMs, errorClass }, 'opencode.retrying_query');
        await delay(delayMs);
        if (lastError) {
          enrichedError.cause = lastError;
        }
        lastError = enrichedError;
      } finally {
        runtime.release();
      }
    }

    throw lastError ?? new Error(`OpenCode query failed after ${MAX_RETRIES} retries`);
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }
}
