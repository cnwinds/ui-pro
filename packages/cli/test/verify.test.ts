import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadScreen,
  type Project,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
} from '@ui-pro/core';
import { type GateResult, readVerifyStamp, type VerifyReport } from '@ui-pro/verify';
import { describe, expect, it } from 'vitest';
import { createFixture, type NodeInit, scene, useTempDirs } from '../../verify/test/helpers';
import { MAX_PROBLEMS_PER_GATE } from '../src/commands/verify';
import { registerPlugins } from '../src/plugins';
import { cliIn, dataOf } from './helpers';

const makeDir = useTempDirs();

// The rule hooks decide every node on each commit, as the CLI does; fixtures built after this
// have current decisions, so every non-engine gate passes until a test edits something.
registerPlugins();

type VerifyData = VerifyReport & {
  gates: (GateResult & { problemCount: number })[];
  report: string;
  stamped: boolean;
};

/** Rewrites the screen document on disk, bypassing the hooks. */
async function edit(project: Project, screen: string, change: (doc: ScreenDoc) => void) {
  const doc = loadScreen(project, screen);
  change(doc);
  await writeFile(
    join(project.root, ...screenRelPath(screen, 'doc').split('/')),
    serializeScreen(doc),
  );
}

async function builtScreen(nodes?: NodeInit[]) {
  const fixture = await scene(makeDir, nodes ? { nodes } : {});
  return { ...fixture, cli: cliIn(fixture.project.root) };
}

describe('ui-pro verify', () => {
  it('全部通过：一行摘要、完整报告、views，下一步是导出；门禁记录已写', async () => {
    const { cli, project, screen } = await builtScreen();
    const envelope = await cli.ok(['verify']);
    const data = dataOf<VerifyData>(envelope);

    expect(envelope.summary).toBe('界面 main 通过 9 道门禁');
    expect(data.ok).toBe(true);
    expect(data.screen).toBe('main');
    expect(data.gates.map((gate) => gate.id)).toEqual([
      'fidelity',
      'standalone',
      'hide',
      'rules',
      'structure',
      'resources',
      'adaptation',
      'text',
      'budget',
    ]);
    expect(data.stamped).toBe(true);
    expect(data.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.views?.some((view) => view.endsWith('fidelity.png'))).toBe(true);
    expect(envelope.next).toEqual(['ui-pro export godot']);
    expect(readVerifyStamp(project, screen)).toMatchObject({ ok: true, failed: [] });
    expect(existsSync(data.report)).toBe(true);
  });

  it('有门禁没通过不是命令出错：ok 为 true、data.ok 为 false，摘要点名没通过的门禁', async () => {
    const { cli, project, screen } = await builtScreen();
    // The button's decisions are gone: the rules gate finds them missing.
    await edit(project, screen, (doc) => {
      const btn = doc.nodes.btn;
      if (btn) btn.decisions = {};
    });

    const run = await cli.run(['verify']);
    expect(run.code).toBe(0);
    if (!run.envelope.ok) throw new Error('应当成功');
    const data = dataOf<VerifyData>(run.envelope);

    expect(data.ok).toBe(false);
    expect(run.envelope.summary).toMatch(/^界面 main 有 1 道门禁未通过：规则一致（\d+ 个问题）$/);
    expect(run.envelope.next?.[0]).toContain('rule.recompute');
    expect(run.envelope.next?.[1]).toBe('ui-pro verify --gate rules  # 修好之后只重跑没通过的门禁');
    expect(readVerifyStamp(project, screen)).toMatchObject({ ok: false, failed: ['rules'] });
  });

  it('问题很多时每道门禁只带前若干条，并给出总数；完整的在 report.json', async () => {
    const extra: NodeInit[] = Array.from({ length: 15 }, (_, index) => ({
      id: `n${index}`,
      type: 'button' as const,
      rect: [10 + index * 12, 100, 10, 10] as [number, number, number, number],
      asset: 'btn',
    }));
    const { cli, project, screen } = await builtScreen(extra);
    await edit(project, screen, (doc) => {
      for (const node of Object.values(doc.nodes)) node.decisions = {};
    });

    const envelope = await cli.ok(['verify', '--gate', 'rules']);
    const data = dataOf<VerifyData>(envelope);
    const [rules] = data.gates;

    expect(rules?.problems).toHaveLength(MAX_PROBLEMS_PER_GATE);
    expect(rules?.problemCount).toBeGreaterThan(MAX_PROBLEMS_PER_GATE);
    const full = JSON.parse(await readFile(data.report, 'utf8')) as VerifyReport;
    expect(full.gates[0]?.problems).toHaveLength(rules?.problemCount ?? -1);
  });

  it('--gate 只跑指定的门禁（可重复、可逗号分隔），不写门禁记录', async () => {
    const { cli, project, screen } = await builtScreen();

    const envelope = await cli.ok(['verify', '--gate', 'budget', '--gate', 'structure,text']);
    const data = dataOf<VerifyData>(envelope);

    expect(data.gates.map((gate) => gate.id)).toEqual(['structure', 'text', 'budget']);
    expect(data.stamped).toBe(false);
    expect(envelope.summary).toBe('界面 main 通过 3 道门禁');
    expect(envelope.next).toEqual(['ui-pro verify  # 跑全部门禁，通过之后才能导出']);
    expect(readVerifyStamp(project, screen)).toBeNull();
    expect(existsSync(join(project.root, '.ui-pro', 'verify', `${screen}.json`))).toBe(false);
  });

  it('不存在的门禁名是用法错误，列出可用的', async () => {
    const { cli } = await builtScreen();
    const { error } = await cli.fail(['verify', '--gate', 'nope']);
    expect(error.code).toBe('E_USAGE');
    expect(error.message).toContain('没有这道门禁：nope');
    expect(error.message).toContain('fidelity');
  });

  it('--engine 加跑引擎门禁，没有实现或没有 Godot 时跳过，摘要里说明', async () => {
    const { cli } = await builtScreen();
    const envelope = await cli.ok(['verify', '--engine']);
    const data = dataOf<VerifyData>(envelope);

    expect(data.gates.at(-1)?.id).toBe('engine');
    expect(data.gates.at(-1)?.status).toBe('skipped');
    expect(envelope.summary).toBe('界面 main 通过 9 道门禁，1 道跳过（引擎一致）');
  });

  it('补全面积大时，显隐测试的 ask 原样带出', async () => {
    const { cli, project, screen } = await builtScreen();
    // The button now asks to be filled out of the background (the default rules keep it).
    await edit(project, screen, (doc) => {
      const decision = doc.nodes.btn?.decisions['occlusion.fill'];
      if (decision) decision.value = 'fill';
    });

    const envelope = await cli.ok(['verify', '--gate', 'hide']);
    expect(envelope.ask?.map((question) => question.id)).toEqual(['hide.fill.total']);
  });

  it('没有构建过资产时报 E_NOT_BUILT，提示 ui-pro build', async () => {
    const fixture = await createFixture(makeDir, { width: 200, height: 120 });
    const { code, error } = await cliIn(fixture.project.root).fail(['verify']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_NOT_BUILT');
    expect(error.hint).toContain('ui-pro build');
  });
});
