import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/runner';

const node = process.execPath;

describe('runProcess', () => {
  it('collects both output streams and the exit code', async () => {
    const run = await runProcess(
      node,
      ['-e', 'console.log("out"); console.error("err"); process.exit(3)'],
      { timeoutMs: 20_000 },
    );

    expect(run).toMatchObject({ code: 3, timedOut: false });
    expect(run.stdout.trim()).toBe('out');
    expect(run.stderr.trim()).toBe('err');
  });

  it('kills a process that runs past the timeout and says so', async () => {
    const started = Date.now();

    const run = await runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });

    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('rejects when the command cannot start', async () => {
    await expect(runProcess('ui-pro-no-such-command', [], { timeoutMs: 5000 })).rejects.toThrow();
  });
});
