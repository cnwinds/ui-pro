import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  addScreen,
  applyOps,
  type Candidate,
  type CandidatesDoc,
  createProject,
  loadScreen,
  referenceImagePath,
} from '@ui-pro/core';
import type { LookResult } from '@ui-pro/perception';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { type Cli, cliIn, dataOf, useTempDirs, writePng } from './helpers';

const makeDir = useTempDirs();

type Rect = [number, number, number, number];

const CANDIDATES: Candidate[] = [
  { id: 'cand#1', source: 'cv', bbox: [100, 100, 400, 300], score: 0.9 },
  {
    id: 'cand#2',
    source: 'ocr',
    bbox: [120, 120, 100, 30],
    score: 0.98,
    text: 'Title',
    parent: 'cand#1',
  },
  { id: 'cand#3', source: 'cv', bbox: [100, 500, 300, 100], score: 0.8 },
  { id: 'cand#4', source: 'cv', bbox: [700, 900, 60, 60], score: 0.7 },
];

interface Fixture {
  dir: string;
  cli: Cli;
}

async function projectWith(candidates: Candidate[] | null): Promise<Fixture> {
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo' });
  const png = join(root, 'ui.png');
  await writePng(png, 1080, 1920);
  await addScreen(project, { name: 'main', source: png });
  if (candidates !== null) {
    const evidence: CandidatesDoc = {
      format: 'ui-pro/candidates',
      version: 1,
      sourceSha256: loadScreen(project, 'main').source.sha256,
      candidates,
      clusters: [],
    };
    await applyOps(
      project,
      [
        {
          op: 'node.add',
          node: { id: 'panel', type: 'container', rect: [90, 90, 420, 320], parent: '#root' },
        },
        {
          op: 'node.add',
          node: {
            id: 'title',
            type: 'text',
            rect: [120, 120, 100, 30],
            parent: '#panel',
            text: { content: 'Title' },
          },
        },
      ],
      { screen: 'main', message: 'seed', evidence: { main: { candidates: evidence } } },
    );
  }
  return { dir, cli: cliIn(dir) };
}

function denseCandidates(): Candidate[] {
  const list: Candidate[] = [];
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 5; column++) {
      list.push({
        id: `cand#${list.length + 1}`,
        source: 'cv',
        bbox: [40 + column * 200, 40 + row * 230, 120, 80],
        score: 0.8,
      });
    }
  }
  return list;
}

async function pixelSize(path: string): Promise<[number, number]> {
  const meta = await sharp(path).metadata();
  return [meta.width ?? 0, meta.height ?? 0];
}

