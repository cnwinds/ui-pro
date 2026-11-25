import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ApplyResult, applyOps, ErrorCodes, loadScreen, type UINode } from '../src';
import {
  addEmptyScreen,
  emptyScreenProject,
  type Fixture,
  failureOf,
  readText,
  treeFixture,
  useTempDirs,
  writeCandidates,
} from './helpers';

const makeDir = useTempDirs();

function run(fixture: Fixture, ...ops: unknown[]): Promise<ApplyResult> {
  return applyOps(fixture.project, ops, { screen: fixture.screen });
}

async function codeOf(fixture: Fixture, ...ops: unknown[]): Promise<string> {
  return (await failureOf(run(fixture, ...ops))).code;
}

function doc(fixture: Fixture) {
  return loadScreen(fixture.project, fixture.screen);
}

function nodeOf(fixture: Fixture, id: string): UINode {
  const node = doc(fixture).nodes[id];
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

const childrenOf = (fixture: Fixture, id: string) => nodeOf(fixture, id).children;

describe('node.add', () => {
  it('adds a node under the root by default, on top of its siblings', async () => {
    const fx = await treeFixture(makeDir);

    const result = await run(fx, {
      op: 'node.add',
      node: {
        id: 'coin',
        type: 'image',
        rect: [10, 20, 30, 40],
        role: 'icon.coin',
        concept: '金币',
      },
    });

    expect(childrenOf(fx, 'root')).toEqual(['topbar', 'btn_upgrade', 'title', 'coin']);
    expect(nodeOf(fx, 'coin')).toMatchObject({
      parent: 'root',
      rect: [10, 20, 30, 40],
      role: 'icon.coin',
      concept: '金币',
      visible: true,
      varies: [],
      evidence: [],
    });
    expect(result.changes.screens.main).toMatchObject({ added: ['coin'], removed: [] });
    expect(result.version).toBe(3);
  });

  it('places the node under the parent selector, at the given index', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'node.add',
      node: { id: 'first', type: 'text', rect: [0, 0, 10, 10], parent: '#topbar', index: 0 },
    });

    expect(childrenOf(fx, 'topbar')).toEqual(['first', 'btn_shop', 'btn_mail']);
    expect(nodeOf(fx, 'first').parent).toBe('topbar');
  });

  it('numbers ids automatically from the type', async () => {
    const fx = await emptyScreenProject(makeDir);
    const add = { op: 'node.add', node: { type: 'toggle-group', rect: [0, 0, 5, 5] } };

    await run(fx, add, add);

    expect(childrenOf(fx, 'root')).toEqual(['toggle_group_1', 'toggle_group_2']);
  });

  it('keeps text, varies and visibility', async () => {
    const fx = await emptyScreenProject(makeDir);

    await run(fx, {
      op: 'node.add',
      node: {
        id: 'amount',
        type: 'text',
        rect: [0, 0, 100, 30],
        text: { content: '1,200', kind: 'value', size: 24, color: '#ffcc00' },
        varies: ['content'],
        visible: false,
      },
    });

    expect(nodeOf(fx, 'amount')).toMatchObject({
      text: { content: '1,200', kind: 'value', size: 24, color: '#ffcc00' },
      varies: ['content'],
      visible: false,
    });
  });

  it('derives the rect from evidence, converting source pixels to design pixels', async () => {
    const fx = await emptyScreenProject(makeDir, { width: 540, height: 960 });
    await writeCandidates(fx.project, 'main', {
      'cand#1': [10, 20, 30, 40],
      'cand#2': [100, 100, 10, 10],
    });

    await run(fx, {
      op: 'node.add',
      node: { id: 'panel', type: 'container' },
      from: ['cand#1', 'cand#2'],
    });

    expect(nodeOf(fx, 'panel').rect).toEqual([20, 40, 200, 180]);
    expect(nodeOf(fx, 'panel').evidence).toEqual(['cand#1', 'cand#2']);
  });

  it('fails when the rect cannot be determined', async () => {
    const fx = await emptyScreenProject(makeDir);
    const noRect = { op: 'node.add', node: { id: 'a', type: 'text' } };

    expect(await codeOf(fx, noRect)).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, { ...noRect, from: ['cand#1'] })).toBe(ErrorCodes.opInvalid);

    await writeCandidates(fx.project, 'main', { 'cand#1': [0, 0, 5, 5] });
    const unknown = await failureOf(run(fx, { ...noRect, from: ['cand#9'] }));
    expect(unknown.code).toBe(ErrorCodes.opInvalid);
    expect(unknown.message).toContain('cand#9');
  });

  it('rejects duplicate ids, bad indexes and unusable parents', async () => {
    const fx = await treeFixture(makeDir);
    const node = (extra: Record<string, unknown>) => ({
      op: 'node.add',
      node: { id: 'fresh', type: 'text', rect: [0, 0, 5, 5], ...extra },
    });

    expect(await codeOf(fx, node({ id: 'title' }))).toBe(ErrorCodes.nodeExists);
    expect(await codeOf(fx, node({ index: 99 }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, node({ parent: '#nope' }))).toBe(ErrorCodes.selectorEmpty);
    expect(await codeOf(fx, node({ parent: 'button' }))).toBe(ErrorCodes.selectorAmbiguous);
  });

  it('rejects malformed op input with E_OP_INVALID', async () => {
    const fx = await emptyScreenProject(makeDir);
    const bad = [
      { op: 'node.add', node: { id: 'Bad-Id', type: 'text', rect: [0, 0, 5, 5] } },
      { op: 'node.add', node: { id: 'a', type: 'sprite', rect: [0, 0, 5, 5] } },
      { op: 'node.add', node: { id: 'a', type: 'text', rect: [0, 0, 0, 5] } },
      { op: 'node.add', node: { id: 'a', type: 'text', rect: [0, 0, 5, 5] }, extra: true },
      { op: 'node.add' },
      { node: { id: 'a' } },
      'node.add',
      null,
    ];

    for (const op of bad) {
      expect(await codeOf(fx, op), JSON.stringify(op)).toBe(ErrorCodes.opInvalid);
    }
  });
});

