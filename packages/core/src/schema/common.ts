import { z } from 'zod';

export const PRIMITIVES = [
  'container',
  'image',
  'text',
  'button',
  'toggle',
  'toggle-group',
  'progress',
  'slider',
  'scroll',
  'list',
  'input',
  'mask',
  'anim',
  'particle',
  'surface',
  'instance',
] as const;
export const PrimitiveSchema = z.enum(PRIMITIVES);
export type Primitive = z.infer<typeof PrimitiveSchema>;

export const VARIABILITIES = ['visibility', 'content', 'state', 'motion', 'size'] as const;
export const VariabilitySchema = z.enum(VARIABILITIES);
export type Variability = z.infer<typeof VariabilitySchema>;

export const VariesSchema = z
  .array(VariabilitySchema)
  .refine((items) => new Set(items).size === items.length, '可变性不能重复');

export const NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const SCREEN_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const ROLE_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
export const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const STATE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Qualified node reference, `<screen>/#<id>`. */
export const NODE_REF_PATTERN = /^([a-z][a-z0-9_-]{0,63})\/#([a-z][a-z0-9_]{0,63})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export const NodeIdSchema = z
  .string()
  .regex(NODE_ID_PATTERN, '节点 id 须匹配 [a-z][a-z0-9_]{0,63}');
export const ScreenNameSchema = z
  .string()
  .regex(SCREEN_NAME_PATTERN, '界面名须匹配 [a-z][a-z0-9_-]{0,63}');
export const RoleSchema = z
  .string()
  .regex(ROLE_PATTERN, '角色须为点分小写，例如 badge.notification');
export const ComponentNameSchema = z
  .string()
  .regex(COMPONENT_NAME_PATTERN, '组件名须为 PascalCase');
export const StateNameSchema = z
  .string()
  .regex(STATE_NAME_PATTERN, '状态名须匹配 [a-z][a-z0-9_]{0,31}');
export const ConceptNameSchema = z.string().min(1, '概念名不能为空');
export const NodeRefSchema = z.string().regex(NODE_REF_PATTERN, '节点引用须形如 <screen>/#<id>');
export const Sha256Schema = z.string().regex(SHA256_PATTERN, '须为 64 位小写十六进制');
export const ColorSchema = z.string().regex(COLOR_PATTERN, '颜色须为 #rrggbb 或 #rrggbbaa');

/** Design-space rectangle `[x, y, w, h]`. Shape only; positivity is checked by `validateScreen`. */
export const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Rect = z.infer<typeof RectSchema>;

/** Rectangle accepted as op input: width and height must be positive. */
export const PositiveRectSchema = RectSchema.refine(
  ([, , w, h]) => w > 0 && h > 0,
  '宽高必须大于 0',
);

export const PairSchema = z.tuple([z.number(), z.number()]);

/** A caller-chosen key of a free-form record such as `pins` or `bind`. */
export const FreeKeySchema = z
  .string()
  .min(1)
  .refine((key) => key !== '__proto__', '不允许使用 __proto__ 作为键名');
