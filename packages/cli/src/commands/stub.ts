import { ErrorCodes, UiProError } from '@ui-pro/core';
import type { Command } from 'commander';
import type { CommandHost, CommandModule } from './types';

export interface StubSpec {
  name: string;
  description: string;
  /** Subcommand name -> description; the stub then behaves as a command group. */
  subcommands?: Readonly<Record<string, string>>;
}

function notImplemented(path: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new UiProError(ErrorCodes.notImplemented, `ui-pro ${path} 尚未实现`, {
        hint: '该命令的接口已预留，由后续迭代提供',
        details: { command: path },
      }),
    );
}

function addStub(
  parent: Command,
  host: CommandHost,
  name: string,
  description: string,
  path: string,
): Command {
  return parent
    .command(name)
    .description(`${description}（尚未实现）`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(host.action(notImplemented(path)));
}

/**
 * A command that is registered so it shows up in `--help` and fails with `E_NOT_IMPLEMENTED`.
 * Replace the module with the real one to implement the command.
 */
export function stubCommand(spec: StubSpec): CommandModule {
  return {
    name: spec.name,
    register(program, host) {
      const subcommands = Object.entries(spec.subcommands ?? {});
      if (subcommands.length === 0) {
        addStub(program, host, spec.name, spec.description, spec.name);
        return;
      }
      const group = program.command(spec.name).description(`${spec.description}（尚未实现）`);
      for (const [name, description] of subcommands) {
        addStub(group, host, name, description, `${spec.name} ${name}`);
      }
    },
  };
}
