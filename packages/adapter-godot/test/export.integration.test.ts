import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUiProError, type NewNodeFields, type ScreenDoc } from '@ui-pro/core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { layoutScreen } from '../../renderer/src/layout';
import {
  type ExportResult,
  errorLines,
  exportScreen,
  findGodotExecutable,
  locateGodot,
  takeShot,
} from '../src';
import { runProcess } from '../src/runner';
import {
  type AssetInit,
  makeDoc,
  memoryAssets,
  paintedPng,
  parseTscnNodes,
  type Rgba,
  solidPng,
  useTempDirs,
} from './helpers';

const godot = findGodotExecutable();
const makeDir = useTempDirs();

/** A directory that lives as long as the enclosing describe, for tests that share one export. */
function useSharedDir(): { readonly path: string } {
  let path = '';
  beforeAll(async () => {
    path = await mkdtemp(join(tmpdir(), 'ui-pro-godot-shared-'));
  });
  afterAll(async () => {
    await rm(path, { recursive: true, force: true });
  });
  return {
    get path() {
      return path;
    },
  };
}

const SCENE = 'ui/main/main.tscn';
const CLEAR = '#ff00ff';

const NAVY: Rgba = [20, 30, 60, 255];
const RED: Rgba = [220, 30, 30, 255];
const GREEN: Rgba = [30, 200, 60, 255];
const BLUE: Rgba = [40, 80, 230, 255];
const YELLOW: Rgba = [240, 220, 40, 255];
const ORANGE: Rgba = [250, 140, 20, 255];
const GREY: Rgba = [120, 120, 120, 255];
const PURPLE: Rgba = [140, 50, 190, 255];

async function exportDoc(
  target: string,
  doc: ScreenDoc,
  inits: AssetInit[],
  extra: Partial<Parameters<typeof exportScreen>[0]> = {},
): Promise<ExportResult> {
  return exportScreen({
    doc,
    projectName: 'demo',
    design: { width: doc.size[0], height: doc.size[1] },
    target,
    assets: await memoryAssets(doc, inits),
    ...extra,
  });
}

async function sceneText(target: string): Promise<string> {
  return readFile(join(target, ...SCENE.split('/')), 'utf8');
}

async function loadsCleanly(target: string): Promise<void> {
  const run = await runProcess(
    godot ?? '',
    ['--headless', '--path', target, `res://${SCENE}`, '--quit'],
    { timeoutMs: 60_000 },
  );
  expect(errorLines(`${run.stdout}\n${run.stderr}`)).toEqual([]);
  expect(run.code).toBe(0);
}

interface Pixels {
  width: number;
  height: number;
  at(x: number, y: number): number[];
}

async function shotAt(target: string, width: number, height: number): Promise<Pixels> {
  const out = join(target, `.shot-${width}x${height}.png`);
  await takeShot({
    install: await locateGodot(),
    project: target,
    scene: `res://${SCENE}`,
    out,
    width,
    height,
    clearColor: CLEAR,
    timeoutMs: 60_000,
  });
  return readPixels(out);
}

async function readPixels(file: string): Promise<Pixels> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)],
  };
}

const rgb = ([r, g, b]: Rgba): number[] => [r, g, b];

/** Applies `edit` to the `.tscn` block of the node named `name`. */
function editNode(text: string, name: string, edit: (block: string) => string): string {
  const blocks = text.split('\n\n');
  const index = blocks.findIndex((block) => block.startsWith(`[node name="${name}"`));
  if (index < 0) throw new Error(`no node ${name} in the scene`);
  blocks[index] = edit(blocks[index] ?? '');
  return blocks.join('\n\n');
}

function uniqueIds(text: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const match of text.matchAll(/\[node name="([^"]+)"[^\n]*unique_id=(\d+)\]/g)) {
    ids[match[1] ?? ''] = match[2] ?? '';
  }
  return ids;
}

/** 16 x 16: red corners (4 px), yellow edges, green middle. */
const nine = () =>
  paintedPng(16, 16, (x, y) => {
    const edgeX = x < 4 || x >= 12;
    const edgeY = y < 4 || y >= 12;
    if (edgeX && edgeY) return RED;
    return edgeX || edgeY ? YELLOW : GREEN;
  });