describe('ui-pro look', () => {
  it('draws an overview of nodes and candidates, labelled so that the legend can decode it', async () => {
    const { dir, cli } = await projectWith(CANDIDATES);

    const envelope = await cli.ok(['look']);

    const result = dataOf<LookResult>(envelope);
    const [overview] = result.images;
    expect(overview).toMatchObject({ kind: 'overview', region: [0, 0, 1080, 1920] });
    expect(Object.keys(result.legend).sort()).toEqual(['1', '2', '3', '4', 'panel', 'title']);
    expect(result.legend['3']).toMatchObject({
      id: 'cand#3',
      kind: 'candidate',
      source: 'cv',
      bbox: [100, 500, 300, 100],
      design: [100, 500, 300, 100],
    });
    expect(result.legend.panel).toMatchObject({ id: 'panel', kind: 'node' });
    for (const label of Object.keys(result.legend)) expect(label).toMatch(/^[\x20-\x7e]+$/);

    expect(envelope.views).toEqual(result.images.map((image) => image.path));
    const view = envelope.views?.[0] as string;
    expect(isAbsolute(view)).toBe(true);
    expect(view).not.toContain('\\');
    expect(view.startsWith(join(dir, '.ui-pro', 'look').replaceAll('\\', '/'))).toBe(true);
    const [width, height] = await pixelSize(view);
    expect(Math.abs(width - 1080 * (overview?.zoom ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs(height - 1920 * (overview?.zoom ?? 0))).toBeLessThanOrEqual(1);
  });

  it('adds zone pictures for a crowded screen, unless told not to', async () => {
    const { cli } = await projectWith(denseCandidates());

    const crowded = dataOf<LookResult>(await cli.ok(['look']));
    const flat = dataOf<LookResult>(await cli.ok(['look', '--no-zones']));

    expect(crowded.images[0]?.kind).toBe('overview');
    const zones = crowded.images.filter((image) => image.kind === 'zone');
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      expect(existsSync(zone.path)).toBe(true);
      expect(zone.zoom).toBeGreaterThan(crowded.images[0]?.zoom ?? 0);
    }
    expect(flat.images.map((image) => image.kind)).toEqual(['overview']);
  });

  it('zooms into one candidate with its surroundings, the target highlighted', async () => {
    const { cli } = await projectWith(CANDIDATES);

    const envelope = await cli.ok(['look', 'cand#4']);

    const result = dataOf<LookResult>(envelope);
    expect(result.images).toHaveLength(1);
    const [view] = result.images;
    expect(view?.kind).toBe('target');
    const region = view?.region as Rect;
    expect(region[0]).toBeLessThanOrEqual(700);
    expect(region[1]).toBeLessThanOrEqual(900);
    expect(region[0] + region[2]).toBeGreaterThanOrEqual(760);
    expect(region[1] + region[3]).toBeGreaterThanOrEqual(960);
    expect(view?.zoom).toBeGreaterThan(1);
    expect(result.legend['4']).toMatchObject({ id: 'cand#4', bbox: [700, 900, 60, 60] });
    const [width] = await pixelSize(view?.path as string);
    expect(Math.abs(width - region[2] * (view?.zoom ?? 0))).toBeLessThanOrEqual(1);
    expect(envelope.summary).toContain('cand#4');
  });

  it('zooms into the nodes a selector matches', async () => {
    const { cli } = await projectWith(CANDIDATES);

    const result = dataOf<LookResult>(await cli.ok(['look', '#title']));

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.kind).toBe('target');
    expect(result.legend.title).toMatchObject({
      id: 'title',
      kind: 'node',
      bbox: [120, 120, 100, 30],
    });
    expect(existsSync(result.images[0]?.path as string)).toBe(true);
  });

  it('draws only nodes or only candidates on request, and not both limits at once', async () => {
    const { cli } = await projectWith(CANDIDATES);

    const nodes = dataOf<LookResult>(await cli.ok(['look', '--nodes-only']));
    const candidates = dataOf<LookResult>(await cli.ok(['look', '--candidates-only']));

    expect(Object.values(nodes.legend).map((entry) => entry.kind)).toEqual(['node', 'node']);
    expect(Object.values(candidates.legend).map((entry) => entry.kind)).toEqual([
      'candidate',
      'candidate',
      'candidate',
      'candidate',
    ]);
    const { error } = await cli.fail(['look', '--nodes-only', '--candidates-only']);
    expect(error.code).toBe('E_USAGE');
  });

  it('honours --zoom, and rejects a zoom that cannot be drawn', async () => {
    const { cli } = await projectWith(CANDIDATES);

    const result = dataOf<LookResult>(await cli.ok(['look', 'cand#4', '--zoom', '2']));

    const [view] = result.images;
    expect(view?.zoom).toBe(2);
    const region = view?.region as Rect;
    expect(await pixelSize(view?.path as string)).toEqual([region[2] * 2, region[3] * 2]);
    expect((await cli.fail(['look', 'cand#4', '--zoom', '99'])).error.code).toBe('E_LOOK_TARGET');
    expect((await cli.fail(['look', 'cand#4', '--zoom', '0'])).error.code).toBe('E_USAGE');
  });

  it('says which target it could not find', async () => {
    const { cli } = await projectWith(CANDIDATES);

    const candidate = await cli.fail(['look', 'cand#99']);
    const selector = await cli.fail(['look', '#nothing']);

    expect(candidate.error.code).toBe('E_LOOK_TARGET');
    expect(candidate.error.message).toContain('cand#99');
    expect(selector.error.code).toBe('E_LOOK_TARGET');
  });

  it('asks for an analysis before looking at a candidate that was never produced', async () => {
    const { cli } = await projectWith(null);

    const { error } = await cli.fail(['look', 'cand#1']);

    expect(error.code).toBe('E_LOOK_NO_EVIDENCE');
    expect(error.hint).toContain('ui-pro analyze');
  });

  it('is not a history entry', async () => {
    const { cli } = await projectWith(CANDIDATES);
    const versions = async () =>
      dataOf<{ items: unknown[] }>(await cli.ok(['history', 'list'])).items.length;
    const before = await versions();

    await cli.ok(['look']);
    await cli.ok(['look', 'cand#1']);

    expect(await versions()).toBe(before);
  });

  it('reads the composite of a PSD screen as its reference image', async () => {
    const root = await makeDir();
    const dir = join(root, 'proj');
    const project = await createProject(dir, { name: 'demo' });
    const header = Buffer.alloc(26);
    header.write('8BPS', 0, 'latin1');
    header.writeUInt16BE(1, 4);
    header.writeUInt32BE(600, 14);
    header.writeUInt32BE(400, 18);
    const psd = join(root, 'ui.psd');
    await writeFile(psd, header);
    await addScreen(project, { name: 'main', source: psd });
    const cli = cliIn(dir);

    const missing = await cli.fail(['look']);
    expect(missing.error.code).toBe('E_REFERENCE_MISSING');

    const composite = join(dir, referenceImagePath(loadScreen(project, 'main')));
    await mkdir(dirname(composite), { recursive: true });
    await writePng(composite, 400, 600);
    const result = dataOf<LookResult>(await cli.ok(['look']));
    expect(result.images[0]?.region).toEqual([0, 0, 400, 600]);
  });
});
