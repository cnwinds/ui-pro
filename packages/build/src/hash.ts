import {
  type CandidatesDoc,
  loadScreen,
  type Project,
  readCandidates,
  type ScreenDoc,
  sha256Hex,
  type UINode,
} from '@ui-pro/core';

/** Bumped when a change to the build makes the same inputs give different assets. */
export const ALGORITHM_VERSION = 1;

/** The decision `asset.assign` can indirectly change (see `buildInputsSha256`). */
const EXCLUDED_DECISION = 'atlas.group';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function nodeInputs(node: UINode): unknown {
  const states =
    node.states === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(node.states).map(([name, state]) => {
            const { asset: _built, ...rest } = state;
            return [name, rest];
          }),
        );
  return {
    id: node.id,
    type: node.type,
    role: node.role,
    parent: node.parent,
    children: node.children,
    rect: node.rect,
    visible: node.visible,
    cluster: node.cluster,
    instanceOf: node.instanceOf,
    evidence: node.evidence,
    states,
    decisions: Object.fromEntries(
      Object.entries(node.decisions)
        .filter(([point]) => point !== EXCLUDED_DECISION)
        .map(([point, decision]) => [point, decision.value]),
    ),
  };
}

export function inputsHash(
  project: Project,
  doc: ScreenDoc,
  evidence: CandidatesDoc | null,
): string {
  return sha256Hex(
    JSON.stringify(
      stable({
        algorithm: ALGORITHM_VERSION,
        source: doc.source.sha256,
        scale: doc.scale,
        size: doc.size,
        design: project.config.design,
        exclusions: doc.exclusions.map((exclusion) => ({ id: exclusion.id, rect: exclusion.rect })),
        evidence,
        nodes: Object.fromEntries(
          Object.values(doc.nodes).map((node) => [node.id, nodeInputs(node)]),
        ),
      }),
    ),
  );
}

/**
 * Hash of everything the build of `screen` reads (DESIGN §6.5), stored in the manifest as
 * `inputsSha256`; a different current value means the assets are stale.
 *
 * Included: the source file's hash, the design size and the screen's scale and size, the
 * exclusions' ids and rects, the evidence document (candidates, clusters, layer data), the build
 * algorithm's version, and for every node its id, type, role, place in the tree, rect, visibility,
 * cluster, component, evidence refs, the states it declares (without the asset names the build
 * wrote into them) and all its decisions.
 *
 * Not included: what `asset.assign` writes (`asset`, `tint`, `nineSlice`, `states.*.asset` and the
 * text style fields filled from measurements), text content, bindings, anchors, pins and other
 * fields no asset depends on, the `atlas.group` decision (the rule that makes it `shared` looks at
 * asset names shared across screens, which `asset.assign` itself changes, so it would never
 * settle), and the quality of the build (a draft and a final differ in file content, not in
 * inputs).
 */
export function buildInputsSha256(project: Project, screen: string): string {
  return inputsHash(project, loadScreen(project, screen), readCandidates(project, screen));
}
