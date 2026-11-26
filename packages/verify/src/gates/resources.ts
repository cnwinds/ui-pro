import { existsSync } from 'node:fs';
import {
  readFileIfExistsSync,
  readLock,
  resolveInside,
  screenRelDir,
  sha256Hex,
} from '@ui-pro/core';
import sharp from 'sharp';
import type { GateContext } from '../context';
import type { GateProblem } from '../types';
import { type GateRun, gateResult } from './types';

/** Said in every result: M1 has no resource slots yet (DESIGN §9), so there is nothing else to check. */
export const NO_SLOTS_REASON = '没有资源槽需要检查（M1 还没有资源槽）';

/**
 * 资源: static checks of the files the screen depends on. Every asset file in the manifest exists,
 * is the file the manifest recorded (hash) and has the recorded size; every locked model output
 * of this screen, and each alternative, exists with its recorded hash; every font the project
 * config names exists. The manifest's own consistency with the screen is the structure gate's.
 */
export async function runResourcesGate(ctx: GateContext): Promise<GateRun> {
  const { project, screen, manifest } = ctx;
  const problems: GateProblem[] = [];
  const add = (message: string, fix: string, node?: string) =>
    problems.push({ ...(node !== undefined ? { node } : {}), message, fix });

  let files = 0;
  for (const record of manifest.assets) {
    files++;
    const node = record.uses[0]?.node;
    const bytes = ctx.assetBytes(record.name);
    if (bytes === null) {
      add(`资产 ${record.name} 的文件 ${record.file} 不存在`, '重新运行 ui-pro build', node);
      continue;
    }
    if (sha256Hex(bytes) !== record.sha256) {
      add(
        `资产 ${record.name} 的文件 ${record.file} 与清单记的哈希不一致，文件被改过或损坏`,
        '重新运行 ui-pro build，让清单和文件重新对上',
        node,
      );
    }
    try {
      const { width, height } = await sharp(Buffer.from(bytes)).metadata();
      if (width !== record.size[0] || height !== record.size[1]) {
        add(
          `资产 ${record.name} 的文件是 ${width}×${height}，清单记的是 ${record.size[0]}×${record.size[1]}`,
          '重新运行 ui-pro build',
          node,
        );
      }
    } catch {
      add(
        `资产 ${record.name} 的文件 ${record.file} 不是能解码的图片`,
        '重新运行 ui-pro build',
        node,
      );
    }
  }

  // Locked model outputs under this screen.
  const prefix = `${screenRelDir(screen)}/`;
  let locked = 0;
  const lock = readLock(project);
  for (const [key, entry] of Object.entries(lock.generated)) {
    if (!entry.file.startsWith(prefix)) continue;
    const candidates = [
      { file: entry.file, sha256: entry.sha256 },
      ...entry.alternatives.map((alternative) => ({
        file: alternative.file,
        sha256: alternative.sha256,
      })),
    ];
    for (const candidate of candidates) {
      locked++;
      let bytes: Uint8Array | null = null;
      try {
        bytes = readFileIfExistsSync(resolveInside(project.root, candidate.file));
      } catch {
        bytes = null;
      }
      if (bytes === null) {
        add(
          `锁文件里的模型输出 ${candidate.file}（请求 ${key.slice(0, 12)}）不存在`,
          '模型输出丢了：重新运行 ui-pro build 重新生成，或从历史里恢复这个文件',
        );
      } else if (sha256Hex(bytes) !== candidate.sha256) {
        add(
          `锁文件里的模型输出 ${candidate.file} 与锁定的哈希不一致`,
          '这个文件被改过：从历史里恢复，或重新运行 ui-pro build 重新生成',
        );
      }
    }
  }

  // Fonts.
  let fonts = 0;
  for (const [name, file] of Object.entries(project.config.fonts)) {
    fonts++;
    let found = false;
    try {
      found = existsSync(resolveInside(project.root, file));
    } catch {
      found = false;
    }
    if (!found) {
      add(
        `字体 ${name} 的文件 ${file} 不存在（或不在项目目录里）`,
        '在 ui-pro.yaml 的 fonts 里改成存在的字体文件',
      );
    }
  }

  return {
    result: gateResult('resources', {
      reason: NO_SLOTS_REASON,
      metrics: { assets: files, locked, fonts },
      problems,
    }),
  };
}
