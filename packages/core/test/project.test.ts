import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Psd, writePsdBuffer } from 'ag-psd';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  addScreen,
  createProject,
  defaultScreen,
  ErrorCodes,
  listHistory,
  listScreens,
  loadProject,
  loadScreen,
  openProject,
  readCandidates,
  readPsdHeader,
  resolveInside,
  roundRect,
  sha256Hex,
  sourceToDesign,
  validateScreen,
} from '../src';
import {
  emptyScreenProject,
  failureOf,
  failureOfSync,
  readText,
  useTempDirs,
  writePng,
} from './helpers';

const makeDir = useTempDirs();

const codeOf = async (promise: Promise<unknown>) => (await failureOf(promise)).code;
const codeOfSync = (fn: () => unknown) => failureOfSync(fn).code;

describe('createProject', () => {
  it('lays out the project directory with defaults', async () => {
    const root = join(await makeDir(), 'game');

    const project = await createProject(root);

    expect(project.config).toMatchObject({
      name: 'game',
      design: { width: 1080, height: 1920 },
      engine: 'godot',
      egress: 'cloud',
    });
    for (const file of ['ui-pro.yaml', 'glossary.yaml', 'rules/project.yaml', '.gitignore']) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    for (const dir of ['kit', 'rules', 'screens', 'resources', 'export', 'history', '.ui-pro']) {
      expect(existsSync(join(root, dir)), dir).toBe(true);
    }
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.ui-pro/\n');
    expect(loadProject(root).config).toEqual(project.config);
  });

  it('honours name, design and engine options', async () => {
    const root = join(await makeDir(), 'game');

    const project = await createProject(root, {
      name: 'Candy',
      design: { width: 720, height: 1280 },
      engine: 'godot',
    });

    expect(project.config.name).toBe('Candy');
    expect(project.config.design).toEqual({ width: 720, height: 1280 });
    expect(await readText(project, 'ui-pro.yaml')).toContain('width: 720');
  });

  it('refuses to overwrite an existing project', async () => {
    const root = join(await makeDir(), 'game');
    await createProject(root);

    expect(await codeOf(createProject(root))).toBe(ErrorCodes.projectExists);
  });

  it('refuses a target that is a file', async () => {
    const file = join(await makeDir(), 'file.txt');
    await writeFile(file, 'x');

    expect(await codeOf(createProject(file))).toBe(ErrorCodes.io);
  });

  it('adds the scratch directory to an existing .gitignore exactly once', async () => {
    const root = join(await makeDir(), 'game');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.gitignore'), 'node_modules/');

    await createProject(root);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.ui-pro/\n');

    const other = join(await makeDir(), 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, '.gitignore'), '.ui-pro/\n');
    await createProject(other);
    expect(await readFile(join(other, '.gitignore'), 'utf8')).toBe('.ui-pro/\n');
  });
});

describe('openProject', () => {
  it('finds the project from a nested directory', async () => {
    const root = join(await makeDir(), 'game');
    await createProject(root);
    const nested = join(root, 'screens');

    expect(openProject(undefined, nested).root).toBe(root);
  });

  it('opens an explicit directory, resolved against the working directory', async () => {
    const base = await makeDir();
    await createProject(join(base, 'game'));

    expect(openProject('game', base).root).toBe(join(base, 'game'));
  });

  it('reports a missing project', async () => {
    const empty = await makeDir();

    expect(codeOfSync(() => openProject(undefined, empty))).toBe(ErrorCodes.projectNotFound);
    expect(codeOfSync(() => openProject(empty, empty))).toBe(ErrorCodes.projectNotFound);
  });

  it('reports an unreadable ui-pro.yaml', async () => {
    const root = join(await makeDir(), 'game');
    await createProject(root);
    await writeFile(join(root, 'ui-pro.yaml'), 'format: wrong\n');

    expect(codeOfSync(() => openProject(root, root))).toBe(ErrorCodes.docInvalid);
  });
});

