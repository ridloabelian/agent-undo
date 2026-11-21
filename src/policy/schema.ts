import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { PolicyConfig } from '../types.js';

const PolicyDecisionSchema = z.enum([
  'allow',
  'grace_window',
  'require_approval',
  'deny',
]);

const ArgOperatorPredicateSchema = z
  .object({
    eq: z.unknown().optional(),
    neq: z.unknown().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    in: z.array(z.unknown()).optional(),
    contains: z.string().optional(),
    regex: z.string().optional(),
  })
  .strict();

const ArgPredicateSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  ArgOperatorPredicateSchema,
]);

const SpendExtractorSchema = z.object({
  arg: z.string().min(1),
  scale: z.number().positive().optional(),
});

const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    args: z.record(ArgPredicateSchema).optional(),
  }),
  decision: PolicyDecisionSchema,
  graceSeconds: z.number().positive().optional(),
  readOnly: z.boolean().optional(),
  spendExtractor: SpendExtractorSchema.optional(),
  reason: z.string().optional(),
});

const BudgetScopeSchema = z.object({
  maxSpendUsd: z.number().nonnegative().optional(),
  maxMutations: z.number().int().nonnegative().optional(),
});

export const PolicyConfigSchema = z.object({
  version: z.union([z.string(), z.number()]).transform((v) => String(v)).default('0.1'),
  defaultDecision: PolicyDecisionSchema.default('require_approval'),
  defaultGraceSeconds: z.number().positive().default(30),
  budgets: z
    .object({
      session: BudgetScopeSchema.optional(),
      daily: BudgetScopeSchema.optional(),
    })
    .optional(),
  rules: z.array(PolicyRuleSchema).default([]),
});

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: '0.1',
  defaultDecision: 'require_approval',
  defaultGraceSeconds: 30,
  budgets: {
    session: {
      maxSpendUsd: 100,
      maxMutations: 25,
    },
    daily: {
      maxSpendUsd: 500,
      maxMutations: 100,
    },
  },
  rules: [
    {
      id: 'allow-readonly-wildcards',
      match: {
        tool: ['*.list_*', '*.get_*', '*.read_*', 'fs.list_dir'],
      },
      decision: 'allow',
      readOnly: true,
      reason: 'Read-only inspection tools execute immediately.',
    },
  ],
};

/**
 * Parses a YAML or JSON policy document into a validated PolicyConfig.
 */
export function parsePolicy(
  raw: string,
  format: 'yaml' | 'json' = 'yaml',
): PolicyConfig {
  const parsed: unknown =
    format === 'json' ? JSON.parse(raw) : YAML.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Policy document must parse to a non-empty object.');
  }

  return PolicyConfigSchema.parse(parsed) as PolicyConfig;
}

/**
 * Loads and validates a policy configuration from a YAML or JSON file.
 */
export function loadPolicyFromFile(filePath: string): PolicyConfig {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  const format = ext === '.json' ? 'json' : 'yaml';
  return parsePolicy(raw, format);
}
