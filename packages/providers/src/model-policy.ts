/**
 * Owner model allowlist, enforced at the one chokepoint every agent query passes.
 *
 * An operator can restrict an install to specific `<provider>/<model>` pairs with
 * `allowedModels` in the global config. Tier bindings, `--model` overrides, aliases
 * and per-node `model:` all resolve to a provider and model before `sendQuery`, so
 * checking there cannot be bypassed by choosing a different way to name the model.
 * Unset (the default) means no restriction.
 */
import type { IAgentProvider, MessageChunk, ProviderCapabilities, SendQueryOptions } from './types';

let allowed: readonly string[] | undefined;

export class ModelNotAllowedError extends Error {
  constructor(
    readonly providerId: string,
    readonly model: string | undefined,
    readonly allowedModels: readonly string[]
  ) {
    super(
      `Model '${providerId}/${model ?? '(unspecified)'}' is not permitted by this install's ` +
        `allowedModels policy (allowed: ${allowedModels.join(', ')}). ` +
        'A model failure is not authorization to switch models; the owner must change the policy.'
    );
    this.name = 'ModelNotAllowedError';
  }
}

/** Set (or clear with `undefined`/empty) the install's allowlist of `<provider>/<model>` pairs. */
export function setAllowedModels(models: readonly string[] | undefined): void {
  const cleaned = (models ?? []).map(m => m.trim()).filter(m => m.length > 0);
  allowed = cleaned.length > 0 ? cleaned : undefined;
}

export function getAllowedModels(): readonly string[] | undefined {
  return allowed;
}

/** Throw unless the policy is unset or permits this exact provider/model pair. */
export function assertModelAllowed(providerId: string, model: string | undefined): void {
  if (!allowed) return;
  if (model === undefined || model.trim() === '' || !allowed.includes(`${providerId}/${model}`)) {
    throw new ModelNotAllowedError(providerId, model, allowed);
  }
}

/**
 * Wrap a provider so its queries are checked against the allowlist before any call.
 * A query with no explicit model is rejected too: the provider's own default would
 * otherwise be an unchecked way to select a model.
 */
export function withModelPolicy(providerId: string, provider: IAgentProvider): IAgentProvider {
  return {
    async *sendQuery(
      prompt: string,
      cwd: string,
      resumeSessionId?: string,
      requestOptions?: SendQueryOptions
    ): AsyncGenerator<MessageChunk> {
      assertModelAllowed(providerId, requestOptions?.model);
      yield* provider.sendQuery(prompt, cwd, resumeSessionId, requestOptions);
    },
    getType: (): string => provider.getType(),
    getCapabilities: (): ProviderCapabilities => provider.getCapabilities(),
  };
}
