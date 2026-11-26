import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AssetFile,
  assetRelPath,
  GENERATED_DIR,
  type GeneratedEntry,
  type LockDoc,
  PROJECT_FILES,
  type Project,
  readFileIfExistsSync,
  resolveInside,
  sha256Hex,
  UiProError,
} from '@ui-pro/core';
import type {
  EgressLog,
  EgressRecord,
  GenerationStore,
  LockedOutput,
  ModelName,
} from '@ui-pro/perception';
import { MODEL_CATALOG } from '@ui-pro/perception';
import { BuildErrorCodes } from './errors';

export interface StoreStats {
  /** Locked outputs used instead of calling a model. */
  reused: number;
  /** New outputs of local models. */
  local: number;
  /** New outputs of the cloud image model. */
  cloud: number;
}

export interface LockedStoreOptions {
  /** True under `build --locked`: asking for a key the lock does not have is then an error. */
  allowNew: boolean;
  /** Consulted on every `get`: true while a request belongs to a node being regenerated. */
  bypass?: () => boolean;
  /** ISO 8601 time stamped on new outputs. */
  now?: () => string;
}

const LOCAL_PREFIX = 'local:';

/**
 * The generation store of a build, over `ui-pro.lock` and the screen's `assets/gen/`
 * (CONTEXT 锁定). Reads come from the lock as it was; new outputs are held back until the whole
 * build commits, and are written as files next to older ones, never over them.
 */
export class LockedStore implements GenerationStore {
  readonly allowNew: boolean;
  readonly stats: StoreStats = { reused: 0, local: 0, cloud: 0 };
  readonly #project: Project;
  readonly #screen: string;
  readonly #entries: Record<string, GeneratedEntry>;
  /** Project-relative path -> content of outputs written by this build. */
  readonly #pending = new Map<string, Uint8Array>();
  readonly #bypass: () => boolean;
  readonly #now: () => string;
  #added = false;

  constructor(project: Project, screen: string, lock: LockDoc, options: LockedStoreOptions) {
    this.#project = project;
    this.#screen = screen;
    this.#entries = { ...lock.generated };
    this.allowNew = options.allowNew;
    this.#bypass = options.bypass ?? (() => false);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #read(file: string): Uint8Array | undefined {
    const pending = this.#pending.get(file);
    if (pending !== undefined) return pending;
    return readFileIfExistsSync(resolveInside(this.#project.root, file)) ?? undefined;
  }

  async get(key: string): Promise<LockedOutput | undefined> {
    if (this.#bypass()) return undefined;
    const entry = this.#entries[key];
    if (entry === undefined) return undefined;
    const png = this.#read(entry.file);
    if (png === undefined) return undefined;
    if (sha256Hex(png) !== entry.sha256) {
      throw new UiProError(
        BuildErrorCodes.lockMismatch,
        `锁定的模型输出 ${entry.file} 与锁文件记录的哈希不一致`,
        {
          hint: '文件被改动过。要换成新的结果，运行 ui-pro build --regenerate <选择器>；要恢复，运行 ui-pro history undo',
        },
      );
    }
    this.stats.reused++;
    return { key, by: entry.by, png: new Uint8Array(png) };
  }

  /** A path under `gen/` for `bytes` that is free, or already holds exactly these bytes. */
  #place(stem: string, bytes: Uint8Array): string {
    const hash = sha256Hex(bytes);
    for (let attempt = 1; ; attempt++) {
      const name = attempt === 1 ? `${stem}.png` : `${stem}-r${attempt}.png`;
      const file = assetRelPath(this.#screen, `${GENERATED_DIR}/${name}`);
      const existing = this.#read(file);
      if (existing === undefined) {
        this.#pending.set(file, bytes);
        return file;
      }
      if (sha256Hex(existing) === hash) return file;
    }
  }

  async put(output: LockedOutput, alternatives: readonly Uint8Array[] = []): Promise<void> {
    const file = this.#place(output.key, output.png);
    const stem = file.slice(file.lastIndexOf('/') + 1, -'.png'.length);
    this.#entries[output.key] = {
      file,
      sha256: sha256Hex(output.png),
      by: output.by,
      at: this.#now(),
      alternatives: alternatives.map((png, index) => ({
        file: this.#place(`${stem}-alt${index + 1}`, png),
        sha256: sha256Hex(png),
      })),
    };
    this.#added = true;
    if (output.by.startsWith(LOCAL_PREFIX)) this.stats.local++;
    else this.stats.cloud++;
  }

  /** New outputs as asset files, paths relative to the screen's `assets/` directory. */
  generatedFiles(): AssetFile[] {
    const prefix = assetRelPath(this.#screen, '');
    return [...this.#pending].map(([file, content]) => ({
      path: file.slice(prefix.length),
      content,
    }));
  }

  /** The lock with this build's outputs added; the same document when nothing was added. */
  lock(base: LockDoc, tool: string): LockDoc {
    if (!this.#added) return base;
    const models = { ...base.models };
    for (const entry of Object.values(this.#entries)) {
      if (!entry.by.startsWith(LOCAL_PREFIX)) continue;
      const spec = MODEL_CATALOG[entry.by.slice(LOCAL_PREFIX.length) as ModelName];
      if (spec === undefined) continue;
      models[spec.name] = {
        sha256: spec.sha256,
        source: `https://huggingface.co/${spec.repo}/resolve/main/${spec.path}`,
      };
    }
    return { ...base, tool, models, generated: { ...this.#entries } };
  }
}

/** The project's record of what was sent to cloud services: `history/egress.jsonl`, append-only. */
export class FileEgressLog implements EgressLog {
  readonly #project: Project;

  constructor(project: Project) {
    this.#project = project;
  }

  #path(): string {
    return resolveInside(this.#project.root, PROJECT_FILES.egress);
  }

  async append(record: EgressRecord): Promise<void> {
    const path = this.#path();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async count(screen: string): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.#path(), 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return 0;
      }
      throw error;
    }
    let count = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record: unknown = JSON.parse(line);
        if (typeof record === 'object' && record !== null && 'screen' in record) {
          if (record.screen === screen) count++;
        }
      } catch {
        // A damaged line is not a call anyone can prove was made; skip it rather than stop the build.
      }
    }
    return count;
  }
}
