import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataOf, treeProject, useTempDirs, writePng } from './helpers';

const makeDir = useTempDirs();

interface Page {
  total: number;
  offset: number;
  limit: number;
  items: Array<Record<string, unknown>>;
}

const ids = (page: Page): unknown[] => page.items.map((item) => item.id);

describe('ui-pro query', () => {
  it('returns id, type, role, concept and rect by default', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['query', '#badge_dot']);

    expect(dataOf<Page>(envelope).items).toEqual([
      {
        screen: 'main',
        id: 'badge_dot',
        type: 'image',
        role: 'badge.notification',
        concept: '红点',
        rect: [380, 1490, 36, 36],
      },
    ]);
    expect(envelope.summary).toBe('匹配 1 个节点');
  });

  it('lists nodes in tree order', async () => {
    const { cli } = await treeProject(makeDir);

    const page = dataOf<Page>(await cli.ok(['query', '*']));

    expect(ids(page)).toEqual([
      'root',
      'topbar',
      'btn_shop',
      'btn_mail',
      'btn_upgrade',
      'badge_dot',
      'title',
    ]);
    expect(page.total).toBe(7);
  });

  it('understands types, attributes, concepts and combinators', async () => {
    const { cli } = await treeProject(makeDir);
    const idsOf = async (selector: string) => ids(dataOf<Page>(await cli.ok(['query', selector])));

    expect(await idsOf('button')).toEqual(['btn_shop', 'btn_mail', 'btn_upgrade']);
    expect(await idsOf('button[role^=nav]')).toEqual(['btn_shop', 'btn_mail']);
    expect(await idsOf('concept:红点')).toEqual(['badge_dot']);
    expect(await idsOf('#topbar > button')).toEqual(['btn_shop', 'btn_mail']);
    expect(await idsOf('#btn_upgrade image')).toEqual(['badge_dot']);
    expect(await idsOf('#no_such_node')).toEqual([]);
  });

  it('projects onto the requested fields, always keeping id', async () => {
    const { cli } = await treeProject(makeDir);

    const page = dataOf<Page>(await cli.ok(['query', '#title', '--fields', 'type,text']));

    expect(page.items).toEqual([
      { screen: 'main', id: 'title', type: 'text', text: { content: '标题' } },
    ]);
  });

  it('returns every field with --fields all', async () => {
    const { cli } = await treeProject(makeDir);

    const [item] = dataOf<Page>(await cli.ok(['query', '#topbar', '--fields', 'all'])).items;

    expect(item).toMatchObject({
      id: 'topbar',
      parent: 'root',
      children: ['btn_shop', 'btn_mail'],
    });
  });

  it('pages through the matches and points at the next page', async () => {
    const { cli } = await treeProject(makeDir);

    const first = await cli.ok(['query', '*', '--limit', '3']);
    const last = await cli.ok(['query', '*', '--limit', '3', '--offset', '6']);

    expect(ids(dataOf<Page>(first))).toEqual(['root', 'topbar', 'btn_shop']);
    expect(first.summary).toBe('匹配 7 个节点，显示第 1–3 个');
    expect(first.next).toEqual(['ui-pro query "*" --offset 3']);
    expect(ids(dataOf<Page>(last))).toEqual(['title']);
    expect(last.next).toBeUndefined();
  });

  it('says so when the offset is past the end', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['query', '*', '--offset', '50']);

    expect(dataOf<Page>(envelope).items).toEqual([]);
    expect(envelope.summary).toContain('offset 50 已超出范围');
  });

  it('nests descendants with --tree', async () => {
    const { cli } = await treeProject(makeDir);

    const [topbar] = dataOf<Page>(await cli.ok(['query', '#topbar', '--tree'])).items;

    expect(topbar).toMatchObject({
      id: 'topbar',
      children: [
        { id: 'btn_shop', type: 'button', rect: [800, 20, 200, 80] },
        { id: 'btn_mail', type: 'button', rect: [600, 20, 150, 80] },
      ],
    });
    const children = topbar?.children as Array<Record<string, unknown>> | undefined;
    expect(children?.[0]).not.toHaveProperty('children');
  });

  it('reports a selector syntax error with its column', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['query', 'button[']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_SELECTOR_SYNTAX');
    expect(error.details).toMatchObject({ column: expect.any(Number) });
  });

  it('needs --screen once the project has several screens', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writePng(join(dir, 'second.png'), 100, 100);
    await cli.ok(['init', '--screen', 'second', '--source', 'second.png']);

    const ambiguous = await cli.fail(['query', '#root']);
    const picked = await cli.ok(['query', '#root', '--screen', 'second']);
    const everywhere = await cli.ok(['query', '*/#root']);

    expect(ambiguous.error.code).toBe('E_SCREEN_NOT_FOUND');
    expect(ambiguous.error.hint).toContain('main');
    expect(dataOf<Page>(picked).items).toMatchObject([{ screen: 'second', id: 'root' }]);
    expect(dataOf<Page>(everywhere).items).toMatchObject([
      { screen: 'main', id: 'root' },
      { screen: 'second', id: 'root' },
    ]);
  });
});
