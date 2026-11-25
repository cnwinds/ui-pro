import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { toPosix, UiProError } from '@ui-pro/core';
import { GodotErrorCodes } from './errors';
import { type RunResult, runProcess } from './runner';

export const GODOT_ENV = 'UI_PRO_GODOT';
export const MIN_VERSION = { major: 4, minor: 6 } as const;

const PATH_NAMES = ['godot', 'godot4'];
const VERSION_TIMEOUT_MS = 30_000;
const MAX_ERROR_LINES = 20;
const NOT_FOUND_HINT = `设置环境变量 ${GODOT_ENV} 指向 Godot ${MIN_VERSION.major}.${MIN_VERSION.minor} 及以上的控制台版可执行文件（Windows 上是 Godot_v..._console.exe），或把 godot 加入 PATH`;

export interface GodotInstall {
  executable: string;
  /** Full version string, e.g. `4.6.1.stable.official.14d19694e`. */
  version: string;
  major: number;
  minor: number;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return (key === undefined ? '' : (env[key] ?? '')).split(delimiter).filter((dir) => dir !== '');
}

/**
 * The Godot executable to use, without running it: `UI_PRO_GODOT` when set (and then only
 * that), otherwise `godot` or `godot4` on PATH.
 */
export function findGodotExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env[GODOT_ENV]?.trim();
  if (configured) return existsSync(configured) ? resolve(configured) : undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of pathEntries(env)) {
    for (const name of PATH_NAMES) {
      for (const extension of extensions) {
        const candidate = join(dir, name + extension);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

export function parseGodotVersion(
  output: string,
): { version: string; major: number; minor: number } | undefined {
  const version = output.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  return { version, major: Number(match[1]), minor: Number(match[2]) };
}

export function isSupportedVersion(major: number, minor: number): boolean {
  return major > MIN_VERSION.major || (major === MIN_VERSION.major && minor >= MIN_VERSION.minor);
}

function notFound(message: string): UiProError {
  return new UiProError(GodotErrorCodes.notFound, message, { hint: NOT_FOUND_HINT });
}

/** Finds Godot and checks that it is 4.6 or newer. */
export async function locateGodot(env: NodeJS.ProcessEnv = process.env): Promise<GodotInstall> {
  const executable = findGodotExecutable(env);
  if (executable === undefined) {
    const configured = env[GODOT_ENV]?.trim();
    throw notFound(
      configured
        ? `环境变量 ${GODOT_ENV} 指向的文件不存在：${toPosix(configured)}`
        : '找不到 Godot：没有设置环境变量 UI_PRO_GODOT，PATH 里也没有 godot 或 godot4',
    );
  }
  let run: RunResult;
  try {
    run = await runProcess(executable, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, env });
  } catch (error) {
    throw new UiProError(
      GodotErrorCodes.notFound,
      `无法运行 Godot：${toPosix(executable)}（${error instanceof Error ? error.message : String(error)}）`,
      { hint: NOT_FOUND_HINT, cause: error },
    );
  }
  return checkGodotVersion(executable, run.stdout);
}

/** Builds the install from the output of `--version`, or fails if it is not Godot 4.6+. */
export function checkGodotVersion(executable: string, versionOutput: string): GodotInstall {
  const parsed = parseGodotVersion(versionOutput);
  if (parsed === undefined) {
    throw notFound(
      `${toPosix(executable)} 不像是 Godot：--version 输出了 ${versionOutput.trim().slice(0, 80) || '空内容'}`,
    );
  }
  if (!isSupportedVersion(parsed.major, parsed.minor)) {
    throw new UiProError(
      GodotErrorCodes.version,
      `Godot 版本过低：${parsed.version}，需要 ${MIN_VERSION.major}.${MIN_VERSION.minor} 及以上`,
      {
        hint: NOT_FOUND_HINT,
        details: { executable: toPosix(executable), version: parsed.version },
      },
    );
  }
  return { executable, ...parsed };
}

// Printed when the process exits with resources still alive; they are not failures of the run.
const EXIT_LEAKS = [
  /were leaked at exit/,
  /resources? still in use at exit/,
  /instances leaked at exit/,
];

/** `ERROR:` lines of Godot's output with their indented `at:` continuation, exit-time leaks left out. */
export function errorLines(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const found: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!/^(SCRIPT )?ERROR:/.test(line) || EXIT_LEAKS.some((leak) => leak.test(line))) continue;
    found.push(line);
    while (/^\s+\S/.test(lines[index + 1] ?? '')) found.push(lines[++index] ?? '');
  }
  return found.slice(0, MAX_ERROR_LINES);
}

export type GodotStep = 'import' | 'build' | 'shot';

const STEP_LABEL: Record<GodotStep, string> = {
  import: '导入资产',
  build: '构建场景',
  shot: '截图',
};

/**
 * Runs Godot for one export step. A timeout is an error; a failing exit code or `ERROR:` lines
 * are returned for the caller to judge, because the builder reports its own errors in a file.
 */
export async function runGodot(
  install: GodotInstall,
  step: GodotStep,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ run: RunResult; errors: string[] }> {
  let run: RunResult;
  try {
    run = await runProcess(install.executable, ['--language', 'en', ...args], { timeoutMs });
  } catch (error) {
    throw new UiProError(
      GodotErrorCodes.run,
      `Godot ${STEP_LABEL[step]}失败：无法启动 ${toPosix(install.executable)}`,
      { cause: error, details: { step } },
    );
  }
  const output = `${run.stdout}\n${run.stderr}`;
  const errors = errorLines(output);
  if (run.timedOut) {
    throw new UiProError(
      GodotErrorCodes.timeout,
      `Godot ${STEP_LABEL[step]}超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束，已终止`,
      {
        hint: '检查 Godot 工程是否能在编辑器里正常打开，或者有没有弹出需要手动确认的窗口',
        details: { step, errors, output: output.trim().slice(-1500) },
      },
    );
  }
  return { run, errors };
}

/** Fails the step when Godot exited abnormally or printed errors. */
export function assertCleanRun(step: GodotStep, run: RunResult, errors: string[]): void {
  if (run.code === 0 && errors.length === 0) return;
  const first = errors[0]?.replace(/^(SCRIPT )?ERROR:\s*/, '');
  throw new UiProError(
    GodotErrorCodes.run,
    first === undefined
      ? `Godot ${STEP_LABEL[step]}失败：退出码 ${run.code}`
      : `Godot ${STEP_LABEL[step]}失败：${first}`,
    {
      hint: '细节见 details.errors；可以在 Godot 编辑器里打开这个 Godot 工程看同样的报错',
      details: {
        step,
        exitCode: run.code,
        errors,
        output:
          errors.length === 0 ? `${run.stdout}\n${run.stderr}`.trim().slice(-1500) : undefined,
      },
    },
  );
}
