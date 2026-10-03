import { createLogger } from '@archon/paths';

import type { MessageChunk, SendQueryOptions } from '../../types';

import {
  adaptNamedAgentForOpencode,
  resolvePromptForAgent,
  selectSingleAgent,
  type NamedAgentConfig,
} from './agent-config';
import { errorMessage } from './errors';
import type { OpencodeClientLike } from './runtime';
import { normalizeTokens } from './tokens';

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function resolveSessionId(
  client: OpencodeClientLike,
  cwd: string,
  resumeSessionId: string | undefined
): Promise<{ sessionId: string; resumed: boolean }> {
  if (resumeSessionId) {
    try {
      const existing = await client.session.get({
        path: { id: resumeSessionId },
        query: { directory: cwd },
      });
      const sessionId = existing.data?.id;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        return { sessionId, resumed: true };
      }
    } catch (error) {
      getLog().warn({ err: error, resumeSessionId, cwd }, 'opencode.session_resume_failed');
    }
  }

  const created = await client.session.create({ query: { directory: cwd } });
  const sessionId = created.data?.id;
  if (!sessionId) {
    throw new Error('OpenCode failed to create a session');
  }

  return { sessionId, resumed: false };
}

export function createSessionPromptBody(
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined,
  agentOverride?: NamedAgentConfig
): Record<string, unknown> {
  const singleAgent = agentOverride ?? selectSingleAgent(requestOptions?.nodeConfig?.agents);
  const adaptedAgentConfig = singleAgent ? adaptNamedAgentForOpencode(singleAgent) : undefined;
  const effectivePrompt = resolvePromptForAgent(singleAgent, prompt);
  const promptBody: Record<string, unknown> = {
    parts: [{ type: 'text', text: effectivePrompt }],
    model: adaptedAgentConfig?.model ?? model,
    ...(adaptedAgentConfig?.agent ? { agent: adaptedAgentConfig.agent } : {}),
    ...(adaptedAgentConfig?.tools ? { tools: adaptedAgentConfig.tools } : {}),
    ...(requestOptions?.systemPrompt ? { system: requestOptions.systemPrompt } : {}),
  };

  if (requestOptions?.outputFormat?.type === 'json_schema') {
    promptBody.format = {
      type: 'json_schema',
      schema: requestOptions.outputFormat.schema,
    };
  }

  return promptBody;
}

export async function promptSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  promptBody: Record<string, unknown>
): Promise<void> {
  await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory: cwd },
    body: promptBody,
  });
}

/**
 * Read the structured payload OpenCode captured for a `json_schema` prompt.
 *
 * OpenCode reports the captured payload as a `structured` field on the assistant
 * message info (current servers) or, on older servers, as `structured_output`; when
 * the model satisfies the schema through the injected tool, the payload also appears
 * as a completed `StructuredOutput` tool part. Read whichever is present. A schema the
 * model never filled in returns undefined, so the caller keeps its fail-closed
 * "no schema-valid structured output" behaviour.
 */
async function readStructuredOutput(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  messageId: string | undefined
): Promise<unknown> {
  if (!messageId) return undefined;

  try {
    const response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory: cwd },
    });
    const data = response.data as { info?: unknown; parts?: unknown } | undefined;
    const info = data?.info;
    if (isRecord(info)) {
      if (info.structured !== undefined) return info.structured;
      if (info.structured_output !== undefined) return info.structured_output;
    }
    return structuredOutputFromParts(data?.parts);
  } catch (error) {
    getLog().warn({ err: error, sessionId, messageId }, 'opencode.structured_output_lookup_failed');
  }

  return undefined;
}

/** The `StructuredOutput` tool part's captured input, when the model produced it there. */
function structuredOutputFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (!isRecord(part) || part.type !== 'tool' || part.tool !== 'StructuredOutput') continue;
    const state = isRecord(part.state) ? part.state : undefined;
    if (state?.status === 'completed' && 'input' in state) {
      return state.input;
    }
  }
  return undefined;
}

/**
 * An OpenCode `permission.updated` event Archon refuses to answer. Archon runs unattended and
 * approves nothing, so a pending permission would otherwise stall the session silently until the
 * node idle timeout. The `provider_failure:permission` marker keeps the reason string stable for
 * downstream mapping without adding a retry class — the engine already refuses to retry
 * failures it cannot classify.
 */
export class OpencodePermissionRequiredError extends Error {
  readonly permissionId: string | undefined;
  readonly permissionKind: string;
  readonly permissionPatterns: string[];

