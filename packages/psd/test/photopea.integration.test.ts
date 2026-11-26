import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { lintPsd, PhotopeaRenderer, PsdErrorCodes, parsePsd, planRenderUnits } from '../src';
import { layersById } from '../src/model';
import { renderUnits } from '../src/render-store';
import { recompose, verify } from '../src/verify';

/** Real Photopea in the local Edge: needs the network, so it only runs on request. */
const enabled = process.env.UI_PRO_PHOTOPEA === '1';
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../../benchmark/psd-fixtures/ag-psd/${name}/src.psd`, import.meta.url));

interface Summary {
  fixture: string;
  layers: number;
  failed: { path: string; diffRatio: number; maxDelta: number }[];
  unexplainedPass: boolean;
  stats: { startupMs: number; openMs: number; renderMs: number; units: number; profile?: string };
}

async function appendLog(lines: string[]): Promise<void> {
  // The reporter swallows console output; the log lets a human read the numbers.
  const log = process.env.UI_PRO_PHOTOPEA_LOG;
  if (log !== undefined) await appendFile(log, `${lines.join('\n')}\n`);
}

describe.skipIf(!enabled)('Photopea renderer (needs network and Edge)', () => {
  const dirs: string[] = [];
  const renderers: PhotopeaRenderer[] = [];
  const track = (renderer: PhotopeaRenderer) => {
    renderers.push(renderer);
    return renderer;
  };
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-photopea-test-'));
    dirs.push(dir);
    return dir;
  };

  afterAll(async () => {
    await Promise.all(renderers.map((renderer) => renderer.close()));
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const shared = (async () =>
    track(new PhotopeaRenderer({ profileDir: join(await tempDir(), 'profile') })))();

  async function check(fixture: string, renderer: PhotopeaRenderer): Promise<Summary> {
    const document = parsePsd(await readFile(fixturePath(fixture)));
    const units = planRenderUnits(document);
    const outcome = await renderUnits({ document, units, renderer });
    const composition = await recompose(document.width, document.height, units, outcome.stored);
    if (document.composite === null) throw new Error('fixture has no composite');
    const verification = verify(document.composite, composition);
    const byId = layersById(document.layers);
    const summary: Summary = {
      fixture,
      layers: verification.checks.length,
      failed: verification.checks
        .filter((c) => !c.pass)
        .map((c) => ({
          path: byId.get(c.id)?.path.join(' / ') ?? String(c.id),
          diffRatio: Number(c.diffRatio.toFixed(4)),
          maxDelta: c.maxDelta,
        })),
      unexplainedPass: verification.unexplained.pass,
      stats: {
        startupMs: outcome.stats?.startupMs ?? 0,
        openMs: outcome.stats?.openMs ?? 0,
        renderMs: outcome.stats?.renderMs ?? 0,
        units: outcome.stats?.units ?? 0,
        profile: outcome.stats?.profile,
      },
    };
    await appendLog([
      `SUMMARY ${JSON.stringify(summary)}`,
      ...verification.checks.map(
        (c) =>
          `LAYER ${fixture} ${byId.get(c.id)?.path.join('/')} pass=${c.pass} area=${c.area} diff=${c.diffPixels} ratio=${c.diffRatio.toFixed(4)} max=${c.maxDelta}`,
      ),
    ]);
    return summary;
  }

  // The calibration of PIXEL_TOLERANCE and the two ratios: these three are expected to pass.
  for (const fixture of ['text-simple', 'smart-object', 'group-drop-shadows', 'layer-mask']) {
    it(`reproduces the composite of ${fixture}`, { timeout: 180_000 }, async () => {
      const summary = await check(fixture, await shared);
      expect(summary.failed).toEqual([]);
      expect(summary.unexplainedPass).toBe(true);
      expect(summary.layers).toBeGreaterThan(0);
    });
  }

  it('finds the layers whose effects Photopea does not reproduce in effects', {
    timeout: 180_000,
  }, async () => {
    const summary = await check('effects', await shared);
    const failed = summary.failed.map((layer) => layer.path);
    expect(failed).toEqual(expect.arrayContaining(['drop shadow', 'bevel', 'inner outer glow']));
    expect(failed).not.toContain('solid fill');
  });

  it('finds the layer whose fill opacity Photopea does not reproduce in fill-opacity', {
    timeout: 180_000,
  }, async () => {
    const summary = await check('fill-opacity', await shared);
    expect(summary.failed.map((layer) => layer.path)).toEqual([
      '[#f00] Fill opacity 20% (non-TS Linear light mode)',
    ]);
  });

  it('lints a real file end to end and writes the checklist', { timeout: 180_000 }, async () => {
    const root = await tempDir();
    const bytes = await readFile(fixturePath('smart-object'));
    // The default renderer: Photopea with the cache profile below `<root>/.ui-pro`.
    const result = await lintPsd(bytes, { scratchRoot: root, label: 'smart-object.psd' });
    expect(result.restore.renderer).toBe('photopea');
    expect(result.restore.checked).toBe(2);
    expect(result.restore.failed).toBe(0);
    expect(result.restore.stats?.profile).toBe('persistent');
    expect((await readFile(result.checklistPath, 'utf8')).startsWith('# PSD 修改清单')).toBe(true);
    // The structure rules of the spec still fail it: the layers carry no prefix names.
    expect(result.grade).toBe('C');
  });

  it('starts much faster when a run reuses the cache profile', { timeout: 240_000 }, async () => {
    const profileDir = join(await tempDir(), 'profile');
    const first = track(new PhotopeaRenderer({ profileDir }));
    const cold = await check('text-simple', first);
    await first.close();
    const second = track(new PhotopeaRenderer({ profileDir }));
    const warm = await check('text-simple', second);
    await appendLog([`CACHE cold=${cold.stats.startupMs}ms warm=${warm.stats.startupMs}ms`]);
    expect(cold.stats.profile).toBe('persistent');
    expect(warm.stats.profile).toBe('persistent');
    expect(warm.stats.startupMs).toBeLessThan(10_000);
  });

  it('uses a clean browser while another renderer holds the profile', {
    timeout: 240_000,
  }, async () => {
    const profileDir = join(await tempDir(), 'profile');
    const holder = track(new PhotopeaRenderer({ profileDir }));
    const held = await check('text-simple', holder);
    const other = track(new PhotopeaRenderer({ profileDir }));
    const concurrent = await check('text-simple', other);
    expect(held.stats.profile).toBe('persistent');
    expect(concurrent.stats.profile).toBe('temporary');
    expect(concurrent.failed).toEqual([]);
  });

  it('reports an unreachable Photopea instead of hanging', { timeout: 120_000 }, async () => {
    const document = parsePsd(await readFile(fixturePath('text-simple')));
    const unreachable = track(new PhotopeaRenderer({ url: 'https://photopea.invalid/' }));
    await expect(
      renderUnits({ document, units: planRenderUnits(document), renderer: unreachable }),
    ).rejects.toMatchObject({ code: PsdErrorCodes.photopeaUnreachable });
  });
});
