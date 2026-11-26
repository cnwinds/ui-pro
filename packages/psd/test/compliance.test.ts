import type { Layer } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { PrefixTable, PsdErrorCodes, parsePsd } from '../src';
import { checkCompliance, type PsdIssue } from '../src/compliance';
import { compliantLayers, DESIGN, group, pixel, psdBytes, text } from './fixtures';

interface CheckOptions {
  width?: number;
  height?: number;
  noComposite?: boolean;
  prefixes?: PrefixTable;
  withDesign?: boolean;
}

function check(layers: Layer[], options: CheckOptions = {}) {
  const bytes = psdBytes(layers, {
    width: options.width ?? DESIGN.width,
    height: options.height ?? DESIGN.height,
    noComposite: options.noComposite,
  });
  return checkCompliance(
    parsePsd(bytes),
    options.prefixes ?? new PrefixTable(),
    options.withDesign === false ? undefined : DESIGN,
  );
}

const codes = (issues: PsdIssue[]) => issues.map((issue) => issue.code);
const find = (issues: PsdIssue[], code: string) => issues.find((issue) => issue.code === code);

const base = () => pixel('base', [10, 10, 40, 20], [40, 120, 220, 255]);

describe('delivery spec: file', () => {
  it('finds nothing in a compliant file and lists what it cannot check', () => {
    const { issues, unchecked } = check(compliantLayers());
    expect(issues).toEqual([]);
    expect(unchecked.join('\n')).toContain('粒度');
    expect(unchecked.join('\n')).toContain('字体');
  });

  it('requires the composite', () => {
    const { issues } = check(compliantLayers(), { noComposite: true });
    expect(find(issues, 'no-composite')).toMatchObject({
      severity: 'must',
      category: 'file',
      fix: expect.stringContaining('最大兼容'),
    });
  });

  it('compares the canvas with the design resolution of the project', () => {
    const { issues } = check([pixel('bg_main', [0, 0, 100, 160], [0, 0, 0, 255])], {
      width: 100,
      height: 160,
    });
    expect(find(issues, 'canvas-size')).toMatchObject({ severity: 'must', category: 'file' });
    expect(find(issues, 'canvas-size')?.message).toContain('100×160');
  });

  it('says the canvas was not checked when there is no project', () => {
    const { issues, unchecked } = check([pixel('bg_main', [0, 0, 100, 160], [0, 0, 0, 255])], {
      width: 100,
      height: 160,
      withDesign: false,
    });
    expect(codes(issues)).not.toContain('canvas-size');
    expect(unchecked.join('\n')).toContain('画布尺寸');
  });
});

describe('delivery spec: group names', () => {
  it('rejects a group without a prefix and does not blame its contents', () => {
    const { issues } = check([
      group('Group 1', [pixel('Layer 2', [0, 0, 10, 10], [1, 2, 3, 255])]),
    ]);
    expect(codes(issues)).toEqual(['group-prefix']);
    expect(issues[0]).toMatchObject({ severity: 'must', category: 'structure', layer: 'Group 1' });
    expect(issues[0]?.fix).toContain('btn_');
  });

  it('rejects a prefix without a name', () => {
    expect(codes(check([group('btn_', [base()])]).issues)).toEqual(['group-name-missing']);
  });

  it('rejects names that cannot become node names', () => {
    const { issues } = check([group('btn_Upgrade', [base()]), group('btn_升级', [base()])]);
    expect(codes(issues)).toEqual(['name-format', 'name-format']);
  });

  it('requires a text layer inside txt_ groups and txt_ layers to be text', () => {
    expect(codes(check([group('txt_gold', [base()])]).issues)).toEqual(['txt-no-text']);
    expect(check([group('txt_gold', [text('label', [0, 0, 40, 20], 'x')])]).issues).toEqual([]);
    const raster = check([pixel('txt_gold', [0, 0, 40, 20], [255, 255, 255, 255])]).issues;
    expect(codes(raster)).toEqual(['txt-raster']);
  });

  it('accepts the project prefixes from psd.prefixes', () => {
    const layers = [group('cell_one', [base()])];
    expect(codes(check(layers).issues)).toEqual(['group-prefix']);
    const prefixes = new PrefixTable({ cell_: 'container:list-item' });
    expect(check(layers, { prefixes }).issues).toEqual([]);
  });
});

