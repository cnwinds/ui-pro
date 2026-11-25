import { describe, expect, it } from 'vitest';
import {
  attachChild,
  createScreenDoc,
  ErrorCodes,
  formatRef,
  type NodeRef,
  newNode,
  parseRef,
  parseSelector,
  resolveSelector,
  type ScreenDoc,
  type Selection,
  type SelectorEnv,
  type UINode,
  UiProError,
} from '../src';

function parseError(selector: string): UiProError {
  try {
    parseSelector(selector);
  } catch (error) {
    if (error instanceof UiProError) return error;
    throw error;
  }
  throw new Error(`expected "${selector}" to be rejected`);
}

function column(selector: string): number {
  const details = parseError(selector).details as { column: number };
  return details.column;
}

const tests = (selector: string) => parseSelector(selector).items[0]?.steps[0]?.compound.tests;

describe('parseSelector', () => {
  it('parses ids, types and the universal selector', () => {
    expect(tests('#btn_shop')).toEqual([{ kind: 'id', id: 'btn_shop' }]);
    expect(tests('button')).toEqual([{ kind: 'type', type: 'button' }]);
    expect(tests('toggle-group')).toEqual([{ kind: 'type', type: 'toggle-group' }]);
    expect(tests('*')).toEqual([]);
  });

  it('parses attribute selectors with every operator', () => {
    expect(tests('[role]')).toEqual([
      { kind: 'attribute', name: 'role', operator: 'exists', value: '' },
    ]);
    expect(tests('[role=badge.notification]')).toEqual([
      { kind: 'attribute', name: 'role', operator: '=', value: 'badge.notification' },
    ]);
    expect(tests('[role^=badge]')).toEqual([
      { kind: 'attribute', name: 'role', operator: '^=', value: 'badge' },
    ]);
    expect(tests('[varies~=content]')).toEqual([
      { kind: 'attribute', name: 'varies', operator: '~=', value: 'content' },
    ]);
    expect(tests('[ role = x ]')).toEqual([
      { kind: 'attribute', name: 'role', operator: '=', value: 'x' },
    ]);
  });

  it('parses quoted attribute values, including escapes', () => {
    expect(tests('[text="a b"]')).toEqual([
      { kind: 'attribute', name: 'text', operator: '=', value: 'a b' },
    ]);
    expect(tests("[text='it\\'s']")).toEqual([
      { kind: 'attribute', name: 'text', operator: '=', value: "it's" },
    ]);
    expect(tests('[text="a]b"]')).toEqual([
      { kind: 'attribute', name: 'text', operator: '=', value: 'a]b' },
    ]);
  });

  it('parses compound selectors', () => {
    expect(tests('button#btn_mail[role^=nav]')).toEqual([
      { kind: 'type', type: 'button' },
      { kind: 'id', id: 'btn_mail' },
      { kind: 'attribute', name: 'role', operator: '^=', value: 'nav' },
    ]);
    expect(tests('*[role]#a')).toHaveLength(2);
  });

  it('parses the concept, component and selection shorthands', () => {
    expect(tests('concept:红点')).toEqual([
      { kind: 'attribute', name: 'concept', operator: '=', value: '红点' },
    ]);
    expect(tests('concept:"两个 词"')).toEqual([
      { kind: 'attribute', name: 'concept', operator: '=', value: '两个 词' },
    ]);
    expect(tests('component:ShopButton')).toEqual([
      { kind: 'attribute', name: 'instanceOf', operator: '=', value: 'ShopButton' },
    ]);
    expect(tests('@selection')).toEqual([{ kind: 'selection' }]);
  });

  it('parses like() with a nested selector list', () => {
    const [test] = tests('like(#a, button)') ?? [];

    expect(test?.kind).toBe('like');
    expect(test?.kind === 'like' && test.inner.items).toHaveLength(2);
  });

  it('parses combinators', () => {
    const [selector] = parseSelector('#top > button  image').items;

    expect(selector?.steps.map((step) => step.combinator)).toEqual([null, 'child', 'descendant']);
    expect(selector?.steps).toHaveLength(3);
    expect(parseSelector('#a>#b').items[0]?.steps.map((step) => step.combinator)).toEqual([
      null,
      'child',
    ]);
  });

  it('parses comma-separated lists', () => {
    expect(parseSelector('button, text ,#x').items).toHaveLength(3);
  });

  it('parses screen qualifiers', () => {
    expect(parseSelector('mail/#x').items[0]?.screen).toBe('mail');
    expect(parseSelector('*/button').items[0]?.screen).toBe('*');
    expect(parseSelector('main/button, shop-2/text').items.map((item) => item.screen)).toEqual([
      'main',
      'shop-2',
    ]);
    expect(parseSelector('button').items[0]?.screen).toBeUndefined();
    expect(parseSelector('mail/#a > button').items[0]?.steps).toHaveLength(2);
  });

  it('rejects malformed selectors with E_SELECTOR_SYNTAX and a 1-based column', () => {
    const cases: Array<[selector: string, expectedColumn: number]> = [
      ['', 1],
      ['   ', 4],
      ['bogus', 1],
      ['button[rol=x]', 8],
      ['button[role=', 13],
      ['button[role="abc]', 13],
      ['button[role=a', 14],
      ['button[role~]', 12],
      ['#', 2],
      ['button >', 9],
      ['button)', 7],
      ['like(button', 12],
      ['@foo', 1],
      ['foo:bar', 1],
      ['button, ', 9],
    ];

    for (const [selector, expectedColumn] of cases) {
      const error = parseError(selector);
      expect(error.code, selector).toBe(ErrorCodes.selectorSyntax);
      expect(column(selector), selector).toBe(expectedColumn);
      expect(error.message, selector).toContain(`第 ${expectedColumn} 列`);
      expect(error.hint, selector).toBeTruthy();
    }
  });

  it('rejects a type name that is not at the start of a compound', () => {
    expect(parseError('[role]button').message).toContain('只能写在复合选择器的开头');
  });
});

