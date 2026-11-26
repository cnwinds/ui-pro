import {
  type Primitive,
  PrimitiveSchema,
  type Project,
  ROLE_PATTERN,
  UiProError,
  type Variability,
} from '@ui-pro/core';
import { PsdErrorCodes } from './errors';

/** What a layer-group prefix declares (delivery spec C.3). */
export interface PrefixEntry {
  prefix: string;
  type: Primitive;
  role?: string;
  varies?: Variability[];
  /** The type when the element also contains other elements, e.g. a count badge with its number. */
  typeWithChildren?: Primitive;
  /** The role is only known from what the element shows; the draft asks instead of guessing. */
  roleFromContent?: boolean;
}

const DEFAULT_ENTRIES: readonly PrefixEntry[] = [
  { prefix: 'btn_', type: 'button', role: 'button', varies: ['state'] },
  { prefix: 'tab_', type: 'toggle', role: 'tab', varies: ['state'] },
  { prefix: 'chk_', type: 'toggle', role: 'toggle', varies: ['state'] },
  { prefix: 'bar_', type: 'progress', role: 'progress', varies: ['size'] },
  { prefix: 'slot_', type: 'container', role: 'slot', varies: ['content'] },
  {
    prefix: 'badge_',
    type: 'image',
    typeWithChildren: 'container',
    varies: ['visibility'],
    roleFromContent: true,
  },
  { prefix: 'icon_', type: 'image', role: 'icon' },
  { prefix: 'txt_', type: 'text', varies: ['content'] },
  { prefix: 'art_', type: 'image', role: 'title' },
  { prefix: 'list_', type: 'list', varies: ['content', 'size'] },
  { prefix: 'item_', type: 'container', role: 'list-item', varies: ['content'] },
  { prefix: 'panel_', type: 'image', role: 'panel', varies: ['size'] },
  { prefix: 'fig_', type: 'image', role: 'figure', varies: ['motion'] },
  { prefix: 'img_', type: 'image' },
  { prefix: 'bg_', type: 'image', role: 'background' },
  { prefix: 'deco_', type: 'image', role: 'decoration' },
  { prefix: 'anim_', type: 'anim', varies: ['motion'] },
  { prefix: 'fx_', type: 'particle', varies: ['motion'] },
  { prefix: 'grp_', type: 'container' },
];

const PREFIX_KEY_PATTERN = /^[a-z][a-z0-9]*_$/;
const NAME_PART_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

function configError(key: string, reason: string): UiProError {
  return new UiProError(
    PsdErrorCodes.config,
    `项目配置 psd.prefixes 里的「${key}」不合法：${reason}`,
    {
      hint: '格式是 前缀: 类型 或 前缀: 类型:角色，例如 cell_: container:list-item',
    },
  );
}

function parseOverride(key: string, value: string): PrefixEntry {
  const prefix = key.endsWith('_') ? key : `${key}_`;
  if (!PREFIX_KEY_PATTERN.test(prefix)) {
    throw configError(key, '前缀只能用小写字母和数字，以下划线结尾，例如 btn_');
  }
  const [type, role, ...rest] = value.split(':');
  const parsed = PrimitiveSchema.safeParse(type);
  if (!parsed.success || rest.length > 0) {
    throw configError(key, `「${value}」不是 类型 或 类型:角色（类型须是基元类型之一）`);
  }
  if (role !== undefined && !ROLE_PATTERN.test(role)) {
    throw configError(key, `角色「${role}」须为点分小写，例如 badge.notification`);
  }
  return { prefix, type: parsed.data, role };
}

export class PrefixTable {
  readonly entries: readonly PrefixEntry[];

  constructor(overrides: Readonly<Record<string, string>> = {}) {
    const byPrefix = new Map(DEFAULT_ENTRIES.map((entry) => [entry.prefix, entry]));
    for (const [key, value] of Object.entries(overrides)) {
      const entry = parseOverride(key, value);
      byPrefix.set(entry.prefix, entry);
    }
    // Prefixes are one word each, so none is the start of another and the order is free.
    this.entries = [...byPrefix.values()];
  }

  /** The entry whose prefix starts `name` and is followed by a name part; `undefined` if none. */
  match(name: string): PrefixEntry | undefined {
    return this.entries.find(
      (entry) => name.startsWith(entry.prefix) && name.length > entry.prefix.length,
    );
  }

  /** Whether `name` is a well-formed `前缀_名称` (lowercase ASCII, digits and underscores). */
  isWellFormed(name: string): boolean {
    const entry = this.match(name);
    return entry !== undefined && NAME_PART_PATTERN.test(name.slice(entry.prefix.length));
  }
}

export function prefixTableFor(project: Project | undefined): PrefixTable {
  return new PrefixTable(project?.config.psd.prefixes);
}
