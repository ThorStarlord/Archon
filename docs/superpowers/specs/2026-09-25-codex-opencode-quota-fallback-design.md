# Codex -> OpenCode quota fallback design

**Status:** Proposed for owner review  
**Date:** 2026-09-25  
**Target baseline:** upstream `coleam00/Archon` `dev` at `879c99fe4dceeeae1bef98869e9427f38aadeea4`  
**Primary use case:** keep long Archon workflow runs alive when Codex subscription quota is exhausted, by safely retrying the affected node through OpenCode.

## 1. Goal

Add a narrow, auditable workflow-execution fallback:

```text
Codex node attempt
-> typed quota_exhausted failure
-> prove fallback is safe for this node attempt
-> retry the same node invocation through configured OpenCode tier binding
-> continue the workflow on success
```

The feature exists to improve provider liveness. It must not turn arbitrary failures into cross-provider retries, replay whole workflows, weaken workflow semantics, or hide that the provider changed.

## 2. Existing Archon primitives to reuse

Current upstream `dev` already provides most of the required substrate:

1. `ProviderFailure.class` distinguishes `quota_exhausted` from `auth`, `budget_exceeded`, `rate_limited`, `transient`, and `unknown`.
2. Quota exhaustion is terminal for the current provider attempt and can already drive bounded durable quota-reset continuation.
3. Run-scoped tier / alias bindings are resolved, validated, sealed, and stored in `metadata.model_bindings`.
4. Each node execution record already has an invocation identity, a distinct attempt identity, and the actual provider/model/tier/effort binding used by that attempt.
5. Provider capability metadata already distinguishes Codex and OpenCode behavior.
6. Provider concurrency admission already operates per attempt.
7. Message chunks expose tool activity, allowing the engine to distinguish a pre-side-effect quota failure from an attempt that may already have mutated state.

The new feature should connect these mechanisms rather than introduce another provider scheduler, another retry engine, or another model-resolution system.

## 3. Non-goals

Version 1 does **not**:

- fall back on ordinary test/product/workflow failures;
- fall back on `auth`, `budget_exceeded`, `rate_limited`, `transient`, or `unknown`;
- automatically chain Codex -> OpenCode -> Claude;
- translate arbitrary literal Codex model names into another provider's model names;
- replay a whole workflow after a node fails;
- preserve a Codex provider session inside OpenCode;
- silently drop required provider capabilities;
- change direct-chat provider selection;
- replace existing quota-reset continuation;
- reinterpret OpenCode's own reasoning configuration as Codex `effort`.

A later extension may add ordered provider chains after the single-fallback semantics are proven.

## 4. Configuration

Keep the policy under the existing workflow continuation configuration because this is a workflow liveness policy, not a chat default and not an OpenCode provider default.

Proposed shape:

```yaml
workflows:
  quotaFallback:
    codex:
      provider: opencode
      tiers:
        small:  <opencode-model-ref>
        medium: <opencode-model-ref>
        large:  <opencode-model-ref>
```

OpenCode model refs use its existing `<provider>/<model>` syntax.

The policy is optional and default-off. A source provider without an entry behaves exactly as today.

### Why tier-specific destination models

A node that requested `small`, `medium`, or `large` has a stable semantic routing label even when the primary tier currently resolves to Codex/Luna. Reusing the tier lets the operator choose an equivalent OpenCode model deliberately.

Version 1 does not guess a fallback for a literal model ref. If the node did not resolve through a tier, automatic provider fallback is skipped with an inspectable reason.

### Reasoning effort

Codex advertises `effortControl: true`; OpenCode currently advertises `effortControl: false`.

Therefore:

- explicit node/workflow `effort:` is a semantic requirement and blocks automatic fallback when the destination cannot honor it;
- effort inherited only from the source tier preset is not copied to OpenCode;
- the fallback attempt records the actual OpenCode binding with no Archon effort value;
- OpenCode reasoning depth continues to come from OpenCode's own configuration.

