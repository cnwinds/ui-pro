import { isUiProError } from '@ui-pro/core';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { stubCommand } from '../src/commands/stub';
import type { CommandHandler, CommandHost } from '../src/commands/types';
import type { CommandContext } from '../src/context';

const host: CommandHost = {
  action<A extends unknown[]>(handler: CommandHandler<A>) {
    return async (...args: unknown[]) => {
      await handler({} as CommandContext, ...(args.slice(0, -1) as A));
    };
  },
};

function programWith(...modules: ReturnType<typeof stubCommand>[]): Command {
  const program = new Command('ui-pro').exitOverride().configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  for (const module of modules) module.register(program, host);
  return program;
}

async function failure(program: Command, argv: string[]): Promise<unknown> {
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    return error;
  }
  throw new Error(`ui-pro ${argv.join(' ')} did not fail`);
}

describe('commands reserved for later iterations', () => {
  it('fail with E_NOT_IMPLEMENTED and name the command', async () => {
    const program = programWith(stubCommand({ name: 'later', description: '以后再做' }));

    const error = await failure(program, ['later']);

    expect(isUiProError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'E_NOT_IMPLEMENTED',
      message: 'ui-pro later 尚未实现',
      details: { command: 'later' },
    });
  });

  it('accept the arguments their real versions will take', async () => {
    const program = programWith(stubCommand({ name: 'later', description: '以后再做' }));

    const error = await failure(program, ['later', '#title', '--gate', 'all', 'extra']);

    expect(error).toMatchObject({ code: 'E_NOT_IMPLEMENTED' });
  });

  it('can be a group of subcommands', async () => {
    const program = programWith(
      stubCommand({ name: 'later', description: '以后再做', subcommands: { one: '第一件' } }),
    );

    const error = await failure(program, ['later', 'one']);

    expect(error).toMatchObject({
      code: 'E_NOT_IMPLEMENTED',
      message: 'ui-pro later one 尚未实现',
      details: { command: 'later one' },
    });
  });

  it('are listed in --help as not implemented', () => {
    const program = programWith(stubCommand({ name: 'later', description: '以后再做' }));

    expect(program.helpInformation()).toMatch(/later\s.*以后再做（尚未实现）/);
  });
});