describe('node.set', () => {
  it('changes the given fields and leaves the rest alone', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'node.set',
      target: '#title',
      set: {
        type: 'button',
        role: 'cta.primary',
        concept: '标题',
        rect: [1, 2, 3, 4],
        varies: ['content', 'state'],
        visible: false,
        confidence: 0.8,
        evidence: ['cand#3'],
        anchor: { h: 'center', v: 'top' },
        pivot: [0.5, 0.5],
        text: { content: '新标题' },
      },
    });

    expect(nodeOf(fx, 'title')).toMatchObject({
      type: 'button',
      role: 'cta.primary',
      concept: '标题',
      rect: [1, 2, 3, 4],
      varies: ['content', 'state'],
      visible: false,
      confidence: 0.8,
      evidence: ['cand#3'],
      anchor: { h: 'center', v: 'top' },
      pivot: [0.5, 0.5],
      text: { content: '新标题' },
      parent: 'root',
    });
  });

  it('clears optional fields with null', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'node.set',
      target: '#badge_dot',
      set: {
        role: null,
        concept: null,
        text: null,
        confidence: null,
        anchor: null,
        pivot: null,
      },
    });

    const node = nodeOf(fx, 'badge_dot');
    expect(node.role).toBeUndefined();
    expect(node.concept).toBeUndefined();
    expect(await readText(fx.project, 'screens/main/screen.uir.json')).not.toContain(
      '"concept": "红点"',
    );
  });

  it('applies to every node the selector matches', async () => {
    const fx = await treeFixture(makeDir);

    const result = await run(fx, { op: 'node.set', target: 'button', set: { varies: ['state'] } });

    for (const id of ['btn_shop', 'btn_mail', 'btn_upgrade']) {
      expect(nodeOf(fx, id).varies, id).toEqual(['state']);
    }
    expect(Object.keys(result.changes.screens.main?.modified ?? {})).toEqual([
      'btn_shop',
      'btn_mail',
      'btn_upgrade',
    ]);
  });

  it('rejects empty, unknown and invalid sets, and targets that match nothing', async () => {
    const fx = await treeFixture(makeDir);
    const set = (value: unknown, target = '#title') => ({ op: 'node.set', target, set: value });

    expect(await codeOf(fx, set({}))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, set({ colour: 'red' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, set({ rect: [0, 0, 0, 1] }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, set({ role: 'Not Valid' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, set({ confidence: 2 }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, set({ visible: false }, '#ghost'))).toBe(ErrorCodes.selectorEmpty);
  });
});

describe('node.split', () => {
  it('adds the part as a child of the source node by default', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'node.split',
      from: '#btn_upgrade',
      part: { rect: [110, 1510, 60, 60] },
      as: { id: 'icon', type: 'image', role: 'icon.upgrade' },
    });

    expect(childrenOf(fx, 'btn_upgrade')).toEqual(['badge_dot', 'icon']);
    expect(nodeOf(fx, 'icon')).toMatchObject({
      parent: 'btn_upgrade',
      rect: [110, 1510, 60, 60],
      role: 'icon.upgrade',
    });
  });

  it('derives the part from evidence and honours an explicit parent', async () => {
    const fx = await treeFixture(makeDir);
    await writeCandidates(fx.project, 'main', { 'cand#7': [120, 1520, 50, 50] });

    await run(fx, {
      op: 'node.split',
      from: '#btn_upgrade',
      part: { evidence: ['cand#7'] },
      as: { id: 'glow', type: 'image', parent: '#root' },
    });

    expect(nodeOf(fx, 'glow')).toMatchObject({
      parent: 'root',
      rect: [120, 1520, 50, 50],
      evidence: ['cand#7'],
    });
  });

  it('rejects parts without a position, ambiguous sources and parents on other screens', async () => {
    const fx = await treeFixture(makeDir);
    await addEmptyScreen(fx.project, 'other');
    const split = (overrides: Record<string, unknown>) => ({
      op: 'node.split',
      from: '#btn_upgrade',
      part: { rect: [0, 0, 5, 5] },
      as: { id: 'bit', type: 'image' },
      ...overrides,
    });

    expect(await codeOf(fx, split({ part: {} }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, split({ from: 'button' }))).toBe(ErrorCodes.selectorAmbiguous);
    expect(
      await codeOf(fx, split({ as: { id: 'bit', type: 'image', parent: 'other/#root' } })),
    ).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, split({ as: { id: 'title', type: 'image' } }))).toBe(
      ErrorCodes.nodeExists,
    );
  });
});

