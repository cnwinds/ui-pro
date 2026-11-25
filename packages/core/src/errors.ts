export const ErrorCodes = {
  projectNotFound: 'E_PROJECT_NOT_FOUND',
  projectExists: 'E_PROJECT_EXISTS',
  screenNotFound: 'E_SCREEN_NOT_FOUND',
  screenExists: 'E_SCREEN_EXISTS',
  sourceUnsupported: 'E_SOURCE_UNSUPPORTED',
  nameInvalid: 'E_NAME_INVALID',
  selectorSyntax: 'E_SELECTOR_SYNTAX',
  selectorEmpty: 'E_SELECTOR_EMPTY',
  selectorAmbiguous: 'E_SELECTOR_AMBIGUOUS',
  opUnknown: 'E_OP_UNKNOWN',
  opInvalid: 'E_OP_INVALID',
  nodeExists: 'E_NODE_EXISTS',
  nodeNotFound: 'E_NODE_NOT_FOUND',
  invariant: 'E_INVARIANT',
  locked: 'E_LOCKED',
  historyEmpty: 'E_HISTORY_EMPTY',
  historyConflict: 'E_HISTORY_CONFLICT',
  versionNotFound: 'E_VERSION_NOT_FOUND',
  docNotFound: 'E_DOC_NOT_FOUND',
  docInvalid: 'E_DOC_INVALID',
  notImplemented: 'E_NOT_IMPLEMENTED',
  usage: 'E_USAGE',
  io: 'E_IO',
  internal: 'E_INTERNAL',
} as const;

export interface UiProErrorOptions {
  /** Actionable next step for the user or agent (Simplified Chinese). */
  hint?: string;
  /** Machine-readable context. Must be JSON-serializable. */
  details?: unknown;
  cause?: unknown;
}

/**
 * The only error type the kernel throws on purpose. `code` is stable and meant for programs;
 * `message` and `hint` are written for people.
 */
export class UiProError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options: UiProErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UiProError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function isUiProError(value: unknown): value is UiProError {
  return value instanceof UiProError;
}

/** Returns a copy of `error` whose object-valued `details` also carries `extra`. */
export function withErrorDetails(error: UiProError, extra: Record<string, unknown>): UiProError {
  const base =
    typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : error.details === undefined
        ? {}
        : { value: error.details };
  return new UiProError(error.code, error.message, {
    hint: error.hint,
    details: { ...base, ...extra },
    cause: error.cause,
  });
}

export function ioError(action: string, path: string, cause: unknown): UiProError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new UiProError(ErrorCodes.io, `${action}失败：${path}（${reason}）`, { cause });
}