// ---------------------------------------------------------------------------------------------

describe.skipIf(godot === undefined)('a hand-built screen in Godot', { timeout: 240_000 }, () => {
  const nodes: NewNodeFields[] = [
    { id: 'bg', type: 'image', parent: 'root', rect: [0, 0, 400, 300], asset: 'bg' },
    { id: 'plain', type: 'image', parent: 'root', rect: [20, 20, 60, 40], asset: 'red' },
    {
      id: 'tinted',
      type: 'image',
      parent: 'root',
      rect: [100, 20, 60, 40],
      asset: 'white',
      tint: '#00ff00',
    },
    { id: 'trim', type: 'image', parent: 'root', rect: [180, 20, 100, 40], asset: 'trim' },
    {
      id: 'panel',
      type: 'image',
      parent: 'root',
      rect: [20, 80, 120, 80],
      asset: 'nine',
      nineSlice: [4, 4, 4, 4],
    },
    {
      id: 'btn_nine',
      type: 'button',
      parent: 'root',
      rect: [160, 80, 100, 40],
      asset: 'nine',
      nineSlice: [4, 4, 4, 4],
      states: { pressed: { asset: 'blue' } },
    },
    {
      id: 'btn_plain',
      type: 'button',
      parent: 'root',
      rect: [280, 80, 100, 40],
      asset: 'purple',
      states: { pressed: { asset: 'blue' }, disabled: {} },
    },
    { id: 'bar', type: 'progress', parent: 'root', rect: [20, 180, 200, 20], asset: 'grey' },
    { id: 'fill', type: 'image', parent: 'bar', rect: [20, 180, 100, 20], asset: 'orange' },
    { id: 'dup_a', type: 'image', parent: 'root', rect: [240, 180, 20, 20], asset: 'dot' },
    { id: 'dup_b', type: 'image', parent: 'root', rect: [270, 180, 20, 20], asset: 'dot' },
    {
      id: 'baked',
      type: 'image',
      parent: 'root',
      rect: [300, 180, 20, 20],
      decisions: { 'attach.split': { value: 'baked', by: 'default@1' } },
    },
    { id: 'slot', type: 'list', parent: 'root', rect: [0, 240, 400, 60] },
  ];

  const inits = async (): Promise<AssetInit[]> => [
    { name: 'bg', png: await solidPng(400, 300, NAVY) },
    { name: 'red', png: await solidPng(60, 40, RED) },
    { name: 'white', png: await solidPng(60, 40, [255, 255, 255, 255]) },
    { name: 'trim', png: await solidPng(60, 20, BLUE), inset: [20, 10, 20, 10] },
    { name: 'nine', png: await nine(), nineSlice: [4, 4, 4, 4] },
    { name: 'blue', png: await solidPng(100, 40, BLUE) },
    { name: 'purple', png: await solidPng(100, 40, PURPLE) },
    { name: 'grey', png: await solidPng(200, 20, GREY) },
    { name: 'orange', png: await solidPng(100, 20, ORANGE) },
    {
      name: 'dot',
      png: await solidPng(20, 20, [255, 120, 200, 255]),
      approximations: ['边缘有一圈补全的像素'],
    },
  ];

  const shared = useSharedDir();
  let target = '';
  let result: ExportResult;
  let design: Pixels;

  beforeAll(async () => {
    target = join(shared.path, 'godot');
    const reference = join(shared.path, 'reference.png');
    await writeFile(reference, await solidPng(400, 300, NAVY));
    result = await exportDoc(target, makeDoc(nodes, { size: [400, 300] }), await inits(), {
      shot: { file: join(shared.path, 'shot.png'), reference },
    });
    design = await readPixels(join(shared.path, 'shot.png'));
  }, 240_000);

  it('builds a scene Godot loads, with the class each node needs', async () => {
    const scene = parseTscnNodes(await sceneText(target));

    expect(scene.map((node) => [node.name, node.type])).toEqual([
      ['Main', 'Control'],
      ['Bg', 'TextureRect'],
      ['Plain', 'TextureRect'],
      ['Tinted', 'TextureRect'],
      ['Trim', 'Control'],
      ['TrimArt', 'TextureRect'],
      ['Panel', 'NinePatchRect'],
      ['BtnNine', 'Button'],
      ['BtnPlain', 'TextureButton'],
      ['Bar', 'TextureProgressBar'],
      ['Fill', 'TextureRect'],
      ['DupA', 'TextureRect'],
      ['DupB', 'TextureRect'],
      ['Baked', 'TextureRect'],
      ['Slot', 'Control'],
    ]);
    for (const node of scene) {
      expect(node.body, node.name).toMatch(/^metadata\/ui_pro_id = "[a-z_:]+"$/m);
      expect(node.body, node.name).toContain('unique_name_in_owner = true');
    }
    await loadsCleanly(target);
  });

  it('writes one texture per asset, none for a baked node, and a report of it', async () => {
    const { report } = result;

    expect(report.assets.map((asset) => asset.name).sort()).toEqual([
      'bg',
      'blue',
      'dot',
      'grey',
      'nine',
      'orange',
      'purple',
      'red',
      'trim',
      'white',
    ]);
    expect(report.assets.find((asset) => asset.name === 'dot')).toMatchObject({
      file: 'ui/main/assets/dot.png',
      nodes: ['dup_a', 'dup_b'],
      approximate: true,
    });
    expect(existsSync(join(target, 'ui/main/assets/dot.png'))).toBe(true);
    const scene = parseTscnNodes(await sceneText(target));
    expect(scene.find((node) => node.name === 'Baked')?.body).not.toContain('texture =');
    expect(report.placeholders).toEqual([{ id: 'slot', type: 'list' }]);
    expect(report.missingAssets).toEqual([{ id: 'slot', reason: '还没有资产' }]);
    expect(report.approximations).toContainEqual({
      source: 'assets',
      kind: 'asset',
      detail: '边缘有一圈补全的像素',
      nodes: ['dup_a', 'dup_b'],
    });
    expect(result.shot?.meanDiff).toBeGreaterThan(0);
  });

  it('draws stretched, tinted, inset and nine-slice assets where the reference renderer would', () => {
    expect(design.at(50, 40)).toEqual(rgb(RED));
    expect(design.at(130, 40)).toEqual([0, 255, 0]);
    // The asset covers [200, 30, 60, 20] of the node's [180, 20, 100, 40].
    expect(design.at(190, 40)).toEqual(rgb(NAVY));
    expect(design.at(199, 35)).toEqual(rgb(NAVY));
    expect(design.at(201, 31)).toEqual(rgb(BLUE));
    expect(design.at(259, 49)).toEqual(rgb(BLUE));
    expect(design.at(261, 40)).toEqual(rgb(NAVY));
    for (const [x, y, w, h] of [
      [20, 80, 120, 80],
      [160, 80, 100, 40],
    ] as const) {
      expect(design.at(x + 1, y + 1), 'corner').toEqual(rgb(RED));
      expect(design.at(x + 3, y + 3), 'corner is 4 px').toEqual(rgb(RED));
      expect(design.at(x + w / 2, y + 1), 'top edge').toEqual(rgb(YELLOW));
      expect(design.at(x + 1, y + h / 2), 'left edge').toEqual(rgb(YELLOW));
      expect(design.at(x + w - 1, y + h - 1), 'far corner').toEqual(rgb(RED));
      expect(design.at(x + w / 2, y + h / 2), 'middle').toEqual(rgb(GREEN));
    }
    expect(design.at(330, 100)).toEqual(rgb(PURPLE));
  });

  it('draws the progress bar full: groove first, then the fill child on top', () => {
    expect(design.at(200, 190)).toEqual(rgb(GREY));
    expect(design.at(50, 190)).toEqual(rgb(ORANGE));
    expect(design.at(119, 190)).toEqual(rgb(ORANGE));
    expect(design.at(121, 190)).toEqual(rgb(GREY));
    expect(design.at(20, 199)).toEqual(rgb(ORANGE));
  });

  it('shows a shared asset at every node that uses it, and nothing for a baked node', () => {
    expect(design.at(250, 190)).toEqual([255, 120, 200]);
    expect(design.at(280, 190)).toEqual([255, 120, 200]);
    expect(design.at(310, 190)).toEqual(rgb(NAVY));
  });

  it('gives a button its state textures', async () => {
    const scene = await sceneText(target);

    expect(editNode(scene, 'BtnPlain', (block) => block)).toContain('texture_pressed');
    expect(editNode(scene, 'BtnPlain', (block) => block)).toContain('self_modulate');
    expect(scene).toContain('StyleBoxTexture');
    expect(result.report.approximations).toContainEqual({
      source: 'export',
      kind: 'state',
      detail: '状态 disabled 没有资产，M1 不补出这个状态，按 press.feedback 由运行时处理',
      nodes: ['btn_plain'],
    });
  });

  it('shows the viewport background where nothing is drawn', () => {
    expect(design.at(10, 280)).toEqual(rgb(NAVY));
  });
});