describe('node.merge', () => {
  it('replaces the targets with one node covering them, at the first target position', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'node.set', target: '#btn_shop', set: { evidence: ['cand#1', 'cand#2'] } });
    await run(fx, { op: 'node.set', target: '#btn_mail', set: { evidence: ['cand#2', 'cand#3'] } });

    await run(fx, { op: 'node.merge', targets: '#btn_shop, #btn_mail' });

    const merged = nodeOf(fx, 'btn_shop');
    expect(doc(fx).nodes.btn_mail).toBeUndefined();
    expect(childrenOf(fx, 'topbar')).toEqual(['btn_shop']);
    expect(merged).toMatchObject({
      type: 'button',
      role: 'nav.shop',
      parent: 'topbar',
      rect: [600, 20, 400, 80],
      evidence: ['cand#1', 'cand#2', 'cand#3'],
    });
  });

  it('takes overrides from `as` and adopts the children of all targets', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'node.merge',
      targets: '#btn_upgrade, #title',
      as: { id: 'combo', type: 'container', role: 'group.combo', concept: '组合' },
    });

    expect(childrenOf(fx, 'root')).toEqual(['topbar', 'combo']);
    expect(nodeOf(fx, 'combo')).toMatchObject({
      type: 'container',
      role: 'group.combo',
      concept: '组合',
      children: ['badge_dot'],
      rect: [100, 300, 680, 1320],
    });
    expect(nodeOf(fx, 'badge_dot').parent).toBe('combo');
  });

  it('warns about user-made data the merged node does not keep', async () => {
    const fx = await treeFixture(makeDir);

    const result = await run(fx, { op: 'node.merge', targets: '#btn_upgrade, #title' });

    expect(result.warnings).toEqual([
      '合并后 #title 的文字不再保留，需要时请在合并后的节点上重新设置',
    ]);
  });

  it('drops glossary exemplars that point at merged-away nodes', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'concept.define', name: '导航', exemplars: '#btn_shop, #btn_mail' });

    await run(fx, { op: 'node.merge', targets: '#btn_shop, #btn_mail' });

    const glossary = await readText(fx.project, 'glossary.yaml');
    expect(glossary).toContain('main/#btn_shop');
    expect(glossary).not.toContain('main/#btn_mail');
  });

  it('rejects unmergeable target sets', async () => {
    const fx = await treeFixture(makeDir);
    await addEmptyScreen(fx.project, 'other');
    const merge = (targets: string, as?: unknown) => ({ op: 'node.merge', targets, as });

    expect(await codeOf(fx, merge('#btn_shop'))).toBe(ErrorCodes.selectorEmpty);
    expect(await codeOf(fx, merge('#root, #title'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, merge('#btn_upgrade, #badge_dot'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, merge('#btn_shop, other/#root'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, merge('#btn_shop, #btn_mail', { id: 'title' }))).toBe(
      ErrorCodes.nodeExists,
    );
  });
});

describe('node.move', () => {
  it('reparents the node and keeps its rectangle', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.move', target: '#btn_mail', parent: '#btn_upgrade' });

    expect(childrenOf(fx, 'topbar')).toEqual(['btn_shop']);
    expect(childrenOf(fx, 'btn_upgrade')).toEqual(['badge_dot', 'btn_mail']);
    expect(nodeOf(fx, 'btn_mail')).toMatchObject({
      parent: 'btn_upgrade',
      rect: [600, 20, 150, 80],
    });
  });

  it('inserts at the given index, keeping the order of several targets', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.move', target: '#btn_shop, #btn_mail', parent: '#root', index: 1 });

    expect(childrenOf(fx, 'root')).toEqual([
      'topbar',
      'btn_shop',
      'btn_mail',
      'btn_upgrade',
      'title',
    ]);
    expect(childrenOf(fx, 'topbar')).toEqual([]);
  });

  it('can reorder within the same parent', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.move', target: '#title', parent: '#root', index: 0 });

    expect(childrenOf(fx, 'root')).toEqual(['title', 'topbar', 'btn_upgrade']);
  });

  it('rejects moves that would break the tree', async () => {
    const fx = await treeFixture(makeDir);
    await addEmptyScreen(fx.project, 'other');
    const move = (target: string, parent: string, index?: number) => ({
      op: 'node.move',
      target,
      parent,
      index,
    });

    expect(await codeOf(fx, move('#btn_upgrade', '#badge_dot'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, move('#btn_upgrade', '#btn_upgrade'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, move('#root', '#title'))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, move('#title', 'button'))).toBe(ErrorCodes.selectorAmbiguous);
    expect(await codeOf(fx, move('#title', '#topbar', 9))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, move('#title', 'other/#root'))).toBe(ErrorCodes.opInvalid);
  });
});

