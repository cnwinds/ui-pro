import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorLines, findGodotExecutable } from '@ui-pro/adapter-godot';
import { toPosix } from '@ui-pro/core';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliIn, dataOf, treeProject, useTempDirs } from './helpers';

const godot = findGodotExecutable();
const makeDir = useTempDirs();

afterEach(() => vi.unstubAllEnvs());

interface ExportData {
  screen: string;
  target: string;
  createdProject: boolean;
  scene: string;
  nodes: number;
  created: number;
  updated: number;
  removed: string[];
  placeholders: number;
  approximateAssets: number;
  conflicts: number;
  report: string;
  timings: { importMs: number; buildMs: number; shotMs?: number };
  shot?: { file: string; width: number; height: number; meanDiff: number };
}

interface TscnNode {
  name: string;
  type: string;
  parent: string | undefined;
  body: string;
}

function parseScene(text: string): TscnNode[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith('[node '))
    .map((block) => {
      const [header = '', ...rest] = block.split(/\r?\n/);
      return {
        name: /name="([^"]*)"/.exec(header)?.[1] ?? '',
        type: /type="([^"]*)"/.exec(header)?.[1] ?? '',
        parent: /parent="([^"]*)"/.exec(header)?.[1],
        body: rest.join('\n'),
      };
    });
}

describe('ui-pro export godot without Godot', () => {
  it('asks for a target when neither --to nor export.godot.project is given', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['export', 'godot']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_GODOT_NO_TARGET');
    expect(error.message).toBe('没有指定要导出到的 Godot 工程目录');
    expect(error.hint).toContain('--to');
    expect(error.hint).toContain('export.godot.project');
  });

  it('reports E_GODOT_NOT_FOUND with the ways to set Godot, and writes nothing', async () => {
    const { dir, cli } = await treeProject(makeDir);
    vi.stubEnv('UI_PRO_GODOT', join(dir, 'no-such-godot.exe'));
    const target = join(dir, 'out');

    const { error } = await cli.fail(['export', 'godot', '--to', target]);

    expect(error.code).toBe('E_GODOT_NOT_FOUND');
    expect(error.message).toContain('UI_PRO_GODOT');
    expect(error.hint).toContain('PATH');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, 'export', 'main.godot.json'))).toBe(false);
  });

  it('resolves --to against the working directory and the configured path against the project', async () => {
    const { dir } = await treeProject(makeDir);
    const root = join(dir, '..');
    for (const folder of ['godot-out', 'elsewhere']) {
      await mkdir(join(dir, folder), { recursive: true });
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(join(dir, folder, 'notes.txt'), 'mine');
      await writeFile(join(root, folder, 'notes.txt'), 'mine');
    }
    const config = join(dir, 'ui-pro.yaml');
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace(
        'export: {}',
        'export:\n  godot:\n    project: godot-out',
      ),
    );
    const cli = cliIn(root);

    const configured = await cli.fail(['--project', 'proj', 'export', 'godot']);
    const given = await cli.fail(['--project', 'proj', 'export', 'godot', '--to', 'elsewhere']);

    expect(configured.error.code).toBe('E_GODOT_BAD_TARGET');
    expect(configured.error.message).toContain(toPosix(join(dir, 'godot-out')));
    expect(given.error.code).toBe('E_GODOT_BAD_TARGET');
    expect(given.error.message).toContain(toPosix(join(root, 'elsewhere')));
  });

  it('refuses a non-empty directory that is not a Godot project', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const target = join(dir, 'stuff');
    await mkdir(target);
    await writeFile(join(target, 'notes.txt'), 'mine');

    const { error } = await cli.fail(['export', 'godot', '--to', target]);

    expect(error.code).toBe('E_GODOT_BAD_TARGET');
    expect(error.message).toContain('不是空目录');
  });
});

