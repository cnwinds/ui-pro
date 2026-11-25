import { type ChildProcess, spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** `null` when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

const KILL_GRACE_MS = 3000;

/** On Windows the console build starts the real executable as a child, so kill the whole tree. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => undefined);
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Runs a command, collecting both output streams. Never leaves the process running: after
 * `timeoutMs` it is killed and the result says so. Rejects only when the command cannot start.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, [...args], {
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, options.timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(error);
    });
    child.on('close', (code) => finish(code));
  });
}
