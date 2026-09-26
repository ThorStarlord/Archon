import { z } from '@hono/zod-openapi';
import { MAX_DURABLE_WAIT_MS } from './durable-wait';
import { runAliasesConfigSchema, runTiersConfigSchema } from './model-binding';

const providerDefaultsSchema = z.record(z.string(), z.unknown());

const quotaFallbackTierModelsSchema = z
  .object({
    small: z.string().trim().min(1),
    medium: z.string().trim().min(1),
    large: z.string().trim().min(1),
  })
  .strict();

const codexQuotaFallbackSchema = z
  .object({
    provider: z.literal('opencode'),
    tiers: quotaFallbackTierModelsSchema,
  })
  .strict();

export const quotaFallbackConfigSchema = z
  .object({
    codex: codexQuotaFallbackSchema.optional(),
  })
  .strict();

export type QuotaFallbackConfig = z.infer<typeof quotaFallbackConfigSchema>;

export const workflowRunContinuationConfigSchema = z
  .object({
    autoResumeOnQuotaReset: z.boolean().optional(),
    quotaFallbackDelayMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
    quotaMaxAttempts: z.number().int().positive().optional(),
    quotaDeadlineMs: z.number().finite().positive().max(MAX_DURABLE_WAIT_MS).optional(),
    quotaFallback: quotaFallbackConfigSchema.optional(),
  })
  .strict();

/** Sparse configuration values whose consumers still run after dispatch. */
export const workflowRunConfigLayerSchema = z
  .object({
    assistant: z.string().trim().min(1).optional(),
    assistants: z.record(z.string(), providerDefaultsSchema).optional(),
    aliases: runAliasesConfigSchema.optional(),
    tiers: runTiersConfigSchema.optional(),
    workflows: workflowRunContinuationConfigSchema.optional(),
    docsPath: z.string().trim().min(1).optional(),
    envVars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type WorkflowRunConfigLayer = z.infer<typeof workflowRunConfigLayerSchema>;

export const workflowRunConfigSourceSchema = z
  .object({
    kind: z.enum(['cli', 'http']),
    label: z.string().min(1),
  })
  .strict();

export type WorkflowRunConfigSource = z.infer<typeof workflowRunConfigSourceSchema>;

export const workflowRunConfigInputSchema = z
  .object({
    layer: workflowRunConfigLayerSchema,
    source: workflowRunConfigSourceSchema,
  })
  .strict();

export type WorkflowRunConfigInput = z.infer<typeof workflowRunConfigInputSchema>;

export const workflowRunConfigMetadataSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z.string().min(1),
    source: workflowRunConfigSourceSchema,
    keys: z.array(z.string().min(1)),
  })
  .strict();

export type WorkflowRunConfigMetadata = z.infer<typeof workflowRunConfigMetadataSchema>;
