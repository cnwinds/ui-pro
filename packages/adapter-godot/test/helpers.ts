import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssetManifest,
  type AssetRecord,
  attachChild,
  createScreenDoc,
  type NewNodeFields,
  newNode,
  type ScreenDoc,
  sha256Hex,
  type UINode,
} from '@ui-pro/core';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import type { AssetSource } from '../src';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-godot-test-'));
    created.push(dir);
    return dir;
  };
}

export interface DocOptions {
  name?: string;
  scale?: number;
  size?: [number, number];
}

/** A screen whose nodes are given parents first; `parent` is the id of an earlier node. */
export function makeDoc(nodes: NewNodeFields[], options: DocOptions = {}): ScreenDoc {
  const size = options.size ?? [1080, 1920];
  const doc = createScreenDoc({
    name: options.name ?? 'main',
    source: {
      kind: 'flat',
      file: 'source/main.png',
      width: size[0],
      height: size[1],
      sha256: '0'.repeat(64),
    },
    scale: options.scale ?? 1,
    size,
  });
  for (const fields of nodes) {
    doc.nodes[fields.id] = newNode(fields);
    if (fields.parent !== null) attachChild(doc, fields.parent, fields.id);
  }
  return doc;
}

/** `[node ...]` header lines of a `.tscn` file with the property lines that follow each. */
export function parseTscnNodes(
  text: string,
): { name: string; type: string; parent: string | undefined; body: string }[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith('[node '))
    .map((block) => {
      const [header = '', ...rest] = block.split(/\r?\n/);
      return {
        name: /name="([^"]*)"/.exec(header)?.[1] ?? '',
        type: /type="([^"]*)"/.exec(header)?.[1] ?? '',
        parent: /parent="([^"]*)"/.exec(header)?.[1],
        body: rest.join('\n'),
      };
    });
}

export type Rgba = [number, number, number, number];

/** A PNG filled with one colour. */
export function solidPng(width: number, height: number, [r, g, b, a]: Rgba): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha: a / 255 } },
  })
    .png()
    .toBuffer();
}

/** A PNG painted by `pixel(x, y)`. */
export function paintedPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** One hand-written asset: its pixels and what the manifest says about them. */
export interface AssetInit {
  name: string;
  png: Buffer;
  inset?: AssetRecord['inset'];
  nineSlice?: AssetRecord['nineSlice'];
  approximations?: string[];
  origin?: AssetRecord['origin'];
}

/** Assets as the export reads them, kept in memory; every node that names one is a user. */
export async function memoryAssets(doc: ScreenDoc, inits: AssetInit[]): Promise<AssetSource> {
  const users = (name: string): string[] =>
    Object.values(doc.nodes)
      .filter(
        (node) =>
          node.asset === name || Object.values(node.states ?? {}).some((s) => s.asset === name),
      )
      .map((node) => node.id);
  const assets: AssetRecord[] = [];
  const files = new Map<string, Buffer>();
  for (const init of inits) {
    const meta = await sharp(init.png).metadata();
    files.set(`${init.name}.png`, init.png);
    assets.push({
      name: init.name,
      file: `${init.name}.png`,
      origin: init.origin ?? 'crop',
      uses: users(init.name).map((node) => ({ node })),
      size: [meta.width ?? 0, meta.height ?? 0],
      inset: init.inset ?? [0, 0, 0, 0],
      ...(init.nineSlice ? { nineSlice: init.nineSlice } : {}),
      holes: [],
      steps: [{ step: 'extract', method: 'crop' }],
      sha256: sha256Hex(init.png),
      approximations: init.approximations ?? [],
    });
  }
  const manifest: AssetManifest = {
    format: 'ui-pro/assets',
    version: 1,
    screen: doc.name,
    sourceSha256: doc.source.sha256,
    inputsSha256: 'b'.repeat(64),
    assets,
  };
  return { manifest, read: (record) => files.get(record.file) ?? null };
}

export function nodeAt(doc: ScreenDoc, id: string): UINode {
  const node = doc.nodes[id];
  if (node === undefined) throw new Error(`no node ${id} in the screen`);
  return node;
}
