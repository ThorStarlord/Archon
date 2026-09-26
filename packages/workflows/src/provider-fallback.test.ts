import { describe, expect, it } from 'bun:test';
import type { ProviderCapabilities } from '@archon/providers/types';
import type { QuotaFallbackInput, QuotaFallbackDecision } from './provider-fallback';

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
    requiredCapabilities: [],
    destinationCapabilities: OPENCODE_CAPS,
    ...overrides,
  };
}

async function resolve(value: QuotaFallbackInput): Promise<QuotaFallbackDecision> {
  const module = (await import('./provider-fallback')) as Record<string, unknown>;
  expect(typeof module.resolveQuotaFallback).toBe('function');
  if (typeof module.resolveQuotaFallback !== 'function') {
    throw new Error('resolveQuotaFallback is not implemented');
  }
  return (
    module.resolveQuotaFallback as (arg: QuotaFallbackInput) => QuotaFallbackDecision
  )(value);
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
    for (const failureClass of ['auth', 'budget_exceeded', 'rate_limited', 'transient', 'unknown'] as const) {
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

  it('refuses a destination that cannot honor a required capability', async () => {
    await expect(resolve(input({ requiredCapabilities: ['mcp'] }))).resolves.toEqual({
      eligible: false,
      reason: { kind: 'unsupported_capability', capability: 'mcp' },
    });
  });
});
