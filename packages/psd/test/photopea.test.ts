import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhotopeaRenderer, PsdErrorCodes, parsePsd, planRenderUnits } from '../src';
import { lockProfile } from '../src/photopea';
import { renderUnits } from '../src/render-store';
import { compliantPsd } from './fixtures';
import { useTempDirs } from './harness';

const makeDir = useTempDirs();

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  const pid = child.pid ?? 0;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

describe('PhotopeaRenderer without a usable browser', () => {
  async function renderWith(renderer: PhotopeaRenderer) {
    const document = parsePsd(compliantPsd());
    try {
      return await renderUnits({ document, units: planRenderUnits(document), renderer });
    } finally {
      await renderer.close();
    }
  }

  it('says that Edge is missing, with what to do about it', async () => {
    const renderer = new PhotopeaRenderer({ executablePath: join(await makeDir(), 'no-edge.exe') });
    await expect(renderWith(renderer)).rejects.toMatchObject({
      code: PsdErrorCodes.noBrowser,
      message: expect.stringContaining('Microsoft Edge'),
      hint: expect.stringContaining('交付包'),
    });
  });

  it('gives the profile lock back when the browser cannot start', async () => {
    const profileDir = join(await makeDir(), 'profile');
    const renderer = new PhotopeaRenderer({
      executablePath: join(profileDir, 'no-edge.exe'),
      profileDir,
    });
    await expect(renderWith(renderer)).rejects.toMatchObject({ code: PsdErrorCodes.noBrowser });
    expect(await exists(`${profileDir}.lock`)).toBe(false);
  });

  it('can be closed more than once and before any use', async () => {
    const renderer = new PhotopeaRenderer();
    await renderer.close();
    await renderer.close();
  });
});

describe('browser profile lock', () => {
  it('lets one holder in at a time', async () => {
    const profileDir = join(await makeDir(), 'profile');
    const first = await lockProfile(profileDir);
    expect(first).toBeDefined();
    expect(await readFile(`${profileDir}.lock`, 'utf8')).toBe(String(process.pid));
    expect(await lockProfile(profileDir)).toBeUndefined();
    await first?.release();
    expect(await exists(`${profileDir}.lock`)).toBe(false);
    expect(await lockProfile(profileDir)).toBeDefined();
  });

  it('takes over a lock whose process is gone', async () => {
    const profileDir = join(await makeDir(), 'profile');
    await mkdir(join(profileDir, '..'), { recursive: true });
    await writeFile(`${profileDir}.lock`, String(await deadPid()));
    expect(await lockProfile(profileDir)).toBeDefined();
    expect(await readFile(`${profileDir}.lock`, 'utf8')).toBe(String(process.pid));
  });

  it('keeps out of a lock that is being written and takes over one that never got a pid', async () => {
    const profileDir = join(await makeDir(), 'profile');
    await mkdir(join(profileDir, '..'), { recursive: true });
    await writeFile(`${profileDir}.lock`, '');
    expect(await lockProfile(profileDir)).toBeUndefined();
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(`${profileDir}.lock`, longAgo, longAgo);
    expect(await lockProfile(profileDir)).toBeDefined();
    await rm(`${profileDir}.lock`, { force: true });
  });
});