describe('node.remove', () => {
  it('moves the children up into the parent by default', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.remove', target: '#btn_upgrade' });

    expect(doc(fx).nodes.btn_upgrade).toBeUndefined();
    expect(childrenOf(fx, 'root')).toEqual(['topbar', 'badge_dot', 'title']);
    expect(nodeOf(fx, 'badge_dot').parent).toBe('root');
  });

  it('removes the whole subtree with children: delete', async () => {
    const fx = await treeFixture(makeDir);

    const result = await run(fx, { op: 'node.remove', target: '#topbar', children: 'delete' });

    expect(Object.keys(doc(fx).nodes)).toEqual(['root', 'btn_upgrade', 'badge_dot', 'title']);
    expect(result.changes.screens.main?.removed).toEqual(['topbar', 'btn_shop', 'btn_mail']);
  });

  it('copes with a target nested in another target', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.remove', target: '#btn_upgrade, #badge_dot', children: 'delete' });

    expect(Object.keys(doc(fx).nodes)).toEqual(['root', 'topbar', 'btn_shop', 'btn_mail', 'title']);
  });

  it('drops glossary exemplars of removed nodes', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'concept.define', name: '红点', exemplars: '#badge_dot' });

    await run(fx, { op: 'node.remove', target: '#badge_dot' });

    expect(await readText(fx.project, 'glossary.yaml')).not.toContain('badge_dot');
  });

  it('rejects the root, unknown modes and empty matches', async () => {
    const fx = await treeFixture(makeDir);

    expect(await codeOf(fx, { op: 'node.remove', target: '#root' })).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, { op: 'node.remove', target: '#title', children: 'orphan' })).toBe(
      ErrorCodes.opInvalid,
    );
    expect(await codeOf(fx, { op: 'node.remove', target: '#ghost' })).toBe(
      ErrorCodes.selectorEmpty,
    );
  });
});

