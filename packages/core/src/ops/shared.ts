import { ErrorCodes, UiProError } from '../errors';
import { roundRect, sourceToDesign } from '../project/evidence';
import type { Rect } from '../schema/common';
import type { ScreenDoc, UINode } from '../schema/screen';
import { attachChild, freeNodeId, newNode, requireNode, unionRect } from '../screen/tree';
import { formatRef, type NodeRef } from '../selector/ref';
import type { TxContext } from '../tx/types';
import type { NodeSpec } from './node-spec';

export function invalidOp(message: string, hint?: string): UiProError {
  return new UiProError(ErrorCodes.opInvalid, message, { hint });
}

/** Resolves a selector that must match exactly one node. */
export function selectOne(ctx: TxContext, selector: string): NodeRef {
  const [ref] = ctx.select(selector, { min: 1, max: 1 });
  if (!ref) throw invalidOp(`选择器没有匹配到节点：${selector}`);
  return ref;
}

/** Applies `edit` to every node the selector matches; at least one must match. */
export function editNodes(
  ctx: TxContext,
  selector: string,
  edit: (node: UINode, ref: NodeRef) => void,
): void {
  for (const ref of ctx.select(selector, { min: 1 })) {
    edit(requireNode(ctx.screen(ref.screen), ref.id), ref);
  }
}

/** The one screen all refs belong to; ops that restructure a tree cannot span screens. */
export function singleScreen(refs: readonly NodeRef[], opName: string): string {
  const screens = new Set(refs.map((ref) => ref.screen));
  const [screen] = screens;
  if (screen === undefined || screens.size > 1) {
    throw invalidOp(`${opName} 的目标必须在同一个界面内（现为 ${[...screens].join('、')}）`);
  }
  return screen;
}

export function assertNotRoot(doc: ScreenDoc, id: string, opName: string): void {
  if (id === doc.root) throw invalidOp(`${opName} 不能作用于根节点 #${id}`);
}

/** Design-space bounding box of the candidates the evidence refs point to. */
export function rectFromEvidence(ctx: TxContext, doc: ScreenDoc, refs: readonly string[]): Rect {
  if (refs.length === 0) {
    throw invalidOp('需要 rect，或用 from / evidence 指向证据区域来推算它');
  }
  const evidence = ctx.evidence(doc.name);
  if (!evidence) {
    throw invalidOp(
      `界面 ${doc.name} 还没有证据（evidence/candidates.json），无法按证据推算 rect`,
      '先运行 ui-pro analyze，或直接给出 rect',
    );
  }
  const byId = new Map(evidence.candidates.map((candidate) => [candidate.id, candidate.bbox]));
  const boxes = refs.map((ref) => {
    const bbox = byId.get(ref);
    if (!bbox) throw invalidOp(`证据 ${ref} 不存在于界面 ${doc.name} 的 candidates.json`);
    return bbox;
  });
  return roundRect(sourceToDesign(unionRect(boxes), doc.scale));
}

export interface AddNodeInput {
  spec: NodeSpec;
  /** Evidence refs recorded on the node; also the rect source when no rect is given. */
  evidence: readonly string[];
  /** Rect that applies when `spec.rect` is absent, before falling back to evidence. */
  rect?: Rect;
  /** Parent used when `spec.parent` is absent; defaults to the current screen's root. */
  defaultParent?: NodeRef;
  /** When set, the parent must live in this screen. */
  screen?: string;
}

/** Creates a node under its parent and returns its qualified ref. */
export function addNode(ctx: TxContext, input: AddNodeInput): NodeRef {
  const { spec } = input;
  const parentRef =
    spec.parent !== undefined
      ? selectOne(ctx, spec.parent)
      : (input.defaultParent ?? defaultRootRef(ctx));
  if (input.screen !== undefined && parentRef.screen !== input.screen) {
    throw invalidOp(`新节点必须放在界面 ${input.screen} 内，而 parent 在 ${parentRef.screen}`);
  }

  const doc = ctx.screen(parentRef.screen);
  const parent = requireNode(doc, parentRef.id);
  const rect = spec.rect ?? input.rect ?? rectFromEvidence(ctx, doc, input.evidence);
  const id = spec.id ?? freeNodeId(doc, spec.type);
  if (id in doc.nodes) {
    throw new UiProError(ErrorCodes.nodeExists, `界面 ${doc.name} 已有节点 #${id}`, {
      hint: '换一个 id，或省略 id 让工具自动编号',
    });
  }
  if (spec.index !== undefined && spec.index > parent.children.length) {
    throw invalidOp(
      `index ${spec.index} 超出 #${parent.id} 的子节点数 ${parent.children.length}`,
      '省略 index 表示追加到最上层',
    );
  }

  doc.nodes[id] = newNode({
    id,
    type: spec.type,
    parent: parent.id,
    rect,
    role: spec.role,
    concept: spec.concept,
    label: spec.label,
    varies: spec.varies,
    text: spec.text,
    visible: spec.visible,
    evidence: [...input.evidence],
  });
  attachChild(doc, parent.id, id, spec.index);
  return { screen: parentRef.screen, id };
}

function defaultRootRef(ctx: TxContext): NodeRef {
  const doc = ctx.screen();
  return { screen: doc.name, id: doc.root };
}

/** Removes glossary exemplars that point at nodes which no longer exist. */
export function dropExemplars(ctx: TxContext, screen: string, ids: readonly string[]): void {
  const gone = new Set(ids.map((id) => formatRef({ screen, id })));
  for (const concept of ctx.glossary().concepts) {
    concept.exemplars = concept.exemplars.filter((ref) => !gone.has(ref));
  }
}