// ---------------------------------------------------------------------------------------------

describe.skipIf(godot === undefined)('anchors in Godot', { timeout: 240_000 }, () => {
  const cell = (id: string, rect: [number, number, number, number], extra: object = {}) =>
    ({ id, type: 'image', parent: 'root', rect, asset: id, ...extra }) as NewNodeFields;
  const nodes: NewNodeFields[] = [
    cell('bg', [0, 0, 400, 300], { anchor: { h: 'stretch', v: 'stretch' } }),
    cell('body', [60, 60, 280, 180], { anchor: { h: 'stretch', v: 'stretch' } }),
    cell('inner', [270, 170, 50, 50], { parent: 'body', anchor: { h: 'right', v: 'bottom' } }),
    cell('strip', [60, 52, 100, 6], { anchor: { h: 'stretch', v: 'top' } }),
    cell('tl', [10, 10, 40, 40]),
    cell('tr', [350, 10, 40, 40], { anchor: { h: 'right', v: 'top' } }),
    cell('bl', [10, 250, 40, 40], { anchor: { h: 'left', v: 'bottom' } }),
    cell('br', [350, 250, 40, 40], {
      decisions: { 'layout.anchor': { value: 'bottom-right', by: 'default@1' } },
    }),
    cell('top', [180, 10, 40, 40], { anchor: { h: 'center', v: 'top' } }),
    cell('mid', [180, 130, 40, 40], { anchor: { h: 'center', v: 'center' } }),
    cell('bottom', [180, 250, 40, 40], { anchor: { h: 'center', v: 'bottom' } }),
    cell('left', [10, 130, 40, 40], { anchor: { h: 'left', v: 'center' } }),
    cell('right', [350, 130, 40, 40], { anchor: { h: 'right', v: 'center' } }),
  ];
  const colors: Record<string, Rgba> = {
    bg: NAVY,
    tl: RED,
    tr: GREEN,
    bl: BLUE,
    br: YELLOW,
    top: [0, 220, 220, 255],
    mid: ORANGE,
    bottom: [255, 255, 255, 255],
    left: GREY,
    right: [0, 128, 128, 255],
    body: [110, 70, 40, 255],
    inner: [160, 255, 0, 255],
    strip: [255, 0, 100, 255],
  };
  const doc = makeDoc(nodes, { size: [400, 300] });
  const shared = useSharedDir();
  let target = '';

  beforeAll(async () => {
    target = join(shared.path, 'godot');
    const inits: AssetInit[] = [];
    for (const [name, color] of Object.entries(colors)) {
      inits.push({ name, png: await solidPng(8, 8, color) });
    }
    await exportDoc(target, doc, inits);
  }, 240_000);

  it.each([
    [400, 300],
    [400, 500],
    [400, 640],
    [600, 300],
    [520, 420],
  ])('puts every node where layoutScreen puts it at %i x %i', async (width, height) => {
    const rects = layoutScreen(doc, { width, height });
    const pixels = await shotAt(target, width, height);

    expect([pixels.width, pixels.height]).toEqual([width, height]);
    for (const [id, color] of Object.entries(colors)) {
      if (id === 'bg') continue;
      const rect = rects.get(id);
      if (!rect) throw new Error(`no rectangle for ${id}`);
      const [x, y, w, h] = rect;
      // The 'mid' cell sits on the middle of the body.
      const probeY = id === 'body' ? y + 20 : y + h / 2;
      expect(pixels.at(Math.floor(x + w / 2), Math.floor(probeY)), `${id} centre`).toEqual(
        rgb(color),
      );
      expect(pixels.at(Math.floor(x + 1), Math.floor(y + 1)), `${id} first pixel`).toEqual(
        rgb(color),
      );
      expect(pixels.at(Math.floor(x + w - 2), Math.floor(y + h - 2)), `${id} last pixel`).toEqual(
        rgb(color),
      );
    }
  });

  it('keeps nodes anchored to the bottom on the bottom when the window gets taller', async () => {
    const pixels = await shotAt(target, 400, 500);

    expect(pixels.at(30, 485)).toEqual(rgb(BLUE));
    expect(pixels.at(30, 440)).toEqual(rgb(NAVY));
    expect(pixels.at(200, 485)).toEqual([255, 255, 255]);
    expect(pixels.at(370, 485)).toEqual(rgb(YELLOW));
    expect(pixels.at(30, 30)).toEqual(rgb(RED));
  });
});

