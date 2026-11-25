import type { Command } from 'commander';
import type { CommandContext } from '../context';
import type { CommandResult } from '../result';

/**
 * A command body. Receives the command's positional arguments followed by its parsed options
 * object, exactly as commander delivers them. Throw a `UiProError` for expected failures.
 */
export type CommandHandler<A extends unknown[]> = (
  ctx: CommandContext,
  ...args: A
) => Promise<CommandResult>;

export interface CommandHost {
  /** Adapts a handler for `command.action(...)`; its result becomes the printed response. */
  action<A extends unknown[]>(handler: CommandHandler<A>): (...args: unknown[]) => Promise<void>;
}

/**
 * One top-level command, defined entirely in its own file. Adding or replacing a command means
 * editing that file and, for a new one, its entry in `commands/index.ts`.
 */
export interface CommandModule {
  /** Top-level command name; unique across modules. */
  readonly name: string;
  /** Adds the command (with its options and subcommands) to `program`. */
  register(program: Command, host: CommandHost): void;
}
