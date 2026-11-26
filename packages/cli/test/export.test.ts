import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorLines, findGodotExecutable } from '@ui-pro/adapter-godot';
import { loadScreen, screenRelPath, serializeScreen, toPosix } from '@ui-pro/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gradient, NAVY, type Rgba, scene, solidPng, useTempDirs } from '../../verify/test/helpers';
import { registerPlugins } from '../src/plugins';
import { cliIn, dataOf } from './helpers';

const godot = findGodotExecutable();
const makeDir = useTempDirs();

// Fixtures committed after this carry their rule decisions, as a CLI commit would.
registerPlugins();

afterEach(() => vi.unstubAllEnvs());

interface ExportData {
  screen: string;
  target: string;
  createdProject: boolean;
  scene: string;
  nodes: number;
  assets: number;
  created: number;
  updated: number;
  removed: string[];
  placeholders: number;
  missingAssets: number;
  approximations: number;
  nodeExceptions: number;
  cloudImageCalls: number;
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

/** A built 200 x 120 screen: background, a gradient button, a list slot and an empty group. */
async function builtScreen() {
  const reference = (x: number, y: number): Rgba => {
    if (x >= 20 && x < 100 && y >= 20 && y < 60) return gradient(x - 20, 80);
    if (x >= 20 && x < 80 && y >= 70 && y < 100) return [0, 160, 0, 255];
    return NAVY;
  };
  const fixture = await scene(makeDir, {
    reference,
    backgroundHoles: [
      { node: 'btn', handling: 'kept', region: [20, 20, 80, 40] },
      { node: 'slot', handling: 'kept', region: [20, 70, 60, 30] },
    ],
    nodes: [
      { id: 'group', type: 'container', rect: [10, 10, 50, 50] },
      { id: 'slot', type: 'list', rect: [20, 70, 60, 30], asset: 'slot' },
    ],
    assets: [{ name: 'slot', png: await solidPng(60, 30, [0, 160, 0, 255]) }],
  });
  return { ...fixture, dir: fixture.project.root, cli: cliIn(fixture.project.root) };
}

/** The same, with the gates run and passed. */
async function verifiedScreen(targetFolder?: string) {
  const built = await builtScreen();
  // The config is one of the verified inputs, so it is settled before the gates run.
  if (targetFolder !== undefined) await configureTarget(built.dir, targetFolder);
  const run = await built.cli.ok(['verify']);
  const gates = dataOf<{ ok: boolean; gates: { id: string; problems: unknown[] }[] }>(run);
  expect(gates.ok, JSON.stringify(gates.gates.map((gate) => gate.problems))).toBe(true);
  return built;
}

async function configureTarget(dir: string, folder: string): Promise<void> {
  const config = join(dir, 'ui-pro.yaml');
  await writeFile(
    config,
    (await readFile(config, 'utf8')).replace(
      'export: {}',
      `export:\n  godot:\n    project: ${folder}`,
    ),
  );
}

describe('ui-pro export godot refuses a screen that was not verified', () => {
  it('has never been verified', async () => {
    const { dir, cli } = await builtScreen();
    const target = join(dir, 'out');

    const { code, error } = await cli.fail(['export', 'godot', '--to', target]);

    expect(code).toBe(1);
    expect(error.code).toBe('E_NOT_VERIFIED');
    expect(error.message).toContain('还没有跑过质量门禁');
    expect(error.hint).toContain('ui-pro verify');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, 'export', 'main.godot.json'))).toBe(false);
  });

  it('failed the gates the last time', async () => {
    const { dir, project, cli } = await builtScreen();
    // The button's decisions are gone: the rules gate finds them missing.
    const doc = loadScreen(project, 'main');
    const btn = doc.nodes.btn;
    if (btn) btn.decisions = {};
    await writeFile(join(dir, ...screenRelPath('main', 'doc').split('/')), serializeScreen(doc));
    const run = await cli.ok(['verify']);
    expect(dataOf<{ ok: boolean }>(run).ok).toBe(false);

    const { error } = await cli.fail(['export', 'godot', '--to', join(dir, 'out')]);

    expect(error.code).toBe('E_NOT_VERIFIED');
    expect(error.message).toContain('没有通过');
    expect(error.message).toContain('规则一致');
  });

  it('was changed after it passed', async () => {
    const { dir, cli } = await verifiedScreen();
    await cli.ok(
      ['apply', '-'],
      JSON.stringify([{ op: 'node.set', target: '#group', set: { rect: [12, 10, 50, 50] } }]),
    );

    const { error } = await cli.fail(['export', 'godot', '--to', join(dir, 'out')]);

    expect(error.code).toBe('E_NOT_VERIFIED');
    expect(error.message).toContain('又改过');
  });
});

