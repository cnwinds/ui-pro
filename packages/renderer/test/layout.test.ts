import {
  attachChild,
  createScreenDoc,
  newNode,
  type Primitive,
  type Rect,
  type ScreenDoc,
  type UINode,
} from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { anchorOf, layoutScreen } from '../src';

const DESIGN = { width: 400, height: 800 };

function screenWith(nodes: (Partial<UINode> & { id: string; rect: Rect; type?: Primitive })[]) {
  const doc: ScreenDoc = createScreenDoc({
    name: 'main',
    source: {
      kind: 'flat',
      file: 'source/main.png',
      width: 400,
      height: 800,
      sha256: 'a'.repeat(64),
    },
    scale: 1,
    size: [DESIGN.width, DESIGN.height],
  });
  for (const spec of nodes) {
    const node = newNode({ type: 'image', parent: 'root', ...spec });
    doc.nodes[node.id] = node;
    attachChild(doc, node.parent ?? 'root', node.id);
  }
  return doc;
}

const at = (layout: Map<string, Rect>, id: string): Rect => {
  const rect = layout.get(id);
  if (!rect) throw new Error(`no layout for ${id}`);
  return rect;
};

describe('layoutScreen', () => {
  it('gives every node its own rect at the design size, whatever its anchor', () => {
    const doc = screenWith([
      { id: 'panel', rect: [10.5, 20.25, 300.1, 400.3], anchor: { h: 'stretch', v: 'center' } },
      {
        id: 'btn',
        rect: [30.7, 40.9, 100.2, 50.6],
        parent: 'panel',
        anchor: { h: 'right', v: 'bottom' },
      },
      {
        id: 'icon',
        rect: [1.1, 2.2, 3.3, 4.4],
        parent: 'btn',
        anchor: { h: 'center', v: 'stretch' },
      },
    ]);
    const layout = layoutScreen(doc, DESIGN);
    for (const [id, node] of Object.entries(doc.nodes)) expect(at(layout, id)).toEqual(node.rect);
  });

  it('makes the root fill the viewport', () => {
    const doc = screenWith([]);
    expect(at(layoutScreen(doc, { width: 500, height: 1000 }), 'root')).toEqual([0, 0, 500, 1000]);
  });

  describe('in a wider and taller viewport (+100 x, +200 y)', () => {
    const wide = { width: 500, height: 1000 };
    const rect: Rect = [50, 100, 100, 80];
    const cases: [string, { h: string; v: string }, Rect][] = [
      ['top-left', { h: 'left', v: 'top' }, [50, 100, 100, 80]],
      ['top-right', { h: 'right', v: 'top' }, [150, 100, 100, 80]],
      ['bottom-left', { h: 'left', v: 'bottom' }, [50, 300, 100, 80]],
      ['bottom-right', { h: 'right', v: 'bottom' }, [150, 300, 100, 80]],
      ['top (centred horizontally)', { h: 'center', v: 'top' }, [100, 100, 100, 80]],
      ['left (centred vertically)', { h: 'left', v: 'center' }, [50, 200, 100, 80]],
      ['center', { h: 'center', v: 'center' }, [100, 200, 100, 80]],
      ['stretch', { h: 'stretch', v: 'stretch' }, [50, 100, 200, 280]],
      ['stretch across, top', { h: 'stretch', v: 'top' }, [50, 100, 200, 80]],
      ['bottom, stretch down', { h: 'right', v: 'stretch' }, [150, 100, 100, 280]],
    ];
    it.each(cases)('%s', (_name, anchor, expected) => {
      const doc = screenWith([{ id: 'a', rect, anchor: anchor as UINode['anchor'] }]);
      expect(at(layoutScreen(doc, wide), 'a')).toEqual(expected);
    });

    it('keeps the distance to the right and bottom edges, not to the origin', () => {
      const doc = screenWith([
        { id: 'a', rect: [300, 700, 80, 60], anchor: { h: 'right', v: 'bottom' } },
      ]);
      const [x, y, w, h] = at(layoutScreen(doc, wide), 'a');
      expect([500 - (x + w), 1000 - (y + h)]).toEqual([400 - 380, 800 - 760]);
    });
  });

  it('keeps nodes inside a narrower viewport the same way', () => {
    const doc = screenWith([
      { id: 'a', rect: [300, 700, 80, 60], anchor: { h: 'right', v: 'bottom' } },
      { id: 'b', rect: [0, 0, 400, 100], anchor: { h: 'stretch', v: 'top' } },
    ]);
    const layout = layoutScreen(doc, { width: 300, height: 700 });
    expect(at(layout, 'a')).toEqual([200, 600, 80, 60]);
    expect(at(layout, 'b')).toEqual([0, 0, 300, 100]);
  });

  it('lays children out against their parent as it has been laid out', () => {
    const doc = screenWith([
      { id: 'panel', rect: [100, 200, 200, 300], anchor: { h: 'center', v: 'center' } },
      { id: 'ok', rect: [220, 440, 60, 40], parent: 'panel', anchor: { h: 'right', v: 'bottom' } },
      {
        id: 'bg',
        rect: [100, 200, 200, 300],
        parent: 'panel',
        anchor: { h: 'stretch', v: 'stretch' },
      },
    ]);
    const layout = layoutScreen(doc, { width: 600, height: 800 });
    expect(at(layout, 'panel')).toEqual([200, 200, 200, 300]);
    expect(at(layout, 'ok')).toEqual([320, 440, 60, 40]);
    expect(at(layout, 'bg')).toEqual([200, 200, 200, 300]);

    const taller = layoutScreen(doc, { width: 400, height: 1000 });
    expect(at(taller, 'panel')).toEqual([100, 300, 200, 300]);
    expect(at(taller, 'ok')).toEqual([220, 540, 60, 40]);
  });

  it('stretches a child with its stretching parent', () => {
    const doc = screenWith([
      { id: 'panel', rect: [0, 100, 400, 200], anchor: { h: 'stretch', v: 'top' } },
      {
        id: 'inner',
        rect: [20, 20, 360, 160],
        parent: 'panel',
        anchor: { h: 'stretch', v: 'stretch' },
      },
    ]);
    const layout = layoutScreen(doc, { width: 600, height: 800 });
    expect(at(layout, 'panel')).toEqual([0, 100, 600, 200]);
    expect(at(layout, 'inner')).toEqual([20, 20, 560, 160]);
  });
});

describe('anchorOf', () => {
  const node = (extra: Partial<UINode>) =>
    newNode({ id: 'a', type: 'image', parent: 'root', rect: [0, 0, 1, 1], ...extra });

  it('prefers the explicit anchor, then the layout.anchor decision, then the top-left corner', () => {
    const decision = { 'layout.anchor': { value: 'bottom-right', by: 'x@default' } };
    expect(anchorOf(node({ anchor: { h: 'center', v: 'top' }, decisions: decision }))).toEqual({
      h: 'center',
      v: 'top',
    });
    expect(anchorOf(node({ decisions: decision }))).toEqual({ h: 'right', v: 'bottom' });
    expect(anchorOf(node({}))).toEqual({ h: 'left', v: 'top' });
  });

  it.each([
    ['top', { h: 'center', v: 'top' }],
    ['left', { h: 'left', v: 'center' }],
    ['center', { h: 'center', v: 'center' }],
    ['bottom', { h: 'center', v: 'bottom' }],
    ['stretch', { h: 'stretch', v: 'stretch' }],
  ])('reads the decision %s', (value, expected) => {
    expect(anchorOf(node({ decisions: { 'layout.anchor': { value, by: 'x@default' } } }))).toEqual(
      expected,
    );
  });
});
