import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyOps,
  commitVersion,
  createCoreRegistry,
  type DocKind,
  defineOp,
  ErrorCodes,
  listHistory,
  loadScreen,
  showVersion,
  type UiProError,
  withProjectLock,
} from '../src';
import { applyStagedWrites } from '../src/fs/atomic';
import {
  addEmptyScreen,
  type Fixture,
  failureOf,
  readText,
  snapshotTree,
  treeFixture,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

const addNode = (id: string) => ({
  op: 'node.add',
  node: { id, type: 'text', rect: [0, 0, 10, 10] },
});

function apply(fx: Fixture, ops: unknown[], options: Parameters<typeof applyOps>[2] = {}) {
  return applyOps(fx.project, ops, { screen: fx.screen, ...options });
}

function detailsOf(error: UiProError): Record<string, unknown> {
  return error.details as Record<string, unknown>;
}

describe('all-or-nothing batches', () => {
  it('leaves every file byte-identical when a later op fails', async () => {
    const fx = await treeFixture(makeDir);
    const before = await snapshotTree(fx.project.root);

    const error = await failureOf(
      apply(fx, [
        addNode('extra'),
        { op: 'concept.define', name: '新概念', exemplars: '#title' },
        { op: 'node.rename', target: '#title', id: 'topbar' },
      ]),
    );

    expect(error.code).toBe(ErrorCodes.nodeExists);
    expect(detailsOf(error)).toMatchObject({ opIndex: 2, op: 'node.rename' });
    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('reports the failing op for unknown ops and malformed input', async () => {
    const fx = await treeFixture(makeDir);
    const before = await snapshotTree(fx.project.root);

    const unknown = await failureOf(apply(fx, [addNode('extra'), { op: 'node.explode' }]));
    expect(unknown.code).toBe(ErrorCodes.opUnknown);
    expect(unknown.hint).toContain('node.add');
    expect(detailsOf(unknown)).toMatchObject({ opIndex: 1, op: 'node.explode' });

    const malformed = await failureOf(apply(fx, [{ op: 'node.remove' }]));
    expect(malformed.code).toBe(ErrorCodes.opInvalid);
    expect(malformed.message).toContain('target');
    expect(detailsOf(malformed)).toMatchObject({ opIndex: 0 });
    expect(Array.isArray(detailsOf(malformed).issues)).toBe(true);

    const notAnObject = await failureOf(apply(fx, [42]));
    expect(notAnObject.code).toBe(ErrorCodes.opInvalid);
    expect(detailsOf(notAnObject)).toMatchObject({ opIndex: 0 });

    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('writes several documents together or not at all', async () => {
    const fx = await treeFixture(makeDir);
    const before = await snapshotTree(fx.project.root);

    const failure = await failureOf(
      apply(fx, [
        { op: 'concept.define', name: '红点', exemplars: '#badge_dot' },
        { op: 'node.set', target: '#ghost', set: { visible: false } },
      ]),
    );

    expect(failure.code).toBe(ErrorCodes.selectorEmpty);
    expect(await snapshotTree(fx.project.root)).toEqual(before);

    const result = await apply(fx, [
      { op: 'concept.define', name: '提醒点', exemplars: '#badge_dot' },
    ]);
    expect(result.changes.docs).toEqual(['glossary.yaml', 'screens/main/screen.uir.json']);
  });

  it('rejects an op that leaves a screen invalid, naming the problems', async () => {
    const fx = await treeFixture(makeDir);
    const registry = createCoreRegistry();
    registry.registerOp(
      defineOp({
        name: 'test.corrupt',
        family: 'structure',
        summary: 'breaks the tree on purpose',
        schema: z.strictObject({ op: z.literal('test.corrupt') }),
        apply(ctx) {
          const node = ctx.screen().nodes.title;
          if (node) node.rect = [0, 0, 0, 0];
        },
      }),
    );
    const before = await snapshotTree(fx.project.root);

    const error = await failureOf(apply(fx, [{ op: 'test.corrupt' }], { registry }));

    expect(error.code).toBe(ErrorCodes.invariant);
    expect(error.message).toContain('宽高必须大于 0');
    expect(detailsOf(error)).toMatchObject({ opIndex: 0, screen: 'main' });
    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('restores already applied files when a write fails part-way', async () => {
    const dir = await makeDir();
    const first = join(dir, 'a.txt');
    const blocked = join(dir, 'blocked');
    await writeFile(first, 'old');
    await mkdir(blocked);

    await expect(
      applyStagedWrites([
        { path: first, before: Buffer.from('old'), after: Buffer.from('new') },
        { path: blocked, before: null, after: Buffer.from('x') },
      ]),
    ).rejects.toMatchObject({ code: ErrorCodes.io });

    expect(await readFile(first, 'utf8')).toBe('old');
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'blocked']);
  });
});

describe('dry runs', () => {
  it('run the whole pipeline but write nothing', async () => {
    const fx = await treeFixture(makeDir);
    const before = await snapshotTree(fx.project.root);

    const result = await apply(fx, [addNode('extra'), { op: 'node.remove', target: '#title' }], {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.changes.screens.main).toMatchObject({ added: ['extra'], removed: ['title'] });
    expect(result.changes.docs).toEqual(['screens/main/screen.uir.json']);
    expect(await snapshotTree(fx.project.root)).toEqual(before);
    expect(existsSync(join(fx.project.root, '.ui-pro', 'lock'))).toBe(false);
  });

  it('report the same errors as a real run', async () => {
    const fx = await treeFixture(makeDir);

    const error = await failureOf(
      apply(fx, [{ op: 'node.rename', target: '#title', id: 'topbar' }], { dryRun: true }),
    );

    expect(error.code).toBe(ErrorCodes.nodeExists);
    expect(detailsOf(error)).toMatchObject({ opIndex: 0 });
  });

  it('do not need the project lock', async () => {
    const fx = await treeFixture(makeDir);

    const result = await withProjectLock(fx.project.root, () =>
      apply(fx, [addNode('extra')], { dryRun: true }),
    );

    expect(result.changes.screens.main?.added).toEqual(['extra']);
  });
});

describe('results and history', () => {
  it('records one version per batch, with the ops, message and source', async () => {
    const fx = await treeFixture(makeDir);
    const ops = [addNode('one'), addNode('two'), { op: 'node.remove', target: '#title' }];

    const result = await apply(fx, ops, { message: '批量整理', source: 'studio' });

    expect(result).toMatchObject({ ok: true, dryRun: false, version: 3, warnings: [], ask: [] });
    const entry = showVersion(fx.project, 3);
    expect(entry).toMatchObject({ message: '批量整理', source: 'studio', live: true, ops });
    expect(Object.keys(entry.docs)).toEqual(['screens/main/screen.uir.json']);
  });

  it('summarises the ops when no message is given', async () => {
    const fx = await treeFixture(makeDir);

    await apply(fx, [addNode('one'), addNode('two'), { op: 'node.remove', target: '#title' }]);

    expect(listHistory(fx.project).at(-1)?.message).toBe('node.add ×2、node.remove');
  });

  it('stores the before and after content of each document as blobs', async () => {
    const fx = await treeFixture(makeDir);
    const beforeText = await readText(fx.project, 'screens/main/screen.uir.json');

    await apply(fx, [addNode('one')]);

    const afterText = await readText(fx.project, 'screens/main/screen.uir.json');
    const { before, after } = showVersion(fx.project, 3).docs['screens/main/screen.uir.json'] ?? {};
    expect(await readFile(join(fx.project.root, 'history', 'blobs', `${before}`), 'utf8')).toBe(
      beforeText,
    );
    expect(await readFile(join(fx.project.root, 'history', 'blobs', `${after}`), 'utf8')).toBe(
      afterText,
    );
  });

  it('creates no version when nothing changed', async () => {
    const fx = await treeFixture(makeDir);
    const versions = listHistory(fx.project).length;

    const result = await apply(fx, [{ op: 'node.set', target: '#title', set: { visible: true } }]);

    expect(result.version).toBeUndefined();
    expect(result.changes.docs).toEqual([]);
    expect(listHistory(fx.project)).toHaveLength(versions);
  });

  it('needs a screen for unqualified selectors in projects with several screens', async () => {
    const fx = await treeFixture(makeDir);
    await addEmptyScreen(fx.project, 'other');
    const op = { op: 'node.set', target: '#title', set: { visible: false } };

    const error = await failureOf(applyOps(fx.project, [op]));
    expect(error.code).toBe(ErrorCodes.screenNotFound);

    await applyOps(fx.project, [{ ...op, target: 'main/#title' }]);
    expect(loadScreen(fx.project, 'main').nodes.title?.visible).toBe(false);
  });

  it('lets `@selection` refer to the nodes Studio has selected', async () => {
    const fx = await treeFixture(makeDir);
    await writeFile(
      join(fx.project.root, '.ui-pro', 'selection.json'),
      JSON.stringify({ screen: 'main', ids: ['title', 'btn_shop'] }),
    );

    await apply(fx, [{ op: 'node.set', target: '@selection', set: { concept: '选中' } }]);

    const doc = loadScreen(fx.project, 'main');
    expect([
      doc.nodes.title?.concept,
      doc.nodes.btn_shop?.concept,
      doc.nodes.btn_mail?.concept,
    ]).toEqual(['选中', '选中', undefined]);
  });
});

describe('extending the kernel', () => {
  const noteKind: DocKind<{ notes: string[] }> = {
    kind: 'test-notes',
    path: (_project, key) => `rules/${key}.notes.json`,
    parse: (text) => JSON.parse(text) as { notes: string[] },
    serialize: (value) => `${JSON.stringify(value)}\n`,
  };

  const noteOp = defineOp({
    name: 'test.note',
    family: 'rules',
    summary: 'appends a note',
    schema: z.strictObject({ op: z.literal('test.note'), text: z.string() }),
    apply(ctx, op) {
      const existing = ctx.doc('test-notes', 'main');
      ctx.setDoc(noteKind, 'main', {
        notes: [...(existing as { notes: string[] }).notes, op.text],
      });
    },
  });

  function registryWithNotes() {
    const registry = createCoreRegistry();
    registry.registerDocKind(noteKind);
    return registry;
  }

  it('passes warnings and questions through, without duplicates', async () => {
    const fx = await treeFixture(makeDir);
    const registry = createCoreRegistry();
    registry.registerOp(
      defineOp({
        name: 'test.chatty',
        family: 'rules',
        summary: 'warns and asks',
        schema: z.strictObject({ op: z.literal('test.chatty') }),
        apply(ctx) {
          ctx.warn('careful');
          ctx.ask({ id: 'q1', question: '确认吗？', options: ['是', '否'], default: '是' });
        },
      }),
    );

    const result = await apply(fx, [{ op: 'test.chatty' }, { op: 'test.chatty' }], {
      registry,
      dryRun: true,
    });

    expect(result.warnings).toEqual(['careful']);
    expect(result.ask).toEqual([
      { id: 'q1', question: '确认吗？', options: ['是', '否'], default: '是' },
    ]);
  });

  it('commits documents of registered kinds and records them in history', async () => {
    const fx = await treeFixture(makeDir);
    const registry = registryWithNotes();
    registry.registerOp(noteOp);
    await writeFile(join(fx.project.root, 'rules', 'main.notes.json'), '{"notes":[]}\n');

    const result = await apply(
      fx,
      [
        { op: 'test.note', text: 'a' },
        { op: 'test.note', text: 'b' },
      ],
      {
        registry,
      },
    );

    expect(result.changes.docs).toEqual(['rules/main.notes.json']);
    expect(await readText(fx.project, 'rules/main.notes.json')).toBe('{"notes":["a","b"]}\n');
    expect(Object.keys(showVersion(fx.project, result.version ?? 0).docs)).toEqual([
      'rules/main.notes.json',
    ]);
  });

  it('fails clearly for documents and kinds that do not exist', async () => {
    const fx = await treeFixture(makeDir);
    const registry = registryWithNotes();
    registry.registerOp(noteOp);

    const missing = await failureOf(apply(fx, [{ op: 'test.note', text: 'a' }], { registry }));
    expect(missing.code).toBe(ErrorCodes.docNotFound);
    expect(missing.message).toContain('rules/main.notes.json');

    const unregistered = await failureOf(
      apply(fx, [{ op: 'test.note', text: 'a' }], { registry: createCoreRegistry() }),
    );
    expect(unregistered.code).toBe(ErrorCodes.opUnknown);
  });

  it('runs beforeCommit hooks after the ops, inside the transaction', async () => {
    const fx = await treeFixture(makeDir);
    const registry = createCoreRegistry();
    registry.registerHook('beforeCommit', (ctx) => {
      const title = ctx.screen('main').nodes.title;
      if (title) title.meta = { checked: true };
    });

    const dry = await apply(fx, [addNode('extra')], { registry, dryRun: true });
    expect(dry.changes.screens.main?.modified).toEqual({ root: ['children'], title: ['meta'] });
    expect(loadScreen(fx.project, 'main').nodes.title?.meta).toBeUndefined();

    await apply(fx, [addNode('extra')], { registry });
    expect(loadScreen(fx.project, 'main').nodes.title?.meta).toEqual({ checked: true });
  });

  it('aborts when a beforeCommit hook throws or leaves a screen invalid', async () => {
    const fx = await treeFixture(makeDir);
    const before = await snapshotTree(fx.project.root);

    const throwing = createCoreRegistry();
    throwing.registerHook('beforeCommit', () => {
      throw new Error('hook exploded');
    });
    await expect(apply(fx, [addNode('extra')], { registry: throwing })).rejects.toThrow(
      'hook exploded',
    );

    const breaking = createCoreRegistry();
    breaking.registerHook('beforeCommit', (ctx) => {
      ctx.screen('main').root = 'nowhere';
    });
    const error = await failureOf(apply(fx, [addNode('extra')], { registry: breaking }));
    expect(error.code).toBe(ErrorCodes.invariant);

    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('tells rename hooks which node was renamed, and lets them update other documents', async () => {
    const fx = await treeFixture(makeDir);
    const registry = registryWithNotes();
    registry.registerOp(noteOp);
    const events: unknown[] = [];
    registry.registerHook('rename', (ctx, event) => {
      events.push(event);
      const notes = ctx.doc(noteKind, 'main');
      ctx.setDoc(noteKind, 'main', {
        notes: notes.notes.map((note) => note.replaceAll(`#${event.from}`, `#${event.to}`)),
      });
    });
    await writeFile(
      join(fx.project.root, 'rules', 'main.notes.json'),
      '{"notes":["see #title"]}\n',
    );

    await apply(fx, [{ op: 'node.rename', target: '#title', id: 'headline' }], { registry });

    expect(events).toEqual([{ screen: 'main', from: 'title', to: 'headline' }]);
    expect(await readText(fx.project, 'rules/main.notes.json')).toBe(
      '{"notes":["see #headline"]}\n',
    );
  });
});

describe('registry', () => {
  it('rejects a second, different op under a taken name but ignores re-registration', () => {
    const registry = createCoreRegistry();
    const make = () =>
      defineOp({
        name: 'test.once',
        family: 'rules',
        summary: 's',
        schema: z.strictObject({ op: z.literal('test.once') }),
        apply() {},
      });
    const first = make();

    registry.registerOp(first);
    registry.registerOp(first);

    expect(() => registry.registerOp(make())).toThrowError(
      expect.objectContaining({ code: ErrorCodes.invariant }),
    );
  });
});

describe('commitVersion', () => {
  it('writes nothing and returns null when no file would change', async () => {
    const fx = await treeFixture(makeDir);
    const text = await readText(fx.project, 'glossary.yaml');
    const versions = listHistory(fx.project).length;

    const entry = await withProjectLock(fx.project.root, () =>
      commitVersion(fx.project, {
        writes: [{ path: 'glossary.yaml', content: Buffer.from(text) }],
        source: 'cli',
        message: 'noop',
        ops: [],
      }),
    );

    expect(entry).toBeNull();
    expect(listHistory(fx.project)).toHaveLength(versions);
  });

  it('refuses two writes to one file and paths outside the project', async () => {
    const fx = await treeFixture(makeDir);
    const commit = (writes: Array<{ path: string; content: Buffer | null }>) =>
      withProjectLock(fx.project.root, () =>
        commitVersion(fx.project, { writes, source: 'cli', message: 'x', ops: [] }),
      );

    const twice = await failureOf(
      commit([
        { path: 'kit/a.txt', content: Buffer.from('1') },
        { path: 'kit/a.txt', content: Buffer.from('2') },
      ]),
    );
    expect(twice.code).toBe(ErrorCodes.invariant);

    const outside = await failureOf(commit([{ path: '../escape.txt', content: Buffer.from('1') }]));
    expect(outside.code).toBe(ErrorCodes.invariant);
  });
});