describe('node.rename', () => {
  it('rewrites every reference to the id', async () => {
    const fx = await treeFixture(makeDir);
    await run(
      fx,
      { op: 'concept.define', name: '升级', exemplars: '#btn_upgrade' },
      { op: 'component.extract', name: 'Upgrade', targets: '#btn_upgrade' },
    );

    await run(fx, { op: 'node.rename', target: '#btn_upgrade', id: 'btn_level' });

    expect(Object.keys(doc(fx).nodes)).toEqual([
      'root',
      'topbar',
      'btn_shop',
      'btn_mail',
      'btn_level',
      'badge_dot',
      'title',
    ]);
    expect(childrenOf(fx, 'root')).toEqual(['topbar', 'btn_level', 'title']);
    expect(nodeOf(fx, 'badge_dot').parent).toBe('btn_level');
    expect(nodeOf(fx, 'btn_level').id).toBe('btn_level');
    expect(doc(fx).components.Upgrade?.master).toBe('btn_level');
    expect(await readText(fx.project, 'glossary.yaml')).toContain('main/#btn_level');
    expect(await readText(fx.project, 'glossary.yaml')).not.toContain('btn_upgrade');
  });

  it('can rename the root', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'node.rename', target: '#root', id: 'screen_root' });

    expect(doc(fx).root).toBe('screen_root');
    expect(nodeOf(fx, 'topbar').parent).toBe('screen_root');
  });

  it('does nothing when the id is unchanged', async () => {
    const fx = await treeFixture(makeDir);

    const result = await run(fx, { op: 'node.rename', target: '#title', id: 'title' });

    expect(result.version).toBeUndefined();
    expect(result.changes.docs).toEqual([]);
  });

  it('rejects taken or malformed ids and ambiguous targets', async () => {
    const fx = await treeFixture(makeDir);

    expect(await codeOf(fx, { op: 'node.rename', target: '#title', id: 'topbar' })).toBe(
      ErrorCodes.nodeExists,
    );
    expect(await codeOf(fx, { op: 'node.rename', target: '#title', id: 'Title' })).toBe(
      ErrorCodes.opInvalid,
    );
    expect(await codeOf(fx, { op: 'node.rename', target: 'button', id: 'x' })).toBe(
      ErrorCodes.selectorAmbiguous,
    );
  });
});

describe('concept.define', () => {
  it('creates a glossary entry and tags the example nodes', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'concept.define',
      name: '导航按钮',
      role: 'nav.button',
      description: '底部或顶部的导航入口',
      exemplars: '#btn_shop, #btn_mail',
    });

    const glossary = await readText(fx.project, 'glossary.yaml');
    expect(glossary).toContain('name: 导航按钮');
    expect(glossary).toContain('role: nav.button');
    expect(glossary).toContain('main/#btn_shop');
    expect(nodeOf(fx, 'btn_shop')).toMatchObject({ concept: '导航按钮', role: 'nav.button' });
    expect(nodeOf(fx, 'btn_mail')).toMatchObject({ concept: '导航按钮', role: 'nav.button' });
  });

  it('updates an existing concept without duplicating exemplars', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'concept.define', name: '导航', exemplars: '#btn_shop' });

    await run(fx, {
      op: 'concept.define',
      name: '导航',
      description: '更新后的说明',
      exemplars: '#btn_shop, #btn_mail',
    });

    const glossary = await readText(fx.project, 'glossary.yaml');
    expect(glossary.match(/name: 导航/g)).toHaveLength(1);
    expect(glossary.match(/main\/#btn_shop/g)).toHaveLength(1);
    expect(glossary).toContain('main/#btn_mail');
    expect(glossary).toContain('更新后的说明');
    expect(nodeOf(fx, 'btn_shop').role).toBe('nav.shop');
  });

  it('can define a concept with no exemplars', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'concept.define', name: '货币' });

    expect(await readText(fx.project, 'glossary.yaml')).toContain('name: 货币');
  });

  it('fails when the exemplar selector matches nothing, leaving the glossary alone', async () => {
    const fx = await treeFixture(makeDir);

    expect(await codeOf(fx, { op: 'concept.define', name: '红点', exemplars: '#ghost' })).toBe(
      ErrorCodes.selectorEmpty,
    );
    expect(await readText(fx.project, 'glossary.yaml')).not.toContain('红点');
  });
});

