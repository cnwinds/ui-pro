import { formatIssues } from '../schema/codec';
import { NODE_ID_PATTERN } from '../schema/common';
import { type ScreenDoc, ScreenDocSchema } from '../schema/screen';
import { preOrder } from './tree';

export type ScreenProblemCode =
  | 'schema'
  | 'id-mismatch'
  | 'id-format'
  | 'root'
  | 'parent'
  | 'children'
  | 'cycle'
  | 'unreachable'
  | 'rect'
  | 'component';

export interface ScreenProblem {
  code: ScreenProblemCode;
  message: string;
  node?: string;
}

/**
 * Checks a screen document against its schema and structural invariants. Schema problems
 * short-circuit the structural checks, which assume well-typed fields.
 */
export function validateScreen(doc: ScreenDoc): ScreenProblem[] {
  const parsed = ScreenDocSchema.safeParse(doc);
  if (!parsed.success) {
    return formatIssues(parsed.error).map((message) => ({ code: 'schema', message }));
  }

  const problems: ScreenProblem[] = [];
  const add = (code: ScreenProblemCode, message: string, node?: string) =>
    problems.push({ code, message, node });

  checkRoot(doc, add);
  for (const [key, node] of Object.entries(doc.nodes)) {
    if (node.id !== key) add('id-mismatch', `节点键 ${key} 与其 id ${node.id} 不一致`, key);
    if (!NODE_ID_PATTERN.test(node.id)) add('id-format', `节点 id 格式不合法：${node.id}`, key);
    checkLinks(doc, key, add);
    const [, , w, h] = node.rect;
    if (!(w > 0 && h > 0)) add('rect', `节点 #${key} 的宽高必须大于 0（现为 ${w}×${h}）`, key);
    if (node.instanceOf !== undefined && !(node.instanceOf in doc.components)) {
      add('component', `节点 #${key} 引用了不存在的组件 ${node.instanceOf}`, key);
    }
  }
  for (const [name, component] of Object.entries(doc.components)) {
    if (component.name !== name) {
      add('component', `组件键 ${name} 与其 name ${component.name} 不一致`);
    }
    if (!(component.master in doc.nodes)) {
      add('component', `组件 ${name} 的 master #${component.master} 不存在`);
    }
  }
  checkReachability(doc, add);
  return problems;
}

type AddProblem = (code: ScreenProblemCode, message: string, node?: string) => void;

function checkRoot(doc: ScreenDoc, add: AddProblem): void {
  const root = doc.nodes[doc.root];
  if (!root) {
    add('root', `根节点 #${doc.root} 不存在`);
    return;
  }
  if (root.parent !== null) add('root', `根节点 #${doc.root} 的 parent 必须为 null`, doc.root);
  for (const [key, node] of Object.entries(doc.nodes)) {
    if (node.parent === null && key !== doc.root) {
      add('root', `节点 #${key} 的 parent 为 null，但根节点是 #${doc.root}`, key);
    }
  }
}

function checkLinks(doc: ScreenDoc, key: string, add: AddProblem): void {
  const node = doc.nodes[key];
  if (!node) return;
  if (node.parent !== null) {
    const parent = doc.nodes[node.parent];
    if (!parent) add('parent', `节点 #${key} 的父节点 #${node.parent} 不存在`, key);
    else if (!parent.children.includes(key)) {
      add('parent', `节点 #${key} 声明父节点 #${node.parent}，但父节点的 children 中没有它`, key);
    }
  }
  if (new Set(node.children).size !== node.children.length) {
    add('children', `节点 #${key} 的 children 含重复项`, key);
  }
  for (const childId of node.children) {
    const child = doc.nodes[childId];
    if (!child) add('children', `节点 #${key} 的子节点 #${childId} 不存在`, key);
    else if (child.parent !== key) {
      add(
        'children',
        `子节点 #${childId} 的 parent 是 ${child.parent ?? 'null'}，不是 #${key}`,
        key,
      );
    }
  }
}

function checkReachability(doc: ScreenDoc, add: AddProblem): void {
  const reachable = new Set(preOrder(doc));
  const limit = Object.keys(doc.nodes).length;
  for (const key of Object.keys(doc.nodes)) {
    if (reachable.has(key)) continue;
    if (isOnCycle(doc, key, limit)) add('cycle', `节点 #${key} 处于父子环路中`, key);
    else add('unreachable', `节点 #${key} 无法从根节点到达`, key);
  }
}

function isOnCycle(doc: ScreenDoc, key: string, limit: number): boolean {
  let current = doc.nodes[key]?.parent ?? null;
  for (let steps = 0; current !== null && steps <= limit; steps++) {
    if (current === key) return true;
    current = doc.nodes[current]?.parent ?? null;
  }
  return false;
}