// ---------------------------------------------------------------------------------------------

describe.skipIf(godot === undefined)('fonts in Godot', { timeout: 240_000 }, () => {
  const font = 'C:/Windows/Fonts/arial.ttf';

  it.skipIf(!existsSync(font))(
    'copies a project font into the Godot project and uses it',
    async () => {
      const target = join(await makeDir(), 'godot');
      const doc = makeDoc(
        [
          {
            id: 'title',
            type: 'text',
            parent: 'root',
            rect: [10, 10, 200, 40],
            text: { content: 'Hello', size: 24, font: 'Arial' },
          },
          {
            id: 'other',
            type: 'text',
            parent: 'root',
            rect: [10, 60, 200, 40],
            text: { content: 'World', size: 24, font: 'Missing Face' },
          },
        ],
        { size: [400, 300] },
      );

      const { report } = await exportDoc(target, doc, [], { fonts: { Arial: font } });

      expect(existsSync(join(target, 'ui/fonts/Arial.ttf'))).toBe(true);
      expect(report.files).toContain('ui/fonts/Arial.ttf');
      const scene = await sceneText(target);
      expect(scene).toContain('res://ui/fonts/Arial.ttf');
      expect(report.approximations).toEqual([
        {
          source: 'export',
          kind: 'font',
          detail: '字体 Missing Face 没有对应的字体文件（项目配置 fonts），文字使用 Godot 默认字体',
          nodes: ['other'],
        },
      ]);
      await loadsCleanly(target);
    },
  );
});

