/** Error codes owned by the perception package, on top of the kernel's `ErrorCodes`. */
export const PerceptionErrorCodes = {
  alreadyAnalyzed: 'E_ALREADY_ANALYZED',
  sourceKind: 'E_SOURCE_KIND',
  ocrFailed: 'E_OCR_FAILED',
  referenceMissing: 'E_REFERENCE_MISSING',
  lookTarget: 'E_LOOK_TARGET',
  lookNoEvidence: 'E_LOOK_NO_EVIDENCE',
  /** A local model could not be downloaded or failed its hash check. */
  modelUnavailable: 'E_MODEL_UNAVAILABLE',
  /** The screen's cloud image calls reached `budget.image_calls_per_screen`; ask the user. */
  imageBudget: 'E_IMAGE_BUDGET',
  /** The cloud image model refused, failed, or every candidate failed the checks of §6.6. */
  cloudImage: 'E_CLOUD_IMAGE',
  /** `build --locked` needed a model output that is not locked. */
  notLocked: 'E_NOT_LOCKED',
} as const;
