import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from '../errors';
import type { ModelName, ModelStore } from '../pixel/types';
import { MODEL_CATALOG, MODEL_ENDPOINTS, type ModelSpec } from './catalog';

export interface ModelStoreOptions {
  /** Cache directory; defaults to `%LOCALAPPDATA%\ui-pro\models` (or `~/.cache/ui-pro/models`). */
  dir?: string;
  onProgress?: (message: string) => void;
  /** Where `UI_PRO_MODEL_DIR` and `HF_ENDPOINT` are read from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the built-in catalog; tests use small files with their own hashes. */
  catalog?: Readonly<Record<ModelName, ModelSpec>>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
  /** An attempt that receives no data for this long is abandoned (default 30 s). */
  stallMs?: number;
}

const STALL_MS = 30_000;
const PROGRESS_PERCENT_STEP = 10;
const PROGRESS_INTERVAL_MS = 2000;
/** Leftover `.part` files of killed downloads older than this are removed. */
const STALE_PART_MS = 24 * 60 * 60 * 1000;

/** The model cache directory: `UI_PRO_MODEL_DIR`, else the per-user cache of the platform. */
export function defaultModelDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UI_PRO_MODEL_DIR) return resolve(env.UI_PRO_MODEL_DIR);
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ui-pro', 'models');
  }
  return join(homedir(), '.cache', 'ui-pro', 'models');
}

/** Download addresses in the order they are tried: `HF_ENDPOINT` first, then the built-in list. */
export function modelEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = [env.HF_ENDPOINT, ...MODEL_ENDPOINTS]
    .filter((endpoint): endpoint is string => Boolean(endpoint))
    .map((endpoint) => endpoint.replace(/\/+$/, ''));
  return [...new Set(list)];
}

export function modelUrl(endpoint: string, spec: ModelSpec): string {
  return `${endpoint.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${spec.path}`;
}

