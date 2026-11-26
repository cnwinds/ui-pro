import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { addScreen, applyOps, createProject, type Project } from '@ui-pro/core';
import sharp from 'sharp';
import { afterEach, expect } from 'vitest';
import { type Envelope, type FailureEnvelope, runCli, type SuccessEnvelope } from '../src';
import { registerPlugins } from '../src/plugins';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-cli-test-'));
    created.push(dir);
    return dir;
  };
}

export async function writePng(path: string, width: number, height: number): Promise<void> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  await writeFile(path, png);
}

/** Relative posix path -> sha256 of every file under `root`, for byte-exact comparisons. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else {
        const bytes = await readFile(join(dir, entry.name));
        result[rel] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  await walk(root, '');
  return result;
}

/** Everything one command line wrote, as the shell would have seen it. */
export interface RawRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface JsonRun {
  code: number;
  stderr: string;
  envelope: Envelope;
}

export interface Cli {
  /** Runs the command line and returns the untouched output streams. */
  raw(args: string[], stdin?: string): Promise<RawRun>;
  /** Runs the command line and parses its single JSON envelope. */
  run(args: string[], stdin?: string): Promise<JsonRun>;
  /** Runs a command that must succeed. */
  ok(args: string[], stdin?: string): Promise<SuccessEnvelope>;
  /** Runs a command that must fail, returning its error and exit code. */
  fail(args: string[], stdin?: string): Promise<{ code: number; error: FailureEnvelope['error'] }>;
}

/** A CLI whose relative paths and project discovery start at `cwd`. */
export function cliIn(cwd: string): Cli {
  const raw = async (args: string[], stdin?: string): Promise<RawRun> => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(args, {
      cwd,
      stdin: stdin === undefined ? undefined : Readable.from([stdin]),
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    });
    return { code, stdout, stderr };
  };

  const run = async (args: string[], stdin?: string): Promise<JsonRun> => {
    const result = await raw(args, stdin);
    expect(result.stdout.endsWith('\n'), 'stdout ends with a newline').toBe(true);
    expect(result.stdout.trimEnd().includes('\n'), 'stdout is one single line').toBe(false);
    return {
      code: result.code,
      stderr: result.stderr,
      envelope: JSON.parse(result.stdout) as Envelope,
    };
  };

  return {
    raw,
    run,
    async ok(args, stdin) {
      const { code, envelope } = await run(args, stdin);
      if (!envelope.ok) {
        expect.fail(`expected success, got ${envelope.error.code}: ${envelope.error.message}`);
      }
      expect(code).toBe(0);
      return envelope;
    },
    async fail(args, stdin) {
      const { code, envelope } = await run(args, stdin);
      if (envelope.ok) expect.fail(`expected a failure, got success: ${envelope.summary}`);
      return { code, error: envelope.error };
    },
  };
}

export interface TreeProject {
  /** Project root; run commands from here. */
  dir: string;
  project: Project;
  /** The one screen, 1080x1920 so design and source pixels coincide. */
  screen: string;
  cli: Cli;
}

/**
 * A project with one screen `main`:
 *
 *     root
 *     |- topbar (container)
 *     |  |- btn_shop (button)
 *     |  `- btn_mail (button)
 *     |- btn_upgrade (button)
 *     |  `- badge_dot (image, concept 红点)
 *     `- title (text)
 *
 * History holds v1 (screen added) and v2 (tree seeded). The seed goes through the plugins'
 * hooks, as a CLI commit would, so the nodes already carry their decisions.
 */
export async function treeProject(makeDir: () => Promise<string>): Promise<TreeProject> {
  registerPlugins();
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo' });
  const png = join(root, 'main.png');
  await writePng(png, 1080, 1920);
  await addScreen(project, { name: 'main', source: png });

  const node = (
    id: string,
    type: string,
    rect: number[],
    parent: string,
    extra: Record<string, unknown> = {},
  ) => ({ op: 'node.add', node: { id, type, rect, parent: `#${parent}`, ...extra } });
  await applyOps(
    project,
    [
      node('topbar', 'container', [0, 0, 1080, 200], 'root'),
      node('btn_shop', 'button', [800, 20, 200, 80], 'topbar', { role: 'nav.shop' }),
      node('btn_mail', 'button', [600, 20, 150, 80], 'topbar', { role: 'nav.mail' }),
      node('btn_upgrade', 'button', [100, 1500, 300, 120], 'root'),
      node('badge_dot', 'image', [380, 1490, 36, 36], 'btn_upgrade', {
        role: 'badge.notification',
        concept: '红点',
      }),
      node('title', 'text', [300, 300, 480, 80], 'root', { text: { content: '标题' } }),
    ],
    { screen: 'main', message: 'seed tree' },
  );
  return { dir, project, screen: 'main', cli: cliIn(dir) };
}

/** The `data` of a successful envelope, typed by the caller. */
export function dataOf<T>(envelope: SuccessEnvelope): T {
  return envelope.data as T;
}
