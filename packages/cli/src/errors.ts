import { ErrorCodes, UiProError } from '@ui-pro/core';

/** The command line itself was wrong (unknown option, bad argument); exits with code 2. */
export class UsageError extends UiProError {
  constructor(message: string, hint?: string) {
    super(ErrorCodes.usage, message, { hint });
    this.name = 'UsageError';
  }
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 3;
