import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUiProError, type NewNodeFields } from '@ui-pro/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  type ExportResult,
  type ExportScreenOptions,
  errorLines,
  exportScreen,
  findGodotExecutable,
} from '../src';
import { runProcess } from '../src/runner';
import { makeDoc, parseTscnNodes, useTempDirs } from './helpers';

const godot = findGodotExecutable();
const makeDir = useTempDirs();

const SCENE = 'ui/main/main.tscn';

const baseNodes = (): NewNodeFields[] => [
  { id: 'panel', type: 'container', parent: 'root', rect: [0, 0, 1080, 400] },
  { id: 'icon', type: 'image', parent: 'panel', rect: [20, 20, 100, 100] },
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
  { id: 'btn', type: 'button', parent: 'panel', rect: [800, 20, 200, 80] },
  { id: 'bar', type: 'progress', parent: 'root', rect: [100, 500, 400, 40] },
  { id: 'list', type: 'list', parent: 'root', rect: [0, 600, 1080, 300] },
];

/** A solid-color PNG per texture node, standing in for built assets. */
const solidAssets: ExportScreenOptions['assets'] = async (node) => ({
  png: await sharp({
    create: {
      width: Math.max(1, Math.round(node.rect[2])),
      height: Math.max(1, Math.round(node.rect[3])),
      channels: 3,
      background: { r: 200, g: 80, b: 40 },
    },
  })
    .png()
    .toBuffer(),
  approximate: true,
});

async function exportTo(target: string, nodes: NewNodeFields[]): Promise<ExportResult> {
  return exportScreen({
    doc: makeDoc(nodes),
    projectName: 'demo',
    design: { width: 1080, height: 1920 },
    target,
    assets: solidAssets,
  });
}

async function sceneText(target: string): Promise<string> {
  return readFile(join(target, ...SCENE.split('/')), 'utf8');
}

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

async function loadsCleanly(target: string): Promise<void> {
  const run = await runProcess(
    godot ?? '',
    ['--headless', '--path', target, `res://${SCENE}`, '--quit'],
    { timeoutMs: 60_000 },
  );
  expect(errorLines(`${run.stdout}\n${run.stderr}`)).toEqual([]);
  expect(run.code).toBe(0);
}

describe.skipIf(godot === undefined)('exportScreen with Godot', { timeout: 180_000 }, () => {
  it('builds a scene Godot loads, with an id and a unique name on every node', async () => {
    const target = join(await makeDir(), 'godot');

    const result = await exportTo(target, baseNodes());

    const scene = await sceneText(target);
    const nodes = parseTscnNodes(scene);
    expect(nodes.map((node) => [node.name, node.type, node.parent])).toEqual([
      ['Main', 'Control', undefined],
      ['Panel', 'Control', '.'],
      ['Icon', 'TextureRect', 'Panel'],
      ['Caption', 'Label', 'Panel'],
      ['Btn', 'TextureButton', 'Panel'],
      ['Bar', 'TextureProgressBar', '.'],
      ['List', 'Control', '.'],
    ]);
    for (const node of nodes) {
      expect(node.body, node.name).toMatch(/^metadata\/ui_pro_id = "[a-z_]+"$/m);
      expect(node.body, node.name).toContain('unique_name_in_owner = true');
    }
    expect(scene).toContain('metadata/ui_pro_id = "caption"');
    expect(scene).toContain('text = "Hello"');
    expect(scene).toContain('horizontal_alignment = 1');
    await loadsCleanly(target);

    const project = await readFile(join(target, 'project.godot'), 'utf8');
    expect(project).toContain('window/size/viewport_width=1080');
    expect(result.createdProject).toBe(true);
    expect(result.report.placeholders).toEqual([{ id: 'list', type: 'list' }]);
    expect(result.report.assets).toEqual([
      { id: 'icon', file: 'ui/main/assets/icon.png', approximate: true },
      { id: 'btn', file: 'ui/main/assets/btn.png', approximate: true },
      { id: 'bar', file: 'ui/main/assets/bar.png', approximate: true },
    ]);
    expect(result.report.created).toHaveLength(7);
    expect(result.report.files).toEqual(
      expect.arrayContaining([SCENE, 'project.godot', 'addons/ui_pro/builder.gd']),
    );
    expect(result.timings.importMs).toBeGreaterThan(0);
    expect(result.timings.buildMs).toBeGreaterThan(0);
    for (const file of result.report.files) expect(existsSync(join(target, file)), file).toBe(true);
  });

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

    const result = await exportTo(
      target,
      nodes.map((node) => (node.id === 'icon' ? { ...node, nineSlice: [4, 4, 4, 4] } : node)),
    );

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
