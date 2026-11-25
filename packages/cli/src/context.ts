import {
  defaultScreen,
  ErrorCodes,
  listScreens,
  openProject,
  type Project,
  UiProError,
} from '@ui-pro/core';
import { UsageError } from './errors';
import { type CliIo, readAll } from './io';
import type { OutputFormat } from './result';

/** Options accepted by every command, whichever side of the subcommand name they appear on. */
export interface GlobalOptions {
  project?: string;
  screen?: string;
  format: OutputFormat;
  debug: boolean;
}

/** What a command handler can see of its environment. */
export interface CommandContext {
  readonly cwd: string;
  readonly globals: GlobalOptions;
  /** Opens `--project`, or the project containing the working directory. */
  openProject(): Project;
  /** The screen picked by `--screen`, or the project's only screen; `undefined` if ambiguous. */
  currentScreen(project: Project): string | undefined;
  /** Like `currentScreen`, but fails with an actionable error when no screen can be chosen. */
  requireScreen(project: Project): string;
  readStdin(): Promise<string>;
}

export function createContext(io: CliIo, globals: GlobalOptions): CommandContext {
  const currentScreen = (project: Project): string | undefined =>
    defaultScreen(project, globals.screen);

  return {
    cwd: io.cwd,
    globals,
    openProject: () => openProject(globals.project, io.cwd),
    currentScreen,
    requireScreen(project) {
      const screen = currentScreen(project);
      if (screen !== undefined) return screen;
      const screens = listScreens(project);
      throw new UiProError(
        ErrorCodes.screenNotFound,
        screens.length === 0 ? '项目里还没有界面' : '项目里有多个界面，需要指定其中一个',
        {
          hint:
            screens.length === 0
              ? '用 ui-pro init --screen <name> --source <file> 添加'
              : `用 --screen 指定：${screens.join('、')}`,
          details: { screens },
        },
      );
    },
    readStdin() {
      if (io.stdin === undefined)
        throw new UsageError('这个命令需要从标准输入读取，但没有可用的 stdin');
      return readAll(io.stdin);
    },
  };
}