This prevents a cross-provider switch from pretending two different reasoning controls are equivalent.

## 5. Trigger semantics

Automatic fallback is considered only when all of the following hold:

1. the failed attempt ran on `codex`;
2. the provider failure is structurally classified as `quota_exhausted`;
3. `workflows.quotaFallback.codex` is configured;
4. the node resolved through a named tier;
5. the destination tier model validates under OpenCode's existing model parser;
6. the destination can honor every required node capability;
7. the attempt has not crossed an unsafe replay boundary;
8. the node does not require cross-provider session continuity.

Raw vendor wording remains diagnostic evidence only. New policy must branch on the typed provider failure class. Existing legacy text detection may continue to normalize older/untyped provider errors into the typed class at the provider/engine boundary, but fallback policy itself must not grow a second string-pattern classifier.

## 6. Safe replay boundary

The central invariant is:

```text
provider fallback != workflow restart
provider fallback != blind node replay after side effects
```

A Codex quota failure is eligible for immediate OpenCode fallback only while the current node attempt is still demonstrably replay-safe.

### 6.1 Provider activity gate

Track whether the failed attempt has emitted any side-effect-capable activity.

The following make automatic fallback unsafe:

- `tool`;
- `tool_result`;
- `workflow_dispatch`;
- background/subagent activity that can outlive or mutate through the attempt;
- any other provider event whose contract permits external or checkout mutation.

Assistant/system/thinking text alone does not establish a side effect, but if partial text was surfaced, Archon should emit a short operator-visible notice that the node is restarting under the fallback provider.

### 6.2 Checkout gate

For checkout-scoped nodes, sample the checkout when the quota failure is received and compare it to the attempt's recorded `checkoutStart`.

If the working tree/revision observation changed, automatic fallback is refused even when no tool event was observed.

This is defense in depth: tool activity is the primary semantic gate; checkout observation catches provider/tool reporting gaps for repository mutation.

### 6.3 Session-continuity gate

Provider session identifiers are provider-specific.

Automatic Codex -> OpenCode fallback therefore requires a fresh/reconstructible node context. It is refused when the node is depending on:

- `context: shared` provider-session continuity;
- `context: { resume: ... }`;
- a persisted provider session;
- any resume handle that would have to cross provider identity.

Both providers supporting session resume does not make their session IDs interchangeable.

## 7. Capability compatibility

Before starting the fallback attempt, run the existing provider-capability checks against the OpenCode destination.

Fallback must fail closed if switching providers would silently remove a semantic requirement.

Examples:

- Codex `mcp` capability -> OpenCode currently cannot honor the same node field: no automatic fallback.
- Explicit `effort:` -> OpenCode cannot honor it: no automatic fallback.
- A feature supported by both providers may proceed.

This check should reuse the same capability source the DAG executor already uses for ignored-capability warnings; do not create a parallel compatibility table.

## 8. Execution model

Fallback is a **new attempt of the same node invocation**, not a new node and not a new workflow run.

Example:

```text
node invocation N
  attempt 1
    binding: codex / gpt-5.6-luna / tier=medium / effort=medium
    result: provider quota_exhausted
    replay safety: PASS

  fallback decision
    codex -> opencode
    reason: quota_exhausted

  attempt 2
    binding: opencode / <configured-medium-model> / tier=medium
    result: completed
```

The node's invocation identity, dependencies, prompt inputs, checkout target, and accounting ownership remain unchanged.

### Run-level model bindings remain immutable

`metadata.model_bindings` continues to record the run's sealed requested/effective model profile.

Do **not** rewrite it when fallback occurs.

The attempt-level `binding` is the authority for what actually executed. This preserves both facts:

```text
run requested Codex for medium
!=
attempt actually executed through OpenCode after quota exhaustion
```

## 9. Provenance and observability

Preserve the provider-failure subtype instead of collapsing all quota failures into an opaque `fatal` record.

Add enough structured attempt/event metadata to reconstruct:

