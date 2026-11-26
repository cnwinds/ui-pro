import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssetManifest,
  type AssetRecord,
  addScreen,
  applyOps,
  attachChild,
  createProject,
  type Exclusion,
  loadProject,
  loadScreen,
  newNode,
  type Primitive,
  type Project,
  projectConfigCodec,
  type Rect,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
  sha256Hex,
  type UINode,
} from '@ui-pro/core';
import sharp from 'sharp';
import { afterEach } from 'vitest';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-renderer-test-'));
    created.push(dir);
    return dir;
  };
}

export type Rgba = [number, number, number, number];

/** A PNG filled with one colour. */
export async function solidPng(width: number, height: number, [r, g, b, a]: Rgba): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha: a / 255 } },
  })
    .png()
    .toBuffer();
}

/** A PNG from straight RGBA pixels. */
export async function rawPng(width: number, height: number, data: Uint8Array): Promise<Buffer> {
  return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** A PNG painted by `pixel(x, y)`. */
export async function paintedPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
): Promise<Buffer> {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return rawPng(width, height, data);
}

export interface NodeInit extends Partial<Omit<UINode, 'id' | 'type' | 'rect' | 'parent'>> {
  id: string;
  type: Primitive;
  rect: Rect;
  /** Defaults to the root. */
  parent?: string;
}

export interface AssetInit {
  name: string;
  png: Buffer;
  /** Nodes drawn with it; defaults to the node of the same name. */
  uses?: string[];
  inset?: AssetRecord['inset'];
  nineSlice?: AssetRecord['nineSlice'];
  holes?: AssetRecord['holes'];
  approximations?: string[];
  atlas?: string;
}

export interface FixtureInit {
  /** Design size and source size: scale 1, so design and image pixels coincide. */
  width: number;
  height: number;
  nodes?: NodeInit[];
  assets?: AssetInit[];
  exclusions?: Exclusion[];
  mock?: unknown;
  /** Written as the source image; a flat grey when absent. */
  source?: Buffer;
  /** Size of the source image when it is not the design size (the screen scale is then not 1). */
  sourceSize?: [number, number];
  /** Font name -> project file, written into `ui-pro.yaml`'s `fonts`. */
  fonts?: Record<string, string>;
  /** Decorates the screen document before it is written. */
  patch?: (doc: ScreenDoc) => void;
}

export interface Fixture {
  project: Project;
  screen: string;
  root: string;
}

function recordOf(asset: AssetInit, size: [number, number]): AssetRecord {
  return {
    name: asset.name,
    file: `${asset.name}.png`,
    origin: 'crop',
    uses: (asset.uses ?? [asset.name]).map((node) => ({ node })),
    size,
    inset: asset.inset ?? [0, 0, 0, 0],
    ...(asset.nineSlice ? { nineSlice: asset.nineSlice } : {}),
    holes: asset.holes ?? [],
    steps: [{ step: 'extract', method: 'crop' }],
    ...(asset.atlas ? { atlas: asset.atlas } : {}),
    sha256: sha256Hex(asset.png),
    approximations: asset.approximations ?? [],
  };
}

/**
 * A project with one screen `main` (scale 1, `width` x `height`), the given nodes in the screen
 * document, and the given assets committed through `applyOps` the way a build commits them. Nodes
 * are listed parents first; each is appended to its parent's children, back to front.
 */
export async function createFixture(
  makeDir: () => Promise<string>,
  init: FixtureInit,
): Promise<Fixture> {
  const root = await makeDir();
  const project = await createProject(join(root, 'proj'), {
    name: 'demo',
    design: { width: init.width, height: init.height },
  });
  const sourcePath = join(root, 'main.png');
  const [sourceWidth, sourceHeight] = init.sourceSize ?? [init.width, init.height];
  await writeFile(
    sourcePath,
    init.source ?? (await solidPng(sourceWidth, sourceHeight, [128, 128, 128, 255])),
  );
  await addScreen(project, { name: 'main', source: sourcePath });

  const doc = loadScreen(project, 'main');
  for (const spec of init.nodes ?? []) {
    const { parent, ...fields } = spec;
    const node = newNode({ ...fields, parent: parent ?? doc.root });
    doc.nodes[node.id] = node;
    attachChild(doc, parent ?? doc.root, node.id);
  }
  if (init.exclusions) doc.exclusions = init.exclusions;
  init.patch?.(doc);
  await writeFile(
    join(project.root, ...screenRelPath('main', 'doc').split('/')),
    serializeScreen(doc),
  );
  if (init.mock !== undefined) {
    await writeFile(
      join(project.root, ...screenRelPath('main', 'mock').split('/')),
      JSON.stringify(init.mock),
    );
  }
  if (init.fonts) {
    await writeFile(
      join(project.root, 'ui-pro.yaml'),
      projectConfigCodec.serialize({ ...project.config, fonts: init.fonts }),
    );
  }
  const opened = loadProject(project.root);
  if (init.assets && init.assets.length > 0) {
    const records: AssetRecord[] = [];
    for (const asset of init.assets) {
      const meta = await sharp(asset.png).metadata();
      records.push(recordOf(asset, [meta.width ?? 0, meta.height ?? 0]));
    }
    const manifest: AssetManifest = {
      format: 'ui-pro/assets',
      version: 1,
      screen: 'main',
      sourceSha256: doc.source.sha256,
      inputsSha256: 'b'.repeat(64),
      assets: records,
    };
    await applyOps(project, [], {
      assets: {
        main: {
          manifest,
          files: init.assets.map((asset) => ({ path: `${asset.name}.png`, content: asset.png })),
        },
      },
    });
  }
  return { project: opened, screen: 'main', root };
}

/** The straight RGBA pixel at `(x, y)` of a render result. */
export function pixelAt(frame: { width: number; data: Uint8Array }, x: number, y: number): Rgba {
  const at = (y * frame.width + x) * 4;
  return [
    frame.data[at] ?? 0,
    frame.data[at + 1] ?? 0,
    frame.data[at + 2] ?? 0,
    frame.data[at + 3] ?? 0,
  ];
}