describe('component.extract', () => {
  it('registers the component and marks the targets as instances', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'component.extract', name: 'NavButton', targets: '#btn_shop, #btn_mail' });

    expect(doc(fx).components.NavButton).toEqual({
      name: 'NavButton',
      master: 'btn_shop',
      props: {},
      events: [],
    });
    expect(nodeOf(fx, 'btn_shop').instanceOf).toBe('NavButton');
    expect(nodeOf(fx, 'btn_mail').instanceOf).toBe('NavButton');
  });

  it('uses an explicit master and keeps it when instances are added later', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, {
      op: 'component.extract',
      name: 'NavButton',
      targets: '#btn_shop',
      master: '#btn_mail',
    });

    await run(fx, { op: 'component.extract', name: 'NavButton', targets: '#btn_upgrade' });

    expect(doc(fx).components.NavButton?.master).toBe('btn_mail');
    expect(nodeOf(fx, 'btn_upgrade').instanceOf).toBe('NavButton');
  });

  it('rejects the root, bad names and masters on other screens', async () => {
    const fx = await treeFixture(makeDir);
    await addEmptyScreen(fx.project, 'other');
    const extract = (overrides: Record<string, unknown>) => ({
      op: 'component.extract',
      name: 'Thing',
      targets: '#btn_shop',
      ...overrides,
    });

    expect(await codeOf(fx, extract({ targets: '#root' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, extract({ name: 'thing' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, extract({ master: 'other/#root' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, extract({ targets: '#btn_shop, other/#root' }))).toBe(
      ErrorCodes.opInvalid,
    );
  });
});

describe('pin.set / pin.clear', () => {
  it('pins values, validating the known keys', async () => {
    const fx = await treeFixture(makeDir);

    await run(
      fx,
      { op: 'pin.set', target: '#btn_shop', key: 'rect', value: [1, 2, 3, 4] },
      { op: 'pin.set', target: '#btn_shop', key: 'nineSlice', value: [8, 8, 8, 8] },
      { op: 'pin.set', target: '#btn_shop', key: 'note', value: { why: 'measured by hand' } },
    );

    expect(nodeOf(fx, 'btn_shop').pins).toEqual({
      rect: [1, 2, 3, 4],
      nineSlice: [8, 8, 8, 8],
      note: { why: 'measured by hand' },
    });
  });

  it('rejects values of the wrong shape and reserved keys', async () => {
    const fx = await treeFixture(makeDir);
    const pin = (key: string, value: unknown) => ({
      op: 'pin.set',
      target: '#btn_shop',
      key,
      value,
    });

    expect(await codeOf(fx, pin('rect', [0, 0, 0, 4]))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, pin('nineSlice', [-1, 0, 0, 0]))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, pin('anchor', { h: 'middle' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, pin('pivot', [1]))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, pin('__proto__', 1))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, pin('', 1))).toBe(ErrorCodes.opInvalid);
  });

  it('treats names that exist on Object.prototype as ordinary keys', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'pin.set', target: '#btn_shop', key: 'constructor', value: 7 });

    expect(nodeOf(fx, 'btn_shop').pins).toEqual({ constructor: 7 });
  });

  it('clears one pin or all of them', async () => {
    const fx = await treeFixture(makeDir);
    await run(
      fx,
      { op: 'pin.set', target: '#btn_shop', key: 'rect', value: [1, 2, 3, 4] },
      { op: 'pin.set', target: '#btn_shop', key: 'note', value: 'x' },
    );

    await run(fx, { op: 'pin.clear', target: '#btn_shop', key: 'rect' });
    expect(nodeOf(fx, 'btn_shop').pins).toEqual({ note: 'x' });

    await run(fx, { op: 'pin.clear', target: '#btn_shop' });
    expect(nodeOf(fx, 'btn_shop').pins).toEqual({});
  });
});

describe('layout.set', () => {
  it('sets anchor and pivot and pins them', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, {
      op: 'layout.set',
      target: '#title',
      anchor: { h: 'stretch', v: 'top' },
      pivot: [0.5, 0],
    });

    expect(nodeOf(fx, 'title')).toMatchObject({
      anchor: { h: 'stretch', v: 'top' },
      pivot: [0.5, 0],
      pins: { anchor: { h: 'stretch', v: 'top' }, pivot: [0.5, 0] },
    });
  });

  it('accepts either field on its own', async () => {
    const fx = await treeFixture(makeDir);

    await run(fx, { op: 'layout.set', target: '#title', pivot: [0, 0] });

    const node = nodeOf(fx, 'title');
    expect(node.pivot).toEqual([0, 0]);
    expect(node.anchor).toBeUndefined();
    expect(node.pins).toEqual({ pivot: [0, 0] });
  });

  it('needs at least one field, and valid ones', async () => {
    const fx = await treeFixture(makeDir);

    expect(await codeOf(fx, { op: 'layout.set', target: '#title' })).toBe(ErrorCodes.opInvalid);
    expect(
      await codeOf(fx, { op: 'layout.set', target: '#title', anchor: { h: 'top', v: 'top' } }),
    ).toBe(ErrorCodes.opInvalid);
  });
});

