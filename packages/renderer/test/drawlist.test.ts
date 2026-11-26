import {
  type AssetManifest,
  type AssetRecord,
  attachChild,
  createScreenDoc,
  newNode,
  type Primitive,
  type Rect,
  type ScreenDoc,
  type UINode,
} from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  buildDrawList,
  type DrawList,
  type ImageOp,
  type PlaceholderOp,
  type RenderOptions,
  type TextOp,
} from '../src';

type Spec = Partial<UINode> & { id: string; rect: Rect; type: Primitive };

function screenWith(specs: Spec[]): ScreenDoc {
  const doc = createScreenDoc({
    name: 'main',
    source: {
      kind: 'flat',
      file: 'source/main.png',
      width: 400,
      height: 800,
      sha256: 'a'.repeat(64),
    },
    scale: 1,
    size: [400, 800],
  });
  for (const spec of specs) {
    const node = newNode({ parent: 'root', ...spec });
    doc.nodes[node.id] = node;
    attachChild(doc, node.parent ?? 'root', node.id);
  }
  return doc;
}

function record(name: string, extra: Partial<AssetRecord> = {}): AssetRecord {
  return {
    name,
    file: `${name}.png`,
    origin: 'crop',
    uses: [{ node: name }],
    size: [100, 50],
    inset: [0, 0, 0, 0],
    holes: [],
    steps: [{ step: 'extract', method: 'crop' }],
    sha256: 'c'.repeat(64),
    approximations: [],
    ...extra,
  };
}

function manifestOf(...records: AssetRecord[]): AssetManifest {
  return {
    format: 'ui-pro/assets',
    version: 1,
    screen: 'main',
    sourceSha256: 'a'.repeat(64),
    inputsSha256: 'b'.repeat(64),
    assets: records,
  };
}

const independent = { 'attach.split': { value: 'independent', by: 'r' } };
const baked = { 'attach.split': { value: 'baked', by: 'r' } };

function list(
  doc: ScreenDoc,
  manifest: AssetManifest | null,
  options: RenderOptions = {},
  fonts: Record<string, string> = {},
): DrawList {
  return buildDrawList(doc, manifest, fonts, { mock: {}, ...options });
}

const ops = <T extends DrawList['ops'][number]>(drawn: DrawList, kind: T['kind']): T[] =>
  drawn.ops.filter((op): op is T => op.kind === kind);

