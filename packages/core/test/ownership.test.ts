import { describe, expect, it } from 'vitest';
import {
  attachChild,
  createScreenDoc,
  expectedHoles,
  type NewNodeFields,
  newNode,
  pixelOwnership,
  type ScreenDoc,
} from '../src';

type Decisions = Record<string, string>;

function screen(): ScreenDoc {
  return createScreenDoc({
    name: 'main',
    source: {
      kind: 'flat',
      file: 'sources/main.png',
      width: 400,
      height: 400,
      sha256: 'a'.repeat(64),
    },
    scale: 1,
    size: [400, 400],
  });
}

function add(
  doc: ScreenDoc,
  fields: Omit<NewNodeFields, 'decisions'> & { decisions?: Decisions },
): void {
  const decisions = Object.fromEntries(
    Object.entries(fields.decisions ?? {}).map(([point, value]) => [point, { value, by: 'test' }]),
  );
  doc.nodes[fields.id] = newNode({ ...fields, parent: null, decisions });
  attachChild(doc, fields.parent ?? doc.root, fields.id);
}

/** Background, a button on it with a red dot and a label, and a title over the background. */
function buttonScreen(dot: Decisions, label: Decisions = { 'text.mode': 'dynamic' }): ScreenDoc {
  const doc = screen();
  add(doc, { id: 'bg', type: 'image', parent: 'root', rect: [0, 0, 400, 400] });
  add(doc, {
    id: 'btn',
    type: 'button',
    parent: 'root',
    rect: [100, 300, 200, 60],
    decisions: { 'content.split': 'baked' },
  });
  add(doc, { id: 'dot', type: 'image', parent: 'btn', rect: [290, 295, 16, 16], decisions: dot });
  add(doc, {
    id: 'label',
    type: 'text',
    parent: 'btn',
    rect: [150, 310, 100, 40],
    decisions: label,
  });
  add(doc, {
    id: 'title',
    type: 'text',
    parent: 'root',
    rect: [100, 20, 200, 50],
    text: { content: '角色' },
    decisions: { 'text.mode': 'bitmap', 'decor.merge': 'merge' },
  });
  return doc;
}

describe('pixelOwnership', () => {
  it('gives independent pixel nodes an asset and dynamic text to the engine', () => {
    const doc = buttonScreen({ 'attach.split': 'independent', 'occlusion.fill': 'fill' });

    const owned = pixelOwnership(doc);

    expect(Object.fromEntries(owned)).toEqual({
      root: { kind: 'none' },
      bg: { kind: 'asset' },
      btn: { kind: 'asset' },
      dot: { kind: 'asset' },
      label: { kind: 'text' },
      title: { kind: 'baked', host: 'bg' },
    });
  });

  it('bakes a child into its host when the child or the host says so', () => {
    const byChild = pixelOwnership(buttonScreen({ 'attach.split': 'baked' }));
    const byHost = pixelOwnership(buttonScreen({}));

    expect(byChild.get('dot')).toEqual({ kind: 'baked', host: 'btn' });
    expect(byHost.get('dot')).toEqual({ kind: 'baked', host: 'btn' });
  });

  it('keeps bitmap text with its host like any other pixels', () => {
    const owned = pixelOwnership(buttonScreen({}, { 'text.mode': 'bitmap' }));

    expect(owned.get('label')).toEqual({ kind: 'baked', host: 'btn' });
  });

  it('keeps an asset of its own when there is nothing to bake into', () => {
    const doc = screen();
    add(doc, {
      id: 'deco',
      type: 'image',
      parent: 'root',
      rect: [0, 0, 10, 10],
      decisions: { 'decor.merge': 'merge' },
    });

    expect(pixelOwnership(doc).get('deco')).toEqual({ kind: 'asset', noHost: true });
  });
});

describe('expectedHoles', () => {
  it('fills, keeps or strips by what the node above is and how it is decided', () => {
    const filled = expectedHoles(
      buttonScreen({ 'attach.split': 'independent', 'occlusion.fill': 'fill' }),
    );
    const kept = expectedHoles(
      buttonScreen({ 'attach.split': 'independent', 'occlusion.fill': 'none' }),
    );

    expect(filled.get('btn')).toEqual([
      { node: 'dot', handling: 'filled', rect: [290, 300, 10, 11] },
      { node: 'label', handling: 'stripped', rect: [150, 310, 100, 40] },
    ]);
    expect(kept.get('btn')?.[0]).toEqual({
      node: 'dot',
      handling: 'kept',
      rect: [290, 300, 10, 11],
    });
    expect(filled.get('bg')?.map((hole) => hole.node)).toEqual(['btn', 'dot', 'label']);
  });

  it('leaves no hole for what is baked into the asset or hidden', () => {
    const baked = expectedHoles(buttonScreen({ 'attach.split': 'baked' }));
    const hidden = buttonScreen({ 'attach.split': 'independent', 'occlusion.fill': 'fill' });
    const dot = hidden.nodes.dot;
    if (dot) dot.visible = false;

    expect(baked.get('btn')?.map((hole) => hole.node)).toEqual(['label']);
    expect(
      expectedHoles(hidden)
        .get('btn')
        ?.map((hole) => hole.node),
    ).toEqual(['label']);
    expect(expectedHoles(hidden).get('dot')).toEqual([]);
  });

  it('fills exclusions in every asset that covers them', () => {
    const doc = buttonScreen({ 'attach.split': 'baked' });
    doc.exclusions.push({ id: 'ex_1', rect: [0, 200, 30, 30], because: '截图带入', evidence: [] });

    const holes = expectedHoles(doc);

    expect(holes.get('bg')).toContainEqual({
      node: 'ex_1',
      handling: 'filled',
      rect: [0, 200, 30, 30],
    });
    expect(holes.get('btn')?.some((hole) => hole.node === 'ex_1')).toBe(false);
  });
});
