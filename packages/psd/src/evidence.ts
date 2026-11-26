import {
  type Candidate,
  type CandidatesDoc,
  type Cluster,
  type EvidenceFile,
  type Rect,
  unionRect,
} from '@ui-pro/core';
import { isDefaultVisible, type PsdDocument, type PsdLayer } from './model';
import type { StoredRender } from './render-store';
import { isIgnored, numberedName } from './structure';

export interface LayerEvidence {
  doc: CandidatesDoc;
  /** The layer renders the candidates' `mask` fields name. */
  files: EvidenceFile[];
  /** Ids of the candidates, for checking what a draft may refer to. */
  candidateIds: ReadonlySet<string>;
}

export const candidateIdOf = (layer: PsdLayer): string => `layer#${layer.id}`;
export const layerFileOf = (layer: PsdLayer): string => `layers/${layer.id}.png`;

interface Built {
  candidates: Candidate[];
  bbox: Rect;
  visible: boolean;
}

interface Collected {
  candidate: Candidate;
  layer: PsdLayer;
  /** Candidate id of the parent group, or `null` at the top level. */
  parent: string | null;
}

class EvidenceBuilder {
  readonly files: EvidenceFile[] = [];
  readonly collected: Collected[] = [];

  constructor(private readonly stored: ReadonlyMap<number, StoredRender>) {}

  visit(layer: PsdLayer, ancestors: readonly PsdLayer[], parent: string | null): Built | undefined {
    if (isIgnored(layer)) return undefined;
    const id = candidateIdOf(layer);
    const info = {
      psdId: layer.id,
      name: layer.name,
      path: layer.path,
      kind: layer.kind,
      hidden: layer.hidden,
      hasEffects: layer.hasEffects,
    };
    const visible = isDefaultVisible({ layer, ancestors: [...ancestors] });
    const base = parent === null ? {} : { parent };

    if (layer.children === undefined) {
      const render = this.stored.get(layer.id);
      const bbox = render?.box ?? layer.box;
      if (bbox === null || bbox === undefined) return undefined;
      const mask = render?.png ? layerFileOf(layer) : undefined;
      if (render?.png && mask !== undefined) this.files.push({ path: mask, content: render.png });
      const candidate: Candidate = {
        id,
        source: 'layer',
        bbox,
        ...(mask === undefined ? {} : { mask }),
        ...base,
        layer: info,
      };
      this.collected.push({ candidate, layer, parent });
      return { candidates: [candidate], bbox, visible };
    }

    const children = layer.children
      .map((child) => this.visit(child, [...ancestors, layer], id))
      .filter((built): built is Built => built !== undefined);
    if (children.length === 0) return undefined;
    // A group's box follows what it shows; hidden state layers only count when nothing else does.
    const shown = children.filter((child) => child.visible);
    const bbox = unionRect((shown.length > 0 ? shown : children).map((child) => child.bbox));
    const candidate: Candidate = { id, source: 'layer', bbox, ...base, layer: info };
    this.collected.push({ candidate, layer, parent });
    return {
      candidates: [candidate, ...children.flatMap((child) => child.candidates)],
      bbox,
      visible: visible && shown.length > 0,
    };
  }
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | undefined): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].filter((members) => members.length >= 2);
}

/** Instances of one smart object, and groups named `base_1`, `base_2`, … under one parent. */
function clustersOf(collected: readonly Collected[]): Cluster[] {
  const clusters: Cluster[] = [];
  const add = (members: readonly Collected[], kind: Cluster['kind'], prefix: string) => {
    const id = `${prefix}#${clusters.filter((cluster) => cluster.kind === kind).length + 1}`;
    for (const member of members) member.candidate.cluster = id;
    clusters.push({ id, kind, members: members.map((member) => member.candidate.id) });
  };
  for (const members of groupBy(collected, (item) => item.layer.smartSource)) {
    add(members, 'smart-object', 'smart');
  }
  const groups = collected.filter((item) => item.layer.kind === 'group');
  for (const members of groupBy(groups, (item) => {
    const numbered = numberedName(item.layer.name);
    return numbered === undefined ? undefined : `${item.parent ?? ''}\u0000${numbered.base}`;
  })) {
    add(members, 'name', 'name');
  }
  return clusters;
}

/**
 * Turns every layer outside `#` groups into a candidate `layer#<id>` (source pixels): leaves
 * carry their render as `mask`, groups the union of what they contain. Instances of one smart
 * object and same-named numbered groups become similarity clusters.
 */
export function buildEvidence(
  document: PsdDocument,
  stored: ReadonlyMap<number, StoredRender>,
  sourceSha256: string,
): LayerEvidence {
  const builder = new EvidenceBuilder(stored);
  const candidates = document.layers
    .map((layer) => builder.visit(layer, [], null))
    .flatMap((built) => built?.candidates ?? []);
  const clusters = clustersOf(builder.collected);
  return {
    doc: { format: 'ui-pro/candidates', version: 1, sourceSha256, candidates, clusters },
    files: builder.files,
    candidateIds: new Set(candidates.map((candidate) => candidate.id)),
  };
}
