/**
 * Session health for long agentic OpenCode turns.
 *
 * An advertised context window is a capacity ceiling, not evidence that a model keeps
 * producing well-formed tool calls across all of it. Observed on `deepseek-v4.1-flash`:
 * clean tool calls below ~80k tokens of context, then a rising share of corrupted
 * tool-call JSON (4% at 80-120k, 29% at 120-160k, 43% at 160-200k) and, in one run,
 * 126 tool calls with zero edits before the provider rejected a request. Letting a
 * degraded session keep retrying feeds each malformed call back into its own context.
 *
 * Two bounded, typed stops let the provider restart the turn in a fresh session over the
 * same working tree (the filesystem, not a model-written summary, is the source of truth).
 */

/** Context size at which a session is ended and restarted fresh. */
export const DEFAULT_CONTEXT_BOUNDARY_TOKENS = 100_000;
/** Fresh sessions a single query may use before it fails. */
export const MAX_SESSION_RESTARTS = 2;
/** This many malformed tool calls in a row end the session. */
export const DEGRADED_CONSECUTIVE_INVALID = 2;
/** ...or this many within the last `DEGRADED_WINDOW` tool results. */
export const DEGRADED_WINDOW = 10;
export const DEGRADED_WINDOW_INVALID = 3;

export type SessionRestartReason = 'context_boundary' | 'degraded_generation';

/** The session was deliberately ended so the caller can restart it fresh. */
export class OpencodeSessionRestartError extends Error {
  constructor(
    readonly reason: SessionRestartReason,
    readonly detail: string,
    /** The session that was ended; a read-only exploration is finalized in it. */
    readonly sessionId?: string
  ) {
    super(`OpenCode session ended for restart (${reason}): ${detail}`);
    this.name = 'OpencodeSessionRestartError';
  }
}

/** Boundary in tokens; `0` disables it. Overridable for tuning, never required. */
export function contextBoundaryTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARCHON_OPENCODE_CONTEXT_BOUNDARY_TOKENS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONTEXT_BOUNDARY_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_CONTEXT_BOUNDARY_TOKENS;
}

/** Tokens in the prompt of an assistant message: fresh input plus cache reads and writes. */
export function contextTokens(info: Record<string, unknown> | undefined): number {
  const tokens = info?.tokens;
  if (typeof tokens !== 'object' || tokens === null) return 0;
  const t = tokens as Record<string, unknown>;
  const cache =
    typeof t.cache === 'object' && t.cache !== null ? (t.cache as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return num(t.input) + num(cache.read) + num(cache.write);
}

/** True for OpenCode's rejected-tool-call shapes (`invalid` tool, or a JSON-parse tool error). */
export function isMalformedToolCall(
  toolName: string,
  status: string | undefined,
  error: string | undefined
): boolean {
  if (toolName === 'invalid') return true;
  return (
    status === 'error' &&
    typeof error === 'string' &&
    /JSON parsing failed|Invalid input for tool/i.test(error)
  );
}

/** Sliding record of recent tool outcomes; reports when generation has degraded. */
export class GenerationHealth {
  private readonly recent: boolean[] = [];

  /** Record one finished tool call; returns a description when the session should end. */
  record(malformed: boolean): string | undefined {
    this.recent.push(malformed);
    if (this.recent.length > DEGRADED_WINDOW) this.recent.shift();

    let consecutive = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i]; i -= 1) consecutive += 1;
    if (consecutive >= DEGRADED_CONSECUTIVE_INVALID) {
      return `${String(consecutive)} consecutive malformed tool calls`;
    }
    const inWindow = this.recent.filter(Boolean).length;
    if (inWindow >= DEGRADED_WINDOW_INVALID) {
      return `${String(inWindow)} malformed tool calls in the last ${String(this.recent.length)}`;
    }
    return undefined;
  }
}

/** System guidance that keeps tool-call arguments small and well-formed. */
export const TOOL_HYGIENE_GUIDANCE =
  'Tool-call hygiene: prefer targeted edits and bounded writes over one very large tool-call ' +
  'argument; split large files into several smaller operations; keep shell commands simple ' +
  'and avoid deeply nested quoting. If a tool call is rejected as invalid, retry once with ' +
  'simpler, smaller arguments instead of repeating it.';

/**
 * Sent to a read-only exploration that spent its context budget. A restart would only re-read
 * the same files, so the session is asked to conclude. An inconclusive answer is legitimate;
 * a guess is not.
 */
export const FINALIZE_PROMPT =
  'The context budget for this investigation is spent. Stop exploring now: do not read or ' +
  'search any more. If your task requires you to write a report or other deliverable file, ' +
  'write it now from what you have already read, in a single bounded write. Then call ' +
  'StructuredOutput with the final result required by the schema. If the evidence does not ' +
  'support a firm conclusion, say so honestly in the fields the schema provides (an ' +
  'inconclusive result is valid); do not guess or invent findings.';
