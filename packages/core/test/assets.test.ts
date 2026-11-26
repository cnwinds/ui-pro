import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AssetManifest,
  type AssetUpdate,
  applyOps,
  createCoreRegistry,
  defineOp,
  ErrorCodes,
  type LockDoc,
  listHistory,
  loadScreen,
  readAssetManifest,
  readLock,
  sha256Hex,
  undo,
} from '../src';
import {
  emptyScreenProject,
  type Fixture,
  failureOf,
  patchScreen,
  snapshotTree,
  treeFixture,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

const png = Buffer.from('png-bytes');
const genPng = Buffer.from('generated-bytes');

function manifestFor(fx: Fixture, extra: Partial<AssetManifest> = {}): AssetManifest {
  return {
    format: 'ui-pro/assets',
    version: 1,
    screen: fx.screen,
    sourceSha256: loadScreen(fx.project, fx.screen).source.sha256,
    inputsSha256: 'b'.repeat(64),
    assets: [
      {
        name: 'btn_upgrade',
        file: 'btn_upgrade.png',
        origin: 'crop',
        uses: [{ node: 'btn_upgrade' }],
        size: [300, 120],
        inset: [0, 0, 0, 0],
        holes: [{ node: 'badge_dot', handling: 'filled', region: [280, 0, 20, 20] }],
        steps: [{ step: 'fill', method: 'lama', generated: 'a'.repeat(64) }],
        sha256: sha256Hex(png),
        approximations: [],
      },
    ],
    ...extra,
  };
}

function lockFor(fx: Fixture): LockDoc {
  return {
    format: 'ui-pro/lock',
    version: 1,
    tool: '0.0.0',
    models: {},
    generated: {
      ['a'.repeat(64)]: {
        file: `screens/${fx.screen}/assets/gen/fill-1.png`,
        sha256: sha256Hex(genPng),
        by: 'local:lama',
        at: '2026-11-26T00:00:00.000Z',
        alternatives: [],
      },
    },
  };
}

function update(fx: Fixture, extra: Partial<AssetUpdate> = {}): AssetUpdate {
  return {
    manifest: manifestFor(fx),
    files: [{ path: 'btn_upgrade.png', content: png }],
    generated: [{ path: 'gen/fill-1.png', content: genPng }],
    ...extra,
  };
}

function assetsPath(fx: Fixture, ...rest: string[]): string {
  return join(fx.project.root, 'screens', fx.screen, 'assets', ...rest);
}

/** A stand-in for the build's own op: binds an asset the committed manifest declares. */
const bindAsset = defineOp({
  name: 'test.bind',
  family: 'build',
  summary: '测试用',
  schema: z.strictObject({ op: z.literal('test.bind'), node: z.string(), asset: z.string() }),
  apply(ctx, op) {
    const doc = ctx.screen();
    const known = ctx.assets(doc.name)?.assets.some((asset) => asset.name === op.asset);
    if (!known) throw new Error(`unknown asset ${op.asset}`);
    const node = doc.nodes[op.node];
    if (node) node.asset = op.asset;
  },
});

function registry() {
  const r = createCoreRegistry();
  r.registerOp(bindAsset);
  return r;
}

describe('assets committed with ops', () => {
  it('writes the manifest, files, lock and bindings as one undoable version', async () => {
    const fx = await treeFixture(makeDir);
    const result = await applyOps(
      fx.project,
      [{ op: 'test.bind', node: 'btn_upgrade', asset: 'btn_upgrade' }],
      {
        screen: fx.screen,
        message: '构建',
        registry: registry(),
        assets: { [fx.screen]: update(fx) },
        lock: lockFor(fx),
      },
    );

    expect(result.changes.docs).toEqual(
      expect.arrayContaining(['screens/main/assets/manifest.json', 'ui-pro.lock']),
    );
    expect(loadScreen(fx.project, fx.screen).nodes.btn_upgrade?.asset).toBe('btn_upgrade');
    expect(readAssetManifest(fx.project, fx.screen)?.assets[0]?.holes[0]?.handling).toBe('filled');
    expect(Object.keys(readLock(fx.project).generated)).toEqual(['a'.repeat(64)]);
    expect(existsSync(assetsPath(fx, 'gen', 'fill-1.png'))).toBe(true);
    expect(listHistory(fx.project).at(-1)?.message).toBe('构建');

    await undo(fx.project);
    expect(readAssetManifest(fx.project, fx.screen)).toBeNull();
    expect(existsSync(assetsPath(fx, 'btn_upgrade.png'))).toBe(false);
    expect(readLock(fx.project).generated).toEqual({});
    expect(loadScreen(fx.project, fx.screen).nodes.btn_upgrade?.asset).toBeUndefined();
  });

  it('replaces built files but never deletes locked model outputs', async () => {
    const fx = await emptyScreenProject(makeDir);
    await applyOps(fx.project, [], { assets: { [fx.screen]: update(fx) }, lock: lockFor(fx) });
    await applyOps(fx.project, [], {
      assets: {
        [fx.screen]: {
          manifest: manifestFor(fx, { assets: [] }),
          files: [],
        },
      },
    });

    expect(existsSync(assetsPath(fx, 'btn_upgrade.png'))).toBe(false);
    expect(existsSync(assetsPath(fx, 'gen', 'fill-1.png'))).toBe(true);
    expect(readAssetManifest(fx.project, fx.screen)?.assets).toEqual([]);
  });

  it('refuses a manifest of another source, a missing file, a misplaced model output or a dangling lock', async () => {
    const fx = await emptyScreenProject(makeDir);
    const before = await snapshotTree(fx.project.root);
    const commit = (assets: AssetUpdate, lock?: LockDoc) =>
      failureOf(applyOps(fx.project, [], { assets: { [fx.screen]: assets }, lock }));

    const stale = await commit(
      update(fx, { manifest: manifestFor(fx, { sourceSha256: 'a'.repeat(64) }) }),
    );
    expect(stale.code).toBe(ErrorCodes.invariant);
    expect(stale.message).toContain('sourceSha256');

    expect((await commit(update(fx, { files: [] }))).message).toContain('btn_upgrade.png');
    expect(
      (await commit(update(fx, { generated: [{ path: 'fill-1.png', content: genPng }] }))).message,
    ).toContain('gen/');
    expect((await commit(update(fx, { generated: [] }), lockFor(fx))).message).toContain(
      'gen/fill-1.png',
    );
    expect(
      (await commit(update(fx, { files: [{ path: '../screen.uir.json', content: png }] }))).message,
    ).toContain('../screen.uir.json');

    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });
});

describe('cluster.split', () => {
  async function clustered(): Promise<Fixture> {
    const fx = await treeFixture(makeDir);
    const node = (id: string, x: number) => ({
      op: 'node.add',
      node: { id, type: 'image', rect: [x, 800, 100, 100] },
    });
    await applyOps(
      fx.project,
      [node('slot_a', 0), node('slot_b', 200), node('slot_c', 400), node('star', 600)],
      { screen: fx.screen },
    );
    await patchScreen(fx.project, fx.screen, (screen) => {
      for (const id of ['slot_a', 'slot_b', 'slot_c', 'star']) {
        const target = screen.nodes[id];
        if (target) target.cluster = 'vis#1';
      }
    });
    return fx;
  }

  const split = (fx: Fixture, op: Record<string, unknown>) =>
    applyOps(fx.project, [{ op: 'cluster.split', ...op }], { screen: fx.screen });

  it('takes one node out of its cluster and records why', async () => {
    const fx = await clustered();
    await split(fx, { target: '#star', because: '星星和装备框只是轮廓相近' });

    const nodes = loadScreen(fx.project, fx.screen).nodes;
    expect(nodes.star?.cluster).toBeUndefined();
    expect(nodes.star?.clusterSplit).toEqual({
      from: 'vis#1',
      because: '星星和装备框只是轮廓相近',
    });
    expect(nodes.slot_a?.cluster).toBe('vis#1');
  });

  it('moves several nodes into a new sub-cluster, or dissolves the cluster with into: none', async () => {
    const fx = await clustered();
    await split(fx, { target: '#slot_b, #slot_c', because: '底框颜色不同' });
    let nodes = loadScreen(fx.project, fx.screen).nodes;
    expect([nodes.slot_b?.cluster, nodes.slot_c?.cluster]).toEqual(['vis#1~1', 'vis#1~1']);

    await split(fx, { target: '#slot_a, #star', because: '误聚', into: 'none' });
    nodes = loadScreen(fx.project, fx.screen).nodes;
    expect([nodes.slot_a?.cluster, nodes.star?.cluster]).toEqual([undefined, undefined]);
  });

  it('refuses no reason, mixed clusters, unclustered nodes and a no-op regroup', async () => {
    const fx = await clustered();
    const codeOf = async (op: Record<string, unknown>) => (await failureOf(split(fx, op))).code;

    expect(await codeOf({ target: '#star', because: '  ' })).toBe(ErrorCodes.opInvalid);
    expect(await codeOf({ target: '#title', because: 'x' })).toBe(ErrorCodes.opInvalid);
    expect(await codeOf({ target: '#slot_a, #slot_b, #slot_c, #star', because: 'x' })).toBe(
      ErrorCodes.opInvalid,
    );
    await split(fx, { target: '#star', because: 'x' });
    expect(await codeOf({ target: '#slot_a, #star', because: 'x' })).toBe(ErrorCodes.opInvalid);
  });
});

describe('exclusion.add / exclusion.remove', () => {
  it('records excluded regions with a reason, numbers them, removes them, and undoes', async () => {
    const fx = await treeFixture(makeDir);
    const apply = (ops: Record<string, unknown>[]) =>
      applyOps(fx.project, ops, { screen: fx.screen });

    await apply([
      { op: 'exclusion.add', rect: [0, 520, 60, 80], because: '系统返回箭头' },
      { op: 'exclusion.add', rect: [0, 880, 90, 100], because: '系统返回箭头' },
    ]);
    expect(loadScreen(fx.project, fx.screen).exclusions).toEqual([
      { id: 'ex_1', rect: [0, 520, 60, 80], because: '系统返回箭头', evidence: [] },
      { id: 'ex_2', rect: [0, 880, 90, 100], because: '系统返回箭头', evidence: [] },
    ]);

    await apply([{ op: 'exclusion.remove', id: 'ex_1' }]);
    await apply([{ op: 'exclusion.add', rect: [10, 10, 5, 5], because: '水印' }]);
    expect(loadScreen(fx.project, fx.screen).exclusions.map((e) => e.id)).toEqual(['ex_2', 'ex_1']);

    await undo(fx.project);
    await undo(fx.project);
    expect(loadScreen(fx.project, fx.screen).exclusions).toHaveLength(2);
  });

  it('refuses no reason, no region and an unknown id', async () => {
    const fx = await treeFixture(makeDir);
    const codeOf = async (op: Record<string, unknown>) =>
      (await failureOf(applyOps(fx.project, [op], { screen: fx.screen }))).code;

    expect(await codeOf({ op: 'exclusion.add', rect: [0, 0, 10, 10], because: ' ' })).toBe(
      ErrorCodes.opInvalid,
    );
    expect(await codeOf({ op: 'exclusion.add', because: 'x' })).toBe(ErrorCodes.opInvalid);
    expect(await codeOf({ op: 'exclusion.remove', id: 'ex_9' })).toBe(ErrorCodes.opInvalid);
  });
});