- source provider/model/tier;
- typed failure class `quota_exhausted`;
- failed attempt ID;
- fallback provider/model/tier;
- fallback attempt ID;
- why replay was considered safe;
- whether fallback was refused, and the refusal reason.

Preferred surface:

```text
provider_fallback
  node_id
  invocation_id
  failed_attempt_id
  from_provider
  to_provider
  tier
  reason = quota_exhausted
```

The existing node-attempt records continue to carry the actual bindings and lifecycle results. The fallback event explains why adjacent attempts use different providers.

No vendor error prose should become a policy field.

## 10. Interaction with existing retries and quota continuation

Ordering:

```text
provider internal retry / ordinary Archon retry
    |
    | rate_limited / transient
    v
same provider retry budget

typed quota_exhausted
    |
    +-- fallback absent/ineligible --> existing terminal quota handling
    |
    +-- fallback eligible ----------> one OpenCode fallback attempt
                                       |
                                       +-- success --> workflow continues
                                       |
                                       +-- failure --> normal failure handling
```

Important rules:

- A rate limit is **not** quota exhaustion; keep today's patient same-provider retry behavior.
- Authentication failure is never a fallback trigger.
- Run budget exhaustion is never a fallback trigger.
- Version 1 permits at most one automatic cross-provider fallback for a node invocation.
- If the OpenCode fallback itself fails, do not automatically choose Claude.
- Existing `autoResumeOnQuotaReset` remains available when the terminal failure after this policy is a quota failure.
- A later scheduled run resume restores the original sealed run bindings; it does not permanently rewrite the run to OpenCode.

## 11. Suggested implementation boundaries

### 11.1 Schema/config

Extend:

- `packages/workflows/src/schemas/run-config.ts`
- `packages/core/src/config/config-types.ts`
- related config loader / run-config validation tests

Add a strict `quotaFallback` schema under `workflows`, keyed by source provider, with one destination provider and explicit tier model map.

Validate fallback models through the destination provider's existing run-model parser.

### 11.2 Pure fallback policy

Add a small workflow-layer helper, e.g. `packages/workflows/src/provider-fallback.ts`, responsible only for:

- matching typed failure class;
- checking configured source/destination;
- resolving the destination model from the node's tier;
- checking declared effort compatibility;
- checking provider capabilities;
- returning an explicit `eligible | ineligible(reason)` decision.

It must not execute providers or mutate run state.

### 11.3 DAG execution

Integrate at the node-attempt boundary in `packages/workflows/src/dag-executor.ts` / shared execution helper:

- preserve the typed provider failure;
- collect the replay-safety signals for the current attempt;
- when eligible, close the Codex attempt as failed;
- emit fallback provenance;
- allocate a fresh attempt ID;
- acquire the OpenCode provider slot normally;
- execute the same node invocation with a fresh OpenCode session and destination binding.

Do not route this through the CLI `--resume --model` path: resumed runs intentionally keep their original model bindings.

### 11.4 Execution records

Extend the execution lifecycle/event projection only as much as needed to retain the provider failure subtype and fallback provenance.

Prefer additive JSON/event fields; no relational migration should be necessary unless current storage constraints prove otherwise.

### 11.5 Docs/operator surface

Update:

- workflow configuration reference;
- AI assistant/provider guide;
- workflow execution/retry documentation;
- example config;
- changelog.

`workflow inspect` / transcript output should make provider fallback visible without requiring raw log inspection.

## 12. Test matrix

### Policy unit tests

1. Codex + `quota_exhausted` + configured tier -> eligible OpenCode binding.
2. Codex `rate_limited` -> ineligible.
3. Codex `auth` -> ineligible.
4. Codex `budget_exceeded` -> ineligible.
5. OpenCode-origin quota -> ineligible in v1.
6. literal/non-tier model -> ineligible.
7. invalid OpenCode model ref -> config rejection.
8. explicit effort unsupported by OpenCode -> ineligible.
9. tier-inherited Codex effort -> destination does not falsely inherit it.
10. unsupported destination capability -> ineligible.

