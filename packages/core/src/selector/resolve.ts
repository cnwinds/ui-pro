import { ErrorCodes, UiProError } from '../errors';
import type { ScreenDoc, UINode } from '../schema/screen';
import { ancestorsOf, preOrder } from '../screen/tree';
import type { ComplexSelector, SelectorAttribute, SelectorList, SimpleSelector, Step } from './ast';
import { parseSelector } from './parse';
import type { NodeRef } from './ref';

/** The user's current pick in Studio, stored in `.ui-pro/selection.json`. */
export interface Selection {
  screen: string;
  ids: string[];
}

/** Everything the resolver needs from the outside world. */
export interface SelectorEnv {
  /** Screen that unqualified selectors apply to. */
  readonly currentScreen: string | undefined;
  listScreens(): readonly string[];
  /** Throws `E_SCREEN_NOT_FOUND` for an unknown screen. */
  loadScreen(name: string): ScreenDoc;
  selection(): Selection | null;
}

interface Scope {
  screen: string;
  doc: ScreenDoc;
}

function attributeValue(
  node: UINode,
  name: SelectorAttribute,
): string | readonly string[] | undefined {
  switch (name) {
    case 'id':
      return node.id;
    case 'type':
      return node.type;
    case 'role':
      return node.role;
    case 'concept':
      return node.concept;
    case 'text':
      return node.text?.content;
    case 'parent':
      return node.parent ?? undefined;
    case 'visible':
      return String(node.visible);
    case 'varies':
      return node.varies;
    case 'instanceOf':
      return node.instanceOf;
    case 'cluster':
      return node.cluster;
  }
}

function matchesAttribute(node: UINode, test: Extract<SimpleSelector, { kind: 'attribute' }>) {
  const actual = attributeValue(node, test.name);
  if (actual === undefined) return false;
  if (test.operator === 'exists') return typeof actual === 'string' || actual.length > 0;
  if (test.operator === '~=') {
    return typeof actual === 'string'
      ? actual.split(/\s+/).includes(test.value)
      : actual.includes(test.value);
  }
  const text = typeof actual === 'string' ? actual : actual.join(',');
  return test.operator === '=' ? text === test.value : text.startsWith(test.value);
}

class Resolver {
  private readonly scopes = new Map<string, Scope>();
  private readonly orders = new Map<string, string[]>();
  private readonly likeClusters = new Map<SimpleSelector, ReadonlySet<string>>();
  private selection: Selection | null | undefined;
  private readonly env: SelectorEnv;

  constructor(env: SelectorEnv) {
    this.env = env;
  }

  resolve(list: SelectorList): NodeRef[] {
    const matched = new Map<string, Set<string>>();
    for (const item of list.items) {
      for (const screen of this.screensFor(item)) {
        const scope = this.scope(screen);
        const ids = matched.get(screen) ?? new Set<string>();
        matched.set(screen, ids);
        for (const id of this.order(scope)) {
          if (this.matchesSteps(item.steps, item.steps.length - 1, scope, id)) ids.add(id);
        }
      }
    }
    const refs: NodeRef[] = [];
    for (const screen of [...matched.keys()].sort()) {
      const ids = matched.get(screen);
      for (const id of this.order(this.scope(screen))) {
        if (ids?.has(id)) refs.push({ screen, id });
      }
    }
    return refs;
  }

  private scope(screen: string): Scope {
    let scope = this.scopes.get(screen);
    if (!scope) {
      scope = { screen, doc: this.env.loadScreen(screen) };
      this.scopes.set(screen, scope);
    }
    return scope;
  }

  private order(scope: Scope): string[] {
    let order = this.orders.get(scope.screen);
    if (!order) {
      order = preOrder(scope.doc);
      this.orders.set(scope.screen, order);
    }
    return order;
  }

  private screensFor(item: ComplexSelector): readonly string[] {
    if (item.screen === '*') return this.env.listScreens();
    if (item.screen !== undefined) return [item.screen];
    if (this.env.currentScreen !== undefined) return [this.env.currentScreen];
    const available = this.env.listScreens();
    throw new UiProError(
      ErrorCodes.screenNotFound,
      '没有指定当前界面，无法解析不带界面限定的选择器',
      {
        hint: `用 --screen 指定，或写成 <screen>/#id、*/选择器；现有界面：${available.join('、') || '（无）'}`,
      },
    );
  }

  private matchesSteps(steps: readonly Step[], index: number, scope: Scope, id: string): boolean {
    const step = steps[index];
    const node = scope.doc.nodes[id];
    if (!step || !node) return false;
    if (!step.compound.tests.every((test) => this.matches(test, scope, node))) return false;
    if (index === 0) return true;
    if (step.combinator === 'child') {
      return node.parent !== null && this.matchesSteps(steps, index - 1, scope, node.parent);
    }
    return ancestorsOf(scope.doc, id).some((ancestor) =>
      this.matchesSteps(steps, index - 1, scope, ancestor),
    );
  }

  private matches(test: SimpleSelector, scope: Scope, node: UINode): boolean {
    switch (test.kind) {
      case 'type':
        return node.type === test.type;
      case 'id':
        return node.id === test.id;
      case 'attribute':
        return matchesAttribute(node, test);
      case 'selection': {
        this.selection ??= this.env.selection();
        return this.selection?.screen === scope.screen && this.selection.ids.includes(node.id);
      }
      case 'like':
        return node.cluster !== undefined && this.clustersOf(test).has(node.cluster);
    }
  }

  private clustersOf(test: Extract<SimpleSelector, { kind: 'like' }>): ReadonlySet<string> {
    const cached = this.likeClusters.get(test);
    if (cached) return cached;
    const clusters = new Set<string>();
    for (const ref of this.resolve(test.inner)) {
      const cluster = this.scope(ref.screen).doc.nodes[ref.id]?.cluster;
      if (cluster !== undefined) clusters.add(cluster);
    }
    this.likeClusters.set(test, clusters);
    return clusters;
  }
}

/**
 * Resolves a selector to qualified node refs: screens in name order, nodes in tree pre-order,
 * duplicates removed. Returns an empty list when nothing matches.
 */
export function resolveSelector(selector: string | SelectorList, env: SelectorEnv): NodeRef[] {
  const list = typeof selector === 'string' ? parseSelector(selector) : selector;
  return new Resolver(env).resolve(list);
}
