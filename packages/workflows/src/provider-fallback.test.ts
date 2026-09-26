import { describe, expect, it } from 'bun:test';
import type { ProviderCapabilities } from '@archon/providers/types';
import type { CheckoutObservation } from './schemas/checkout-observation';
import {
  checkoutProvenUnchanged,
  resolveQuotaFallback,
  type QuotaFallbackDecision,
  type QuotaFallbackInput,
} from './provider-fallback';

const OPENCODE_CAPS = {
  sessionResume: true,
  sessionFork: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced',
  requiresAllPropertiesRequired: false,
  envInjection: true,
  costControl: false,
  costReporting: true,
  tokenReporting: true,
  stopReasonReporting: true,
  turnCountReporting: false,
  resolvedModelReporting: true,
  effortControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
} satisfies ProviderCapabilities;

const POLICY = {
  codex: {
    provider: 'opencode' as const,
    tiers: {
      small: 'openai/gpt-5.6-mini',
      medium: 'openai/gpt-5.6',
      large: 'anthropic/claude-sonnet-4-5',
    },
  },
};

function input(overrides: Partial<QuotaFallbackInput> = {}): QuotaFallbackInput {
  return {
    sourceProvider: 'codex',
    failure: { class: 'quota_exhausted', evidence: 'subscription quota exhausted' },
    tier: 'medium',
    policy: POLICY,
    explicitEffort: false,
    requiresSessionContinuity: false,
    sideEffectsObserved: false,
    checkoutChanged: false,
    runActive: true,
    requiredCapabilities: [],
    destinationCapabilities: OPENCODE_CAPS,
    ...overrides,
  };
}

function resolve(value: QuotaFallbackInput): Promise<QuotaFallbackDecision> {
  return Promise.resolve(resolveQuotaFallback(value));
}

describe('resolveQuotaFallback', () => {
  it('selects the configured OpenCode model for a tier-backed Codex quota failure', async () => {
    await expect(resolve(input())).resolves.toEqual({
      eligible: true,
      provider: 'opencode',
      model: 'openai/gpt-5.6',
    });
  });

  it('refuses every provider failure class except quota exhaustion', async () => {
    for (const failureClass of [
      'auth',
      'budget_exceeded',
      'rate_limited',
      'transient',
      'unknown',
    ] as const) {
      await expect(
        resolve(input({ failure: { class: failureClass, evidence: failureClass } }))
      ).resolves.toEqual({
        eligible: false,
        reason: { kind: 'failure_class', failureClass },
      });
    }
  });

  it('refuses non-Codex sources, absent policy, and literal/non-tier model resolution', async () => {
    await expect(resolve(input({ sourceProvider: 'opencode' }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'source_provider', provider: 'opencode' },
    });
    await expect(resolve(input({ policy: undefined }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'not_configured' },
    });
    await expect(resolve(input({ tier: undefined }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'tier_required' },
    });
  });

  it('fails closed on session continuity, explicit effort, side effects, and checkout drift', async () => {
    await expect(resolve(input({ requiresSessionContinuity: true }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'session_continuity' },
    });
    await expect(resolve(input({ explicitEffort: true }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'explicit_effort' },
    });
    await expect(resolve(input({ sideEffectsObserved: true }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'side_effects_observed' },
    });
    await expect(resolve(input({ checkoutChanged: true }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'checkout_changed' },
    });
  });

  it('refuses once the run is no longer active', async () => {
    await expect(resolve(input({ runActive: false }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'run_not_active' },
    });
  });

  it('refuses a destination that cannot honor a required capability', async () => {
    await expect(resolve(input({ requiredCapabilities: ['mcp'] }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'unsupported_capability', capability: 'mcp' },
    });
  });
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function gitObservation(
  worktree: Extract<CheckoutObservation, { kind: 'git' }>['worktree'],
  overrides: Partial<Extract<CheckoutObservation, { kind: 'git' }>> = {}
): CheckoutObservation {
  return {
    kind: 'git',
    sampledAt: new Date().toISOString(),
    commit: COMMIT,
    tree: TREE,
    worktree,
    ...overrides,
  };
}

function dirty(sha256: string, content: 'complete' | 'incomplete' = 'complete') {
  return {
    status: 'dirty' as const,
    content,
    staged: 0,
    unstaged: 1,
    untracked: 0,
    manifest: {
      pointer: { type: 'archon_artifact' as const, run_id: 'run', path: 'checkout/manifest.json' },
      sha256,
      entries: 1,
    },
  };
}

describe('checkoutProvenUnchanged', () => {
  it('proves equality for the same clean commit and the same complete dirty manifest', () => {
    const clean = gitObservation({ status: 'clean' });
    expect(checkoutProvenUnchanged(clean, gitObservation({ status: 'clean' }))).toBe(true);
    const same = dirty('c'.repeat(64));
    expect(checkoutProvenUnchanged(gitObservation(same), gitObservation(same))).toBe(true);
  });

  it('refuses to prove equality when anything moved or cannot be identified', () => {
    const clean = gitObservation({ status: 'clean' });
    expect(checkoutProvenUnchanged(undefined, clean)).toBe(false);
    expect(
      checkoutProvenUnchanged(
        clean,
        gitObservation({ status: 'clean' }, { commit: 'd'.repeat(40) })
      )
    ).toBe(false);
    expect(checkoutProvenUnchanged(clean, gitObservation(dirty('c'.repeat(64))))).toBe(false);
    expect(
      checkoutProvenUnchanged(
        gitObservation(dirty('c'.repeat(64))),
        gitObservation(dirty('e'.repeat(64)))
      )
    ).toBe(false);
    const incomplete = dirty('c'.repeat(64), 'incomplete');
    expect(checkoutProvenUnchanged(gitObservation(incomplete), gitObservation(incomplete))).toBe(
      false
    );
    const notGit: CheckoutObservation = { kind: 'not_git', sampledAt: new Date().toISOString() };
    expect(checkoutProvenUnchanged(notGit, notGit)).toBe(false);
  });
});
