import {
  ConceptNameSchema,
  NodeIdSchema,
  NodeRefSchema,
  PrimitiveSchema,
  VariabilitySchema,
} from '@ui-pro/core';
import { z } from 'zod';

export const RULES_FORMAT = 'ui-pro/rules';

export const POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
  'fill',
] as const;
export type Position = (typeof POSITIONS)[number];

export const TEXT_KINDS = ['value', 'label', 'title'] as const;
export const SHAPES = ['square', 'wide', 'tall'] as const;
export type Shape = (typeof SHAPES)[number];

const RULE_ID_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*(\.\*)?$/;

export const RuleIdSchema = z
  .string()
  .regex(
    RULE_ID_PATTERN,
    '规则 id 须以小写字母开头，只含小写字母、数字、下划线、连字符，可用点分段',
  );
export const RolePatternSchema = z
  .string()
  .regex(ROLE_PATTERN, '角色须形如 badge.notification，或用 badge.* 匹配前缀');
export const BecauseSchema = z.string().trim().min(1, '必须写理由（because 不能为空）');

function oneOrMany<T extends z.ZodType>(item: T, expected: string) {
  return z.union([item, z.array(item).min(1)], {
    error: `须为${expected}，或由它们组成的非空数组`,
  });
}

const CountRangeSchema = z
  .strictObject({
    min: z.number().int().positive().optional(),
    max: z.number().int().positive().optional(),
  })
  .refine((range) => range.min !== undefined || range.max !== undefined, 'min 和 max 至少给一个')
  .refine(
    (range) => range.min === undefined || range.max === undefined || range.min <= range.max,
    'min 不能大于 max',
  );

/**
 * The fixed vocabulary of `when`. Every key is one predicate; all predicates must hold, and a
 * rule's specificity is the number of keys it uses. Documented in the package README.
 */
export const WhenSchema = z.strictObject({
  type: oneOrMany(PrimitiveSchema, '基元类型').optional(),
  role: oneOrMany(RolePatternSchema, '通用角色').optional(),
  concept: oneOrMany(ConceptNameSchema, '概念名').optional(),
  varies: z
    .union([
      z.enum(['empty', 'non-empty']),
      oneOrMany(VariabilitySchema, 'empty、non-empty，或可变性'),
    ])
    .optional(),
  interactive: z.boolean().optional(),
  textKind: oneOrMany(z.enum(TEXT_KINDS), '文字种类').optional(),
  repeat: CountRangeSchema.optional(),
  parentType: oneOrMany(PrimitiveSchema, '基元类型').optional(),
  parentRole: oneOrMany(RolePatternSchema, '通用角色').optional(),
  attached: z.boolean().optional(),
  overVariable: z.boolean().optional(),
  position: oneOrMany(z.enum(POSITIONS), '位置').optional(),
  shape: oneOrMany(z.enum(SHAPES), '形状').optional(),
  childrenEven: z.boolean().optional(),
  touchSmall: z.boolean().optional(),
  lowRes: z.boolean().optional(),
  crossScreen: z.boolean().optional(),
});
export type When = z.infer<typeof WhenSchema>;
export type WhenKey = keyof When;
export const WHEN_KEYS = Object.keys(WhenSchema.shape) as readonly WhenKey[];

export const RuleSchema = z.strictObject({
  id: RuleIdSchema,
  point: z.string().min(1),
  when: WhenSchema.default({}),
  value: z.string().min(1),
  because: BecauseSchema,
  /** Qualified nodes (`<screen>/#<id>`) that prompted the rule; `rules check` replays them. */
  examples: z.array(NodeRefSchema).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const ExceptionSchema = z.strictObject({
  node: NodeIdSchema,
  point: z.string().min(1),
  value: z.string().min(1),
  because: z.string().trim().min(1, '节点例外必须写理由（because 不能为空）'),
});
export type NodeException = z.infer<typeof ExceptionSchema>;

export const DisabledRuleSchema = z.strictObject({
  /** `<id>@default` or `<id>@project`. */
  rule: z.string().min(1),
  because: z.string().trim().min(1, '停用规则必须写理由（because 不能为空）'),
});
export type DisabledRule = z.infer<typeof DisabledRuleSchema>;

function duplicates(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) (seen.has(item) ? repeated : seen).add(item);
  return [...repeated];
}

const uniqueIds = (rules: readonly Rule[], pending: readonly Rule[] = []) =>
  duplicates([...rules, ...pending].map((rule) => rule.id)).length === 0;

/** The default rule pack and `rules/project.yaml` share this shape. */
export const ProjectRulesSchema = z
  .strictObject({
    format: z.literal(RULES_FORMAT),
    version: z.literal(1),
    rules: z.array(RuleSchema),
    /** Proposed rules that do not apply until adopted. */
    pending: z.array(RuleSchema).default([]),
    disabled: z.array(DisabledRuleSchema).default([]),
  })
  .refine((doc) => uniqueIds(doc.rules, doc.pending), '规则 id 不能重复（含待定区）')
  .refine(
    (doc) => duplicates(doc.disabled.map((entry) => entry.rule)).length === 0,
    '同一条规则不能重复停用',
  );
export type ProjectRules = z.infer<typeof ProjectRulesSchema>;

export const ScreenRulesSchema = z
  .strictObject({
    format: z.literal(RULES_FORMAT),
    version: z.literal(1),
    rules: z.array(RuleSchema),
    exceptions: z.array(ExceptionSchema).default([]),
  })
  .refine((doc) => uniqueIds(doc.rules), '规则 id 不能重复')
  .refine(
    (doc) => duplicates(doc.exceptions.map((entry) => `${entry.node}|${entry.point}`)).length === 0,
    '同一个节点在同一个决策点上只能有一条节点例外',
  );
export type ScreenRules = z.infer<typeof ScreenRulesSchema>;

export const emptyProjectRules = (): ProjectRules => ({
  format: RULES_FORMAT,
  version: 1,
  rules: [],
  pending: [],
  disabled: [],
});

export const emptyScreenRules = (): ScreenRules => ({
  format: RULES_FORMAT,
  version: 1,
  rules: [],
  exceptions: [],
});
