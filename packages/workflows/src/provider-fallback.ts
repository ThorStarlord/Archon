import type { ProviderCapabilities } from '@archon/providers/types';
import type { ProviderFailure, ProviderFailureClass } from '@archon/provider-contract';
import type { QuotaFallbackConfig } from './schemas/run-config';
import type { TierName } from './schemas/model-binding';
import type { CheckoutObservation } from './schemas/checkout-observation';

export type QuotaFallbackRefusal =
  | { kind: 'not_configured' }
  | { kind: 'source_provider'; provider: string }
  | { kind: 'failure_class'; failureClass: ProviderFailureClass }
  | { kind: 'tier_required' }
  | { kind: 'session_continuity' }
  | { kind: 'explicit_effort' }
  | { kind: 'side_effects_observed' }
  | { kind: 'checkout_changed' }
  | { kind: 'run_not_active' }
  | { kind: 'unsupported_capability'; capability: keyof ProviderCapabilities };

export interface QuotaFallbackInput {
  sourceProvider: string;
  failure: ProviderFailure;
  tier: TierName | undefined;
  policy: QuotaFallbackConfig | undefined;
  explicitEffort: boolean;
  requiresSessionContinuity: boolean;
  sideEffectsObserved: boolean;
  /** True unless the checkout is proven unchanged since the failed attempt started. */
  checkoutChanged: boolean;
  /** False once the run left `running` (cancelled, paused, deleted) or its status is unknown. */
  runActive: boolean;
  requiredCapabilities: readonly (keyof ProviderCapabilities)[];
  destinationCapabilities: ProviderCapabilities;
}

export type QuotaFallbackDecision =
  | { eligible: true; provider: 'opencode'; model: string }
  | { eligible: false; reason: QuotaFallbackRefusal };

/**
 * Decide whether a failed Codex attempt may be replayed once on OpenCode. Pure: the caller
 * gathers the evidence, and every refusal names its reason so the executor can record it.
 */
export function resolveQuotaFallback(input: QuotaFallbackInput): QuotaFallbackDecision {
  if (input.sourceProvider !== 'codex') {
    return {
      eligible: false,
      reason: { kind: 'source_provider', provider: input.sourceProvider },
    };
  }

  if (input.failure.class !== 'quota_exhausted') {
    return {
      eligible: false,
      reason: { kind: 'failure_class', failureClass: input.failure.class },
    };
  }

  const fallback = input.policy?.codex;
  if (fallback === undefined) {
    return { eligible: false, reason: { kind: 'not_configured' } };
  }

  if (input.tier === undefined) {
    return { eligible: false, reason: { kind: 'tier_required' } };
  }

  if (input.requiresSessionContinuity) {
    return { eligible: false, reason: { kind: 'session_continuity' } };
  }

  if (input.explicitEffort) {
    return { eligible: false, reason: { kind: 'explicit_effort' } };
  }

  if (input.sideEffectsObserved) {
    return { eligible: false, reason: { kind: 'side_effects_observed' } };
  }

  if (input.checkoutChanged) {
    return { eligible: false, reason: { kind: 'checkout_changed' } };
  }

  if (!input.runActive) {
    return { eligible: false, reason: { kind: 'run_not_active' } };
  }

  for (const capability of input.requiredCapabilities) {
    if (!input.destinationCapabilities[capability]) {
      return {
        eligible: false,
        reason: { kind: 'unsupported_capability', capability },
      };
    }
  }

  return {
    eligible: true,
    provider: fallback.provider,
    model: fallback.tiers[input.tier],
  };
}

/**
 * True only when two checkout observations prove the same content: the same commit and
 * tree, and either both clean or both dirty with an identical complete manifest. Anything
 * the engine could not identify (no start sample, no Git, an incomplete manifest) proves
 * nothing, so the fallback treats it as changed.
 */
export function checkoutProvenUnchanged(
  start: CheckoutObservation | undefined,
  now: CheckoutObservation
): boolean {
  if (start?.kind !== 'git' || now.kind !== 'git') return false;
  if (start.commit !== now.commit || start.tree !== now.tree) return false;
  const before = start.worktree;
  const after = now.worktree;
  if (before.status === 'clean' || after.status === 'clean') {
    return before.status === after.status;
  }
  return (
    before.content === 'complete' &&
    after.content === 'complete' &&
    before.manifest.sha256 === after.manifest.sha256 &&
    before.staged === after.staged &&
    before.unstaged === after.unstaged &&
    before.untracked === after.untracked
  );
}
