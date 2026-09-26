# Codex -> OpenCode Quota Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an eligible workflow node automatically retry through a configured OpenCode model when a Codex attempt ends with typed `quota_exhausted`, without replaying the workflow or weakening node semantics.

**Architecture:** Extend the existing workflow continuation config with a strict, default-off Codex fallback mapping, add one pure eligibility/resolution helper, and integrate it at the agent-node attempt boundary. The first Codex attempt remains a failed recorded attempt; an eligible fallback creates a second attempt in the same invocation with an OpenCode binding and explicit provenance. Existing retries, run model bindings, and quota-reset continuation remain authoritative and unchanged outside this narrow branch.

**Tech Stack:** TypeScript, Bun test runner, Zod schemas, Archon workflow engine/provider registry.

**Spec:** `docs/superpowers/specs/2026-09-25-codex-opencode-quota-fallback-design.md`

## Global Constraints

- V1 supports only automatic `codex -> opencode` fallback.
- Trigger only on typed `ProviderFailure.class === 'quota_exhausted'`; never branch on vendor prose.
- Fallback is default-off and requires explicit tier-to-OpenCode model mappings.
- Only tier-backed nodes are eligible; literal model refs do not auto-fallback.
- Explicit node/workflow `effort:` blocks fallback while OpenCode advertises `effortControl: false`; tier-inherited Codex effort is not copied.
- Never reuse Codex provider-session state in OpenCode.
- Never replay after provider/tool/background/workflow-dispatch activity that can carry side effects.
- Checkout drift after the failed attempt also blocks replay.
- Run-level `metadata.model_bindings` stays immutable; actual execution belongs in attempt-level bindings.
- At most one automatic cross-provider fallback per node invocation.
- Existing same-provider retry and quota-reset continuation behavior must remain unchanged.

## Review Focus

- A quota failure after partial assistant text but before any side-effect-capable provider event should be eligible and should not duplicate surfaced batch output.
- A node with `context: shared`, named resume, or persisted session must fail closed rather than crossing provider session identity.
- A fallback destination whose capabilities cannot honor an authored node requirement must be refused, not warned-and-ignored.
- Cancellation between the Codex failure and OpenCode dispatch must prevent the fallback attempt.
- A quota failure on OpenCode after fallback must not recurse to Codex, Claude, or a second OpenCode attempt.

---

### Task 1: Configuration and pure fallback policy

**Files:**
- Modify: `packages/workflows/src/schemas/run-config.ts`
- Modify: `packages/core/src/config/config-types.ts`
- Modify: `packages/workflows/src/run-config.test.ts`
- Create: `packages/workflows/src/provider-fallback.ts`
- Create: `packages/workflows/src/provider-fallback.test.ts`

**Interfaces:**
- Consumes: `ProviderFailure`, `ProviderCapabilities`, `TierName`, destination provider model parser/capabilities.
- Produces: `QuotaFallbackPolicy` config shape and `resolveQuotaFallback(input): QuotaFallbackDecision`, where the decision is either `{ eligible: true, provider: 'opencode', model: string }` or `{ eligible: false, reason: QuotaFallbackRefusal }`.

- [ ] **Step 1: Write failing config tests**
  - `applyWorkflowRunConfigLayer` merges `workflows.quotaFallback.codex` without dropping existing quota continuation defaults.
  - malformed provider/tier entries fail strict run-config validation.
  - an OpenCode destination model with invalid ref syntax is rejected before execution.

- [ ] **Step 2: Run config tests and verify RED**

Run: `bun test packages/workflows/src/run-config.test.ts packages/core/src/config/run-config.test.ts`  
Expected: new fallback assertions fail because `quotaFallback` is not in the schema/config merge yet.

- [ ] **Step 3: Implement the config schema and merge plumbing**
  - Add the strict default-off fallback structure under `workflows`.
  - Preserve nested `quotaFallback` entries when a run layer changes only another workflow continuation key.
  - Validate destination models through the registered destination provider parser.

- [ ] **Step 4: Write failing pure-policy tests**
  - typed Codex quota + tier + configured destination => eligible.
  - rate limit/auth/budget/transient => refusal.
  - non-Codex origin => refusal.
  - literal model/no tier => refusal.
  - explicit effort + OpenCode no effort control => refusal.
  - required unsupported capability => refusal.
  - shared/named/persisted session continuity => refusal.

- [ ] **Step 5: Run policy tests and verify RED**

Run: `bun test packages/workflows/src/provider-fallback.test.ts`  
Expected: FAIL because `resolveQuotaFallback` does not exist.

- [ ] **Step 6: Implement `resolveQuotaFallback`**

