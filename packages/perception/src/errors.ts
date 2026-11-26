/** Error codes owned by the perception package, on top of the kernel's `ErrorCodes`. */
export const PerceptionErrorCodes = {
  alreadyAnalyzed: 'E_ALREADY_ANALYZED',
  sourceKind: 'E_SOURCE_KIND',
  ocrFailed: 'E_OCR_FAILED',
  referenceMissing: 'E_REFERENCE_MISSING',
  lookTarget: 'E_LOOK_TARGET',
  lookNoEvidence: 'E_LOOK_NO_EVIDENCE',
} as const;
