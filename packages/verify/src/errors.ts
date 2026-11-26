/** Error codes of this package, `E_` + upper snake case like the kernel's. */
export const VerifyErrorCodes = {
  /** The screen has no asset manifest: nothing to verify yet. */
  notBuilt: 'E_NOT_BUILT',
  /** Export asked for a verify result that is missing, failed, or out of date. */
  notVerified: 'E_NOT_VERIFIED',
} as const;
