import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnalysisReport,
  addScreen,
  type Candidate,
  createProject,
  ErrorCodes,
  isUiProError,
  listHistory,
  loadScreen,
  readCandidates,
  referenceImagePath,
  undo,
} from '@ui-pro/core';
import type { Layer } from 'ag-psd';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { analyzePsdScreen, PsdErrorCodes } from '../src';
import {
  type Box,
  brokenPsd,
  compliantLayers,
  compliantPsd,
  DESIGN,
  group,
  paintBlock,
  pixel,
  psdBytes,
} from './fixtures';
import { psdProject, snapshotTree, useEmbeddedRenderer, useTempDirs } from './harness';

const makeDir = useTempDirs();

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isUiProError(error)) return error;
    throw error;
  }
  throw new Error('expected a UiProError');
}

function layerCandidate(candidates: Candidate[], path: string[]): Candidate {
  const found = candidates.find((c) => c.layer?.path.join('/') === path.join('/'));
  if (found === undefined) throw new Error(`no candidate for ${path.join('/')}`);
  return found;
}

describe('analyzePsdScreen with a compliant PSD', () => {
  async function analyze() {
    useEmbeddedRenderer();
    const fixture = await psdProject(makeDir, compliantPsd());
    const report = await analyzePsdScreen(fixture.project, fixture.screen);
    return { ...fixture, report };
  }

  it('grades the file A and reports what it found', async () => {
    const { report } = await analyze();
    expect(report).toMatchObject<Partial<AnalysisReport>>({
      screen: 'main',
      kind: 'psd',
      grade: 'A',
      precheck: { upscale: 1, risks: [] },
      candidates: 13,
      clusters: 2,
      nodes: 7,
    });
    expect(report.version).toBeTypeOf('number');
    expect(report.warnings).toEqual([]);
  });

  it('writes the composite as the reference image and the layer renders as evidence', async () => {
    const { project, report, dir } = await analyze();
    const doc = loadScreen(project, 'main');
    expect(referenceImagePath(doc)).toBe('screens/main/evidence/composite.png');
    const composite = join(dir, 'screens', 'main', 'evidence', 'composite.png');
    expect(report.views).toEqual([composite.replaceAll('\\', '/')]);

    const image = await sharp(await readFile(report.views[0] ?? '')).metadata();
    expect([image.width, image.height]).toEqual([DESIGN.width, DESIGN.height]);

    const evidence = readCandidates(project, 'main');
    const base = layerCandidate(evidence?.candidates ?? [], ['btn_upgrade', 'base']);
    expect(base).toMatchObject({
      source: 'layer',
      bbox: [20, 240, 120, 40],
      parent: expect.any(String),
    });
    const mask = await sharp(
      await readFile(join(dir, 'screens', 'main', 'evidence', base.mask ?? 'missing')),
    ).metadata();
    expect([mask.width, mask.height]).toEqual([120, 40]);
  });

  it('records layer information, parents and both kinds of cluster', async () => {
    const { project } = await analyze();
    const evidence = readCandidates(project, 'main');
    const candidates = evidence?.candidates ?? [];

    const group = layerCandidate(candidates, ['btn_upgrade']);
    expect(group.layer).toMatchObject({ name: 'btn_upgrade', kind: 'group', hidden: false });
    expect(group.bbox).toEqual([20, 236, 122, 44]);
    const dot = layerCandidate(candidates, ['btn_upgrade', 'badge_dot', 'dot']);
    expect(dot.parent).toBe(layerCandidate(candidates, ['btn_upgrade', 'badge_dot']).id);
    expect(layerCandidate(candidates, ['btn_upgrade', '@pressed']).layer?.hidden).toBe(true);

    const clusters = evidence?.clusters ?? [];
    const smart = clusters.find((cluster) => cluster.kind === 'smart-object');
    const names = clusters.find((cluster) => cluster.kind === 'name');
    expect(smart?.members).toHaveLength(3);
    expect(names?.members).toHaveLength(3);
    const icon = layerCandidate(candidates, ['slot_equip_2', 'icon']);
    expect(icon.cluster).toBe(smart?.id);
    expect(layerCandidate(candidates, ['slot_equip_2']).cluster).toBe(names?.id);
    expect(layerCandidate(candidates, ['bg_main']).cluster).toBeUndefined();
  });

  it('builds the draft from the group structure', async () => {
    const { project } = await analyze();
    const { nodes } = loadScreen(project, 'main');
    const summary = Object.fromEntries(
      Object.entries(nodes)
        .filter(([id]) => id !== 'root')
        .map(([id, node]) => [id, [node.type, node.role, node.parent]]),
    );
    expect(summary).toEqual({
      bg_main: ['image', 'background', 'root'],
      btn_upgrade: ['button', 'button', 'root'],
      badge_dot: ['image', undefined, 'btn_upgrade'],
      txt_gold: ['text', undefined, 'root'],
      slot_equip_1: ['container', 'slot', 'root'],
      slot_equip_2: ['container', 'slot', 'root'],
      slot_equip_3: ['container', 'slot', 'root'],
    });
    // A node's rectangle follows its own art; the badge sticking out is a node of its own.
    expect(nodes.btn_upgrade?.rect).toEqual([20, 240, 120, 40]);
    expect(nodes.badge_dot?.rect).toEqual([130, 236, 12, 12]);
    expect(nodes.btn_upgrade?.states?.pressed).toMatchObject({ source: 'drawn' });
    expect(nodes.txt_gold?.text).toMatchObject({ content: '12,345', kind: 'value', size: 24 });
    expect(nodes.slot_equip_1?.cluster).toBeDefined();
  });

  it('asks which badge role applies instead of guessing', async () => {
    const { report } = await analyze();
    expect(report.ask).toEqual([
      expect.objectContaining({
        id: 'psd.badge-role',
        question: expect.stringContaining('#badge_dot'),
      }),
    ]);
  });

  it('commits evidence and draft as one version that undo removes completely', async () => {
    useEmbeddedRenderer();
    const { project, dir, screen } = await psdProject(makeDir, compliantPsd());
    const before = await snapshotTree(join(dir, 'screens'));
    const versionsBefore = listHistory(project).length;

    await analyzePsdScreen(project, screen);
    expect(listHistory(project)).toHaveLength(versionsBefore + 1);
    expect(await snapshotTree(join(dir, 'screens'))).not.toEqual(before);

    await undo(project);
    expect(await snapshotTree(join(dir, 'screens'))).toEqual(before);
  });

  it('writes nothing in a dry run, not even the render cache', async () => {
    useEmbeddedRenderer();
    const { project, dir, screen } = await psdProject(makeDir, compliantPsd());
    const before = await snapshotTree(dir);
    const report = await analyzePsdScreen(project, screen, { dryRun: true });
    expect(report.grade).toBe('A');
    expect(report.version).toBeUndefined();
    expect(report.views).toEqual([]);
    expect(report.nodes).toBe(7);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('takes layer renders from the cache on a second analysis', async () => {
    const renderers = useEmbeddedRenderer();
    const { project, screen } = await psdProject(makeDir, compliantPsd());
    await analyzePsdScreen(project, screen);
    const first = renderers.units();
    expect(first).toBeGreaterThan(0);

    await undo(project);
    await analyzePsdScreen(project, screen);
    expect(renderers.units()).toBe(first);
  });
});

describe('analyzePsdScreen with a PSD that breaks the delivery spec', () => {
  it('refuses with the fix list instead of guessing', async () => {
    useEmbeddedRenderer();
    const { project, screen } = await psdProject(makeDir, brokenPsd());
    const error = await failure(analyzePsdScreen(project, screen));
    expect(error.code).toBe(PsdErrorCodes.grade);
    const details = error.details as { grade: string; fixList: string[] };
    expect(details.grade).toBe('C');
    expect(details.fixList.some((line) => line.includes('合成图'))).toBe(true);
    expect(details.fixList.some((line) => line.includes('画布尺寸'))).toBe(true);
    expect(details.fixList.some((line) => line.includes('Group 1'))).toBe(true);
    expect(error.hint).toContain('--allow-degraded');
  });

  it('refuses a file that is only partly wrong the same way', async () => {
    const renderers = useEmbeddedRenderer();
    const { project, screen } = await psdProject(makeDir, brokenPsd());
    await failure(analyzePsdScreen(project, screen));
    // A file that is already C does not need to be rendered.
    expect(renderers.renderers).toHaveLength(0);
  });

  it('goes ahead with --allow-degraded, with warnings, and every layer still becomes a node', async () => {
    useEmbeddedRenderer();
    const { project, screen } = await psdProject(makeDir, brokenPsd());
    const report = await analyzePsdScreen(project, screen, { allowDegraded: true });
    expect(report.grade).toBe('C');
    expect(report.version).toBeTypeOf('number');
    expect(report.precheck.risks.join('\n')).toContain('降级');
    expect(report.warnings.join('\n')).toContain('Group 1');
    expect(report.nodes).toBeGreaterThanOrEqual(2);
    const nodes = Object.values(loadScreen(project, 'main').nodes).filter(
      (node) => node.id !== 'root',
    );
    expect(nodes.every((node) => node.type === 'image')).toBe(true);
    // No embedded composite: the recomposition stands in as the reference image.
    const reference = join(project.root, referenceImagePath(loadScreen(project, 'main')));
    expect((await stat(reference)).isFile()).toBe(true);
  });
});

describe('analyzePsdScreen when a layer does not render like the composite', () => {
  /** The composite shows magenta where the layers add up to something else. */
  const mismatched = (layers: Layer[], region: Box) =>
    psdBytes(layers, {
      ...DESIGN,
      alter: (image) => paintBlock(image, region, [255, 0, 255, 255]),
    });

  it('grades the file B and says which layer to fix', async () => {
    useEmbeddedRenderer();
    const bytes = mismatched(compliantLayers(), [20, 240, 100, 40]);
    const { project, screen } = await psdProject(makeDir, bytes);
    const error = await failure(analyzePsdScreen(project, screen));
    expect(error.code).toBe(PsdErrorCodes.grade);
    const details = error.details as { grade: string; fixList: string[] };
    expect(details.grade).toBe('B');
    expect(details.fixList).toHaveLength(1);
    expect(details.fixList[0]).toContain('btn_upgrade / base');
    expect(details.fixList[0]).toContain('改法');
  });

  it('takes the layer as the node’s own art when it has no sound layer, with a warning', async () => {
    useEmbeddedRenderer();
    const bytes = mismatched(compliantLayers(), [20, 240, 100, 40]);
    const { project, screen } = await psdProject(makeDir, bytes);
    const report = await analyzePsdScreen(project, screen, { allowDegraded: true });
    expect(report.grade).toBe('B');
    expect(report.nodes).toBe(7);
    expect(report.warnings.join('\n')).toContain('btn_upgrade / base');
  });

  it('gives a failed layer a node of its own beside the sound layers of its element', async () => {
    useEmbeddedRenderer();
    const layers = [
      pixel('bg_main', [0, 0, 200, 320], [20, 24, 40, 255]),
      group('panel_main', [
        pixel('frame', [10, 10, 100, 100], [40, 120, 220, 255]),
        pixel('shine', [30, 30, 40, 40], [250, 250, 250, 255]),
      ]),
    ];
    const { project, screen } = await psdProject(makeDir, mismatched(layers, [40, 40, 10, 10]));
    const report = await analyzePsdScreen(project, screen, { allowDegraded: true });
    expect(report.nodes).toBe(3);
    expect(report.warnings.join('\n')).toContain('核对不通过');
    const nodes = loadScreen(project, 'main').nodes;
    expect(nodes.panel_main?.rect).toEqual([10, 10, 100, 100]);
    expect(nodes.image_1).toMatchObject({
      type: 'image',
      parent: 'panel_main',
      rect: [30, 30, 40, 40],
    });
  });
});

describe('analyzePsdScreen and the renderer', () => {
  it('refuses the online renderer when the project keeps data local', async () => {
    const { project, screen } = await psdProject(makeDir, compliantPsd(), { egress: 'local' });
    const error = await failure(analyzePsdScreen(project, screen));
    expect(error.code).toBe(PsdErrorCodes.egress);
    expect(error.message).toContain('local');
  });

  it('falls back to the stored pixels with --allow-degraded and says so', async () => {
    const { project, screen } = await psdProject(makeDir, compliantPsd(), { egress: 'local' });
    const report = await analyzePsdScreen(project, screen, { allowDegraded: true });
    expect(report.grade).toBe('B');
    expect(report.precheck.risks.join('\n')).toContain('渲染器不可用');
    expect(report.nodes).toBe(7);
  });

  it('refuses a source that is not a PSD', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'), { name: 'demo', design: DESIGN });
    const png = join(root, 'ui.png');
    await sharp({ create: { width: 200, height: 320, channels: 3, background: '#333' } })
      .png()
      .toFile(png);
    await addScreen(project, { name: 'flat', source: png });
    const error = await failure(analyzePsdScreen(project, 'flat'));
    expect(error.code).toBe(PsdErrorCodes.source);
  });

  it('says a delivery package is not supported yet and asks for the PSD', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'proj'), { name: 'demo', design: DESIGN });
    const pack = join(root, 'pack');
    await mkdir(pack);
    await writeFile(
      join(pack, 'manifest.json'),
      JSON.stringify({ format: 'ui-pro-delivery', canvas: DESIGN }),
    );
    await addScreen(project, { name: 'pack', source: pack });
    const error = await failure(analyzePsdScreen(project, 'pack'));
    expect(error.code).toBe(ErrorCodes.notImplemented);
    expect(error.hint).toContain('PSD');
  });
});
