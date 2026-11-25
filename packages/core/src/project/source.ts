import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { isNodeError } from '../fs/files';
import { sha256Hex } from '../hash';
import { toPosix } from '../paths';
import { parseWithSchema } from '../schema/codec';

const FLAT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PSD_HEADER_BYTES = 26;
const DELIVERY_MANIFEST = 'manifest.json';

const SUPPORTED_HINT = '支持 png/jpg/jpeg/webp 单图、.psd 文件，或含 manifest.json 的交付包目录';

/** Only what the kernel needs from a delivery package manifest; the psd package owns the rest. */
const DeliveryManifestSchema = z.object({
  format: z.literal('ui-pro-delivery'),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export interface SourceFile {
  /** Posix path relative to the screen's `source/` directory. */
  path: string;
  content: Uint8Array;
}

export interface InspectedSource {
  kind: 'flat' | 'psd';
  /** Entry name inside `source/`: `ui.png`, `ui.psd`, or the package directory name. */
  entry: string;
  width: number;
  height: number;
  sha256: string;
  files: SourceFile[];
}

function unsupported(message: string, cause?: unknown): UiProError {
  return new UiProError(ErrorCodes.sourceUnsupported, message, { hint: SUPPORTED_HINT, cause });
}

/** Width and height from the fixed-size PSD file header. */
export function readPsdHeader(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (bytes.byteLength < PSD_HEADER_BYTES || signature !== '8BPS') {
    throw unsupported('不是有效的 PSD 文件（文件头不是 8BPS）');
  }
  if (view.getUint16(4) !== 1) throw unsupported('不支持 PSB 大文档格式，请导出为 PSD');
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  if (width === 0 || height === 0) throw unsupported('PSD 文件头里的画布尺寸为 0');
  return { width, height };
}

async function inspectFlat(path: string, extension: string): Promise<InspectedSource> {
  const content = await readFile(path);
  let metadata: Metadata;
  try {
    metadata = await sharp(content).metadata();
  } catch (cause) {
    throw unsupported(`无法读取图片：${toPosix(path)}`, cause);
  }
  if (!metadata.width || !metadata.height) throw unsupported(`读不到图片尺寸：${toPosix(path)}`);
  const entry = `ui${extension}`;
  return {
    kind: 'flat',
    entry,
    width: metadata.width,
    height: metadata.height,
    sha256: sha256Hex(content),
    files: [{ path: entry, content }],
  };
}

async function inspectPsd(path: string): Promise<InspectedSource> {
  const content = await readFile(path);
  const { width, height } = readPsdHeader(content);
  return {
    kind: 'psd',
    entry: 'ui.psd',
    width,
    height,
    sha256: sha256Hex(content),
    files: [{ path: 'ui.psd', content }],
  };
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(dir, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

async function inspectPackage(dir: string): Promise<InspectedSource> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(dir, DELIVERY_MANIFEST));
  } catch (cause) {
    throw unsupported(`目录不是交付包（缺少 ${DELIVERY_MANIFEST}）：${toPosix(dir)}`, cause);
  }
  let manifest: z.infer<typeof DeliveryManifestSchema>;
  try {
    manifest = parseWithSchema(
      DeliveryManifestSchema,
      JSON.parse(manifestBytes.toString('utf8')),
      DELIVERY_MANIFEST,
    );
  } catch (cause) {
    throw unsupported(`交付包的 ${DELIVERY_MANIFEST} 无效：${toPosix(dir)}`, cause);
  }
  const files: SourceFile[] = [];
  for (const path of await listFiles(dir)) {
    files.push({ path: `${basename(dir)}/${path}`, content: await readFile(join(dir, path)) });
  }
  return {
    kind: 'psd',
    entry: basename(dir),
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    sha256: sha256Hex(manifestBytes),
    files,
  };
}

/**
 * Reads a source (flat image, PSD, or delivery package directory), determines its canvas size and
 * content hash, and returns the files to copy into the screen's `source/` directory.
 */
export async function inspectSource(path: string): Promise<InspectedSource> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw unsupported(`源文件不存在：${toPosix(path)}`, error);
    }
    throw ioError('读取源文件', path, error);
  }
  if (info.isDirectory()) return inspectPackage(path);

  const extension = extname(path).toLowerCase();
  if (FLAT_EXTENSIONS.has(extension)) return inspectFlat(path, extension);
  if (extension === '.psd') return inspectPsd(path);
  throw unsupported(`不支持的源文件类型 ${extension || '（无扩展名）'}：${toPosix(path)}`);
}