  constructor(options: { permissionId?: string; kind: string; patterns: string[] }) {
    super(
      `OpenCode permission required (provider_failure:permission): kind '${options.kind}' ` +
        `for pattern(s) [${options.patterns.map(pattern => `"${pattern}"`).join(', ')}]` +
        (options.permissionId ? ` (permission ${options.permissionId})` : '') +
        '. Archon never approves permissions on your behalf — pre-allow it via ' +
        `OPENCODE_CONFIG (opencode.json: permission.${options.kind}).`
    );
    this.name = 'OpencodePermissionRequiredError';
    this.permissionId = options.permissionId;
    this.permissionKind = options.kind;
    this.permissionPatterns = options.patterns;
  }
}

/**
 * Fail fast on an OpenCode permission request aimed at `sessionId`.
 *
 * Requests for other sessions on the shared subscription are ignored. A request that arrives
 * after the required structured output was already captured (a completed `StructuredOutput`
 * tool call) is also ignored: the payload is in hand and `readStructuredOutput` will still
 * find it, so failing would turn a working run into a false failure.
 */
export function checkPermissionEvent(
  eventType: string | undefined,
  properties: Record<string, unknown>,
  sessionId: string | undefined,
  structuredOutputCaptured: boolean
): void {
  if (eventType !== 'permission.updated' && eventType !== 'permission.asked') return;
  const requestSessionId =
    typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
  if (requestSessionId !== undefined && requestSessionId !== sessionId) return;
  if (structuredOutputCaptured) {
    getLog().debug({ sessionId }, 'opencode.permission_after_output_ignored');
    return;
  }

  // OpenCode's live 1.18.x runtime emits permission.asked with
  // permission/patterns. Older generated SDK types expose permission.updated
  // with type/pattern. Accept both shapes at this compatibility boundary.
  const kind =
    typeof properties.permission === 'string' && properties.permission
      ? properties.permission
      : typeof properties.type === 'string' && properties.type
        ? properties.type
        : 'unknown';
  const rawPatterns = properties.patterns !== undefined ? properties.patterns : properties.pattern;
  const patternValues = Array.isArray(rawPatterns)
    ? rawPatterns
    : rawPatterns === undefined
      ? []
      : [rawPatterns];
  const patterns = patternValues.filter(
    (pattern): pattern is string => typeof pattern === 'string'
  );
  const permissionId = typeof properties.id === 'string' ? properties.id : undefined;
  getLog().warn({ sessionId, permissionId, kind, eventType }, 'opencode.permission_required');
  throw new OpencodePermissionRequiredError({ permissionId, kind, patterns });
}

