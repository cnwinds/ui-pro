import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../src';
import { useTempDirs } from './helpers';

const makeDir = useTempDirs();

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageDir, 'bin', 'ui-pro.mjs');

// Starting node plus tsx takes a second or two per process.
const SPAWN_TIMEOUT_MS = 60_000;

function launch(cwd: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope: result.stdout.startsWith('{') ? (JSON.parse(result.stdout) as Envelope) : undefined,
  };
}

describe('the ui-pro launcher', () => {
  it('is what package.json declares as the ui-pro executable', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(manifest.bin['ui-pro']).toBe('./bin/ui-pro.mjs');
  });

  it(
    'runs the TypeScript entry and prints a JSON envelope',
    () => {
      const run = launch(process.cwd(), ['schema', 'node.add']);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.envelope).toMatchObject({
        ok: true,
        summary: expect.stringContaining('node.add'),
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'drives a project end to end, reading standard input and setting the exit code',
    async () => {
      const root = await makeDir();

      const created = launch(root, ['init', 'game', '--name', 'Smoke']);
      const game = join(root, 'game');
      const history = launch(game, ['history', 'list']);
      const applied = launch(game, ['apply', '-'], '[]');
      const unknown = launch(game, ['frobnicate']);

      expect(created.status).toBe(0);
      expect(created.envelope).toMatchObject({ ok: true, data: { name: 'Smoke' } });
      expect(history.status).toBe(0);
      expect(history.envelope).toMatchObject({ ok: true, data: { items: [] } });
      expect(applied.status).toBe(1);
      expect(applied.envelope).toMatchObject({ ok: false, error: { code: 'E_OP_INVALID' } });
      expect(unknown.status).toBe(2);
      expect(unknown.envelope).toMatchObject({ ok: false, error: { code: 'E_USAGE' } });
      expect(unknown.stderr).toBe('');
    },
    SPAWN_TIMEOUT_MS * 2,
  );
});
