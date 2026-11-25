import type { Command } from 'commander';
import type { CommandHandler, CommandHost } from './commands/types';
import { createContext, type GlobalOptions } from './context';
import type { CliIo } from './io';
import type { CommandResult } from './result';

/** Where the host leaves the result of the command that ran. */
export interface ResultSlot {
  result?: CommandResult;
}

export function createHost(program: Command, io: CliIo, slot: ResultSlot): CommandHost {
  return {
    action<A extends unknown[]>(handler: CommandHandler<A>) {
      return async (...args: unknown[]): Promise<void> => {
        const context = createContext(io, program.opts<GlobalOptions>());
        // Commander appends the Command itself after the positionals and the options object.
        slot.result = await handler(context, ...(args.slice(0, -1) as A));
      };
    },
  };
}