describe.skipIf(godot === undefined)('ui-pro export godot with Godot', { timeout: 240_000 }, () => {
  async function loadsCleanly(target: string): Promise<void> {
    const run = spawnSync(
      godot ?? '',
      ['--headless', '--path', target, 'res://ui/main/main.tscn', '--quit'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );
    expect(errorLines(`${run.stdout}\n${run.stderr}`)).toEqual([]);
    expect(run.status).toBe(0);
  }

  it('exports the tree to a new Godot project and writes the export report', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const target = join(await makeDir(), 'godot');
    const before = dataOf<{ items: unknown[] }>(await cli.ok(['history', 'list'])).items.length;

    const envelope = await cli.ok(['export', 'godot', '--to', target]);

    const data = dataOf<ExportData>(envelope);
    expect(data).toMatchObject({
      screen: 'main',
      createdProject: true,
      scene: 'ui/main/main.tscn',
      nodes: 7,
      created: 7,
      updated: 0,
      removed: [],
      placeholders: 0,
      approximateAssets: 4,
      conflicts: 0,
      report: 'export/main.godot.json',
    });
    expect(data.timings.importMs).toBeGreaterThan(0);
    expect(data.timings.buildMs).toBeGreaterThan(0);
    expect(envelope.summary).toBe(
      `已导出界面 main 到 Godot 工程 ${toPosix(target)}：节点 7 个（新增 7、更新 0、移除 0）；新建了 Godot 工程`,
    );
    expect(envelope.warnings).toEqual([
      '4 个资产是按节点框从基准图裁出的近似图，待资产构建后替换',
      '#title：没有字号，按框高估算为 64',
    ]);
    expect(envelope.next).toEqual(['ui-pro export godot --shot  # 截图并与基准图比对']);

    const scene = parseScene(await readFile(join(target, 'ui', 'main', 'main.tscn'), 'utf8'));
    expect(scene.map((node) => [node.name, node.type, node.parent])).toEqual([
      ['Main', 'Control', undefined],
      ['Topbar', 'Control', '.'],
      ['BtnShop', 'TextureButton', 'Topbar'],
      ['BtnMail', 'TextureButton', 'Topbar'],
      ['BtnUpgrade', 'TextureButton', '.'],
      ['BadgeDot', 'TextureRect', 'BtnUpgrade'],
      ['Title', 'Label', '.'],
    ]);
    for (const node of scene) {
      expect(node.body, node.name).toMatch(/^metadata\/ui_pro_id = "[a-z_]+"$/m);
      expect(node.body, node.name).toContain('unique_name_in_owner = true');
    }
    expect(scene.find((node) => node.name === 'BtnShop')?.body).toContain('offset_left = 800.0');
    expect(scene.find((node) => node.name === 'BadgeDot')?.body).toContain('offset_left = 280.0');
    expect(scene.find((node) => node.name === 'Title')?.body).toContain('text = "标题"');
    await loadsCleanly(target);

    const report = JSON.parse(await readFile(join(dir, 'export', 'main.godot.json'), 'utf8'));
    expect(report).toMatchObject({
      format: 'ui-pro/export-report',
      engine: 'godot',
      screen: 'main',
      scene: 'ui/main/main.tscn',
      placeholders: [],
      removed: [],
      conflicts: [],
    });
    expect(report.assets).toEqual([
      { id: 'btn_shop', file: 'ui/main/assets/btn_shop.png', approximate: true },
      { id: 'btn_mail', file: 'ui/main/assets/btn_mail.png', approximate: true },
      { id: 'btn_upgrade', file: 'ui/main/assets/btn_upgrade.png', approximate: true },
      { id: 'badge_dot', file: 'ui/main/assets/badge_dot.png', approximate: true },
    ]);
    expect(report.nodes).toHaveLength(7);
    const items = dataOf<{ items: unknown[] }>(await cli.ok(['history', 'list'])).items;
    expect(items).toHaveLength(before);
  });

  it('exports again to the configured target, keeping what was added in Godot', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const target = join(dir, 'godot-out');
    const config = join(dir, 'ui-pro.yaml');
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace(
        'export: {}',
        'export:\n  godot:\n    project: godot-out',
      ),
    );
    await cli.ok(['export', 'godot']);
    const scenePath = join(target, 'ui', 'main', 'main.tscn');

    await mkdir(join(target, 'user'));
    await writeFile(join(target, 'user', 'upgrade.gd'), 'extends TextureButton\nvar level := 3\n');
    let scene = await readFile(scenePath, 'utf8');
    scene = scene.replace(
      /^(\[gd_scene[^\n]*\]\n\n)/,
      '$1[ext_resource type="Script" path="res://user/upgrade.gd" id="9_user"]\n',
    );
    scene = scene.replace(
      /(\[node name="BtnUpgrade"[^\n]*\]\n)/,
      '$1script = ExtResource("9_user")\n',
    );
    scene += '\n[node name="Notes" type="Label" parent="Topbar" unique_id=424242]\ntext = "mine"\n';
    await writeFile(scenePath, scene);

    await cli.ok(
      ['apply', '-'],
      JSON.stringify([
        { op: 'node.set', target: '#title', set: { text: { content: '新标题' } } },
        { op: 'node.remove', target: '#btn_mail' },
      ]),
    );
    const envelope = await cli.ok(['export', 'godot']);

    const data = dataOf<ExportData>(envelope);
    expect(data).toMatchObject({
      createdProject: false,
      created: 0,
      removed: ['btn_mail'],
      conflicts: 0,
    });
    expect(envelope.summary).toContain('节点 6 个（新增 0、更新 1、移除 1）');
    const updated = await readFile(scenePath, 'utf8');
    const names = parseScene(updated).map((node) => node.name);
    expect(names).not.toContain('BtnMail');
    expect(names).toContain('Notes');
    expect(updated).toContain('script = ExtResource("9_user")');
    expect(updated).toContain('text = "mine"');
    expect(updated).toContain('text = "新标题"');
    expect(updated).toContain('unique_id=424242');
    await loadsCleanly(target);
    const report = JSON.parse(await readFile(join(dir, 'export', 'main.godot.json'), 'utf8'));
    expect(report.removed).toEqual(['btn_mail']);
  });

  it('takes a screenshot of the exported scene with --shot', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const target = join(await makeDir(), 'godot');

    const envelope = await cli.ok(['export', 'godot', '--to', target, '--shot']);

    const data = dataOf<ExportData>(envelope);
    const file = toPosix(join(dir, '.ui-pro', 'look', 'main-godot.png'));
    expect(envelope.views).toEqual([file]);
    expect(data.shot).toMatchObject({ file, width: 1080, height: 1920 });
    expect(data.shot?.meanDiff).toBeGreaterThan(0);
    expect(data.shot?.meanDiff).toBeLessThan(1);
    expect(data.timings.shotMs).toBeGreaterThan(0);
    expect(envelope.next).toBeUndefined();

    const { data: pixels, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1080, 1920]);
    // btn_shop sits at (800, 20, 200x80); its stand-in asset is the reference's solid blue.
    const y = 60;
    const at = (y * info.width + 900) * info.channels;
    expect([...pixels.subarray(at, at + 3)]).toEqual([40, 90, 160]);
  });
});