describe('state.set', () => {
  it('sets, replaces and deletes a named state', async () => {
    const fx = await treeFixture(makeDir);
    const state = (set: unknown) => ({
      op: 'state.set',
      target: '#btn_shop',
      state: 'pressed',
      set,
    });

    await run(fx, state({ tint: '#cccccc', visible: true }));
    expect(nodeOf(fx, 'btn_shop').states).toEqual({ pressed: { tint: '#cccccc', visible: true } });

    await run(fx, state({ asset: 'btn_pressed.png', source: 'drawn' }));
    expect(nodeOf(fx, 'btn_shop').states).toEqual({
      pressed: { asset: 'btn_pressed.png', source: 'drawn' },
    });

    await run(fx, state(null));
    expect(nodeOf(fx, 'btn_shop').states).toBeUndefined();
  });

  it('keeps the other states when one is deleted', async () => {
    const fx = await treeFixture(makeDir);
    await run(
      fx,
      { op: 'state.set', target: '#btn_shop', state: 'pressed', set: { tint: '#111111' } },
      { op: 'state.set', target: '#btn_shop', state: 'disabled', set: { tint: '#999999' } },
    );

    await run(fx, { op: 'state.set', target: '#btn_shop', state: 'pressed', set: null });

    expect(Object.keys(nodeOf(fx, 'btn_shop').states ?? {})).toEqual(['disabled']);
  });

  it('rejects bad state names and override fields', async () => {
    const fx = await treeFixture(makeDir);
    const state = (name: string, set: unknown) => ({
      op: 'state.set',
      target: '#btn_shop',
      state: name,
      set,
    });

    expect(await codeOf(fx, state('Pressed', {}))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, state('__proto__', {}))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, state('pressed', { tint: 'red' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, state('pressed', { glow: true }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, { op: 'state.set', target: '#btn_shop', state: 'pressed' })).toBe(
      ErrorCodes.opInvalid,
    );
  });
});

describe('bind.set', () => {
  it('binds a property to a data path, with an optional format', async () => {
    const fx = await treeFixture(makeDir);

    await run(
      fx,
      { op: 'bind.set', target: '#title', prop: 'text', path: 'player.name' },
      { op: 'bind.set', target: '#title', prop: 'visible', path: 'player.ready', format: 'bool' },
    );

    expect(nodeOf(fx, 'title').bind).toEqual({
      text: { path: 'player.name' },
      visible: { path: 'player.ready', format: 'bool' },
    });
  });

  it('removes a binding with a null path, and the bind map when it empties', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'bind.set', target: '#title', prop: 'text', path: 'player.name' });

    await run(fx, { op: 'bind.set', target: '#title', prop: 'text', path: null });

    expect(nodeOf(fx, 'title').bind).toBeUndefined();
  });

  it('rejects a format on an unbinding, empty paths and reserved property names', async () => {
    const fx = await treeFixture(makeDir);
    const bind = (overrides: Record<string, unknown>) => ({
      op: 'bind.set',
      target: '#title',
      prop: 'text',
      path: 'a.b',
      ...overrides,
    });

    expect(await codeOf(fx, bind({ path: null, format: 'x' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, bind({ path: '' }))).toBe(ErrorCodes.opInvalid);
    expect(await codeOf(fx, bind({ prop: '__proto__' }))).toBe(ErrorCodes.opInvalid);
  });
});

describe('persisted result', () => {
  it('writes canonical screen files that a fresh read sees', async () => {
    const fx = await treeFixture(makeDir);
    await run(fx, { op: 'node.rename', target: '#title', id: 'headline' });

    const onDisk = await readFile(join(fx.project.root, 'screens/main/screen.uir.json'), 'utf8');

    expect(onDisk).toContain('"id": "headline"');
    expect(Object.keys(doc(fx).nodes)).toContain('headline');
  });
});
