/** Error codes owned by the build package, on top of the kernel's `ErrorCodes`. */
export const BuildErrorCodes = {
  /** The screen's decisions are incomplete or ambiguous; the build cannot read them. */
  decisions: 'E_BUILD_DECISIONS',
  /** The screen has no evidence yet. */
  notAnalyzed: 'E_BUILD_NOT_ANALYZED',
  /** A locked model output does not match the hash the lock file recorded for it. */
  lockMismatch: 'E_BUILD_LOCK_MISMATCH',
  /** `--final` was asked for, but no cloud image model can be used. */
  noCloud: 'E_BUILD_NO_CLOUD',
} as const;
