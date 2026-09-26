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
