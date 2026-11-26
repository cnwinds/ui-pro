import type { Variability } from '@ui-pro/core';

/**
 * The shipped table of generic roles (DESIGN §5.4): each role's default variability, which
 * applies to a node whose own `varies` is empty. Game-specific names belong to concepts.
 */
export const GENERIC_ROLES: Readonly<Record<string, readonly Variability[]>> = {
  background: [],
  decoration: [],
  panel: ['size'],
  frame: ['size'],
  title: [],
  label: ['content'],
  value: ['content'],
  icon: [],
  button: ['state'],
  toggle: ['state'],
  tab: ['state'],
  slot: ['content'],
  'badge.notification': ['visibility'],
  'badge.count': ['visibility', 'content'],
  'badge.mark': ['content'],
  progress: ['size'],
  figure: ['motion'],
  'list-item': ['content'],
  surface: ['motion'],
};

export const ROLE_NAMES: readonly string[] = Object.keys(GENERIC_ROLES);

/** Roles whose nodes take input, whatever their primitive type. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set(['button', 'toggle', 'tab']);

/** An icon inside a slot is the slot's content; elsewhere it does not change at runtime. */
export function defaultVaries(role: string | undefined, parentRole?: string): Variability[] {
  if (role === undefined) return [];
  if (role === 'icon') return parentRole === 'slot' ? ['content'] : [];
  return [...(GENERIC_ROLES[role] ?? [])];
}

/** `badge.*` matches every role under the `badge.` prefix; anything else matches exactly. */
export function matchesRolePattern(pattern: string, role: string): boolean {
  if (pattern.endsWith('.*')) return role.startsWith(pattern.slice(0, -1));
  return pattern === role;
}

/** Whether a role pattern in a default rule refers to a role of the shipped table. */
export function isKnownRolePattern(pattern: string): boolean {
  return ROLE_NAMES.some((role) => matchesRolePattern(pattern, role));
}
