import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AssetManifest,
  ancestorsOf,
  ErrorCodes,
  type ExpectedHole,
  expectedHoles,
  loadScreen,
  type Ownership,
  type Project,
  pixelOwnership,
  readAssetFile,
  readFileIfExistsSync,
  referenceImagePath,
  resolveInside,
  type ScreenDoc,
  scratchPath,
  screenRelPath,
  toPosix,
  UiProError,
} from '@ui-pro/core';
import { openRenderSession, type ReferenceSession, type RenderResult } from '@ui-pro/renderer';
import { decodeRaster, type Raster, resizeRaster } from './raster';

/**
 * The ground a frame is rendered on for comparison: nothing a screen draws is this colour, so a
 * pixel no asset covers stands out in the difference.
 */
export const FRAME_BACKGROUND = '#ff00ff';

/** Everything the gates share about one screen, loaded on first use. */
export interface GateContext {
  readonly project: Project;
  readonly screen: string;
  readonly doc: ScreenDoc;
  readonly manifest: AssetManifest;
  readonly ownership: ReadonlyMap<string, Ownership>;
  readonly holes: ReadonlyMap<string, ExpectedHole[]>;
  /** The reference image was resampled to the frame's size (it was a pixel off). */
  readonly referenceResized: () => boolean;
  session(): Promise<ReferenceSession>;
  /** The default-state frame at the reference's size, on `FRAME_BACKGROUND`. */
  baseline(): Promise<RenderResult>;
  /** The reference image (基准图), the size of the baseline frame. */
  reference(): Promise<Raster>;
  /** A built asset's pixels; `undefined` when the file is missing or unreadable. */
  asset(name: string): Promise<Raster | undefined>;
  /** A built asset's file as it is on disk; `null` when it is missing. */
  assetBytes(name: string): Uint8Array | null;
  /** Whether the node and all its ancestors are visible in the default state. */
  shown(id: string): boolean;
  /** The screen's `mock.json` as data (`{}` when it has none), without opening a render session. */
  mock(): unknown;
  /** Writes a picture under `.ui-pro/verify/<screen>/` and returns its absolute posix path. */
  writeView(file: string, png: Uint8Array): Promise<string>;
  dispose(): Promise<void>;
}

export function createContext(
  project: Project,
  screen: string,
  manifest: AssetManifest,
): GateContext {
  const doc = loadScreen(project, screen);
  const ownership = pixelOwnership(doc);
  const holes = expectedHoles(doc, ownership);
  const outDir = scratchPath(project.root, 'verify', screen);

  let opened: Promise<ReferenceSession> | undefined;
  let baselineFrame: Promise<RenderResult> | undefined;
  let referenceRaster: Promise<Raster> | undefined;
  let resized = false;
  const assets = new Map<string, Promise<Raster | undefined>>();

  const self: GateContext = {
    project,
    screen,
    doc,
    manifest,
    ownership,
    holes,
    referenceResized: () => resized,
    session() {
      opened ??= openRenderSession(project, screen);
      return opened;
    },
    baseline() {
      baselineFrame ??= self
        .session()
        .then((session) => session.render({ background: FRAME_BACKGROUND }));
      return baselineFrame;
    },
    reference() {
      referenceRaster ??= (async () => {
        const path = resolveInside(project.root, referenceImagePath(doc));
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch (error) {
          throw new UiProError(ErrorCodes.io, `找不到基准图：${referenceImagePath(doc)}`, {
            hint: 'PSD 源文件要先运行 ui-pro analyze 生成合成图',
            cause: error,
          });
        }
        const raster = await decodeRaster(bytes);
        const frame = await self.baseline();
        if (raster.width === frame.width && raster.height === frame.height) return raster;
        resized = true;
        return resizeRaster(raster, frame.width, frame.height);
      })();
      return referenceRaster;
    },
    assetBytes(name) {
      const record = manifest.assets.find((entry) => entry.name === name);
      return record ? readAssetFile(project, screen, record.file) : null;
    },
    asset(name) {
      let found = assets.get(name);
      if (!found) {
        const bytes = self.assetBytes(name);
        found =
          bytes === null ? Promise.resolve(undefined) : decodeRaster(bytes).catch(() => undefined);
        assets.set(name, found);
      }
      return found;
    },
    shown(id) {
      const node = doc.nodes[id];
      if (!node || node.visible === false) return false;
      return ancestorsOf(doc, id).every((ancestor) => doc.nodes[ancestor]?.visible !== false);
    },
    mock() {
      const path = screenRelPath(screen, 'mock');
      const bytes = readFileIfExistsSync(join(project.root, ...path.split('/')));
      if (bytes === null) return {};
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        throw new UiProError(ErrorCodes.docInvalid, `${path} 不是合法的 JSON`, { cause: error });
      }
    },
    async writeView(file, png) {
      const path = `${outDir}/${file}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
      return toPosix(path);
    },
    async dispose() {
      const session = await opened?.catch(() => undefined);
      session?.dispose();
    },
  };
  return self;
}
