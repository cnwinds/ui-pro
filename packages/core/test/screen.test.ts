import { describe, expect, it } from 'vitest';
import {
  attachChild,
  createScreenDoc,
  ErrorCodes,
  newNode,
  parseScreen,
  preOrder,
  type ScreenDoc,
  type ScreenProblemCode,
  serializeScreen,
  UiProError,
  validateScreen,
} from '../src';

/** root -> [a_first -> [a_child], z_last], with nodes inserted in a scrambled order. */
function sampleDoc(): ScreenDoc {
  const doc = createScreenDoc({
    name: 'main',
    source: {
      kind: 'flat',
      file: 'source/ui.png',
      width: 1080,
      height: 1920,
      sha256: 'a'.repeat(64),
    },
    scale: 1,
    size: [1080, 1920],
  });
  doc.nodes.z_last = newNode({ id: 'z_last', type: 'text', parent: null, rect: [0, 900, 100, 40] });
  doc.nodes.a_child = newNode({
    id: 'a_child',
    type: 'image',
    parent: null,
    rect: [10, 10, 20, 20],
  });
  doc.nodes.a_first = newNode({
    id: 'a_first',
    type: 'container',
    parent: null,
    rect: [0, 0, 500, 500],
  });
  attachChild(doc, 'root', 'a_first');
  attachChild(doc, 'root', 'z_last');
  attachChild(doc, 'a_first', 'a_child');
  return doc;
}

function problemCodes(doc: ScreenDoc): ScreenProblemCode[] {
  return validateScreen(doc).map((problem) => problem.code);
}

function node(doc: ScreenDoc, id: string) {
  const found = doc.nodes[id];
  if (!found) throw new Error(`fixture has no node ${id}`);
  return found;
}

describe('canonical screen serialization', () => {
  it('lists nodes in tree pre-order whatever order they were inserted in', () => {
    const doc = sampleDoc();
    expect(Object.keys(doc.nodes)).toEqual(['root', 'z_last', 'a_child', 'a_first']);

    const written = JSON.parse(serializeScreen(doc)) as { nodes: Record<string, unknown> };

    expect(Object.keys(written.nodes)).toEqual(['root', 'a_first', 'a_child', 'z_last']);
    expect(preOrder(doc)).toEqual(['root', 'a_first', 'a_child', 'z_last']);
  });

  it('is stable: serialize -> parse -> serialize yields identical text', () => {
    const text = serializeScreen(sampleDoc());

    expect(serializeScreen(parseScreen(text))).toBe(text);
  });

  it('ends with a newline and keeps short number arrays on one line', () => {
    const text = serializeScreen(sampleDoc());

    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('"rect": [0, 0, 1080, 1920]');
  });

  it('writes fields in schema order, not insertion order', () => {
    const doc = sampleDoc();
    const root = node(doc, 'root');
    // Same node, built with its properties in reverse order.
    doc.nodes.root = Object.fromEntries(Object.entries(root).reverse()) as typeof root;

    const written = JSON.parse(serializeScreen(doc)) as {
      nodes: { root: Record<string, unknown> };
    } & Record<string, unknown>;

    expect(Object.keys(written).slice(0, 5)).toEqual([
      'format',
      'version',
      'name',
      'source',
      'scale',
    ]);
    expect(Object.keys(written.nodes.root).slice(0, 4)).toEqual([
      'id',
      'type',
      'parent',
      'children',
    ]);
    expect(serializeScreen(doc)).toBe(serializeScreen(sampleDoc()));
  });

  it('sorts the keys of free-form maps', () => {
    const doc = sampleDoc();
    node(doc, 'a_first').pins = { zeta: 1, alpha: { y: 2, x: 1 } };

    const written = JSON.parse(serializeScreen(doc)) as {
      nodes: { a_first: { pins: Record<string, Record<string, number>> } };
    };

    expect(Object.keys(written.nodes.a_first.pins)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(written.nodes.a_first.pins.alpha ?? {})).toEqual(['x', 'y']);
  });

  it('omits optional fields that are undefined', () => {
    const doc = sampleDoc();
    node(doc, 'a_first').role = undefined;

    expect(serializeScreen(doc)).not.toContain('"role"');
  });

  it('rejects text that is not JSON or does not match the schema, naming the document', () => {
    const wrongVersion = serializeScreen(sampleDoc()).replace('"version": 1', '"version": 2');

    for (const text of ['{ nope', wrongVersion]) {
      let caught: unknown;
      try {
        parseScreen(text, 'screens/main/screen.uir.json');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UiProError);
      expect((caught as UiProError).code).toBe(ErrorCodes.docInvalid);
      expect((caught as UiProError).message).toContain('screens/main/screen.uir.json');
    }
  });
});

