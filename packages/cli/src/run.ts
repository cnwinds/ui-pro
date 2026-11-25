import { CommanderError } from 'commander';
import type { GlobalOptions } from './context';
import { EXIT_OK, UsageError } from './errors';
import type { ResultSlot } from './host';
import type { CliIo } from './io';
import { buildProgram } from './program';
import { causeChain, failureOutcome, type Outcome, renderEnvelope, successOutcome } from './result';

/** `--help` and `--version` print their own text and are not failures. */
const INFORMATIONAL_EXITS = new Set(['commander.helpDisplayed', 'commander.version']);

/** Commander's own failures (unknown option, missing argument, ...) are usage errors. */
function usageFailure(error: CommanderError): UsageError {
  if (error.code === 'commander.help') {
    return new UsageError('缺少命令或子命令', '用 ui-pro --help 查看所有命令');
  }
  return new UsageError(
    `命令行用法不正确：${error.message.replace(/^error: /, '')}`,
    '用 ui-pro <命令> --help 查看该命令的用法',
  );
}

/**
 * Runs one command line and prints exactly one response (a JSON envelope, or text with
 * `--format text`) to stdout. Resolves with the process exit code: 0 success, 1 expected
 * failure, 2 usage error, 3 internal error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const slot: ResultSlot = {};
  const program = buildProgram(io, stdout, slot);

  let outcome: Outcome | undefined;
  let failure: unknown;
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (slot.result !== undefined) outcome = successOutcome(slot.result);
  } catch (error) {
    if (error instanceof CommanderError && INFORMATIONAL_EXITS.has(error.code)) return EXIT_OK;
    failure = error instanceof CommanderError ? usageFailure(error) : error;
    outcome = failureOutcome(failure, program.opts<GlobalOptions>().debug);
  }

  if (outcome === undefined) return EXIT_OK;
  const { format, debug } = program.opts<GlobalOptions>();
  stdout.write(renderEnvelope(outcome.envelope, format));
  if (debug && failure !== undefined) {
    for (const cause of causeChain(failure)) stderr.write(`[debug] 原因：${cause}\n`);
  }
  return outcome.exitCode;
}