Keep it pure: no provider instantiation, no store writes, no logging. Return explicit refusal reasons for executor provenance.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run: `bun test packages/workflows/src/provider-fallback.test.ts packages/workflows/src/run-config.test.ts packages/core/src/config/run-config.test.ts`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workflows/src/schemas/run-config.ts packages/core/src/config/config-types.ts packages/workflows/src/run-config.test.ts packages/core/src/config/run-config.test.ts packages/workflows/src/provider-fallback.ts packages/workflows/src/provider-fallback.test.ts
git commit -m "feat(workflows): define safe quota fallback policy"
```

### Task 2: Same-invocation OpenCode fallback execution

**Files:**
- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/schemas/node-execution.ts`
- Modify: `packages/workflows/src/store.ts` only if an event-type union requires the new provenance event
- Modify: `packages/workflows/src/dag-executor.test.ts`
- Modify/add focused serialization/schema tests if needed.

**Interfaces:**
- Consumes: Task 1 `resolveQuotaFallback`.
- Produces: a Codex failed attempt followed by one OpenCode attempt under the same `NodeInvocation`, plus inspectable `provider_fallback` provenance.

- [ ] **Step 1: Write failing executor tests**
  - pre-tool typed Codex quota falls back once to OpenCode and downstream work receives the successful node output.
  - first and second records share invocation ID and have distinct attempt IDs/bindings.
  - run-level model bindings are untouched.
  - fallback emits structured provenance naming from/to provider, tier, failed attempt, and `quota_exhausted`.

- [ ] **Step 2: Run focused executor tests and verify RED**

Run: `bun test packages/workflows/src/dag-executor.test.ts --timeout 30000`  
Expected: new fallback assertions fail because the executor currently terminates the node on quota exhaustion.

- [ ] **Step 3: Add replay-safety tracking**
  - Track side-effect-capable provider activity during the attempt.
  - Mark unsafe on tool/tool_result, workflow dispatch, and background/subagent activity.
  - Re-observe checkout at quota failure and compare with the attempt start observation.
  - Keep partial assistant/system/thinking text non-mutating, but reset per-attempt output buffers before OpenCode execution.

- [ ] **Step 4: Add same-invocation/new-attempt fallback dispatch**
  - Preserve the original invocation object.
  - Finish/persist the Codex attempt as failed with typed quota provenance.
  - Re-resolve the same node using the fallback OpenCode binding without mutating run model bindings.
  - Create a new attempt ID through existing execution-record machinery.
  - Acquire OpenCode normally through the existing provider/admission path.
  - Execute once with fresh provider session state.

- [ ] **Step 5: Add refusal-path tests**
  - post-tool quota => no fallback.
  - checkout drift => no fallback.
  - shared/named/persisted session => no fallback.
  - unsupported capability/explicit effort => no fallback.
  - cancellation before fallback => no OpenCode call.
  - OpenCode fallback failure => no recursive provider switch.

- [ ] **Step 6: Run focused executor suite and verify GREEN**

Run: `bun test packages/workflows/src/dag-executor.test.ts --timeout 30000`  
Expected: PASS, including existing retry/resume tests.

- [ ] **Step 7: Commit**

```bash
git add packages/workflows/src/dag-executor.ts packages/workflows/src/schemas/node-execution.ts packages/workflows/src/store.ts packages/workflows/src/dag-executor.test.ts
git commit -m "feat(workflows): fall back from Codex quota to OpenCode safely"
```

### Task 3: Documentation, regression verification, and integration evidence

**Files:**
- Modify: `.archon/config.example.yaml`
- Modify: `packages/docs-web/src/content/docs/reference/configuration.md`
- Modify: `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
- Modify: `CHANGELOG.md`
- Modify spec/plan only if implementation rulings require clarification.

**Interfaces:**
- Consumes: completed Task 1-2 behavior.
- Produces: operator-facing configuration/semantics and final verification evidence.

- [ ] **Step 1: Add documentation examples**
  - Show Codex primary tiers separately from `workflows.quotaFallback.codex`.
  - State that OpenCode effort semantics are not inherited.
  - State every refusal boundary and the interaction with existing quota-reset continuation.
  - Make clear that provider fallback is attempt-level, not workflow replay.

- [ ] **Step 2: Run focused tests**

Run: `bun test packages/workflows/src/provider-fallback.test.ts packages/workflows/src/run-config.test.ts packages/core/src/config/run-config.test.ts packages/workflows/src/dag-executor.test.ts --timeout 30000`  
Expected: PASS.

- [ ] **Step 3: Run repository validation**

Run: `bun run validate`  
Expected: PASS.

- [ ] **Step 4: Run the repository's broader test command declared by package scripts/CI**

Expected: PASS, or record exact pre-existing/infrastructure failure separately without converting it into a code-failure claim.

- [ ] **Step 5: Commit**

```bash
git add .archon/config.example.yaml packages/docs-web/src/content/docs/reference/configuration.md packages/docs-web/src/content/docs/getting-started/ai-assistants.md CHANGELOG.md
git commit -m "docs: document Codex quota fallback to OpenCode"
```

- [ ] **Step 6: Whole-branch review**
  - Review the branch against the spec and the five Review Focus cases.
  - Fix Critical/Important findings with RED->GREEN tests.
  - Record any deferred Minor findings.

- [ ] **Step 7: Open a PR against `ThorStarlord/Archon:dev`**
  - Do not merge automatically unless the repository's normal review/CI policy permits it and the user has already granted that authority.
