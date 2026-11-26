import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DesignSize,
  loadScreen,
  type Project,
  readFileIfExists,
  type ScreenDoc,
  toPosix,
  UiProError,
  writeFileAtomic,
} from '@ui-pro/core';
import { type AssetSource, projectAssetSource, projectFonts } from './assets';
import { GodotErrorCodes } from './errors';
import { assertCleanRun, type GodotInstall, locateGodot, runGodot } from './godot';
import { type BuilderSpec, fontFile, planExport, sceneFile, toResPath } from './plan';
import { inspectGodotTarget, prepareGodotProject } from './project';
import {
  buildErrorMessage,
  conflictMessage,
  type ExportReport,
  parseBuilderResult,
} from './report';
import { meanAbsDiff, takeShot } from './shot';

const ADDON_DIR = 'addons/ui_pro';
const BUILDER_SCRIPT = 'builder.gd';
const SHOT_SCRIPT = 'shot.gd';

const DEFAULT_TIMEOUTS = { import: 120_000, build: 60_000, shot: 60_000 };

export interface ExportShotOptions {
  /** Absolute path of the PNG to write. */
  file: string;
  /** Absolute path of the reference image to compare the shot with. */
  reference: string;
}

export interface ExportScreenOptions {
  doc: ScreenDoc;
  /** Name for the Godot project when this export has to create one. */
  projectName: string;
  design: DesignSize;
  /** Absolute path of the Godot project. */
  target: string;
  assets: AssetSource;
  /** Font name -> absolute path of the font file; the ones the screen uses are copied in. */
  fonts?: Readonly<Record<string, string>>;
  /** Pixel-art style (the precheck's style profile): textures use nearest-texel sampling. */
  pixelArt?: boolean;
  /** Builds the scene from scratch instead of updating the one already there. */
  freshScene?: boolean;
  /** Skips looking for Godot. */
  godot?: GodotInstall;
  env?: NodeJS.ProcessEnv;
  shot?: ExportShotOptions;
  timeoutMs?: Partial<typeof DEFAULT_TIMEOUTS>;
}

export interface ExportResult {
  report: ExportReport;
  /** A new Godot project was created in the target directory. */
  createdProject: boolean;
  godot: { executable: string; version: string };
  timings: { importMs: number; buildMs: number; shotMs?: number };
  shot?: { file: string; width: number; height: number; meanDiff: number };
}

/** Writes `content` unless the file already has exactly these bytes, so mtimes stay put. */
async function writeIfChanged(path: string, content: Uint8Array): Promise<void> {
  const existing = await readFileIfExists(path);
  if (existing !== null && Buffer.compare(existing, content) === 0) return;
  await writeFileAtomic(path, content);
}

function addonScript(name: string): string {
  return fileURLToPath(new URL(`../godot/${ADDON_DIR}/${name}`, import.meta.url));
}

async function copyAddonScript(target: string, name: string): Promise<string> {
  const relative = `${ADDON_DIR}/${name}`;
  await writeIfChanged(join(target, ...relative.split('/')), await readFile(addonScript(name)));
  return relative;
}

/**
 * Exports one screen into a Godot project: writes the assets, lets the engine import them,
 * builds or updates the scene with the in-engine builder, and optionally takes a screenshot.
 */