// ---------------------------------------------------------------------------------------------

const baseNodes = (): NewNodeFields[] => [
  { id: 'panel', type: 'container', parent: 'root', rect: [0, 0, 1080, 400] },
  { id: 'icon', type: 'image', parent: 'panel', rect: [20, 20, 100, 100], asset: 'solid' },
  {
    id: 'caption',
    type: 'text',
    parent: 'panel',
    rect: [140, 40, 300, 60],
    text: {
      content: 'Hello',
      size: 36,
      color: '#ffcc00',
      stroke: { color: '#000000', width: 2 },
      align: { h: 'center', v: 'center' },
    },
  },
  { id: 'btn', type: 'button', parent: 'panel', rect: [800, 20, 200, 80], asset: 'solid' },
  { id: 'bar', type: 'progress', parent: 'root', rect: [100, 500, 400, 40], asset: 'solid' },
  { id: 'list', type: 'list', parent: 'root', rect: [0, 600, 1080, 300] },
];

describe.skipIf(godot === undefined)('exportScreen updates in place', { timeout: 240_000 }, () => {
  const solid = async (): Promise<AssetInit[]> => [
    { name: 'solid', png: await solidPng(16, 16, [200, 80, 40, 255]) },
  ];
  const exportTo = async (target: string, list: NewNodeFields[]): Promise<ExportResult> =>
    exportDoc(target, makeDoc(list), await solid());

  it('updates the scene in place and keeps what was added in Godot', async () => {
    const target = join(await makeDir(), 'godot');
    await exportTo(target, baseNodes());
    const first = await sceneText(target);

    await mkdir(join(target, 'user'));
    await writeFile(join(target, 'user', 'caption.gd'), 'extends Label\nvar score := 42\n');
    let edited = editNode(first, 'Caption', (block) =>
      block
        .replace(/offset_left = 140\.0/, 'offset_left = 150.0')
        .replace(/\n/, '\nscript = ExtResource("9_user")\n'),
    );
    edited = editNode(edited, 'Icon', (block) =>
      block.replace(/\n/, '\nmodulate = Color(1, 0, 0, 1)\n'),
    );
    edited = edited.replace(
      /^(\[gd_scene[^\n]*\]\n\n)/,
      '$1[ext_resource type="Script" path="res://user/caption.gd" id="9_user"]\n',
    );
    edited += '\n[node name="Notes" type="Label" parent="Panel" unique_id=424242]\ntext = "mine"\n';
    await writeFile(join(target, ...SCENE.split('/')), edited);

    const changed = baseNodes()
      .filter((node) => node.id !== 'bar')
      .map((node): NewNodeFields => {
        if (node.id === 'icon') return { ...node, rect: [30, 30, 100, 100] };
        if (node.id === 'caption' && node.text) {
          return { ...node, rect: [160, 40, 300, 60], text: { ...node.text, content: 'Bye' } };
        }
        return node;
      });
    changed.push({ id: 'extra', type: 'container', parent: 'root', rect: [0, 1000, 50, 50] });
    const result = await exportTo(target, changed);

    const scene = await sceneText(target);
    const names = parseTscnNodes(scene).map((node) => node.name);
    expect(names).toContain('Notes');
    expect(names).toContain('Extra');
    expect(names).not.toContain('Bar');
    expect(scene).toContain('script = ExtResource("9_user")');
    expect(scene).toContain('text = "mine"');
    expect(scene).toContain('text = "Bye"');
    expect(editNode(scene, 'Icon', (block) => block)).toContain('modulate = Color(1, 0, 0, 1)');
    expect(editNode(scene, 'Icon', (block) => block)).toContain('offset_left = 30.0');
    expect(editNode(scene, 'Caption', (block) => block)).toContain('offset_left = 150.0');
    expect(uniqueIds(scene).Panel).toBe(uniqueIds(first).Panel);
    expect(uniqueIds(scene).Icon).toBe(uniqueIds(first).Icon);
    expect(uniqueIds(scene).Notes).toBe('424242');
    await loadsCleanly(target);

    expect(result.report.removed).toEqual(['bar']);
    expect(result.report.created).toEqual(['extra']);
    expect(result.report.updated).toEqual([
      { id: 'icon', keys: ['rect'] },
      { id: 'caption', keys: ['text'] },
    ]);
    expect(result.report.conflicts).toMatchObject([
      {
        id: 'caption',
        key: 'rect',
        code: 'both_changed',
        scene: [150, 40, 440, 100],
        design: [160, 40, 460, 100],
      },
    ]);
    expect(result.report.conflicts[0]?.message).toContain('保留了场景里的值');
  });

  it('leaves the scene file untouched when nothing changed', async () => {
    const target = join(await makeDir(), 'godot');
    await exportTo(target, baseNodes());
    const first = await sceneText(target);

    const result = await exportTo(target, baseNodes());

    expect(await sceneText(target)).toBe(first);
    expect(result.report.created).toEqual([]);
    expect(result.report.updated).toEqual([]);
    expect(result.report.removed).toEqual([]);
    expect(result.report.conflicts).toEqual([]);
  });

  it('keeps a node that the screen dropped but that has a script or user children', async () => {
    const target = join(await makeDir(), 'godot');
    await exportTo(target, baseNodes());
    await mkdir(join(target, 'user'));
    await writeFile(join(target, 'user', 'btn.gd'), 'extends TextureButton\n');
    let edited = editNode(await sceneText(target), 'Btn', (block) =>
      block.replace(/\n/, '\nscript = ExtResource("9_user")\n'),
    );
    edited = edited.replace(
      /^(\[gd_scene[^\n]*\]\n\n)/,
      '$1[ext_resource type="Script" path="res://user/btn.gd" id="9_user"]\n',
    );
    edited += '\n[node name="Mine" type="Label" parent="Bar" unique_id=777]\n';
    await writeFile(join(target, ...SCENE.split('/')), edited);

    const result = await exportTo(
      target,
      baseNodes().filter((node) => node.id !== 'btn' && node.id !== 'bar'),
    );

    const names = parseTscnNodes(await sceneText(target)).map((node) => node.name);
    expect(names).toContain('Btn');
    expect(names).toContain('Bar');
    expect(names).toContain('Mine');
    expect(result.report.removed).toEqual([]);
    expect(result.report.conflicts.map((conflict) => [conflict.id, conflict.code])).toEqual([
      ['btn', 'removal_has_script'],
      ['bar', 'removal_has_user_nodes'],
    ]);
    await loadsCleanly(target);
  });

  it('replaces a node whose Godot class changed and keeps its children and name', async () => {
    const target = join(await makeDir(), 'godot');
    const nodes = baseNodes();
    nodes.push({ id: 'inner', type: 'image', parent: 'icon', rect: [30, 30, 10, 10] });
    await exportTo(target, nodes);

    const result = await exportDoc(target, makeDoc(nodes), [
      { name: 'solid', png: await solidPng(16, 16, [200, 80, 40, 255]), nineSlice: [4, 4, 4, 4] },
    ]);

    const scene = await sceneText(target);
    const icon = parseTscnNodes(scene).find((node) => node.name === 'Icon');
    expect(icon?.type).toBe('NinePatchRect');
    expect(icon?.body).toContain('patch_margin_left = 4');
    expect(icon?.body).toContain('texture = ExtResource');
    expect(icon?.body).toContain('unique_name_in_owner = true');
    expect(parseTscnNodes(scene).find((node) => node.name === 'Inner')?.parent).toBe('Panel/Icon');
    expect(result.report.conflicts).toEqual([]);
    await loadsCleanly(target);
  });

  it('moves a node when the screen moved it to another parent', async () => {
    const target = join(await makeDir(), 'godot');
    await exportTo(target, baseNodes());

    const moved = baseNodes().map((node) =>
      node.id === 'btn' ? { ...node, parent: 'root' } : node,
    );
    const result = await exportTo(target, moved);

    const btn = parseTscnNodes(await sceneText(target)).find((node) => node.name === 'Btn');
    expect(btn?.parent).toBe('.');
    expect(result.report.updated).toEqual([{ id: 'btn', keys: ['parent'] }]);
    await loadsCleanly(target);
  });

  it('refuses to overwrite a scene that was not exported by ui-pro', async () => {
    const target = join(await makeDir(), 'godot');
    await exportTo(target, baseNodes());
    const scenePath = join(target, ...SCENE.split('/'));
    await writeFile(scenePath, '[gd_scene format=3]\n\n[node name="Mine" type="Control"]\n');

    let code: string | undefined;
    let message = '';
    try {
      await exportTo(target, baseNodes());
    } catch (error) {
      if (isUiProError(error)) {
        code = error.code;
        message = error.message;
      }
    }

    expect(code).toBe('E_GODOT_BUILD');
    expect(message).toContain('不是 ui-pro 导出的');
    expect(await readFile(scenePath, 'utf8')).toContain('name="Mine"');
  });

  it('refuses a directory that is not a Godot project before writing anything', async () => {
    const target = await makeDir();
    await writeFile(join(target, 'notes.txt'), 'mine');

    let code: string | undefined;
    try {
      await exportTo(target, baseNodes());
    } catch (error) {
      if (isUiProError(error)) code = error.code;
    }

    expect(code).toBe('E_GODOT_BAD_TARGET');
    expect(existsSync(join(target, 'ui'))).toBe(false);
  });
});
