import { describe, expect, it } from 'vitest';
import { MEDIUM_NODE_COUNT, mediumScreen } from '../../renderer/test/medium';
import { GATE_IDS, type GateId, verifyScreen } from '../src';
import { useTempDirs } from './helpers';

const makeDir = useTempDirs();

const ms = (since: number): string => `${(performance.now() - since).toFixed(0)} ms`;

describe('中等界面上的全部门禁', () => {
  it(`${MEDIUM_NODE_COUNT} 个节点、1080 x 1920：全部非引擎门禁的耗时，显隐测试的帧数和单帧耗时`, async () => {
    const { project, screen } = await mediumScreen(makeDir);
    // No rule hooks and no build here: no node has decisions, so every occluder counts as
    // filled (the default) and the hide test runs its largest set of frames.
    const started = performance.now();
    const report = await verifyScreen(project, screen);
    const total = performance.now() - started;

    const lines = [`全部门禁（${report.gates.length} 道）${total.toFixed(0)} ms`];
    for (const gate of report.gates) {
      lines.push(
        `  ${gate.id} ${gate.status} 问题 ${gate.problems.length} 警告 ${gate.warnings.length} ${JSON.stringify(gate.metrics)}`,
      );
      for (const problem of gate.problems.slice(0, 2)) lines.push(`    - ${problem.message}`);
    }

    // Each gate alone, to see where the time goes (each pays for its own context).
    for (const id of GATE_IDS.filter((gate): gate is GateId => gate !== 'engine')) {
      const at = performance.now();
      await verifyScreen(project, screen, { gates: [id] });
      lines.push(`  单跑 ${id} ${ms(at)}`);
    }
    const hide = report.gates.find((gate) => gate.id === 'hide');
    const frames = hide?.metrics.frames ?? 0;
    const hideAt = performance.now();
    await verifyScreen(project, screen, { gates: ['hide'] });
    const hideMs = performance.now() - hideAt;
    lines.push(
      `显隐测试 ${frames} 帧 ${hideMs.toFixed(0)} ms，平均每帧 ${(hideMs / Math.max(1, frames)).toFixed(1)} ms`,
    );
    console.info(`[verify] ${lines.join('\n')}`);

    expect(report.gates.map((gate) => gate.id)).toEqual(
      GATE_IDS.filter((gate) => gate !== 'engine'),
    );
    expect(frames).toBeGreaterThan(0);
    // Only the rules gate complains, that nothing decided the nodes; the screen matches its
    // reference, so fidelity, standalone, hide and the rest pass.
    expect(report.gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id)).toEqual([
      'rules',
    ]);
    // Generous: a few seconds measured; this only catches a gate that went quadratic.
    expect(total).toBeLessThan(60_000);
  }, 300_000);
});