describe('ui-pro export godot without Godot', () => {
  it('asks for a target when neither --to nor export.godot.project is given', async () => {
    const { cli } = await verifiedScreen();

    const { code, error } = await cli.fail(['export', 'godot']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_GODOT_NO_TARGET');
    expect(error.message).toBe('没有指定要导出到的 Godot 工程目录');
    expect(error.hint).toContain('--to');
    expect(error.hint).toContain('export.godot.project');
  });

  it('reports E_GODOT_NOT_FOUND with the ways to set Godot, and writes nothing', async () => {
    const { dir, cli } = await verifiedScreen();
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
    const { dir } = await verifiedScreen('godot-out');
    const root = join(dir, '..');
    for (const folder of ['godot-out', 'elsewhere']) {
      await mkdir(join(dir, folder), { recursive: true });
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(join(dir, folder, 'notes.txt'), 'mine');
      await writeFile(join(root, folder, 'notes.txt'), 'mine');
    }
    const cli = cliIn(root);

    const configured = await cli.fail(['--project', 'proj', 'export', 'godot']);
    const given = await cli.fail(['--project', 'proj', 'export', 'godot', '--to', 'elsewhere']);

    expect(configured.error.code).toBe('E_GODOT_BAD_TARGET');
    expect(configured.error.message).toContain(toPosix(join(dir, 'godot-out')));
    expect(given.error.code).toBe('E_GODOT_BAD_TARGET');
    expect(given.error.message).toContain(toPosix(join(root, 'elsewhere')));
  });

  it('refuses a non-empty directory that is not a Godot project', async () => {
    const { dir, cli } = await verifiedScreen();
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

  it('exports to a new Godot project and writes the export report', async () => {
    const built = await builtScreen();
    const { dir, cli } = built;
    await cli.ok(
      ['apply', '-'],
      JSON.stringify([
        {
          op: 'exception.add',
          target: '#btn',
          point: 'press.feedback',
          value: 'tint',
          because: '这个按钮的按压反馈由美术指定为变色',
        },
      ]),
    );
    await appendFile(
      join(dir, 'history', 'egress.jsonl'),
      [
        { at: '2026-01-01T00:00:00Z', screen: 'main', model: 'x/y', purpose: 'inpaint' },
        { at: '2026-01-01T00:00:01Z', screen: 'main', model: 'x/y', purpose: 'upscale' },
        { at: '2026-01-01T00:00:02Z', screen: 'other', model: 'x/y', purpose: 'inpaint' },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(''),
    );
    await cli.ok(['verify']);
    const target = join(await makeDir(), 'godot');

    const envelope = await cli.ok(['export', 'godot', '--to', target]);

    const data = dataOf<ExportData>(envelope);
    expect(data).toMatchObject({
      screen: 'main',
      createdProject: true,
      scene: 'ui/main/main.tscn',
      nodes: 5,
      assets: 3,
      created: 5,
      updated: 0,
      removed: [],
      placeholders: 1,
      missingAssets: 0,
      nodeExceptions: 1,
      cloudImageCalls: 2,
      conflicts: 0,
      report: 'export/main.godot.json',
    });
    expect(data.timings.importMs).toBeGreaterThan(0);
    expect(data.timings.buildMs).toBeGreaterThan(0);
    expect(envelope.summary).toBe(
      `已导出界面 main 到 Godot 工程 ${toPosix(target)}：节点 5 个（新增 5、更新 0、移除 0）；新建了 Godot 工程`,
    );
    const warnings = envelope.warnings ?? [];
    expect(warnings.some((line) => line.includes('占位 Control') && line.includes('#slot'))).toBe(
      true,
    );
    expect(warnings.some((line) => line.includes('1 个节点例外'))).toBe(true);
    expect(warnings.some((line) => line.includes('云端图像模型 2 次'))).toBe(true);
    expect(warnings.every((line) => line.length < 200)).toBe(true);
    expect(envelope.next).toEqual(['ui-pro export godot --shot  # 截图并与基准图比对']);

    const sceneNodes = parseScene(await readFile(join(target, 'ui', 'main', 'main.tscn'), 'utf8'));
    expect(
      sceneNodes.map((node): [string, string, string | undefined] => [
        node.name,
        node.type,
        node.parent,
      ]),
    ).toEqual([
      ['Main', 'Control', undefined],
      ['Bg', 'TextureRect', '.'],
      ['Btn', 'TextureButton', '.'],
      ['Group', 'Control', '.'],
      ['Slot', 'Control', '.'],
      ['SlotArt', 'TextureRect', 'Slot'],
    ]);
    await loadsCleanly(target);

    const report = JSON.parse(await readFile(join(dir, 'export', 'main.godot.json'), 'utf8'));
    expect(report).toMatchObject({
      format: 'ui-pro/export-report',
      engine: 'godot',
      screen: 'main',
      scene: 'ui/main/main.tscn',
      placeholders: [{ id: 'slot', type: 'list' }],
      missingAssets: [],
      removed: [],
      conflicts: [],
      cloudImageCalls: 2,
      nodeExceptions: [
        {
          node: 'btn',
          point: 'press.feedback',
          value: 'tint',
          because: '这个按钮的按压反馈由美术指定为变色',
        },
      ],
    });
    expect(report.files).toContain('ui/main/main.tscn');
    expect(report.files).toContain('ui/main/assets/btn.png');
    expect(report.assets.map((asset: { name: string }) => asset.name)).toEqual([
      'bg',
      'btn',
      'slot',
    ]);
    expect(report.verification.ok).toBe(true);
    expect(report.verification.gates.map((gate: { id: string }) => gate.id)).toContain('fidelity');
    expect(
      report.verification.gates.every((gate: { status: string }) => gate.status === 'pass'),
    ).toBe(true);
  });

  it('exports again to the configured target, keeping what was added in Godot', async () => {
    const { dir, cli } = await verifiedScreen('godot-out');
    const target = join(dir, 'godot-out');
    await cli.ok(['export', 'godot']);
    const scenePath = join(target, 'ui', 'main', 'main.tscn');

    await mkdir(join(target, 'user'));
    await writeFile(join(target, 'user', 'btn.gd'), 'extends TextureButton\nvar level := 3\n');
    let text = await readFile(scenePath, 'utf8');
    text = text.replace(
      /^(\[gd_scene[^\n]*\]\n\n)/,
      '$1[ext_resource type="Script" path="res://user/btn.gd" id="9_user"]\n',
    );
    text = text.replace(/(\[node name="Btn"[^\n]*\]\n)/, '$1script = ExtResource("9_user")\n');
    text += '\n[node name="Notes" type="Label" parent="." unique_id=424242]\ntext = "mine"\n';
    await writeFile(scenePath, text);

    await cli.ok(
      ['apply', '-'],
      JSON.stringify([{ op: 'node.set', target: '#group', set: { rect: [12, 10, 50, 50] } }]),
    );
    await cli.ok(['verify']);
    const envelope = await cli.ok(['export', 'godot']);

    const data = dataOf<ExportData>(envelope);
    expect(data).toMatchObject({ createdProject: false, created: 0, conflicts: 0 });
    expect(data.updated).toBeGreaterThanOrEqual(1);
    const updated = await readFile(scenePath, 'utf8');
    expect(parseScene(updated).map((node) => node.name)).toContain('Notes');
    expect(updated).toContain('script = ExtResource("9_user")');
    expect(updated).toContain('text = "mine"');
    expect(parseScene(updated).find((node) => node.name === 'Group')?.body).toContain(
      'offset_left = 12.0',
    );
    expect(updated).toContain('unique_id=424242');
    await loadsCleanly(target);
  });

  it('takes a screenshot of the exported scene with --shot', async () => {
    const { dir, cli } = await verifiedScreen();
    const target = join(await makeDir(), 'godot');

    const envelope = await cli.ok(['export', 'godot', '--to', target, '--shot']);

    const data = dataOf<ExportData>(envelope);
    const file = toPosix(join(dir, '.ui-pro', 'look', 'main-godot.png'));
    expect(envelope.views).toEqual([file]);
    expect(data.shot).toMatchObject({ file, width: 200, height: 120 });
    expect(data.shot?.meanDiff).toBeLessThan(0.1);
    expect(data.timings.shotMs).toBeGreaterThan(0);
    expect(envelope.next).toBeUndefined();
  });
});
