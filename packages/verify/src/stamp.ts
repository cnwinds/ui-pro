import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isUiProError,
  PROJECT_FILES,
  type Project,
  readAssetFile,
  readAssetManifest,
  readFileIfExistsSync,
  resolveInside,
  scratchPath,
  screenRelPath,
  sha256Hex,
  UiProError,
} from '@ui-pro/core';
import { defaultPack } from '@ui-pro/rules';
import { VerifyErrorCodes } from './errors';
import { GATE_IDS, GATE_NAMES, type GateId, type VerifyStamp } from './types';

const hashOf = (bytes: Uint8Array | null): string => (bytes === null ? 'absent' : sha256Hex(bytes));

const readProjectFile = (project: Project, relPath: string): Uint8Array | null =>
  readFileIfExistsSync(join(project.root, ...relPath.split('/')));

/**
 * Hash of everything a verify result depends on.
 *
 * Included: the screen document; the asset manifest and the bytes of every asset file it names
 * (read from disk, so an edited file changes the hash even when the manifest does not); the
 * screen's `mock.json`; the three rule layers (the shipped default pack, the project rules, the
 * screen rules); the glossary; the project config `ui-pro.yaml` and the bytes of every font file
 * it names.
 *
 * Not included: the tool's version and the gates' thresholds (a new version re-verifies only when
 * something it reads has changed; run `ui-pro verify` after upgrading), the source image beyond
 * the hash the screen document records of it, the reference image derived from it, the
 * `behavior.yaml` (the gates do not read it), and the lock (the manifest already carries the
 * hashes of every locked output it used).
 */
export function verifyInputsSha256(project: Project, screen: string): string {
  const parts: [string, string][] = [
    ['screen', hashOf(readProjectFile(project, screenRelPath(screen, 'doc')))],
    ['manifest', hashOf(readProjectFile(project, screenRelPath(screen, 'assets')))],
    ['mock', hashOf(readProjectFile(project, screenRelPath(screen, 'mock')))],
    ['rules/default', sha256Hex(JSON.stringify(defaultPack()))],
    ['rules/project', hashOf(readProjectFile(project, PROJECT_FILES.projectRules))],
    ['rules/screen', hashOf(readProjectFile(project, screenRelPath(screen, 'rules')))],
    ['glossary', hashOf(readProjectFile(project, PROJECT_FILES.glossary))],
    ['config', hashOf(readProjectFile(project, PROJECT_FILES.config))],
  ];
  try {
    for (const record of readAssetManifest(project, screen)?.assets ?? []) {
      parts.push([`asset/${record.file}`, hashOf(readAssetFile(project, screen, record.file))]);
    }
  } catch (error) {
    // A manifest that does not parse is itself a change; its bytes are already in the hash.
    if (!isUiProError(error)) throw error;
  }
  for (const [name, file] of Object.entries(project.config.fonts).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = readFileIfExistsSync(resolveInside(project.root, file));
    } catch {
      bytes = null;
    }
    parts.push([`font/${name}`, hashOf(bytes)]);
  }
  return sha256Hex(JSON.stringify(parts));
}

/** `.ui-pro/verify/<screen>.json`. */
export function stampPath(project: Project, screen: string): string {
  return scratchPath(project.root, 'verify', `${screen}.json`);
}

/** Records the outcome of a run of all the non-engine gates. */
export function writeVerifyStamp(project: Project, screen: string, stamp: VerifyStamp): void {
  const path = stampPath(project, screen);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

const isGateId = (value: unknown): value is GateId =>
  typeof value === 'string' && (GATE_IDS as readonly string[]).includes(value);

/** The last verify result of the screen, or `null` when it was never verified or the record is unusable. */
export function readVerifyStamp(project: Project, screen: string): VerifyStamp | null {
  const bytes = readFileIfExistsSync(stampPath(project, screen));
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { inputsSha256, ok, at, failed } = value as Record<string, unknown>;
  if (
    typeof inputsSha256 !== 'string' ||
    typeof ok !== 'boolean' ||
    typeof at !== 'string' ||
    !Array.isArray(failed) ||
    !failed.every(isGateId)
  ) {
    return null;
  }
  return { inputsSha256, ok, at, failed };
}

const VERIFY_HINT = '运行 ui-pro verify，全部通过之后再导出';

/**
 * Throws `E_NOT_VERIFIED` unless the last verify passed and nothing it depends on changed since.
 * The three refusals say which of the situations it is.
 */
export function assertVerified(project: Project, screen: string): void {
  const stamp = readVerifyStamp(project, screen);
  if (stamp === null) {
    throw new UiProError(VerifyErrorCodes.notVerified, `界面 ${screen} 还没有跑过质量门禁`, {
      hint: VERIFY_HINT,
    });
  }
  if (!stamp.ok) {
    const failed = stamp.failed.map((id) => GATE_NAMES[id]).join('、');
    throw new UiProError(
      VerifyErrorCodes.notVerified,
      `界面 ${screen} 上次质量门禁没有通过：${failed || '有门禁未通过'}`,
      { hint: VERIFY_HINT, details: { failed: stamp.failed } },
    );
  }
  if (stamp.inputsSha256 !== verifyInputsSha256(project, screen)) {
    throw new UiProError(
      VerifyErrorCodes.notVerified,
      `界面 ${screen} 通过质量门禁之后又改过（规格、资产、规则、概念库或项目配置有变化）`,
      { hint: VERIFY_HINT },
    );
  }
}
