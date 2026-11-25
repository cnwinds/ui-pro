import { PRIMITIVES, type Primitive } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { assetFile, godotClassOf, planExport, sceneFile, wantsAsset } from '../src';
import { makeDoc, nodeAt } from './helpers';

const none = new Set<string>();

function nodeOf(plan: ReturnType<typeof planExport>, id: string) {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id} in the plan`);
  return node;
}

describe('primitive mapping', () => {
  const classOf = (type: Primitive, extra: object = {}) =>
    godotClassOf(
      nodeAt(makeDoc([{ id: 'n', type, parent: 'root', rect: [0, 0, 10, 10], ...extra }]), 'n'),
    );

  it.each([
    ['container', 'Control'],
    ['image', 'TextureRect'],
    ['text', 'Label'],
    ['button', 'TextureButton'],
    ['progress', 'TextureProgressBar'],
  ] as const)('%s becomes %s', (type, godot) => {
    expect(classOf(type)).toBe(godot);
  });

  it('uses NinePatchRect for an image with nine-slice margins', () => {
    expect(classOf('image', { nineSlice: [4, 4, 4, 4] })).toBe('NinePatchRect');
  });

  it('lists every other primitive as a Control placeholder in the plan', () => {
    const others = PRIMITIVES.filter(
      (type) => !['container', 'image', 'text', 'button', 'progress'].includes(type),
    );
    const doc = makeDoc(
      others.map((type) => ({
        id: type.replaceAll('-', '_'),
        type,
        parent: 'root',
        rect: [0, 0, 5, 5],
      })),
    );

    const plan = planExport(doc, none);

    expect(plan.placeholders.map((item) => item.type)).toEqual(others);
    expect(
      plan.planned.filter((node) => node.id !== 'root').every((node) => node.godot === 'Control'),
    ).toBe(true);
  });

  it('asks for textures only for the texture-backed classes', () => {
    const doc = makeDoc([
      { id: 'a', type: 'image', parent: 'root', rect: [0, 0, 1, 1] },
      { id: 'b', type: 'container', parent: 'root', rect: [0, 0, 1, 1] },
      { id: 'c', type: 'text', parent: 'root', rect: [0, 0, 1, 1] },
      { id: 'd', type: 'progress', parent: 'root', rect: [0, 0, 1, 1] },
    ]);

    expect(
      Object.values(doc.nodes)
        .filter(wantsAsset)
        .map((node) => node.id),
    ).toEqual(['a', 'd']);
  });
});

describe('geometry', () => {
  it('gives offsets from the parent, in design pixels', () => {
    const doc = makeDoc([
      { id: 'topbar', type: 'container', parent: 'root', rect: [100, 50, 800, 200] },
      { id: 'btn', type: 'button', parent: 'topbar', rect: [700, 70, 150, 80] },
      { id: 'dot', type: 'image', parent: 'btn', rect: [830, 60, 20, 20] },
    ]);

    const plan = planExport(doc, none);

    expect(nodeOf(plan, 'root').props.rect).toEqual([0, 0, 1080, 1920]);
    expect(nodeOf(plan, 'topbar').props.rect).toEqual([100, 50, 900, 250]);
    expect(nodeOf(plan, 'btn').props.rect).toEqual([600, 20, 750, 100]);
    expect(nodeOf(plan, 'dot').props.rect).toEqual([130, -10, 150, 10]);
  });

  it('takes node rectangles as design pixels whatever the source scale', () => {
    const doc = makeDoc([{ id: 'icon', type: 'image', parent: 'root', rect: [10, 20, 30, 40] }], {
      scale: 0.5,
      size: [540, 960],
    });

    expect(nodeOf(planExport(doc, none), 'icon').props.rect).toEqual([10, 20, 40, 60]);
  });

  it('rounds fractional design pixels to two decimals', () => {
    const doc = makeDoc([
      { id: 'icon', type: 'image', parent: 'root', rect: [10.123456, 20.5, 30.987654, 40] },
    ]);

    expect(nodeOf(planExport(doc, none), 'icon').props.rect).toEqual([10.12, 20.5, 41.11, 60.5]);
  });
});

describe('naming and identity', () => {
  it('names the root after the screen and other nodes after their ids', () => {
    const doc = makeDoc(
      [{ id: 'btn_upgrade', type: 'button', parent: 'root', rect: [0, 0, 10, 10] }],
      { name: 'character-page' },
    );

    const plan = planExport(doc, none);

    expect(plan.planned.map((node) => node.name)).toEqual(['CharacterPage', 'BtnUpgrade']);
    expect(plan.scene).toBe('ui/character_page/character_page.tscn');
  });

  it('keeps the node id on every entry and null as the root parent', () => {
    const doc = makeDoc([
      { id: 'a', type: 'container', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'b', type: 'image', parent: 'a', rect: [0, 0, 5, 5] },
    ]);

    const plan = planExport(doc, none);

    expect(plan.nodes.map((node) => [node.id, node.parent])).toEqual([
      ['root', null],
      ['a', 'root'],
      ['b', 'a'],
    ]);
  });

  it('lists parents before children and siblings back to front', () => {
    const doc = makeDoc([
      { id: 'back', type: 'container', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'front', type: 'container', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'inner', type: 'image', parent: 'back', rect: [0, 0, 5, 5] },
    ]);

    expect(planExport(doc, none).nodes.map((node) => node.id)).toEqual([
      'root',
      'back',
      'inner',
      'front',
    ]);
  });

  it('derives file paths from the screen name and node id', () => {
    expect(sceneFile('main')).toBe('ui/main/main.tscn');
    expect(assetFile('main', 'btn_shop')).toBe('ui/main/assets/btn_shop.png');
  });
});

describe('builder spec properties', () => {
  it('points a texture node at its asset, or clears the texture when it has none', () => {
    const doc = makeDoc([
      { id: 'with_asset', type: 'image', parent: 'root', rect: [0, 0, 10, 10] },
      { id: 'without', type: 'image', parent: 'root', rect: [0, 0, 10, 10] },
    ]);

    const plan = planExport(doc, new Set(['with_asset']));

    expect(nodeOf(plan, 'with_asset').props.texture).toBe('res://ui/main/assets/with_asset.png');
    expect(nodeOf(plan, 'without').props.texture).toBe('');
  });

  it('carries nine-slice margins', () => {
    const doc = makeDoc([
      {
        id: 'panel',
        type: 'image',
        parent: 'root',
        rect: [0, 0, 100, 60],
        nineSlice: [8, 6, 8, 6],
      },
    ]);

    const panel = nodeOf(planExport(doc, none), 'panel');

    expect(panel.class).toBe('NinePatchRect');
    expect(panel.props.patch_margin).toEqual([8, 6, 8, 6]);
  });

  it('passes hidden nodes on as not visible', () => {
    const doc = makeDoc([
      { id: 'hidden', type: 'container', parent: 'root', rect: [0, 0, 1, 1], visible: false },
    ]);

    expect(nodeOf(planExport(doc, none), 'hidden').props.visible).toBe(false);
  });

  it('exports the text a TextSpec gives, with explicit values for the rest', () => {
    const doc = makeDoc([
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

    const plan = planExport(doc, none);

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

  it('sets creation-only defaults that make a Godot node behave like the design', () => {
    const doc = makeDoc([
      { id: 'group', type: 'container', parent: 'root', rect: [0, 0, 1, 1] },
      { id: 'icon', type: 'image', parent: 'root', rect: [0, 0, 1, 1] },
      { id: 'btn', type: 'button', parent: 'root', rect: [0, 0, 1, 1] },
    ]);

    const plan = planExport(doc, none);

    expect(nodeOf(plan, 'group').init).toEqual({ mouse_filter: 2 });
    expect(nodeOf(plan, 'icon').init).toEqual({ expand_mode: 1, stretch_mode: 0 });
    expect(nodeOf(plan, 'btn').init).toEqual({ ignore_texture_size: true, stretch_mode: 0 });
  });

  it('serializes to JSON that survives a round trip', () => {
    const doc = makeDoc([
      { id: 'title', type: 'text', parent: 'root', rect: [1, 2, 3, 4], text: { content: 'a\nb' } },
    ]);
    const spec = {
      version: 1,
      screen: 'main',
      scene: 'res://ui/main/main.tscn',
      result: 'C:/tmp/result.json',
      nodes: planExport(doc, none).nodes,
    };

    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
});

describe('what the export cannot carry over yet', () => {
  it('reports a font name as an approximation', () => {
    const doc = makeDoc([
      {
        id: 'title',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 1, 1],
        text: { content: 'x', font: 'Alfa Slab One' },
      },
    ]);

    const [item] = planExport(doc, none).approximations;

    expect(item).toMatchObject({ id: 'title', kind: 'font' });
    expect(item?.detail).toContain('Alfa Slab One');
  });

  it('estimates a missing font size from the box height and reports it', () => {
    const doc = makeDoc([
      { id: 'title', type: 'text', parent: 'root', rect: [0, 0, 480, 80], text: { content: 'x' } },
      {
        id: 'sized',
        type: 'text',
        parent: 'root',
        rect: [0, 0, 480, 80],
        text: { content: 'x', size: 40 },
      },
    ]);

    const plan = planExport(doc, none);

    expect(nodeOf(plan, 'title').props.font_size).toBe(64);
    expect(nodeOf(plan, 'sized').props.font_size).toBe(40);
    expect(plan.approximations).toEqual([
      { id: 'title', kind: 'font-size', detail: '没有字号，按框高估算为 64' },
    ]);
  });

  it('reports the text of a button as an approximation', () => {
    const doc = makeDoc([
      { id: 'btn', type: 'button', parent: 'root', rect: [0, 0, 1, 1], text: { content: '升级' } },
    ]);

    expect(planExport(doc, none).approximations).toMatchObject([
      { id: 'btn', kind: 'button-text' },
    ]);
  });
});
