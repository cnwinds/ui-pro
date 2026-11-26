import { ASSET_NAME_PATTERN, type Primitive } from '@ui-pro/core';

/** What `{prefix}` expands to: a short form of the node's primitive type. */
export const TYPE_PREFIX: Record<Primitive, string> = {
  container: 'grp',
  image: 'img',
  text: 'txt',
  button: 'btn',
  toggle: 'tgl',
  'toggle-group': 'tgg',
  progress: 'bar',
  slider: 'sld',
  scroll: 'scr',
  list: 'lst',
  input: 'inp',
  mask: 'msk',
  anim: 'anim',
  particle: 'fx',
  surface: 'srf',
  instance: 'ins',
};

const MAX_LENGTH = 96;

/** The node id without a leading type prefix (`btn_upgrade` of a button is `upgrade`). */
export function semanticOf(nodeId: string, type: Primitive): string {
  const prefixes = [`${TYPE_PREFIX[type]}_`, `${type.replaceAll('-', '_')}_`];
  for (const prefix of prefixes) {
    if (nodeId.startsWith(prefix) && nodeId.length > prefix.length) {
      return nodeId.slice(prefix.length);
    }
  }
  return nodeId;
}

/** Lowercase, only `[a-z0-9_-]`, no doubled or edge separators, short enough to take a suffix. */
function sanitize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_')
    .replaceAll(/_{2,}/g, '_')
    .replaceAll(/^[_-]+|[_-]+$/g, '');
  return cleaned.slice(0, MAX_LENGTH - 8).replaceAll(/[_-]+$/g, '');
}

function render(template: string, prefix: string, semantic: string, index: string): string {
  return template
    .replaceAll('{prefix}', prefix)
    .replaceAll('{semantic}', semantic)
    .replaceAll('{index}', index);
}

/**
 * Hands out asset names: from the `naming.asset` template, unique within the screen and valid
 * for `ASSET_NAME_PATTERN`. The first of a name goes without `{index}`, later ones get 2, 3, …
 */
export class NameAllocator {
  readonly #taken = new Set<string>();
  readonly #counts = new Map<string, number>();

  /** A name for the asset of node `nodeId`. */
  forNode(template: string, nodeId: string, type: Primitive): string {
    const prefix = TYPE_PREFIX[type];
    const semantic = semanticOf(nodeId, type);
    return this.#allocate(
      sanitize(render(template, prefix, semantic, '')),
      (index) => sanitize(render(template, prefix, semantic, String(index))),
      template.includes('{index}'),
    );
  }

  /** A name for the picture of one state of an asset named `base`. */
  forState(base: string, state: string): string {
    const stem = sanitize(`${base}_${state}`);
    return this.#allocate(stem, (index) => sanitize(`${stem}_${index}`), true);
  }

  #allocate(stem: string, indexed: (index: number) => string, templated: boolean): string {
    const base = stem === '' ? 'asset' : stem;
    let index = (this.#counts.get(base) ?? 0) + 1;
    for (;;) {
      let name = index === 1 ? base : templated ? indexed(index) : `${base}_${index}`;
      if (name === '' || name === base) name = index === 1 ? base : `${base}_${index}`;
      if (!this.#taken.has(name) && ASSET_NAME_PATTERN.test(name)) {
        this.#taken.add(name);
        this.#counts.set(base, index);
        return name;
      }
      index++;
    }
  }
}