describe('formatRef / parseRef', () => {
  it('round-trips qualified node references', () => {
    const ref: NodeRef = { screen: 'main', id: 'btn_shop' };

    expect(formatRef(ref)).toBe('main/#btn_shop');
    expect(parseRef('main/#btn_shop')).toEqual(ref);
  });

  it('rejects text that is not a reference', () => {
    expect(() => parseRef('btn_shop')).toThrowError(UiProError);
    expect(() => parseRef('Main/#x')).toThrowError(UiProError);
  });
});

interface NodeSpec {
  id: string;
  type: UINode['type'];
  parent: string;
  extra?: Partial<UINode>;
}

function buildScreen(name: string, specs: NodeSpec[]): ScreenDoc {
  const doc = createScreenDoc({
    name,
    source: {
      kind: 'flat',
      file: 'source/ui.png',
      width: 100,
      height: 100,
      sha256: 'b'.repeat(64),
    },
    scale: 1,
    size: [100, 100],
  });
  for (const { id, type, parent, extra } of specs) {
    doc.nodes[id] = newNode({ id, type, parent: null, rect: [0, 0, 10, 10], ...extra });
    attachChild(doc, parent, id);
  }
  return doc;
}

const MAIN = buildScreen('main', [
  { id: 'topbar', type: 'container', parent: 'root' },
  {
    id: 'btn_shop',
    type: 'button',
    parent: 'topbar',
    extra: { role: 'nav.shop', concept: '商店', cluster: 'nav' },
  },
  {
    id: 'btn_mail',
    type: 'button',
    parent: 'topbar',
    extra: { role: 'nav.mail', concept: '邮件', cluster: 'nav' },
  },
  {
    id: 'badge_mail',
    type: 'image',
    parent: 'btn_mail',
    extra: { role: 'badge.notification', concept: '红点', cluster: 'dot' },
  },
  {
    id: 'title',
    type: 'text',
    parent: 'root',
    extra: { text: { content: 'foo bar' }, visible: false },
  },
  { id: 'panel', type: 'container', parent: 'root' },
  {
    id: 'btn_buy',
    type: 'button',
    parent: 'panel',
    extra: { instanceOf: 'BuyButton', varies: ['state', 'content'] },
  },
]);

const SHOP = buildScreen('shop', [
  { id: 'btn_back', type: 'button', parent: 'root', extra: { role: 'nav.back', cluster: 'nav' } },
  {
    id: 'badge_tab',
    type: 'image',
    parent: 'btn_back',
    extra: { role: 'badge.notification', cluster: 'dot' },
  },
]);

function envFor(current: string | undefined, selection: Selection | null = null): SelectorEnv {
  const docs: Record<string, ScreenDoc> = { main: MAIN, shop: SHOP };
  return {
    currentScreen: current,
    listScreens: () => Object.keys(docs).sort(),
    loadScreen(name) {
      const doc = docs[name];
      if (!doc) throw new UiProError(ErrorCodes.screenNotFound, `no screen ${name}`);
      return doc;
    },
    selection: () => selection,
  };
}

const findIn = (
  current: string | undefined,
  selector: string,
  selection: Selection | null = null,
) => resolveSelector(selector, envFor(current, selection)).map(formatRef);

/** Resolves against the `main` screen. */
const find = (selector: string, current = 'main', selection: Selection | null = null) =>
  findIn(current, selector, selection);

