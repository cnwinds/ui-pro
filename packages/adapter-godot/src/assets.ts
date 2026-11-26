import { existsSync } from 'node:fs';
import {
  type AssetManifest,
  type AssetRecord,
  type Project,
  readAssetFile,
  readAssetManifest,
  resolveInside,
} from '@ui-pro/core';

/**
 * Where the export gets the built assets: the screen's manifest and the bytes of each file. The
 * adapter does not care where they live; tests hand it hand-written ones.
 */
export interface AssetSource {
  /** `null` before the first build; every node that draws an asset is then reported missing. */
  manifest: AssetManifest | null;
  /** The file's PNG bytes, or `null` when it is missing. */
  read(record: AssetRecord): Uint8Array | null | Promise<Uint8Array | null>;
}

/** The assets a UI-Pro project holds for `screen`. */
export function projectAssetSource(project: Project, screen: string): AssetSource {
  return {
    manifest: readAssetManifest(project, screen),
    read: (record) => readAssetFile(project, screen, record.file),
  };
}

/**
 * The project's fonts that can be exported: font name -> absolute path of the font file. A font
 * whose file is missing or outside the project is left out, so the export reports it.
 */
export function projectFonts(project: Project): Record<string, string> {
  const fonts: Record<string, string> = {};
  for (const [name, file] of Object.entries(project.config.fonts)) {
    try {
      const path = resolveInside(project.root, file);
      if (existsSync(path)) fonts[name] = path;
    } catch {
      // A path outside the project is not exported.
    }
  }
  return fonts;
}