describe('buildDrawList', () => {
  it('draws an independent node with its own asset, in tree order, parents before children', () => {
    const doc = screenWith([
      { id: 'panel', type: 'image', rect: [10, 20, 200, 100], asset: 'panel' },
      {
        id: 'badge',
        type: 'image',
        rect: [180, 10, 30, 30],
        parent: 'panel',
        asset: 'badge',
        decisions: independent,
      },
      { id: 'btn', type: 'button', rect: [10, 200, 100, 50], asset: 'btn' },
    ]);
    const drawn = list(doc, manifestOf(record('panel'), record('badge'), record('btn')));
    expect(drawn.ops.map((op) => op.node)).toEqual(['panel', 'badge', 'btn']);
    expect(drawn.width).toBe(400);
    expect(drawn.height).toBe(800);
    expect(ops<ImageOp>(drawn, 'image')[0]).toEqual({
      kind: 'image',
      node: 'panel',
      asset: 'panel',
      dest: [10, 20, 200, 100],
    });
    expect(drawn.warnings).toEqual([]);
  });

  it('draws children back to front in `children` order', () => {
    const doc = screenWith([
      { id: 'first', type: 'image', rect: [0, 0, 10, 10], asset: 'first' },
      { id: 'second', type: 'image', rect: [0, 0, 10, 10], asset: 'second' },
    ]);
    const drawn = list(doc, manifestOf(record('first'), record('second')));
    expect(drawn.ops.map((op) => op.node)).toEqual(['first', 'second']);
  });

  it('draws nothing for a node baked into its host, or for a container', () => {
    const doc = screenWith([
      { id: 'card', type: 'image', rect: [0, 0, 200, 200], asset: 'card' },
      { id: 'star', type: 'image', rect: [10, 10, 20, 20], parent: 'card', decisions: baked },
      { id: 'group', type: 'container', rect: [0, 300, 200, 100] },
    ]);
    const drawn = list(doc, manifestOf(record('card')));
    expect(drawn.ops.map((op) => op.node)).toEqual(['card']);
  });

  it('insets the destination by the asset record', () => {
    const doc = screenWith([
      { id: 'glow', type: 'image', rect: [100, 100, 80, 40], asset: 'glow' },
    ]);
    const drawn = list(doc, manifestOf(record('glow', { inset: [-10, -5, -10, -15] })));
    expect(ops<ImageOp>(drawn, 'image')[0]?.dest).toEqual([90, 95, 100, 60]);
  });

  it('draws dynamic text as a text op with the Godot defaults', () => {
    const doc = screenWith([
      { id: 'title', type: 'text', rect: [20, 20, 200, 50], text: { content: '糖果骑士' } },
    ]);
    const [op] = ops<TextOp>(list(doc, null), 'text');
    expect(op).toMatchObject({
      kind: 'text',
      node: 'title',
      content: '糖果骑士',
      box: [20, 20, 200, 50],
      color: '#ffffff',
      align: { h: 'center', v: 'center' },
      font: { family: 'sans-serif', size: 40 },
    });
    expect(op?.stroke).toBeUndefined();
  });

  it('takes size, colour, stroke, shadow and alignment from the text spec', () => {
    const doc = screenWith([
      {
        id: 'name',
        type: 'text',
        rect: [20, 20, 200, 50],
        text: {
          content: 'Lv.36',
          size: 22,
          color: '#ffd24a',
          stroke: { color: '#4a2a00', width: 3 },
          shadow: { color: '#00000080', offset: [0, 2], blur: 2 },
          align: { h: 'left', v: 'top' },
        },
      },
    ]);
    expect(ops<TextOp>(list(doc, null), 'text')[0]).toMatchObject({
      color: '#ffd24a',
      stroke: { color: '#4a2a00', width: 3 },
      shadow: { color: '#00000080', offset: [0, 2], blur: 2 },
      align: { h: 'left', v: 'top' },
      font: { size: 22 },
    });
  });

  it('draws bitmap text as an image, and says so for bitmap-font', () => {
    const doc = screenWith([
      {
        id: 'digits',
        type: 'text',
        rect: [0, 0, 100, 30],
        asset: 'digits',
        text: { content: '123' },
        decisions: { 'text.mode': { value: 'bitmap', by: 'r' } },
      },
      {
        id: 'fancy',
        type: 'text',
        rect: [0, 40, 100, 30],
        asset: 'fancy',
        text: { content: 'ABC' },
        decisions: { 'text.mode': { value: 'bitmap-font', by: 'r' } },
      },
    ]);
    const drawn = list(doc, manifestOf(record('digits'), record('fancy')));
    expect(ops<ImageOp>(drawn, 'image').map((op) => op.node)).toEqual(['digits', 'fancy']);
    expect(ops<TextOp>(drawn, 'text')).toEqual([]);
    expect(drawn.warnings).toEqual(['1 个位图字体文字按位图画（M1 的近似）：#fancy']);
  });

  it('skips a hidden node with its whole subtree', () => {
    const doc = screenWith([
      { id: 'popup', type: 'image', rect: [0, 0, 100, 100], asset: 'popup', visible: false },
      {
        id: 'inside',
        type: 'image',
        rect: [0, 0, 10, 10],
        parent: 'popup',
        asset: 'inside',
        decisions: independent,
      },
      { id: 'shown', type: 'image', rect: [0, 200, 10, 10], asset: 'shown' },
    ]);
    const drawn = list(doc, manifestOf(record('popup'), record('inside'), record('shown')));
    expect(drawn.ops.map((op) => op.node)).toEqual(['shown']);
  });

  it('hides what the options hide, subtree included', () => {
    const doc = screenWith([
      { id: 'panel', type: 'image', rect: [0, 0, 100, 100], asset: 'panel' },
      {
        id: 'dot',
        type: 'image',
        rect: [80, 0, 20, 20],
        parent: 'panel',
        asset: 'dot',
        decisions: independent,
      },
      { id: 'label', type: 'text', rect: [82, 2, 16, 16], parent: 'dot', text: { content: '3' } },
    ]);
    const manifest = manifestOf(record('panel'), record('dot'));
    expect(list(doc, manifest, { hidden: ['dot'] }).ops.map((op) => op.node)).toEqual(['panel']);
  });

  it('shows a hidden node when a state says it is visible, and the other way round', () => {
    const doc = screenWith([
      {
        id: 'hint',
        type: 'image',
        rect: [0, 0, 10, 10],
        asset: 'hint',
        visible: false,
        states: { on: { visible: true } },
      },
      {
        id: 'shade',
        type: 'image',
        rect: [0, 20, 10, 10],
        asset: 'shade',
        states: { off: { visible: false } },
      },
    ]);
    const manifest = manifestOf(record('hint'), record('shade'));
    expect(list(doc, manifest).ops.map((op) => op.node)).toEqual(['shade']);
    expect(
      list(doc, manifest, { states: { hint: 'on', shade: 'off' } }).ops.map((op) => op.node),
    ).toEqual(['hint']);
  });

  it('replaces asset, tint and text by a state', () => {
    const doc = screenWith([
      {
        id: 'btn',
        type: 'button',
        rect: [0, 0, 100, 50],
        asset: 'btn',
        states: { pressed: { asset: 'btn_pressed', tint: '#cccccc' } },
      },
      {
        id: 'caption',
        type: 'text',
        rect: [0, 100, 100, 30],
        text: { content: 'OK', color: '#ffffff' },
        states: { disabled: { text: { content: '--', color: '#888888' } } },
      },
    ]);
    const manifest = manifestOf(record('btn'), record('btn_pressed'));

    const normal = list(doc, manifest);
    expect(ops<ImageOp>(normal, 'image')[0]).toMatchObject({ asset: 'btn' });
    expect(ops<ImageOp>(normal, 'image')[0]?.tint).toBeUndefined();

    const states = { btn: 'pressed', caption: 'disabled' };
    const changed = list(doc, manifest, { states });
    expect(ops<ImageOp>(changed, 'image')[0]).toMatchObject({
      asset: 'btn_pressed',
      tint: '#cccccc',
    });
    expect(ops<TextOp>(changed, 'text')[0]).toMatchObject({ content: '--', color: '#888888' });
  });

  it('warns about a state the node does not have and draws the default look', () => {
    const doc = screenWith([{ id: 'btn', type: 'button', rect: [0, 0, 10, 10], asset: 'btn' }]);
    const drawn = list(doc, manifestOf(record('btn')), { states: { btn: 'pressed' } });
    expect(drawn.warnings).toEqual(['节点 #btn 没有状态 pressed，按常态画']);
    expect(drawn.ops).toHaveLength(1);
  });

  it('multiplies the node tint into the image op', () => {
    const doc = screenWith([
      { id: 'gem', type: 'image', rect: [0, 0, 20, 20], asset: 'gem', tint: '#ff6060' },
    ]);
    expect(ops<ImageOp>(list(doc, manifestOf(record('gem'))), 'image')[0]?.tint).toBe('#ff6060');
  });

  it('takes the nine-slice margins from the asset record', () => {
    const doc = screenWith([
      {
        id: 'frame',
        type: 'image',
        rect: [0, 0, 300, 100],
        asset: 'frame',
        nineSlice: [16, 16, 16, 16],
      },
    ]);
    const manifest = manifestOf(record('frame', { nineSlice: [16, 16, 16, 16], size: [48, 48] }));
    const drawn = list(doc, manifest);
    expect(ops<ImageOp>(drawn, 'image')[0]?.nineSlice).toEqual([16, 16, 16, 16]);
    expect(drawn.warnings).toEqual([]);

    const mismatch = list(
      screenWith([
        {
          id: 'frame',
          type: 'image',
          rect: [0, 0, 300, 100],
          asset: 'frame',
          nineSlice: [8, 8, 8, 8],
        },
      ]),
      manifest,
    );
    expect(mismatch.warnings).toEqual(['节点 #frame 的九宫边距与资产清单不一致，按资产清单画']);
    expect(ops<ImageOp>(mismatch, 'image')[0]?.nineSlice).toEqual([16, 16, 16, 16]);
  });

  it('stretches the whole file, and says so, when only the node has nine-slice margins', () => {
    const doc = screenWith([
      {
        id: 'frame',
        type: 'image',
        rect: [0, 0, 300, 100],
        asset: 'frame',
        nineSlice: [16, 16, 16, 16],
      },
    ]);
    const drawn = list(doc, manifestOf(record('frame')));
    expect(ops<ImageOp>(drawn, 'image')[0]?.nineSlice).toBeUndefined();
    expect(drawn.warnings).toEqual(['节点 #frame 的资产清单里没有九宫边距，整张拉伸']);
  });

  describe('placeholders', () => {
    it('draw a box and warn for a node with no asset, grouped into one line', () => {
      const doc = screenWith([
        { id: 'one', type: 'image', rect: [0, 0, 40, 40] },
        { id: 'two', type: 'button', rect: [0, 50, 40, 40] },
        { id: 'fx', type: 'anim', rect: [0, 100, 40, 40] },
        { id: 'glass', type: 'surface', rect: [0, 150, 40, 40] },
      ]);
      const drawn = list(doc, manifestOf());
      expect(ops<PlaceholderOp>(drawn, 'placeholder').map((op) => op.node)).toEqual([
        'one',
        'two',
        'fx',
        'glass',
      ]);
      expect(drawn.warnings).toEqual(['4 个节点还没有资产，画占位框：#one、#two、#fx、#glass']);
    });

    it('draw for a missing manifest, and for an asset the manifest does not list', () => {
      const doc = screenWith([{ id: 'one', type: 'image', rect: [0, 0, 40, 40], asset: 'one' }]);
      expect(ops<PlaceholderOp>(list(doc, null), 'placeholder')).toHaveLength(1);
      const drawn = list(doc, manifestOf(record('other')));
      expect(ops<PlaceholderOp>(drawn, 'placeholder')[0]?.reason).toBe('资产 one 不在资产清单里');
      expect(drawn.warnings).toEqual(['#one 用的资产 one 不在资产清单里，画占位框']);
    });

    it('list at most a few ids', () => {
      const specs: Spec[] = Array.from({ length: 9 }, (_, i) => ({
        id: `n${i}`,
        type: 'image',
        rect: [0, i * 10, 5, 5],
      }));
      const [warning] = list(screenWith(specs), null).warnings;
      expect(warning).toBe('9 个节点还没有资产，画占位框：#n0、#n1、#n2、#n3、#n4、#n5 等 9 个');
    });
  });

  describe('progress bars', () => {
    const bar = (extra: Partial<UINode> = {}, fill: Partial<UINode> = {}): Spec[] => [
      { id: 'hp', type: 'progress', rect: [10, 10, 200, 24], asset: 'slot', ...extra },
      {
        id: 'hp_fill',
        type: 'image',
        rect: [12, 12, 196, 20],
        parent: 'hp',
        asset: 'fill',
        decisions: independent,
        ...fill,
      },
    ];

    it('draws the slot, then the fill child at its own rectangle', () => {
      const drawn = list(screenWith(bar()), manifestOf(record('slot'), record('fill')));
      expect(ops<ImageOp>(drawn, 'image').map((op) => [op.node, op.dest])).toEqual([
        ['hp', [10, 10, 200, 24]],
        ['hp_fill', [12, 12, 196, 20]],
      ]);
    });

    it('draws one picture when the bar is baked', () => {
      const doc = screenWith(
        bar({ decisions: { 'content.split': { value: 'baked', by: 'r' } } }, { decisions: {} }),
      );
      const drawn = list(doc, manifestOf(record('slot')));
      expect(drawn.ops.map((op) => op.node)).toEqual(['hp']);
    });
  });

  describe('text content', () => {
    const doc = () =>
      screenWith([
        {
          id: 'gold',
          type: 'text',
          rect: [0, 0, 100, 30],
          text: { content: '0' },
          bind: { text: { path: 'hero.gold', format: '{,}' } },
          states: { rich: { text: { content: 'RICH' } } },
        },
      ]);
    const content = (options: RenderOptions & { mock?: unknown }) =>
      ops<TextOp>(buildDrawList(doc(), null, {}, { mock: {}, ...options }), 'text')[0]?.content;

    it('reads a binding from the mock data, with its format', () => {
      expect(content({ mock: { hero: { gold: 1234567 } } })).toBe('1,234,567');
    });

    it('falls back to text.content when the data has no value', () => {
      expect(content({ mock: {} })).toBe('0');
    });

    it('lets a render option replace the binding, and a state replace the option', () => {
      const mock = { hero: { gold: 5 } };
      expect(content({ mock, text: { gold: '9,999,999' } })).toBe('9,999,999');
      expect(content({ mock, text: { gold: '9,999,999' }, states: { gold: 'rich' } })).toBe('RICH');
    });

    it('shows a plain bound value as it is, and a template around it', () => {
      const bound = (format?: string) =>
        screenWith([
          {
            id: 'lv',
            type: 'text',
            rect: [0, 0, 100, 30],
            text: { content: '' },
            bind: { text: format === undefined ? { path: 'lv' } : { path: 'lv', format } },
          },
        ]);
      const shown = (format?: string) =>
        ops<TextOp>(buildDrawList(bound(format), null, {}, { mock: { lv: 36 } }), 'text')[0]
          ?.content;
      expect(shown()).toBe('36');
      expect(shown('Lv.{}')).toBe('Lv.36');
    });
  });

  describe('fonts', () => {
    const doc = () =>
      screenWith([
        { id: 'a', type: 'text', rect: [0, 0, 100, 30], text: { content: 'A', font: 'Title' } },
        { id: 'b', type: 'text', rect: [0, 40, 100, 30], text: { content: 'B', font: 'Title' } },
        { id: 'c', type: 'text', rect: [0, 80, 100, 30], text: { content: 'C' } },
      ]);

    it('names the file of a font the project maps, and warns about nothing', () => {
      const drawn = buildDrawList(
        screenWith([
          { id: 'a', type: 'text', rect: [0, 0, 100, 30], text: { content: 'A', font: 'Title' } },
        ]),
        null,
        { Title: 'resources/fonts/title.ttf' },
        { mock: {} },
      );
      expect(ops<TextOp>(drawn, 'text')[0]?.font).toEqual({
        family: 'Title',
        file: 'resources/fonts/title.ttf',
        size: 24,
      });
      expect(drawn.warnings).toEqual([]);
    });

    it('warns once per missing font, and once for text that names none', () => {
      const drawn = list(doc(), null);
      expect(drawn.warnings).toEqual([
        '字体 Title 没有对应的字体文件（项目配置 fonts），2 个文字用系统字体兜底：#a、#b',
        '1 个文字没有指定字体，用系统字体兜底：#c',
      ]);
      expect(ops<TextOp>(drawn, 'text').every((op) => op.font.file === undefined)).toBe(true);
    });
  });

  it('draws in a viewport: the layout moves the rectangles, not the asset insets', () => {
    const doc = screenWith([
      {
        id: 'btn',
        type: 'button',
        rect: [300, 700, 80, 60],
        asset: 'btn',
        anchor: { h: 'right', v: 'bottom' },
      },
    ]);
    const drawn = list(doc, manifestOf(record('btn', { inset: [-4, -4, -4, -4] })), {
      viewport: { width: 500, height: 1000 },
    });
    expect(drawn.width).toBe(500);
    expect(drawn.height).toBe(1000);
    expect(ops<ImageOp>(drawn, 'image')[0]?.dest).toEqual([396, 896, 88, 68]);
  });

  it('is pure: the same inputs give the same list and leave the document alone', () => {
    const doc = screenWith([
      { id: 'a', type: 'image', rect: [0, 0, 10, 10], asset: 'a' },
      { id: 't', type: 'text', rect: [0, 20, 50, 20], text: { content: 'x' } },
    ]);
    const before = JSON.stringify(doc);
    const manifest = manifestOf(record('a'));
    expect(list(doc, manifest)).toEqual(list(doc, manifest));
    expect(JSON.stringify(doc)).toBe(before);
  });
});
