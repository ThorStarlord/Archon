import type { ProviderCapabilities } from '@archon/providers/types';
import type { ProviderFailure, ProviderFailureClass } from '@archon/provider-contract';
import type { QuotaFallbackConfig } from './schemas/run-config';
import type { TierName } from './schemas/model-binding';

export type QuotaFallbackRefusal =
  | { kind: 'not_configured' }
  | { kind: 'source_provider'; provider: string }
  | { kind: 'failure_class'; failureClass: ProviderFailureClass }
  | { kind: 'tier_required' }
  | { kind: 'session_continuity' }
  | { kind: 'explicit_effort' }
  | { kind: 'side_effects_observed' }
  | { kind: 'checkout_changed' }
  | { kind: 'unsupported_capability'; capability: keyof ProviderCapabilities };

export interface QuotaFallbackInput {
  sourceProvider: string;
  failure: ProviderFailure;
  tier: TierName | undefined;
  policy: QuotaFallbackConfig | undefined;
  explicitEffort: boolean;
  requiresSessionContinuity: boolean;
  sideEffectsObserved: boolean;
  checkoutChanged: boolean;
  requiredCapabilities: readonly (keyof ProviderCapabilities)[];
  destinationCapabilities: ProviderCapabilities;
}

export type QuotaFallbackDecision =
  | { eligible: true; provider: 'opencode'; model: string }
  | { eligible: false; reason: QuotaFallbackRefusal };


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
