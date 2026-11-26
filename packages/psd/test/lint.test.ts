import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UiProError } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { lintPsd, PsdErrorCodes, setRendererFactory } from '../src';
import { brokenPsd, compliantPsd, DESIGN } from './fixtures';
import { psdProject, useEmbeddedRenderer, useTempDirs } from './harness';

const makeDir = useTempDirs();

describe('lintPsd', () => {
  it('grades a compliant file A and writes a checklist that says nothing is left to do', async () => {
    useEmbeddedRenderer();
    const root = await makeDir();
    const result = await lintPsd(compliantPsd(), { scratchRoot: root, label: 'ui.psd' });
    expect(result).toMatchObject({
      grade: 'A',
      canvas: DESIGN,
      layers: 13,
      issues: [],
      restore: { renderer: 'embedded', failed: 0 },
    });
    expect(result.restore.checked).toBeGreaterThan(0);
    expect(result.checklistPath).toBe(join(root, '.ui-pro', 'psd-lint', 'ui.md'));
    const markdown = await readFile(result.checklistPath, 'utf8');
    expect(markdown).toContain('输入等级：A');
    expect(markdown).toContain('没有发现需要修改的地方');
    expect(markdown).toContain('粒度');
  });

  it('lists every problem of a broken file with a fix, most severe first', async () => {
    useEmbeddedRenderer();
    const root = await makeDir();
    const result = await lintPsd(brokenPsd(), { scratchRoot: root, label: 'broken.psd' });
    expect(result.grade).toBe('C');
    expect(result.issues.every((issue) => issue.fix.length > 0 && issue.message.length > 0)).toBe(
      true,
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['no-composite', 'group-prefix']),
    );
    const markdown = await readFile(result.checklistPath, 'utf8');
    expect(markdown).toContain('## 必须修改');
    expect(markdown).toContain('`Group 1`');
    expect(markdown).toContain('改法：');
    expect(result.restore.skipped).toContain('合成图');
  });

  it('checks the canvas and the prefixes against the project when it has one', async () => {
    useEmbeddedRenderer();
    const { project, dir } = await psdProject(makeDir, compliantPsd());
    const without = await lintPsd(brokenPsd(), { scratchRoot: dir, label: 'a.psd' });
    const within = await lintPsd(brokenPsd(), { project, scratchRoot: dir, label: 'b.psd' });
    expect(without.issues.map((issue) => issue.code)).not.toContain('canvas-size');
    expect(without.unchecked.join('\n')).toContain('画布尺寸');
    expect(within.issues.map((issue) => issue.code)).toContain('canvas-size');
  });

  it('leaves the grade open when asked not to render', async () => {
    const root = await makeDir();
    const result = await lintPsd(compliantPsd(), {
      scratchRoot: root,
      label: 'ui.psd',
      render: false,
    });
    expect(result.grade).toBeNull();
    expect(result.restore).toMatchObject({
      checked: 0,
      skipped: expect.stringContaining('没有渲染'),
    });
    expect(await readFile(result.checklistPath, 'utf8')).toContain('待定');
  });

  it('still reports the structure problems when the renderer cannot run', async () => {
    setRendererFactory(() => ({
      name: 'broken',
      capabilities: { network: false },
      render: () => {
        throw new UiProError(PsdErrorCodes.noBrowser, '无法启动 Microsoft Edge：测试');
      },
      close: async () => {},
    }));
    const root = await makeDir();
    const ok = await lintPsd(compliantPsd(), { scratchRoot: root, label: 'ok.psd' });
    expect(ok.grade).toBeNull();
    expect(ok.restore.skipped).toContain('无法启动 Microsoft Edge');

    const broken = await lintPsd(brokenPsd(), { scratchRoot: root, label: 'broken.psd' });
    expect(broken.grade).toBe('C');
  });

  it('does not use the online renderer in a project that keeps data local', async () => {
    const { project, dir } = await psdProject(makeDir, compliantPsd(), { egress: 'local' });
    const result = await lintPsd(compliantPsd(), { project, scratchRoot: dir, label: 'ui.psd' });
    expect(result.grade).toBeNull();
    expect(result.restore.skipped).toContain('local');
  });

  it('fails only when the file cannot be read at all', async () => {
    const root = await makeDir();
    await expect(
      lintPsd(new TextEncoder().encode('not a psd'), { scratchRoot: root, label: 'x.psd' }),
    ).rejects.toMatchObject({ code: PsdErrorCodes.unreadable, hint: expect.any(String) });
  });
});
