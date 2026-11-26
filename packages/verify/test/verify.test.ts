import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  applyOps,
  createCoreRegistry,
  loadScreen,
  type Project,
  screenRelPath,
  serializeScreen,
} from '@ui-pro/core';
import { registerRules } from '@ui-pro/rules';
import { describe, expect, it } from 'vitest';
import {
  assertVerified,
  GATE_IDS,
  readVerifyStamp,
  stampPath,
  VerifyErrorCodes,
  verifyInputsSha256,
  verifyScreen,
} from '../src';
import { createFixture, scene, useTempDirs } from './helpers';

const makeDir = useTempDirs();

/** A screen whose decisions are current, so every non-engine gate passes. */
async function passingScene() {
  const fixture = await scene(makeDir);
  const registry = createCoreRegistry();
  registerRules(registry);
  await applyOps(fixture.project, [{ op: 'rule.recompute' }], { screen: fixture.screen, registry });
  return fixture;
}

const inProject = (project: Project, relPath: string): string =>
  join(project.root, ...relPath.split('/'));

describe('verifyScreen', () => {
  it('没有资产清单时报 E_NOT_BUILT，提示 ui-pro build', async () => {
    const { project, screen } = await createFixture(makeDir, { width: 200, height: 120 });

    await expect(verifyScreen(project, screen)).rejects.toMatchObject({
      code: VerifyErrorCodes.notBuilt,
      hint: expect.stringContaining('ui-pro build'),
    });
    expect(existsSync(stampPath(project, screen))).toBe(false);
  });

  it('按 GATE_IDS 的顺序跑全部非引擎门禁，写门禁记录和完整报告', async () => {
    const { project, screen } = await passingScene();
    const report = await verifyScreen(project, screen);

    expect(report.ok).toBe(true);
    expect(report.screen).toBe(screen);
    expect(report.gates.map((gate) => gate.id)).toEqual(GATE_IDS.filter((id) => id !== 'engine'));
    expect(report.gates.map((gate) => gate.status)).toEqual(Array(9).fill('pass'));
    expect(report.inputsSha256).toBe(verifyInputsSha256(project, screen));

    const stamp = readVerifyStamp(project, screen);
    expect(stamp).toMatchObject({ inputsSha256: report.inputsSha256, ok: true, failed: [] });
    expect(Date.parse(stamp?.at ?? '')).not.toBeNaN();

    const written = JSON.parse(
      await readFile(join(project.root, '.ui-pro', 'verify', screen, 'report.json'), 'utf8'),
    );
    expect(written.gates).toHaveLength(9);
    expect(written.ok).toBe(true);
    expect(() => assertVerified(project, screen)).not.toThrow();
  });

  it('--gate 只跑指定的门禁，不写门禁记录，也不动已有的', async () => {
    const { project, screen } = await passingScene();

    const partial = await verifyScreen(project, screen, { gates: ['budget', 'structure'] });
    expect(partial.gates.map((gate) => gate.id)).toEqual(['structure', 'budget']);
    expect(readVerifyStamp(project, screen)).toBeNull();

    await verifyScreen(project, screen);
    const before = readVerifyStamp(project, screen);
    await verifyScreen(project, screen, { gates: ['text'] });
    expect(readVerifyStamp(project, screen)).toEqual(before);
  });

  it('--engine 才跑引擎门禁，排在最后；现在是跳过', async () => {
    const { project, screen } = await passingScene();
    const report = await verifyScreen(project, screen, { engine: true });

    expect(report.gates).toHaveLength(10);
    expect(report.gates.at(-1)).toMatchObject({ id: 'engine', status: 'skipped' });
    expect(report.ok).toBe(true);
  });

  it('有门禁没通过：ok 为 false，记录里列出失败的门禁；这不是错误', async () => {
    const { project, screen } = await scene(makeDir); // decisions not computed: the rules gate fails
    const report = await verifyScreen(project, screen);

    expect(report.ok).toBe(false);
    expect(report.gates.find((gate) => gate.id === 'rules')?.status).toBe('fail');
    expect(readVerifyStamp(project, screen)).toMatchObject({ ok: false, failed: ['rules'] });
  });

  it('隐藏测试的 ask 汇总到报告里', async () => {
    const { project, screen } = await scene(makeDir, {
      buttonDecisions: { 'occlusion.fill': { value: 'fill', by: 'exception' } },
    });
    const report = await verifyScreen(project, screen, { gates: ['hide'] });
    expect(report.ask.map((question) => question.id)).toEqual(['hide.fill.total']);
  });
});