describe('addScreen', () => {
  it('creates a screen from a PNG, scaling to the design width', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const png = join(root, 'shot.png');
    await writePng(png, 438, 652);

    const added = await addScreen(project, { name: 'main', source: png });

    const scale = 1080 / 438;
    expect(added.version).toBe(1);
    expect(added.screen.source).toEqual({
      kind: 'flat',
      file: 'source/ui.png',
      width: 438,
      height: 652,
      sha256: sha256Hex(await readFile(png)),
    });
    expect(added.screen.scale).toBeCloseTo(scale, 10);
    expect(added.screen.size).toEqual([1080, Math.round(652 * scale)]);
    expect(added.screen.nodes.root?.rect).toEqual([0, 0, 1080, Math.round(652 * scale)]);
    expect(added.files).toEqual([
      'screens/main/behavior.yaml',
      'screens/main/mock.json',
      'screens/main/rules.yaml',
      'screens/main/screen.uir.json',
      'screens/main/source/ui.png',
    ]);
    expect(await readFile(join(project.root, 'screens/main/source/ui.png'))).toEqual(
      await readFile(png),
    );
    expect(existsSync(join(project.root, 'screens/main/evidence'))).toBe(true);
    expect(existsSync(join(project.root, 'screens/main/assets'))).toBe(true);
    expect(validateScreen(loadScreen(project, 'main'))).toEqual([]);
  });

  it('records the new screen as a history version', async () => {
    const { project } = await emptyScreenProject(makeDir);

    const [entry] = listHistory(project);

    expect(entry).toMatchObject({
      version: 1,
      message: '新增界面 main',
      live: true,
      source: 'cli',
    });
  });

  it('accepts JPEG and WebP sources and keeps their extension', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const base = sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } });
    await writeFile(join(root, 'a.jpg'), await base.clone().jpeg().toBuffer());
    await writeFile(join(root, 'b.jpeg'), await base.clone().jpeg().toBuffer());
    await writeFile(join(root, 'c.webp'), await base.clone().webp().toBuffer());

    const files = [];
    for (const [name, file] of [
      ['shot_a', 'a.jpg'],
      ['shot_b', 'b.jpeg'],
      ['shot_c', 'c.webp'],
    ] as const) {
      const added = await addScreen(project, { name, source: join(root, file) });
      files.push(added.screen.source.file);
    }

    expect(files).toEqual(['source/ui.jpg', 'source/ui.jpeg', 'source/ui.webp']);
    expect(listScreens(project)).toEqual(['shot_a', 'shot_b', 'shot_c']);
  });

  it('creates a screen from a PSD, reading the canvas size from its header', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const psd: Psd = {
      width: 200,
      height: 300,
      children: [
        {
          name: 'bg',
          left: 0,
          top: 0,
          imageData: { width: 200, height: 300, data: new Uint8ClampedArray(200 * 300 * 4) },
        },
        {
          name: 'dot',
          left: 5,
          top: 5,
          imageData: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
        },
      ],
    };
    const bytes = writePsdBuffer(psd);
    await writeFile(join(root, 'ui.psd'), bytes);

    const added = await addScreen(project, { name: 'hud', source: join(root, 'ui.psd') });

    expect(added.screen.source).toMatchObject({
      kind: 'psd',
      file: 'source/ui.psd',
      width: 200,
      height: 300,
      sha256: sha256Hex(bytes),
    });
    expect(added.screen.scale).toBe(1080 / 200);
    expect(added.screen.size).toEqual([1080, 1620]);
    expect(existsSync(join(project.root, 'screens/hud/source/ui.psd'))).toBe(true);
    expect(readPsdHeader(bytes)).toEqual({ width: 200, height: 300 });
  });

  it('creates a screen from a delivery package directory', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const pkg = join(root, 'delivery-v3');
    await mkdir(join(pkg, 'layers'), { recursive: true });
    const manifest = JSON.stringify({
      format: 'ui-pro-delivery',
      canvas: { width: 750, height: 1334 },
      layers: [],
    });
    await writeFile(join(pkg, 'manifest.json'), manifest);
    await writePng(join(pkg, 'layers', 'a.png'), 4, 4);

    const added = await addScreen(project, { name: 'shop', source: pkg });

    expect(added.screen.source).toEqual({
      kind: 'psd',
      file: 'source/delivery-v3',
      width: 750,
      height: 1334,
      sha256: sha256Hex(Buffer.from(manifest)),
    });
    expect(added.files).toContain('screens/shop/source/delivery-v3/manifest.json');
    expect(added.files).toContain('screens/shop/source/delivery-v3/layers/a.png');
    expect(added.screen.size).toEqual([1080, Math.round(1334 * (1080 / 750))]);
  });

  it('rejects sources it cannot use with E_SOURCE_UNSUPPORTED', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const header = Buffer.alloc(26);
    header.write('8BPS', 0);
    header.writeUInt16BE(2, 4);
    const emptyDir = join(root, 'empty-dir');
    await mkdir(emptyDir);
    const badManifest = join(root, 'bad-manifest');
    await mkdir(badManifest);
    await writeFile(join(badManifest, 'manifest.json'), '{"format":"other"}');
    await writeFile(
      join(root, 'junk.psd'),
      'not a psd at all, but long enough to have a header....',
    );
    await writeFile(join(root, 'psb.psd'), header);
    await writeFile(join(root, 'broken.png'), 'definitely not a png');
    await writeFile(join(root, 'anim.gif'), 'GIF89a');

    const sources = [
      'missing.png',
      'junk.psd',
      'psb.psd',
      'broken.png',
      'anim.gif',
      'empty-dir',
      'bad-manifest',
    ];
    for (const source of sources) {
      const code = await codeOf(addScreen(project, { name: 'main', source: join(root, source) }));
      expect(code, source).toBe(ErrorCodes.sourceUnsupported);
    }
    expect(listScreens(project)).toEqual([]);
    expect(listHistory(project)).toEqual([]);
  });

  it('rejects invalid screen names', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const png = join(root, 'shot.png');
    await writePng(png, 10, 10);

    for (const name of ['Main', '1main', 'a/b', '..', '', 'a b']) {
      expect(await codeOf(addScreen(project, { name, source: png })), name).toBe(
        ErrorCodes.nameInvalid,
      );
    }
  });

  it('refuses to add the same screen twice and leaves the first intact', async () => {
    const { project } = await emptyScreenProject(makeDir);
    const before = await readText(project, 'screens/main/screen.uir.json');
    const png = join(project.root, 'again.png');
    await writePng(png, 10, 10);

    expect(await codeOf(addScreen(project, { name: 'main', source: png }))).toBe(
      ErrorCodes.screenExists,
    );

    expect(await readText(project, 'screens/main/screen.uir.json')).toBe(before);
    expect(listHistory(project)).toHaveLength(1);
  });
});