describe('delivery spec: loose layers, states and ignored groups', () => {
  it('rejects visible layers that belong to no element', () => {
    const { issues } = check([pixel('Layer 1', [0, 0, 10, 10], [1, 2, 3, 255])]);
    expect(codes(issues)).toEqual(['loose-layer']);
    expect(issues[0]?.severity).toBe('must');
  });

  it('advises about hidden layers that are not states', () => {
    const { issues } = check([
      group('btn_ok', [base(), pixel('old', [0, 0, 10, 10], [1, 2, 3, 255], { hidden: true })]),
    ]);
    expect(codes(issues)).toEqual(['hidden-layer']);
    expect(issues[0]?.severity).toBe('should');
    expect(issues[0]?.fix).toContain('@pressed');
  });

  it('checks state layers: visible, malformed name, outside an element', () => {
    const state = (name: string, hidden: boolean) =>
      pixel(name, [10, 10, 40, 20], [1, 2, 3, 255], { hidden });
    expect(codes(check([group('btn_ok', [base(), state('@pressed', false)])]).issues)).toEqual([
      'state-visible',
    ]);
    expect(codes(check([group('btn_ok', [base(), state('@Pressed', true)])]).issues)).toEqual([
      'state-name',
    ]);
    expect(codes(check([state('@pressed', true)]).issues)).toEqual(['state-orphan']);
  });

  it('leaves groups named with # alone, but warns when they are visible', () => {
    const guide = (hidden: boolean) =>
      group('#guides', [pixel('Layer 9', [0, 0, 10, 10], [1, 2, 3, 255])], { hidden });
    expect(check([guide(true)]).issues).toEqual([]);
    expect(codes(check([guide(false)]).issues)).toEqual(['ignored-visible']);
  });
});

describe('delivery spec: blend modes and adjustment layers', () => {
  it('allows only a few blend modes between elements', () => {
    const element = (mode: Layer['blendMode']) => group('btn_ok', [base()], { blendMode: mode });
    expect(check([element('multiply')]).issues).toEqual([]);
    expect(check([element('linear dodge')]).issues).toEqual([]);
    const { issues } = check([element('screen')]);
    expect(codes(issues)).toEqual(['blend-element']);
    expect(issues[0]?.message).toContain('滤色');
  });

  it('allows other modes inside an element only when clipped to its base', () => {
    const overlay = (clipping: boolean) =>
      pixel('glow', [10, 10, 40, 20], [255, 255, 255, 255], { blendMode: 'overlay', clipping });
    expect(codes(check([group('btn_ok', [base(), overlay(false)])]).issues)).toEqual([
      'blend-unclipped',
    ]);
    expect(check([group('btn_ok', [base(), overlay(true)])]).issues).toEqual([]);
  });

  it('rejects adjustment layers that are not clipped', () => {
    const adjustment = (clipping: boolean): Layer => ({
      name: 'invert',
      adjustment: { type: 'invert' },
      clipping,
    });
    expect(codes(check([group('btn_ok', [base(), adjustment(false)])]).issues)).toEqual([
      'adjustment-unclipped',
    ]);
    expect(check([group('btn_ok', [base(), adjustment(true)])]).issues).toEqual([]);
  });
});

describe('delivery spec: text and numbered groups', () => {
  it('advises against one text layer with several sizes', () => {
    const mixed: Layer = {
      ...text('label', [0, 0, 60, 30], 'Hello'),
    };
    mixed.text = {
      ...mixed.text,
      text: 'Hello',
      styleRuns: [
        { length: 2, style: { fontSize: 20 } },
        { length: 3, style: { fontSize: 30 } },
      ],
    };
    const { issues } = check([group('txt_title', [mixed])]);
    expect(codes(issues)).toEqual(['text-mixed']);
    expect(issues[0]?.severity).toBe('should');
  });

  it('wants numbered groups to share one structure and blames the odd one out', () => {
    const slot = (n: number, extra: Layer[] = []) =>
      group(`slot_equip_${n}`, [pixel('icon', [n * 20, 0, 10, 10], [9, 9, 9, 255]), ...extra]);
    const { issues } = check([
      slot(1),
      slot(2),
      slot(3, [pixel('extra', [60, 20, 10, 10], [9, 9, 9, 255])]),
    ]);
    expect(issues.map((issue) => [issue.code, issue.layer])).toEqual([
      ['numbered-structure', 'slot_equip_3'],
    ]);
  });
});

describe('prefix table', () => {
  it('needs a name after the prefix and is case sensitive', () => {
    const table = new PrefixTable({ cell_: 'container' });
    expect(table.match('cell_ok')?.type).toBe('container');
    expect(table.match('btn_ok')?.type).toBe('button');
    expect(table.match('btn_')).toBeUndefined();
    expect(table.match('Btn_ok')).toBeUndefined();
  });

  it('lets a project replace a default prefix with a type and a role', () => {
    const entry = new PrefixTable({ btn_: 'toggle:tab' }).match('btn_x');
    expect(entry).toMatchObject({ type: 'toggle', role: 'tab' });
  });

  it('refuses malformed overrides with a pointer to the format', () => {
    const malformed: Record<string, string>[] = [
      { Cell: 'container' },
      { big_cell_: 'container' },
      { cell_: 'nonsense' },
    ];
    for (const overrides of [...malformed, { cell_: 'container:Bad' }]) {
      let caught: unknown;
      try {
        new PrefixTable(overrides);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: PsdErrorCodes.config,
        hint: expect.stringContaining('类型'),
      });
    }
  });
});
