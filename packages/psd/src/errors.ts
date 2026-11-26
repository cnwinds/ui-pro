export const PsdErrorCodes = {
  /** Input grade below A without `allowDegraded`. */
  grade: 'E_PSD_GRADE',
  /** The file cannot be read as a PSD at all. */
  unreadable: 'E_PSD_UNREADABLE',
  /** The screen's source is not a PSD file. */
  source: 'E_PSD_SOURCE',
  /** `psd.prefixes` in the project config is malformed. */
  config: 'E_PSD_CONFIG',
  /** The renderer needs the network but the project's egress level forbids it. */
  egress: 'E_PSD_EGRESS',
  noBrowser: 'E_PSD_NO_BROWSER',
  photopeaUnreachable: 'E_PSD_PHOTOPEA_UNREACHABLE',
  renderTimeout: 'E_PSD_RENDER_TIMEOUT',
  renderFailed: 'E_PSD_RENDER_FAILED',
} as const;

/** Codes that mean "the renderer could not run", as opposed to a problem with the PSD itself. */
export const RENDERER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  PsdErrorCodes.egress,
  PsdErrorCodes.noBrowser,
  PsdErrorCodes.photopeaUnreachable,
  PsdErrorCodes.renderTimeout,
  PsdErrorCodes.renderFailed,
]);
