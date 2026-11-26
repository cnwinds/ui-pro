import {
  type AssetManifest,
  type AssetRecord,
  type NewNodeFields,
  PRIMITIVES,
  type ScreenDoc,
} from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  ART_SUFFIX,
  anchorOf,
  assetFile,
  fontFile,
  layoutProps,
  planExport,
  sceneFile,
} from '../src';
import { makeDoc, nodeAt } from './helpers';

function nodeOf(plan: ReturnType<typeof planExport>, id: string) {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id} in the plan`);
  return node;
}

function record(name: string, extra: Partial<AssetRecord> = {}): AssetRecord {
  return {
    name,
    file: `${name}.png`,
    origin: 'crop',
    uses: [],
    size: [10, 10],
    inset: [0, 0, 0, 0],
    holes: [],
    steps: [{ step: 'extract', method: 'crop' }],
    sha256: 'a'.repeat(64),
    approximations: [],
    ...extra,
  };
}

function manifestOf(doc: ScreenDoc, ...records: AssetRecord[]): AssetManifest {
  return {
    format: 'ui-pro/assets',
    version: 1,
    screen: doc.name,
    sourceSha256: doc.source.sha256,
    inputsSha256: 'b'.repeat(64),
    assets: records,
  };
}

/** Plans a screen of the given nodes with hand-written assets. */
function planWith(nodes: NewNodeFields[], records: AssetRecord[] = [], size?: [number, number]) {
  const doc = makeDoc(nodes, size ? { size } : {});
  return { doc, plan: planExport(doc, { manifest: manifestOf(doc, ...records) }) };
}

describe('primitive mapping', () => {
  const classOf = (
    type: NewNodeFields['type'],
    extra: object = {},
    records: AssetRecord[] = [],
  ) => {
    const { plan } = planWith(
      [{ id: 'n', type, parent: 'root', rect: [0, 0, 10, 10], asset: 'n', ...extra }],
      records,
    );
    return nodeOf(plan, 'n').class;
  };

  it.each([
    ['container', 'Control'],
    ['image', 'TextureRect'],
    ['text', 'Label'],
    ['button', 'TextureButton'],
    ['progress', 'TextureProgressBar'],
  ] as const)('%s becomes %s', (type, godot) => {
    expect(classOf(type, {}, [record('n')])).toBe(godot);
  });

  it('uses NinePatchRect for an asset with nine-slice margins', () => {
    expect(classOf('image', {}, [record('n', { nineSlice: [4, 4, 4, 4] })])).toBe('NinePatchRect');
  });

  it('uses a styled Button for a button asset with nine-slice margins or an inset', () => {
    expect(classOf('button', {}, [record('n', { nineSlice: [4, 4, 4, 4] })])).toBe('Button');
    expect(classOf('button', {}, [record('n', { inset: [2, 0, 0, 0] })])).toBe('Button');
  });

  it('draws text with a bitmap-font decision as a picture', () => {
    expect(
      classOf(
        'text',
        {
          text: { content: 'x' },
          decisions: { 'text.mode': { value: 'bitmap-font', by: 'default@1' } },
        },
        [record('n')],
      ),
    ).toBe('TextureRect');
  });

  it('lists every other primitive as a Control placeholder', () => {
    const others = PRIMITIVES.filter(
      (type) => !['container', 'image', 'text', 'button', 'progress'].includes(type),
    );
    const doc = makeDoc(
      others.map((type) => ({
        id: type.replaceAll('-', '_'),
        type,
        parent: 'root',
        rect: [0, 0, 5, 5] as [number, number, number, number],
      })),
    );

    const plan = planExport(doc);

    // Containers, instances and particles are plain groups, not placeholders.
    const groups = ['instance', 'particle'];
    expect(plan.placeholders.map((item) => item.type)).toEqual(
      others.filter((type) => !groups.includes(type)),
    );
    expect(
      plan.planned.filter((node) => node.id !== 'root').every((node) => node.godot === 'Control'),
    ).toBe(true);
  });
});

describe('assets', () => {
  it('writes a shared asset once, named by the asset', () => {
    const { plan } = planWith(
      [
        { id: 'a', type: 'image', parent: 'root', rect: [0, 0, 10, 10], asset: 'dot' },
        { id: 'b', type: 'image', parent: 'root', rect: [20, 0, 10, 10], asset: 'dot' },
      ],
      [record('dot')],
    );

    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]).toMatchObject({ name: 'dot', file: 'ui/main/assets/dot.png' });
    expect(plan.assets[0]?.nodes).toEqual(['a', 'b']);
    expect(nodeOf(plan, 'a').props.texture).toBe('res://ui/main/assets/dot.png');
    expect(nodeOf(plan, 'b').props.texture).toBe('res://ui/main/assets/dot.png');
  });

  it('exports a baked node without a texture', () => {
    const { plan } = planWith(
      [
        { id: 'panel', type: 'image', parent: 'root', rect: [0, 0, 100, 100], asset: 'panel' },
        {
          id: 'decor',
          type: 'image',
          parent: 'panel',
          rect: [10, 10, 20, 20],
          asset: 'decor',
          decisions: { 'attach.split': { value: 'baked', by: 'default@1' } },
        },
      ],
      [record('panel'), record('decor')],
    );

    expect(nodeOf(plan, 'decor').class).toBe('TextureRect');
    expect(nodeOf(plan, 'decor').props.texture).toBe('');
    expect(plan.assets.map((asset) => asset.name)).toEqual(['panel']);
  });

  it('draws a text node as a Label without a texture', () => {
    const { plan } = planWith(
      [{ id: 't', type: 'text', parent: 'root', rect: [0, 0, 10, 10], text: { content: 'x' } }],
      [],
    );

    expect(nodeOf(plan, 't').class).toBe('Label');
    expect(nodeOf(plan, 't').props).not.toHaveProperty('texture');
    expect(plan.missing).toEqual([]);
  });

  it('reports a node that should draw an asset but has none', () => {
    const { plan } = planWith([
      { id: 'a', type: 'image', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'b', type: 'image', parent: 'root', rect: [0, 0, 10, 10], asset: 'gone' },
    ]);

    expect(plan.missing).toEqual([
      { id: 'a', reason: '还没有资产' },
      { id: 'b', reason: '资产 gone 不在资产清单里' },
    ]);
    expect(nodeOf(plan, 'a').props.texture).toBe('');
  });

  it('reports an asset whose file does not exist', () => {
    const doc = makeDoc([
      { id: 'a', type: 'image', parent: 'root', rect: [0, 0, 10, 10], asset: 'dot' },
    ]);

    const plan = planExport(doc, {
      manifest: manifestOf(doc, record('dot')),
      files: new Set(),
    });

    expect(plan.missing).toEqual([{ id: 'a', reason: '资产 dot 的文件不存在' }]);
    expect(plan.assets).toEqual([]);
  });

  it('carries the approximations an asset was built with, with the nodes that use it', () => {
    const { plan } = planWith(
      [
        { id: 'a', type: 'image', parent: 'root', rect: [0, 0, 10, 10], asset: 'dot' },
        { id: 'b', type: 'image', parent: 'root', rect: [20, 0, 10, 10], asset: 'dot' },
      ],
      [record('dot', { approximations: ['空洞按周围颜色补出'] })],
    );

    expect(plan.approximations).toEqual([
      { source: 'assets', kind: 'asset', detail: '空洞按周围颜色补出', nodes: ['a', 'b'] },
    ]);
  });
});

describe('placement', () => {
  it('stretches an asset over the node rectangle', () => {
    const { plan } = planWith(
      [{ id: 'a', type: 'image', parent: 'root', rect: [10, 20, 30, 40], asset: 'a' }],
      [record('a')],
    );

    expect(nodeOf(plan, 'a').props).toMatchObject({
      anchors: [0, 0, 0, 0],
      rect: [10, 20, 40, 60],
      tint: '#ffffffff',
    });
    expect(nodeOf(plan, 'a').init).toEqual({ expand_mode: 1, stretch_mode: 0 });
    expect(plan.nodes.some((node) => node.id.endsWith(ART_SUFFIX))).toBe(false);
  });

  it('draws an asset with an inset in a child that keeps the node rectangle', () => {
    const { plan } = planWith(
      [{ id: 'a', type: 'image', parent: 'root', rect: [10, 20, 30, 40], asset: 'a' }],
      [record('a', { inset: [4, 3, 2, 0] })],
    );

    const node = nodeOf(plan, 'a');
    const art = nodeOf(plan, `a${ART_SUFFIX}`);

    expect(node.class).toBe('Control');
    expect(node.props.rect).toEqual([10, 20, 40, 60]);
    expect(node.props).not.toHaveProperty('texture');
    expect(art).toMatchObject({ parent: 'a', class: 'TextureRect' });
    expect(art.props).toMatchObject({
      anchors: [0, 0, 1, 1],
      rect: [4, 3, -2, 0],
      texture: 'res://ui/main/assets/a.png',
    });
    expect(art.init).toMatchObject({ mouse_filter: 2 });
    expect(plan.planned.find((item) => item.id === 'a')?.art).toBe('AArt');
  });

  it('carries nine-slice margins of the asset', () => {
    const { plan } = planWith(
      [{ id: 'panel', type: 'image', parent: 'root', rect: [0, 0, 100, 60], asset: 'panel' }],
      [record('panel', { nineSlice: [8, 6, 8, 6] })],
    );

    expect(nodeOf(plan, 'panel').class).toBe('NinePatchRect');
    expect(nodeOf(plan, 'panel').props.patch_margin).toEqual([8, 6, 8, 6]);
  });

  it('tints with the node colour, leaving transparency alone', () => {
    const { plan } = planWith(
      [
        {
          id: 'a',
          type: 'image',
          parent: 'root',
          rect: [0, 0, 10, 10],
          asset: 'a',
          tint: '#FF8800AA',
        },
      ],
      [record('a')],
    );

    expect(nodeOf(plan, 'a').props.tint).toBe('#ff8800ff');
  });

  it('gives a button the textures of its states', () => {
    const { plan } = planWith(
      [
        {
          id: 'btn',
          type: 'button',
          parent: 'root',
          rect: [0, 0, 100, 40],
          asset: 'btn',
          states: { pressed: { asset: 'btn_down' }, hover: { asset: 'btn_hover' } },
        },
      ],
      [record('btn'), record('btn_down'), record('btn_hover')],
    );

    expect(nodeOf(plan, 'btn').class).toBe('TextureButton');
    expect(nodeOf(plan, 'btn').props).toMatchObject({
      texture: 'res://ui/main/assets/btn.png',
      texture_pressed: 'res://ui/main/assets/btn_down.png',
      texture_hover: 'res://ui/main/assets/btn_hover.png',
    });
    expect(plan.assets.map((asset) => asset.name)).toEqual(['btn', 'btn_down', 'btn_hover']);
  });

  it('styles a nine-slice button with its states, falling back to the normal look', () => {
    const { plan } = planWith(
      [
        {
          id: 'btn',
          type: 'button',
          parent: 'root',
          rect: [0, 0, 100, 40],
          asset: 'btn',
          states: { pressed: { asset: 'btn_down' } },
        },
      ],
      [
        record('btn', { nineSlice: [6, 6, 6, 6], inset: [2, 2, 2, 2] }),
        record('btn_down', { nineSlice: [6, 6, 6, 6], inset: [2, 2, 2, 2] }),
      ],
    );

    expect(nodeOf(plan, 'btn').class).toBe('Button');
    expect(nodeOf(plan, 'btn').props).toMatchObject({
      texture: 'res://ui/main/assets/btn.png',
      texture_pressed: 'res://ui/main/assets/btn_down.png',
      texture_hover: 'res://ui/main/assets/btn.png',
      texture_disabled: 'res://ui/main/assets/btn.png',
      patch_margin: [6, 6, 6, 6],
      expand: [-2, -2, -2, -2],
    });
  });

  it('says so when a button state has no asset of its own or no texture slot', () => {
    const { plan } = planWith(
      [
        {
          id: 'btn',
          type: 'button',
          parent: 'root',
          rect: [0, 0, 100, 40],
          asset: 'btn',
          states: { disabled: {}, selected: { asset: 'x' } },
        },
      ],
      [record('btn')],
    );

    expect(plan.approximations.map((item) => [item.source, item.kind])).toEqual([
      ['export', 'state'],
      ['export', 'state'],
    ]);
    expect(plan.approximations.map((item) => item.detail).join('\n')).toContain('selected');
  });

  it('draws a progress bar groove as the texture and leaves the fill to the runtime', () => {
    const { plan } = planWith(
      [{ id: 'bar', type: 'progress', parent: 'root', rect: [0, 0, 200, 20], asset: 'groove' }],
      [record('groove')],
    );

    expect(nodeOf(plan, 'bar').class).toBe('TextureProgressBar');
    expect(nodeOf(plan, 'bar').props.texture).toBe('res://ui/main/assets/groove.png');
    expect(nodeOf(plan, 'bar').init).toMatchObject({ nine_patch_stretch: true, value: 100 });
  });

  it('draws a progress bar groove with an inset in a child', () => {
    const { plan } = planWith(
      [{ id: 'bar', type: 'progress', parent: 'root', rect: [0, 0, 200, 20], asset: 'groove' }],
      [record('groove', { inset: [0, 2, 0, 2] })],
    );

    expect(nodeOf(plan, 'bar').props).not.toHaveProperty('texture');
    expect(nodeOf(plan, `bar${ART_SUFFIX}`).props.rect).toEqual([0, 2, 0, -2]);
  });

  it('samples with linear filtering, or the nearest texel for pixel art, on the root', () => {
    const doc = makeDoc([]);

    expect(nodeOf(planExport(doc), 'root').props.texture_filter).toBe(2);
    expect(nodeOf(planExport(doc, { pixelArt: true }), 'root').props.texture_filter).toBe(1);
  });
});

describe('anchors', () => {
  const parent = makeDoc([
    { id: 'p', type: 'container', parent: 'root', rect: [100, 50, 400, 300] },
  ]).nodes.p;

  const place = (anchor: object) => {
    const doc = makeDoc([
      { id: 'p', type: 'container', parent: 'root', rect: [100, 50, 400, 300] },
      { id: 'n', type: 'image', parent: 'p', rect: [120, 70, 60, 40], ...anchor },
    ]);
    return layoutProps(nodeAt(doc, 'n'), nodeAt(doc, 'p'));
  };

  it.each([
    ['top-left', { h: 'left', v: 'top' }, [0, 0, 0, 0], [20, 20, 80, 60]],
    ['top', { h: 'center', v: 'top' }, [0.5, 0, 0.5, 0], [-180, 20, -120, 60]],
    ['top-right', { h: 'right', v: 'top' }, [1, 0, 1, 0], [-380, 20, -320, 60]],
    ['left', { h: 'left', v: 'center' }, [0, 0.5, 0, 0.5], [20, -130, 80, -90]],
    ['center', { h: 'center', v: 'center' }, [0.5, 0.5, 0.5, 0.5], [-180, -130, -120, -90]],
    ['right', { h: 'right', v: 'center' }, [1, 0.5, 1, 0.5], [-380, -130, -320, -90]],
    ['bottom-left', { h: 'left', v: 'bottom' }, [0, 1, 0, 1], [20, -280, 80, -240]],
    ['bottom', { h: 'center', v: 'bottom' }, [0.5, 1, 0.5, 1], [-180, -280, -120, -240]],
    ['bottom-right', { h: 'right', v: 'bottom' }, [1, 1, 1, 1], [-380, -280, -320, -240]],
    ['stretch', { h: 'stretch', v: 'stretch' }, [0, 0, 1, 1], [20, 20, -320, -240]],
  ] as const)('%s keeps its distance to the parent', (_name, anchor, anchors, rect) => {
    expect(place({ anchor })).toEqual({ anchors, rect });
  });

  it('stretches in one direction and holds the other', () => {
    expect(place({ anchor: { h: 'stretch', v: 'bottom' } })).toEqual({
      anchors: [0, 1, 1, 1],
      rect: [20, -280, -320, -240],
    });
  });

  it('reads the layout.anchor decision when the node has no anchor of its own', () => {
    const doc = makeDoc([
      {
        id: 'n',
        type: 'image',
        parent: 'root',
        rect: [0, 0, 10, 10],
        decisions: { 'layout.anchor': { value: 'bottom-right', by: 'default@1' } },
      },
    ]);

    expect(anchorOf(nodeAt(doc, 'n'))).toEqual({ h: 'right', v: 'bottom' });
    expect(parent).toBeDefined();
  });

  it('fills the viewport with the root', () => {
    const doc = makeDoc([]);

    expect(layoutProps(nodeAt(doc, 'root'), undefined)).toEqual({
      anchors: [0, 0, 1, 1],
      rect: [0, 0, 0, 0],
    });
  });

  it('rounds fractional design pixels to two decimals', () => {
    const { plan } = planWith([
      { id: 'icon', type: 'container', parent: 'root', rect: [10.123456, 20.5, 30.987654, 40] },
    ]);

    expect(nodeOf(plan, 'icon').props.rect).toEqual([10.12, 20.5, 41.11, 60.5]);
  });
});

describe('naming and identity', () => {
  it('names the root after the screen and other nodes after their ids', () => {
    const doc = makeDoc(
      [{ id: 'btn_upgrade', type: 'button', parent: 'root', rect: [0, 0, 10, 10] }],
      { name: 'character-page' },
    );

    const plan = planExport(doc);

    expect(plan.planned.map((node) => node.name)).toEqual(['CharacterPage', 'BtnUpgrade']);
    expect(plan.scene).toBe('ui/character_page/character_page.tscn');
  });

  it('lists parents before children and siblings back to front', () => {
    const doc = makeDoc([
      { id: 'back', type: 'container', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'front', type: 'container', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'inner', type: 'image', parent: 'back', rect: [0, 0, 5, 5] },
    ]);

    expect(planExport(doc).nodes.map((node) => [node.id, node.parent])).toEqual([
      ['root', null],
      ['back', 'root'],
      ['inner', 'back'],
      ['front', 'root'],
    ]);
  });

  it('derives file paths from the screen name, asset name and font name', () => {
    expect(sceneFile('main')).toBe('ui/main/main.tscn');
    expect(assetFile('main', 'btn_shop')).toBe('ui/main/assets/btn_shop.png');
    expect(fontFile('Alfa Slab One', '.ttf')).toBe('ui/fonts/Alfa_Slab_One.ttf');
  });

  it('passes hidden nodes on as not visible', () => {
    const { plan } = planWith([
      { id: 'hidden', type: 'container', parent: 'root', rect: [0, 0, 1, 1], visible: false },
    ]);

    expect(nodeOf(plan, 'hidden').props.visible).toBe(false);
  });

  it('serializes to JSON that survives a round trip', () => {
    const { plan } = planWith(
      [
        {
          id: 'title',
          type: 'text',
          parent: 'root',
          rect: [1, 2, 3, 4],
          text: { content: 'a\nb' },
        },
      ],
      [],
    );
    const spec = {
      version: 1,
      screen: 'main',
      scene: 'res://ui/main/main.tscn',
      result: 'C:/tmp/result.json',
      nodes: plan.nodes,
    };

    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
});

describe('text', () => {
  it('exports the text a TextSpec gives, with explicit values for the rest', () => {
    const { plan } = planWith([
      {
        id: 'title',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 200, 40],
        text: {
          content: '标题',
          size: 32.4,
          color: '#FFCC00',
          stroke: { color: '#000000', width: 3 },
          shadow: { color: '#00000080', offset: [2, 3], blur: 2 },
          align: { h: 'center', v: 'bottom' },
        },
      },
      { id: 'plain', type: 'text', parent: 'root', rect: [0, 0, 100, 20], text: { content: 'x' } },
    ]);

    expect(nodeOf(plan, 'title').props).toMatchObject({
      text: '标题',
      font_size: 32,
      font_color: '#ffcc00',
      outline_size: 3,
      outline_color: '#000000',
      shadow_color: '#00000080',
      shadow_offset: [2, 3],
      shadow_size: 2,
      h_align: 'center',
      v_align: 'bottom',
    });
    expect(nodeOf(plan, 'plain').props).toMatchObject({
      text: 'x',
      h_align: 'center',
      v_align: 'center',
      font_size: 16,
      font_color: '#ffffffff',
      outline_size: 0,
      shadow_color: '#00000000',
    });
    expect(nodeOf(plan, 'plain').props).not.toHaveProperty('shadow_offset');
  });

  it('points the label at the project font and uses no approximation for it', () => {
    const doc = makeDoc([
      {
        id: 'title',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 1, 1],
        text: { content: 'x', size: 20, font: 'Alfa Slab One' },
      },
    ]);

    const plan = planExport(doc, {
      fonts: { 'Alfa Slab One': 'res://ui/fonts/Alfa_Slab_One.ttf' },
    });

    expect(nodeOf(plan, 'title').props.font).toBe('res://ui/fonts/Alfa_Slab_One.ttf');
    expect(plan.approximations).toEqual([]);
  });

  it('reports a font without a project font file as an approximation', () => {
    const { plan } = planWith([
      {
        id: 'title',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 1, 1],
        text: { content: 'x', size: 20, font: 'Alfa Slab One' },
      },
    ]);

    const [item] = plan.approximations;

    expect(item).toMatchObject({ source: 'export', kind: 'font', nodes: ['title'] });
    expect(item?.detail).toContain('Alfa Slab One');
    expect(nodeOf(plan, 'title').props).not.toHaveProperty('font');
  });

  it('estimates a missing font size from the box height and reports it', () => {
    const { plan } = planWith([
      { id: 'title', type: 'text', parent: 'root', rect: [0, 0, 480, 80], text: { content: 'x' } },
      {
        id: 'sized',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 480, 80],
        text: { content: 'x', size: 40 },
      },
    ]);

    expect(nodeOf(plan, 'title').props.font_size).toBe(64);
    expect(nodeOf(plan, 'sized').props.font_size).toBe(40);
    expect(plan.approximations).toEqual([
      {
        source: 'export',
        kind: 'font-size',
        detail: '没有字号，按框高估算为 64',
        nodes: ['title'],
      },
    ]);
  });

  it('reports the text of a button as an approximation', () => {
    const { plan } = planWith(
      [
        {
          id: 'btn',
          type: 'button',
          parent: 'root',
          rect: [0, 0, 1, 1],
          asset: 'btn',
          text: { content: '升级' },
        },
      ],
      [record('btn')],
    );

    expect(plan.approximations).toMatchObject([{ kind: 'button-text', nodes: ['btn'] }]);
  });
});
