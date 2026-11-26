import type { Candidate, CandidatesDoc, Primitive } from '@ui-pro/core';

export interface DraftResult {
  /** `node.add` ops, every parent before its children. */
  ops: unknown[];
  /** Candidate id -> id of the node drafted for it. */
  nodes: Map<string, string>;
}

const VALUE_PATTERNS = [
  /^(lv\.?)?[+\-×x*]?\d[\d,.]*[%+]?$/i,
  /^\d[\d,.]*[/:]\d[\d,.]*$/,
  /^[+\-×x*]\d[\d,.]*$/i,
];

/** Numbers, amounts and levels: text whose content the game fills in, not a fixed label. */
export function isValueText(text: string): boolean {
  const squeezed = text.replace(/\s+/g, '');
  return VALUE_PATTERNS.some((pattern) => pattern.test(squeezed));
}

function holdsText(id: string, children: ReadonlyMap<string, Candidate[]>): boolean {
  return (children.get(id) ?? []).some(
    (child) => child.source === 'ocr' || holdsText(child.id, children),
  );
}

/**
 * A first guess at the screen's structure from the evidence alone. Every text becomes a text
 * node; shapes become nodes when they are repeated elements (a visual cluster) or hold text,
 * i.e. when they are plausibly a button, a bar or a panel; what a node is for (its role) is left
 * to whoever reads the screen. A node sits under the nearest drafted shape around it.
 */
export function buildDraft(doc: CandidatesDoc, usedIds: Iterable<string>): DraftResult {
  const { candidates } = doc;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const children = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.parent === undefined) continue;
    const siblings = children.get(candidate.parent) ?? [];
    siblings.push(candidate);
    children.set(candidate.parent, siblings);
  }

  const drafted = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.source === 'ocr') drafted.add(candidate.id);
    else if (candidate.cluster !== undefined || holdsText(candidate.id, children)) {
      drafted.add(candidate.id);
    }
  }

  const draftedParent = (candidate: Candidate): string | undefined => {
    let parent = candidate.parent;
    while (parent !== undefined && !drafted.has(parent)) parent = byId.get(parent)?.parent;
    return parent;
  };
  const draftedChildren = new Map<string, Candidate[]>();
  const roots: Candidate[] = [];
  for (const candidate of candidates) {
    if (!drafted.has(candidate.id)) continue;
    const parent = draftedParent(candidate);
    if (parent === undefined) roots.push(candidate);
    else draftedChildren.set(parent, [...(draftedChildren.get(parent) ?? []), candidate]);
  }

  const used = new Set(usedIds);
  const nodes = new Map<string, string>();
  const ops: unknown[] = [];
  const nextId = (type: Primitive): string => {
    const base = type.replaceAll('-', '_');
    for (let n = 1; ; n++) {
      const id = `${base}_${n}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  const add = (candidate: Candidate, parentNode: string | undefined): void => {
    const isText = candidate.source === 'ocr';
    const type: Primitive = isText
      ? 'text'
      : (draftedChildren.get(candidate.id) ?? []).length > 0
        ? 'container'
        : 'image';
    const id = nextId(type);
    nodes.set(candidate.id, id);
    const text =
      isText && candidate.text !== undefined
        ? { content: candidate.text, ...(isValueText(candidate.text) ? { kind: 'value' } : {}) }
        : undefined;
    ops.push({
      op: 'node.add',
      node: {
        id,
        type,
        ...(parentNode === undefined ? {} : { parent: `#${parentNode}` }),
        ...(text === undefined ? {} : { text }),
      },
      from: [candidate.id],
    });
    for (const child of draftedChildren.get(candidate.id) ?? []) add(child, id);
  };
  for (const root of roots) add(root, undefined);
  return { ops, nodes };
}