describe('validateScreen', () => {
  it('accepts a well-formed document', () => {
    expect(validateScreen(sampleDoc())).toEqual([]);
  });

  it('reports schema violations and skips the structural checks', () => {
    const doc = sampleDoc();
    (doc as { version: number }).version = 2;

    expect(problemCodes(doc)).toEqual(['schema']);
  });

  it('reports a missing root', () => {
    const doc = sampleDoc();
    doc.root = 'nope';

    expect(problemCodes(doc)).toContain('root');
  });

  it('reports a second node without a parent', () => {
    const doc = sampleDoc();
    node(doc, 'z_last').parent = null;

    expect(problemCodes(doc)).toContain('root');
  });

  it('reports a key that differs from the node id', () => {
    const doc = sampleDoc();
    node(doc, 'z_last').id = 'other';

    expect(problemCodes(doc)).toContain('id-mismatch');
  });

  it('reports ids that break the naming pattern', () => {
    const doc = sampleDoc();
    doc.nodes.BadId = newNode({ id: 'BadId', type: 'text', parent: 'root', rect: [0, 0, 1, 1] });
    node(doc, 'root').children.push('BadId');

    expect(problemCodes(doc)).toContain('id-format');
  });

  it('reports a parent link the parent does not acknowledge', () => {
    const doc = sampleDoc();
    node(doc, 'root').children = ['a_first'];

    expect(problemCodes(doc)).toContain('parent');
  });

  it('reports children that are missing, duplicated or claimed by someone else', () => {
    const missing = sampleDoc();
    node(missing, 'root').children.push('ghost');
    expect(problemCodes(missing)).toContain('children');

    const duplicated = sampleDoc();
    node(duplicated, 'root').children.push('a_first');
    expect(problemCodes(duplicated)).toContain('children');

    const stolen = sampleDoc();
    node(stolen, 'a_child').parent = 'root';
    expect(problemCodes(stolen)).toContain('children');
  });

  it('reports parent-child cycles', () => {
    const doc = sampleDoc();
    doc.nodes.loop_a = newNode({
      id: 'loop_a',
      type: 'container',
      parent: 'loop_b',
      rect: [0, 0, 1, 1],
      children: ['loop_b'],
    });
    doc.nodes.loop_b = newNode({
      id: 'loop_b',
      type: 'container',
      parent: 'loop_a',
      rect: [0, 0, 1, 1],
      children: ['loop_a'],
    });

    expect(problemCodes(doc)).toContain('cycle');
  });

  it('reports nodes the root cannot reach', () => {
    const doc = sampleDoc();
    doc.nodes.orphan = newNode({ id: 'orphan', type: 'text', parent: 'root', rect: [0, 0, 1, 1] });

    expect(problemCodes(doc)).toContain('unreachable');
  });

  it('reports non-positive rectangles', () => {
    const doc = sampleDoc();
    node(doc, 'a_child').rect = [0, 0, 0, 20];

    expect(problemCodes(doc)).toContain('rect');
  });

  it('reports dangling component references', () => {
    const doc = sampleDoc();
    node(doc, 'a_child').instanceOf = 'Missing';
    doc.components.Gone = { name: 'Gone', master: 'nowhere', props: {}, events: [] };

    const messages = validateScreen(doc)
      .filter((problem) => problem.code === 'component')
      .map((problem) => problem.message);

    expect(messages).toHaveLength(2);
  });
});