describe('screens and evidence', () => {
  it('lists screens sorted and resolves the default screen', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'));
    const png = join(root, 'shot.png');
    await writePng(png, 10, 10);
    expect(defaultScreen(project)).toBeUndefined();

    await addScreen(project, { name: 'zeta', source: png });
    expect(defaultScreen(project)).toBe('zeta');

    await addScreen(project, { name: 'alpha', source: png });
    expect(listScreens(project)).toEqual(['alpha', 'zeta']);
    expect(defaultScreen(project)).toBeUndefined();
    expect(defaultScreen(project, 'alpha')).toBe('alpha');
    expect(codeOfSync(() => defaultScreen(project, 'nope'))).toBe(ErrorCodes.screenNotFound);
  });

  it('does not let a screen name escape the project', async () => {
    const { project } = await emptyScreenProject(makeDir);

    expect(codeOfSync(() => loadScreen(project, '../x'))).toBe(ErrorCodes.screenNotFound);
    expect(codeOfSync(() => loadScreen(project, 'missing'))).toBe(ErrorCodes.screenNotFound);
    expect(codeOfSync(() => resolveInside(project.root, '../outside.txt'))).toBe(
      ErrorCodes.invariant,
    );
    expect(resolveInside(project.root, '..name/file')).toBe(join(project.root, '..name', 'file'));
  });

  it('reads candidate evidence when present and null before analysis', async () => {
    const { project } = await emptyScreenProject(makeDir);
    expect(readCandidates(project, 'main')).toBeNull();

    const doc = {
      format: 'ui-pro/candidates',
      version: 1,
      sourceSha256: 'c'.repeat(64),
      candidates: [{ id: 'cand#1', source: 'cv', bbox: [10, 20, 30, 40] }],
      clusters: [],
    };
    await writeFile(
      join(project.root, 'screens/main/evidence/candidates.json'),
      JSON.stringify(doc),
    );

    expect(readCandidates(project, 'main')?.candidates[0]?.bbox).toEqual([10, 20, 30, 40]);
  });

  it('converts source rectangles to design space and rounds them', () => {
    expect(sourceToDesign([10, 20, 30, 40], 2.5)).toEqual([25, 50, 75, 100]);
    expect(roundRect([1 / 3, 2 / 3, 10.005, 4])).toEqual([0.33, 0.67, 10.01, 4]);
    expect(roundRect([1.23456, 0, 0, 0], 0)[0]).toBe(1);
  });
});