describe('verifyInputsSha256', () => {
  it('同样的输入同样的值；改界面规格、资产清单、资产文件、模拟数据、规则、概念库、项目配置之后变化', async () => {
    const { project, screen } = await passingScene();
    const seen = new Set<string>([verifyInputsSha256(project, screen)]);
    expect(verifyInputsSha256(project, screen)).toBe([...seen][0]);
    const changed = (label: string) => {
      const value = verifyInputsSha256(project, screen);
      expect(seen.has(value), `${label} 没有改变哈希`).toBe(false);
      seen.add(value);
    };

    const docPath = inProject(project, screenRelPath(screen, 'doc'));
    const doc = loadScreen(project, screen);
    const btn = doc.nodes.btn;
    if (!btn) throw new Error('缺少 btn');
    btn.rect = [21, 20, 80, 40];
    await writeFile(docPath, serializeScreen(doc));
    changed('界面规格');

    const manifestPath = inProject(project, screenRelPath(screen, 'assets'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.inputsSha256 = 'c'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    changed('资产清单');

    await appendFile(inProject(project, `screens/${screen}/assets/btn.png`), Buffer.from([0]));
    changed('资产文件');

    await writeFile(inProject(project, screenRelPath(screen, 'mock')), '{"a":1}');
    changed('模拟数据');

    await appendFile(inProject(project, 'rules/project.yaml'), '\n# 改过\n');
    changed('项目规则');

    await appendFile(inProject(project, screenRelPath(screen, 'rules')), '\n# 改过\n');
    changed('界面规则');

    await appendFile(inProject(project, 'glossary.yaml'), '\n# 改过\n');
    changed('概念库');

    await appendFile(inProject(project, 'ui-pro.yaml'), '\n# 改过\n');
    changed('项目配置');
  });

  it('不在输入里的东西不影响哈希：门禁记录、验证产出的图', async () => {
    const { project, screen } = await passingScene();
    const before = verifyInputsSha256(project, screen);
    await verifyScreen(project, screen);
    await mkdir(dirname(inProject(project, 'notes/x.txt')), { recursive: true });
    await writeFile(inProject(project, 'notes/x.txt'), '随手记');
    expect(verifyInputsSha256(project, screen)).toBe(before);
  });
});

describe('readVerifyStamp / assertVerified', () => {
  it('没有记录、记录损坏都读成 null', async () => {
    const { project, screen } = await passingScene();
    expect(readVerifyStamp(project, screen)).toBeNull();
    await mkdir(dirname(stampPath(project, screen)), { recursive: true });
    await writeFile(stampPath(project, screen), '{"inputsSha256": 3}');
    expect(readVerifyStamp(project, screen)).toBeNull();
    await writeFile(stampPath(project, screen), '不是 JSON');
    expect(readVerifyStamp(project, screen)).toBeNull();
  });

  it('三种拒绝：没跑过、没通过（列出失败的门禁）、通过之后又改过', async () => {
    const never = await passingScene();
    expect(() => assertVerified(never.project, never.screen)).toThrowError(
      expect.objectContaining({
        code: VerifyErrorCodes.notVerified,
        message: `界面 ${never.screen} 还没有跑过质量门禁`,
        hint: expect.stringContaining('ui-pro verify'),
      }),
    );

    const failing = await scene(makeDir);
    await verifyScreen(failing.project, failing.screen);
    expect(() => assertVerified(failing.project, failing.screen)).toThrowError(
      expect.objectContaining({
        code: VerifyErrorCodes.notVerified,
        message: `界面 ${failing.screen} 上次质量门禁没有通过：规则一致`,
      }),
    );

    const stale = await passingScene();
    await verifyScreen(stale.project, stale.screen);
    await appendFile(inProject(stale.project, 'glossary.yaml'), '\n# 改过\n');
    expect(() => assertVerified(stale.project, stale.screen)).toThrowError(
      expect.objectContaining({
        code: VerifyErrorCodes.notVerified,
        message: expect.stringContaining('通过质量门禁之后又改过'),
      }),
    );
  });
});
