import { type AskQuestion, ErrorCodes, isUiProError } from '@ui-pro/core';
import { EXIT_FAILURE, EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, UsageError } from './errors';

export type OutputFormat = 'json' | 'text';

/** What a command hands back; the runner turns it into the one response printed on stdout. */
export interface CommandResult {
  /** One line in Simplified Chinese saying what happened. */
  summary: string;
  data?: unknown;
  warnings?: string[];
  ask?: AskQuestion[];
  /** Absolute forward-slash paths of images or files worth looking at. */
  views?: string[];
  /** Suggested follow-up command lines. */
  next?: string[];
}

export interface SuccessEnvelope extends CommandResult {
  ok: true;
}

export interface FailureEnvelope {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: unknown };
}

export type Envelope = SuccessEnvelope | FailureEnvelope;

export interface Outcome {
  envelope: Envelope;
  exitCode: number;
}

function nonEmpty<T>(items: T[] | undefined): T[] | undefined {
  return items !== undefined && items.length > 0 ? items : undefined;
}

export function successOutcome(result: CommandResult): Outcome {
  const envelope: SuccessEnvelope = {
    ok: true,
    summary: result.summary,
    data: result.data,
    warnings: nonEmpty(result.warnings),
    ask: nonEmpty(result.ask),
    views: nonEmpty(result.views),
    next: nonEmpty(result.next),
  };
  return { envelope, exitCode: EXIT_OK };
}

/** Maps any thrown value to its envelope and exit code; stacks only leave the process in debug. */
export function failureOutcome(error: unknown, debug: boolean): Outcome {
  if (isUiProError(error)) {
    const exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
    return {
      envelope: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          hint: error.hint,
          details: error.details,
        },
      },
      exitCode,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    envelope: {
      ok: false,
      error: {
        code: ErrorCodes.internal,
        message: `内部错误：${message}`,
        hint: '这是 ui-pro 的缺陷，请带上 --debug 重新运行并反馈输出',
        details: debug && stack !== undefined ? { stack } : undefined,
      },
    },
    exitCode: EXIT_INTERNAL,
  };
}

/** Messages of the causes behind `error`, nearest first; empty when it has none. */
export function causeChain(error: unknown): string[] {
  const messages: string[] = [];
  let current = error instanceof Error ? error.cause : undefined;
  while (current !== undefined && messages.length < 10) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

function renderJson(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function renderText(envelope: Envelope): string {
  const lines: string[] = [];
  if (envelope.ok) {
    lines.push(envelope.summary);
    if (envelope.data !== undefined) lines.push(JSON.stringify(envelope.data, null, 2));
    for (const warning of envelope.warnings ?? []) lines.push(`警告：${warning}`);
    for (const question of envelope.ask ?? []) {
      const options = question.options?.length ? `（${question.options.join(' / ')}）` : '';
      lines.push(`需要确认 [${question.id}]：${question.question}${options}`);
    }
    for (const view of envelope.views ?? []) lines.push(`查看：${view}`);
    for (const next of envelope.next ?? []) lines.push(`下一步：${next}`);
  } else {
    const { code, message, hint, details } = envelope.error;
    lines.push(`错误 [${code}]：${message}`);
    if (hint !== undefined) lines.push(`提示：${hint}`);
    if (details !== undefined) lines.push(JSON.stringify(details, null, 2));
  }
  return `${lines.join('\n')}\n`;
}

export function renderEnvelope(envelope: Envelope, format: OutputFormat): string {
  return format === 'json' ? renderJson(envelope) : renderText(envelope);
}