describe('resolveSelector', () => {
  it('matches by id, type and universal selector in tree pre-order', () => {
    expect(find('#btn_shop')).toEqual(['main/#btn_shop']);
    expect(find('button')).toEqual(['main/#btn_shop', 'main/#btn_mail', 'main/#btn_buy']);
    expect(find('*')).toEqual([
      'main/#root',
      'main/#topbar',
      'main/#btn_shop',
      'main/#btn_mail',
      'main/#badge_mail',
      'main/#title',
      'main/#panel',
      'main/#btn_buy',
    ]);
  });

  it('matches attributes with =, ^=, ~= and existence tests', () => {
    expect(find('[role=nav.shop]')).toEqual(['main/#btn_shop']);
    expect(find('[role^=nav]')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('[role]')).toEqual(['main/#btn_shop', 'main/#btn_mail', 'main/#badge_mail']);
    expect(find('[varies~=state]')).toEqual(['main/#btn_buy']);
    expect(find('[varies]')).toEqual(['main/#btn_buy']);
    expect(find('[text~=bar]')).toEqual(['main/#title']);
    expect(find('[text~=ba]')).toEqual([]);
    expect(find('[text="foo bar"]')).toEqual(['main/#title']);
    expect(find('[text]')).toEqual(['main/#title']);
  });

  it('matches the structural attributes', () => {
    expect(find('[visible=false]')).toEqual(['main/#title']);
    expect(find('[parent=topbar]')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('[instanceOf=BuyButton]')).toEqual(['main/#btn_buy']);
    expect(find('[cluster=nav]')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('[type=text]')).toEqual(['main/#title']);
    expect(find('[id^=btn_]')).toHaveLength(3);
  });

  it('combines tests within a compound selector', () => {
    expect(find('button[role^=nav]#btn_mail')).toEqual(['main/#btn_mail']);
    expect(find('image[role^=nav]')).toEqual([]);
  });

  it('applies descendant and child combinators', () => {
    expect(find('#topbar button')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('#topbar > button')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('#root > button')).toEqual([]);
    expect(find('#root button')).toHaveLength(3);
    expect(find('#topbar image')).toEqual(['main/#badge_mail']);
    expect(find('#topbar > image')).toEqual([]);
    expect(find('#root > #panel > button')).toEqual(['main/#btn_buy']);
    expect(find('container container button')).toEqual([
      'main/#btn_shop',
      'main/#btn_mail',
      'main/#btn_buy',
    ]);
  });

  it('unions list items, keeping pre-order and removing duplicates', () => {
    expect(find('#btn_buy, text, button')).toEqual([
      'main/#btn_shop',
      'main/#btn_mail',
      'main/#title',
      'main/#btn_buy',
    ]);
  });

  it('resolves the concept and component shorthands', () => {
    expect(find('concept:红点')).toEqual(['main/#badge_mail']);
    expect(find('component:BuyButton')).toEqual(['main/#btn_buy']);
    expect(find('concept:不存在')).toEqual([]);
  });

  it('resolves @selection from the environment', () => {
    const selection = { screen: 'main', ids: ['btn_mail', 'title'] };

    expect(find('@selection', 'main', selection)).toEqual(['main/#btn_mail', 'main/#title']);
    expect(find('button@selection', 'main', selection)).toEqual(['main/#btn_mail']);
    expect(find('@selection', 'main', null)).toEqual([]);
    expect(find('@selection', 'shop', selection)).toEqual([]);
  });

  it('resolves like() through clusters, across screens', () => {
    expect(find('*/like(#badge_mail)')).toEqual(['main/#badge_mail', 'shop/#badge_tab']);
    expect(find('shop/like(main/#badge_mail)')).toEqual(['shop/#badge_tab']);
    expect(find('like(button)')).toEqual(['main/#btn_shop', 'main/#btn_mail']);
    expect(find('like(#title)')).toEqual([]);
  });

  it('honours screen qualifiers', () => {
    expect(find('shop/#btn_back')).toEqual(['shop/#btn_back']);
    expect(find('shop/button', 'main')).toEqual(['shop/#btn_back']);
    expect(find('*/button')).toEqual([
      'main/#btn_shop',
      'main/#btn_mail',
      'main/#btn_buy',
      'shop/#btn_back',
    ]);
    expect(find('shop/button, main/#title')).toEqual(['main/#title', 'shop/#btn_back']);
  });

  it('needs a current screen for unqualified selectors', () => {
    expect(() => findIn(undefined, 'button')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.screenNotFound }),
    );
    expect(findIn(undefined, '*/#btn_back')).toEqual(['shop/#btn_back']);
  });

  it('fails for an unknown screen qualifier', () => {
    expect(() => find('nope/button')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.screenNotFound }),
    );
  });

  it('propagates syntax errors', () => {
    expect(() => find('button[')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.selectorSyntax }),
    );
  });

  it('accepts an already parsed selector', () => {
    const parsed = parseSelector('button');

    expect(resolveSelector(parsed, envFor('shop')).map(formatRef)).toEqual(['shop/#btn_back']);
  });
});