export async function* streamOpencodeSession(
  client: OpencodeClientLike,
  cwd: string,
  sessionId: string,
  prompt: string,
  model: { providerID: string; modelID: string },
  requestOptions: SendQueryOptions | undefined
): AsyncGenerator<MessageChunk> {
  const events = await client.event.subscribe({ query: { directory: cwd } });
  const streamController = new AbortController();
  const seenToolCalls = new Set<string>();
  const completedToolCalls = new Set<string>();
  // A completed `StructuredOutput` tool call means the required payload is already in hand
  // (readStructuredOutput will find it at idle), so a later permission ask for some *other*
  // tool must not fail the step (see checkPermissionEvent).
  let structuredOutputCaptured = false;
  let latestAssistantInfo: Record<string, unknown> | undefined;
  let lastAssistantMessageId: string | undefined;
  let aborted = requestOptions?.abortSignal?.aborted === true;
  let resultYielded = false;

  const abortHandler = (): void => {
    aborted = true;
    void client.session
      .abort({ path: { id: sessionId }, query: { directory: cwd } })
      .catch((error): void => {
        getLog().debug({ err: error, sessionId }, 'opencode.session_abort_failed');
      });
    streamController.abort();
  };

  requestOptions?.abortSignal?.addEventListener('abort', abortHandler, {
    once: true,
  });

  try {
    const promptBody = createSessionPromptBody(prompt, model, requestOptions);
    await promptSession(client, cwd, sessionId, promptBody);

    for await (const rawEvent of abortableStream(events.stream, streamController.signal)) {
      const event = rawEvent as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const properties = isRecord(event.properties) ? event.properties : {};

      if (event.type === 'message.updated') {
        const info = isRecord(properties.info) ? properties.info : undefined;
        if (info?.role === 'assistant' && info.sessionID === sessionId) {
          latestAssistantInfo = info;
          if (typeof info.id === 'string') {
            lastAssistantMessageId = info.id;
          }
        }
        continue;
      }

      if (event.type === 'permission.updated' || event.type === 'permission.asked') {
        checkPermissionEvent(event.type, properties, sessionId, structuredOutputCaptured);
        continue;
      }

      if (event.type === 'message.part.updated') {
        const part = isRecord(properties.part) ? properties.part : undefined;
        if (!part || part?.sessionID !== sessionId || typeof part.type !== 'string') {
          continue;
        }

        if (part.type === 'text') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'assistant', content: text };
          }
          continue;
        }

        if (part.type === 'reasoning') {
          const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
          const text = delta ?? (typeof part.text === 'string' ? part.text : '');
          if (text) {
            yield { type: 'thinking', content: text };
          }
          continue;
        }

        if (part.type === 'tool') {
          const callId = typeof part.callID === 'string' ? part.callID : undefined;
          const toolName = typeof part.tool === 'string' ? part.tool : 'unknown';
          const state = isRecord(part.state) ? part.state : undefined;
          const toolInput = isRecord(state?.input) ? state.input : undefined;
          const status = typeof state?.status === 'string' ? state.status : undefined;

          if (callId && !seenToolCalls.has(callId)) {
            seenToolCalls.add(callId);
            yield {
              type: 'tool',
              toolName,
              ...(toolInput ? { toolInput } : {}),
              ...(callId ? { toolCallId: callId } : {}),
            };
          }

          if (callId && !completedToolCalls.has(callId)) {
            if (status === 'completed') {
              completedToolCalls.add(callId);
              if (toolName === 'StructuredOutput') structuredOutputCaptured = true;
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.output === 'string' ? state.output : '',
                ...(callId ? { toolCallId: callId } : {}),
                toolOutcome: 'success',
              };
            } else if (status === 'error') {
              completedToolCalls.add(callId);
              yield {
                type: 'tool_result',
                toolName,
                toolOutput: typeof state?.error === 'string' ? state.error : 'Tool failed',
                ...(callId ? { toolCallId: callId } : {}),
                toolOutcome: 'error',
              };
            }
          }
        }
        continue;
      }

      if (event.type === 'session.error') {
        const eventSessionId =
          typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        if (eventSessionId && eventSessionId !== sessionId) continue;

        const rawError = isRecord(properties.error) ? properties.error : properties;
        const err = new Error(errorMessage(rawError));
        err.cause = rawError;
        throw err;
      }

      if (event.type === 'session.idle') {
        if (properties.sessionID !== sessionId) continue;

        const structuredOutput = await readStructuredOutput(
          client,
          cwd,
          sessionId,
          lastAssistantMessageId
        );
        const tokens = normalizeTokens(latestAssistantInfo);

        yield {
          type: 'result',
          sessionId,
          ...(tokens ? { tokens } : {}),
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          ...(typeof latestAssistantInfo?.cost === 'number'
            ? { cost: latestAssistantInfo.cost }
            : {}),
          ...(typeof latestAssistantInfo?.finish === 'string'
            ? { stopReason: latestAssistantInfo.finish }
            : {}),
          ...(typeof latestAssistantInfo?.modelID === 'string' &&
          latestAssistantInfo.modelID.length > 0
            ? { resolvedModel: { id: latestAssistantInfo.modelID } }
            : {}),
        };
        resultYielded = true;
        return;
      }
    }

    if (!resultYielded && !aborted) {
      yield { type: 'result', sessionId };
    }

    if (aborted) {
      const abortReason = requestOptions?.abortSignal?.reason;
      throw new Error(
        `OpenCode query aborted (session: ${sessionId}, cwd: ${cwd})` +
          (abortReason ? `: ${String(abortReason)}` : '')
      );
    }
  } finally {
    requestOptions?.abortSignal?.removeEventListener('abort', abortHandler);
    streamController.abort();
  }
}

export async function* abortableStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal
): AsyncGenerator<unknown, void, unknown> {
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    if (signal.aborted) {
      await iterator.return?.().catch(() => undefined);
      return;
    }

    const nextPromise = iterator.next();
    const result = await Promise.race([
      nextPromise,
      new Promise<IteratorResult<unknown>>(resolve => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve({ done: true, value: undefined });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void nextPromise.finally((): void => {
          signal.removeEventListener('abort', onAbort);
        });
      }),
    ]);

    if (result.done) {
      await iterator.return?.().catch(() => undefined);
      return;
    }
    yield result.value;
  }
}