interface VerifiedRecord {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readVerifiedRecord(file: string): Promise<VerifiedRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${file}.verified.json`, 'utf8')) as VerifiedRecord;
    return typeof parsed.sha256 === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `file` is the model `spec` describes. Hashing 200 MB takes a while, so the result is
 * remembered next to the file (size, modification time, hash) and not recomputed while those match.
 */
async function isVerified(file: string, spec: ModelSpec): Promise<boolean> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size !== spec.bytes) return false;
  const record = await readVerifiedRecord(file);
  if (
    record &&
    record.bytes === info.size &&
    record.mtimeMs === info.mtimeMs &&
    record.sha256 === spec.sha256
  ) {
    return true;
  }
  if ((await hashFile(file)) !== spec.sha256) return false;
  await writeVerifiedRecord(file, info.size, info.mtimeMs, spec.sha256);
  return true;
}

async function writeVerifiedRecord(file: string, bytes: number, mtimeMs: number, sha256: string) {
  const record: VerifiedRecord = { bytes, mtimeMs, sha256 };
  await writeFile(`${file}.verified.json`, `${JSON.stringify(record)}\n`, 'utf8').catch(() => {
    // The record only saves time; the model works without it.
  });
}

async function removeStaleParts(dir: string, spec: ModelSpec): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${spec.file}.`) && name.endsWith('.part'))
      .map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => undefined);
        if (info && now - info.mtimeMs > STALE_PART_MS) await rm(join(dir, name), { force: true });
      }),
  );
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Local model files shared by every project on the machine. */
export function createModelStore(options: ModelStoreOptions = {}): ModelStore {
  const env = options.env ?? process.env;
  const dir = options.dir ? resolve(options.dir) : defaultModelDir(env);
  const catalog = options.catalog ?? MODEL_CATALOG;
  const fetchImpl = options.fetch ?? fetch;
  const stallMs = options.stallMs ?? STALL_MS;
  const say = options.onProgress ?? (() => {});
  const downloading = new Map<ModelName, Promise<string>>();

  async function fetchTo(url: string, part: string, spec: ModelSpec): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error(`超过 ${Math.round(stallMs / 1000)} 秒没有收到数据`)),
        stallMs,
      );
    };
    arm();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`服务器返回 ${response.status}`);
      const hash = createHash('sha256');
      let received = 0;
      let lastPercent = 0;
      let lastAt = Date.now();
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          received += chunk.length;
          arm();
          const percent = Math.floor((received / spec.bytes) * 100);
          const now = Date.now();
          if (
            percent - lastPercent >= PROGRESS_PERCENT_STEP ||
            (now - lastAt >= PROGRESS_INTERVAL_MS && percent > lastPercent)
          ) {
            lastPercent = percent;
            lastAt = now;
            say(
              `正在下载本地模型 ${spec.name}：${Math.min(percent, 100)}%（${megabytes(received)} / ${megabytes(spec.bytes)} MB）`,
            );
          }
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(part),
        { signal: controller.signal },
      );
      if (received !== spec.bytes) {
        throw new Error(`文件大小不符：收到 ${received} 字节，应为 ${spec.bytes} 字节`);
      }
      if (hash.digest('hex') !== spec.sha256)
        throw new Error('sha256 校验不符，文件已损坏或被替换');
    } catch (error) {
      // An abort surfaces as "The operation was aborted"; the reason we gave says what happened.
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function download(spec: ModelSpec, file: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const failures: { endpoint: string; reason: string }[] = [];
    const endpoints = modelEndpoints(env);
    const started = Date.now();
    say(`本地模型 ${spec.name}（${spec.purpose}）首次使用，开始下载约 ${megabytes(spec.bytes)} MB`);
    for (const endpoint of endpoints) {
      // A unique name per attempt lets two processes download the same model without
      // corrupting each other; the rename at the end is atomic.
      const part = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.part`;
      try {
        await fetchTo(modelUrl(endpoint, spec), part, spec);
        try {
          await rename(part, file);
        } catch (error) {
          // Another process may have finished first and still hold the file open.
          if (!(await isVerified(file, spec))) throw error;
          await rm(part, { force: true });
        }
        const info = await stat(file);
        await writeVerifiedRecord(file, info.size, info.mtimeMs, spec.sha256);
        say(
          `本地模型 ${spec.name} 已下载并通过校验，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`,
        );
        return;
      } catch (error) {
        await rm(part, { force: true });
        failures.push({ endpoint, reason: reasonOf(error) });
        say(`从 ${endpoint} 下载 ${spec.name} 失败：${reasonOf(error)}`);
      }
    }
    throw new UiProError(
      PerceptionErrorCodes.modelUnavailable,
      `本地模型 ${spec.name} 下载失败：${failures.map((f) => `${f.endpoint}（${f.reason}）`).join('；')}`,
      {
        hint: `设置环境变量 HF_ENDPOINT 指向能连通的 HuggingFace 镜像（例如 https://hf-mirror.com），或手动下载 ${modelUrl(endpoints[0] ?? MODEL_ENDPOINTS[0], spec)} 后放进 ${dir}，文件名保持 ${spec.file}`,
        details: { model: spec.name, dir, failures },
      },
    );
  }

  async function ensure(name: ModelName): Promise<string> {
    const spec = catalog[name];
    const file = join(dir, spec.file);
    if (await isVerified(file, spec)) return file;
    if (
      await stat(file)
        .then((info) => info.isFile())
        .catch(() => false)
    ) {
      say(`本地模型 ${spec.name} 的文件校验不通过，重新下载`);
    }
    await removeStaleParts(dir, spec);
    await download(spec, file);
    return file;
  }

  return {
    path(name) {
      const running = downloading.get(name);
      if (running) return running;
      const task = ensure(name).finally(() => downloading.delete(name));
      downloading.set(name, task);
      return task;
    },
    has(name) {
      const spec = catalog[name];
      return isVerified(join(dir, spec.file), spec);
    },
  };
}