### Executor tests

11. Pre-tool Codex quota -> one OpenCode attempt -> success -> downstream node runs.
12. Codex quota after `tool` -> no fallback.
13. Codex quota after checkout mutation -> no fallback.
14. Codex quota with shared/resumed session -> no fallback.
15. Fallback attempt uses a new attempt ID but same invocation ID.
16. Attempt 1 records Codex binding and typed quota failure.
17. Attempt 2 records OpenCode binding.
18. Exactly one fallback event is emitted.
19. Fallback OpenCode failure does not select Claude or loop.
20. Cancellation during/just before fallback prevents the second provider attempt.
21. Provider concurrency admission releases Codex and separately admits OpenCode.

### Resume/continuation tests

22. Run-level model bindings remain the original sealed Codex profile.
23. Manual/durable run resume still refuses replacement model overrides.
24. Existing quota-reset continuation behavior is unchanged when fallback is absent or ineligible.
25. A later quota resume can encounter Codex again and make a fresh bounded fallback decision.

### Regression

26. Existing provider retry tests remain unchanged.
27. Existing dry-run/model-resolution tests remain unchanged except for optional fallback visibility.
28. OpenCode effort warnings/behavior remain unchanged outside fallback.
29. Direct chat never uses workflow quota fallback.

## 13. Rollout

### Phase A — substrate and policy

- config schema;
- pure fallback decision helper;
- provenance schema/event;
- unit tests.

No live cross-provider execution yet.

### Phase B — executor integration

- same-invocation/new-attempt fallback;
- replay-safety tracking;
- capability/session gates;
- executor tests.

### Phase C — local subscription qualification

Using a controlled workflow:

1. configure Codex primary and OpenCode fallback;
2. force or simulate typed Codex quota exhaustion before tool activity;
3. prove OpenCode executes the same node and the workflow continues;
4. prove a post-tool quota failure refuses automatic replay;
5. inspect the transcript to prove both provider bindings and the fallback reason.

Do not manufacture real quota exhaustion if a deterministic provider fixture can prove engine semantics. A real subscription-limit run is useful only as the final provider-integration qualification.

## 14. Fork prerequisite

The writable `ThorStarlord/Archon` fork was 99 commits behind upstream when this design was prepared.

Those upstream commits contain critical substrate this feature should reuse, including the current typed provider-failure contract, durable quota continuation, run-scoped model bindings, provider concurrency/admission work, and related execution metadata.

Therefore implementation must first synchronize the fork to the target upstream `dev` baseline (or a later reviewed upstream revision) before feature code begins.

Do not implement a compatibility copy of those mechanisms on the stale fork.

## 15. Acceptance criteria

The feature is complete when:

- a Codex `quota_exhausted` failure can switch an eligible tier-backed workflow node to its configured OpenCode model automatically;
- the switch occurs at the node-attempt boundary, never by replaying the workflow;
- no automatic fallback occurs after a potentially mutating attempt boundary;
- no cross-provider session handle is reused;
- incompatible node semantics fail closed;
- run-level requested model bindings remain immutable;
- attempt-level provenance shows what actually ran;
- existing same-provider retry and quota-reset continuation semantics remain intact;
- fallback is default-off;
- no automatic Claude second fallback exists in v1;
- deterministic tests cover both successful fallback and every important refusal boundary.

## 16. Future extensions deliberately deferred

Only after v1 is proven should Archon consider:

- ordered provider chains such as Codex -> OpenCode -> Claude;
- cross-provider fallback for literal models through explicit aliases;
- provider-health/circuit-breaker routing;
- fallback on selected transient/provider-unavailable classes;
- cross-provider continuation based on reconstructed conversation state;
- shared policy for direct chat.

Each extension should preserve the v1 law:

```text
provider continuity
!= semantic weakening
!= blind replay
```