export async function exportScreen(options: ExportScreenOptions): Promise<ExportResult> {
  const { doc, target } = options;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeoutMs };
  await inspectGodotTarget(target);
  const install = options.godot ?? (await locateGodot(options.env));
  const prepared = await prepareGodotProject(target, {
    name: options.projectName,
    width: options.design.width,
    height: options.design.height,
  });
  const files = new Set(prepared.files);

  // Every asset the screen's nodes name, read once; the plan decides which of them are drawn.
  const manifest = options.assets.manifest;
  const bytes = new Map<string, Uint8Array>();
  const wanted = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    if (node.asset !== undefined) wanted.add(node.asset);
    for (const state of Object.values(node.states ?? {})) {
      if (state.asset !== undefined) wanted.add(state.asset);
    }
  }
  for (const record of manifest?.assets ?? []) {
    if (!wanted.has(record.name)) continue;
    const content = await options.assets.read(record);
    if (content !== null) bytes.set(record.name, content);
  }

  const fonts: Record<string, string> = {};
  for (const node of Object.values(doc.nodes)) {
    const name = node.text?.font;
    const source = name === undefined ? undefined : options.fonts?.[name];
    if (name === undefined || source === undefined || fonts[name] !== undefined) continue;
    const file = fontFile(name, extname(source).toLowerCase());
    await writeIfChanged(join(target, ...file.split('/')), await readFile(source));
    fonts[name] = toResPath(file);
    files.add(file);
  }

  const plan = planExport(doc, {
    manifest,
    files: new Set(bytes.keys()),
    fonts,
    pixelArt: options.pixelArt,
  });
  for (const asset of plan.assets) {
    const content = bytes.get(asset.name);
    if (content === undefined) continue;
    await writeIfChanged(join(target, ...asset.file.split('/')), content);
    files.add(asset.file);
  }
  files.add(await copyAddonScript(target, BUILDER_SCRIPT));
  files.add(await copyAddonScript(target, SHOT_SCRIPT));
  if (options.freshScene)
    await rm(join(target, ...sceneFile(doc.name).split('/')), { force: true });

  const imported = await runGodot(
    install,
    'import',
    ['--headless', '--path', target, '--import'],
    timeouts.import,
  );
  assertCleanRun('import', imported.run, imported.errors);

  const built = await runBuilder(
    install,
    target,
    { version: 1, screen: doc.name, scene: toResPath(plan.scene), nodes: plan.nodes },
    timeouts.build,
  );
  files.add(plan.scene);

  const report: ExportReport = {
    format: 'ui-pro/export-report',
    version: 1,
    engine: 'godot',
    screen: doc.name,
    godotVersion: install.version,
    scene: plan.scene,
    files: [...files].sort(),
    nodes: plan.planned,
    placeholders: plan.placeholders,
    missingAssets: plan.missing,
    assets: plan.assets.map((asset) => ({
      name: asset.name,
      file: asset.file,
      origin: asset.record.origin,
      nodes: asset.nodes,
      approximate: asset.record.approximations.length > 0,
    })),
    approximations: plan.approximations,
    created: built.result.created,
    updated: built.result.updated,
    removed: built.result.removed,
    conflicts: built.result.conflicts.map((conflict) => ({
      id: conflict.id,
      key: conflict.key,
      code: conflict.reason,
      message: conflictMessage(conflict.reason),
      design: conflict.design,
      scene: conflict.scene,
    })),
  };

  const result: ExportResult = {
    report,
    createdProject: prepared.created,
    godot: { executable: toPosix(install.executable), version: install.version },
    timings: { importMs: imported.run.ms, buildMs: built.ms },
  };
  if (options.shot) {
    const [width, height] = doc.size;
    const { ms } = await takeShot({
      install,
      project: target,
      scene: toResPath(plan.scene),
      out: options.shot.file,
      width,
      height,
      timeoutMs: timeouts.shot,
    });
    result.timings.shotMs = ms;
    result.shot = {
      file: toPosix(options.shot.file),
      width,
      height,
      meanDiff: await meanAbsDiff(options.shot.file, options.shot.reference, width, height),
    };
  }
  return result;
}

/**
 * Exports a screen of a UI-Pro project: its document, built assets and fonts. What `ui-pro
 * export godot` and the engine gate both do; the callers differ in where the Godot project is.
 */
export function exportProjectScreen(
  project: Project,
  screen: string,
  options: Omit<ExportScreenOptions, 'doc' | 'projectName' | 'design' | 'assets' | 'fonts'>,
): Promise<ExportResult> {
  return exportScreen({
    doc: loadScreen(project, screen),
    projectName: project.config.name,
    design: project.config.design,
    assets: projectAssetSource(project, screen),
    fonts: projectFonts(project),
    ...options,
  });
}

/** Runs `builder.gd` on `spec`; spec and result travel through a scratch directory. */
async function runBuilder(
  install: GodotInstall,
  target: string,
  spec: Omit<BuilderSpec, 'result'>,
  timeoutMs: number,
) {
  const scratch = await mkdtemp(join(tmpdir(), 'ui-pro-godot-'));
  try {
    const specFile = join(scratch, 'spec.json');
    const resultFile = join(scratch, 'result.json');
    await writeFile(specFile, JSON.stringify({ ...spec, result: toPosix(resultFile) }));
    const { run, errors } = await runGodot(
      install,
      'build',
      [
        '--headless',
        '--path',
        target,
        '--script',
        `res://${ADDON_DIR}/${BUILDER_SCRIPT}`,
        '--',
        specFile,
      ],
      timeoutMs,
    );
    const text = await readFileIfExists(resultFile);
    const result = text === null ? undefined : parseBuilderResult(text.toString('utf8'));
    if (result === undefined) {
      assertCleanRun('build', run, errors);
      throw new UiProError(GodotErrorCodes.build, 'Godot 构建场景失败：构建器没有留下结果文件', {
        details: {
          exitCode: run.code,
          output: `${run.stdout}\n${run.stderr}`.trim().slice(-1500),
        },
      });
    }
    if (!result.ok) {
      const first = result.errors[0];
      throw new UiProError(
        GodotErrorCodes.build,
        first === undefined ? 'Godot 构建场景失败' : buildErrorMessage(first),
        { details: { errors: result.errors, godotErrors: errors } },
      );
    }
    assertCleanRun('build', run, errors);
    return { result, ms: run.ms };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
