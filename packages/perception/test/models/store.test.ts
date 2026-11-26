import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiProError } from '@ui-pro/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelSpec } from '../../src/models/catalog';
import {
  createModelStore,
  defaultModelDir,
  modelEndpoints,
  modelUrl,
} from '../../src/models/store';
import type { ModelName } from '../../src/pixel/types';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

interface Origin {
  url: string;
  hits: string[];
  close(): Promise<void>;
}

const servers: Origin[] = [];

async function serve(routes: Record<string, Route>): Promise<Origin> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '';
    hits.push(path);
    const route = routes[path];
    if (!route) {
      response.writeHead(404).end('not found');
      return;
    }
    Promise.resolve(route(request, response)).catch(() => response.destroy());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin: Origin = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
  servers.push(origin);
  return origin;
}

/** Sends `bytes` in slices, so a download takes several reads. */
const send =
  (bytes: Uint8Array, options: { slice?: number; pause?: number } = {}): Route =>
  async (_request, response) => {
    response.writeHead(200, { 'Content-Length': bytes.byteLength });
    const slice = options.slice ?? 64 * 1024;
    for (let at = 0; at < bytes.byteLength; at += slice) {
      response.write(bytes.subarray(at, at + slice));
      if (options.pause) await sleep(options.pause);
    }
    response.end();
  };

/** A catalog of small files whose hashes are known, so downloads can be checked for real. */
function catalogOf(contents: Partial<Record<ModelName, Uint8Array>>) {
  const names: ModelName[] = ['lama', 'realesr-animevideov3', 'anime-seg'];
  const catalog = {} as Record<ModelName, ModelSpec>;
  for (const name of names) {
    const bytes = contents[name] ?? randomBytes(1000);
    catalog[name] = {
      name,
      purpose: '测试用',
      file: `${name}.onnx`,
      repo: `org/${name}`,
      path: `${name}.onnx`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      license: 'MIT',
      io: 'none',
    };
  }
  return catalog;
}

const routeOf = (spec: ModelSpec) => `/${spec.repo}/resolve/main/${spec.path}`;

/** Requests to the real endpoints are answered by the local servers (or fail, offline). */
function routedFetch(mapping: Record<string, string>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const [from, to] of Object.entries(mapping)) {
      if (url.startsWith(from)) return fetch(`${to}${url.slice(from.length)}`, init);
    }
    return Promise.reject(new TypeError(`没有网络：${url}`));
  }) as typeof fetch;
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ui-pro-models-'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((origin) => origin.close()));
  await rm(dir, { recursive: true, force: true });
});

describe('createModelStore: download', () => {
  it('downloads with progress, verifies, and remembers that it did', async () => {
    const body = randomBytes(1_600_000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({
      [routeOf(catalog.lama)]: send(body, { slice: 100_000, pause: 4 }),
    });
    const messages: string[] = [];
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: origin.url },
      onProgress: (message) => messages.push(message),
    });

    expect(await store.has('lama')).toBe(false);
    const file = await store.path('lama');

    expect(file).toBe(join(dir, 'lama.onnx'));
    expect(sha256(await readFile(file))).toBe(sha256(body));
    expect(await store.has('lama')).toBe(true);
    expect(await readdir(dir)).toEqual(['lama.onnx', 'lama.onnx.verified.json']);

    const percents = messages
      .map((message) => /^正在下载本地模型 lama：(\d+)%（/.exec(message)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    expect(percents.length).toBeGreaterThanOrEqual(5);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(Math.max(...percents)).toBeLessThanOrEqual(100);
    expect(messages[0]).toMatch(/本地模型 lama.*首次使用.*1\.6 MB/);
    expect(messages.at(-1)).toMatch(/已下载并通过校验，用时/);
    for (const message of messages) expect(message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('does not download a model it already has, even from a new process', async () => {
    const body = randomBytes(3000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({ [routeOf(catalog.lama)]: send(body) });
    const env = { HF_ENDPOINT: origin.url };
    await createModelStore({ dir, catalog, env }).path('lama');
    expect(origin.hits).toHaveLength(1);

    const again = createModelStore({ dir, catalog, env });
    expect(await again.has('lama')).toBe(true);
    expect(await again.path('lama')).toBe(join(dir, 'lama.onnx'));
    expect(origin.hits).toHaveLength(1);
  });

  it('downloads each model of the catalog on its own', async () => {
    const bodies: Record<ModelName, Uint8Array> = {
      lama: randomBytes(2000),
      'realesr-animevideov3': randomBytes(1500),
      'anime-seg': randomBytes(2500),
    };
    const catalog = catalogOf(bodies);
    const routes: Record<string, Route> = {};
    for (const spec of Object.values(catalog)) routes[routeOf(spec)] = send(bodies[spec.name]);
    const origin = await serve(routes);
    const store = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    for (const name of ['lama', 'realesr-animevideov3', 'anime-seg'] as const) {
      expect(sha256(await readFile(await store.path(name)))).toBe(sha256(bodies[name]));
    }
    expect(origin.hits).toHaveLength(3);
  });

  it('throws E_MODEL_UNAVAILABLE for a file with the wrong hash and leaves no file behind', async () => {
    const catalog = catalogOf({});
    const origin = await serve({ [routeOf(catalog.lama)]: send(randomBytes(catalog.lama.bytes)) });
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: origin.url },
      fetch: routedFetch({ [origin.url]: origin.url }),
    });

    const error = (await store.path('lama').catch((e: unknown) => e)) as UiProError;
    expect(error).toBeInstanceOf(UiProError);
    expect(error.code).toBe('E_MODEL_UNAVAILABLE');
    expect(error.message).toMatch(/lama/);
    expect(error.message).toMatch(/sha256 校验不符/);
    expect(error.hint).toMatch(/HF_ENDPOINT/);
    expect(error.hint).toContain(dir);
    expect(await readdir(dir)).toEqual([]);
    expect(await store.has('lama')).toBe(false);
  });

  it('throws for a file of the wrong size and leaves no file behind', async () => {
    const catalog = catalogOf({});
    const origin = await serve({
      [routeOf(catalog.lama)]: send(randomBytes(catalog.lama.bytes - 100)),
    });
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: origin.url },
      fetch: routedFetch({ [origin.url]: origin.url }),
    });
    const error = (await store.path('lama').catch((e: unknown) => e)) as UiProError;
    expect(error.code).toBe('E_MODEL_UNAVAILABLE');
    expect(error.message).toMatch(/文件大小不符/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('tries the next endpoint when the first fails', async () => {
    const body = randomBytes(5000);
    const catalog = catalogOf({ lama: body });
    const broken = await serve({
      [routeOf(catalog.lama)]: (_request, response) => {
        response.writeHead(503).end('busy');
      },
    });
    const working = await serve({ [routeOf(catalog.lama)]: send(body) });
    const messages: string[] = [];
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: broken.url },
      // Second in line is huggingface.co; here it is the working server.
      fetch: routedFetch({ [broken.url]: broken.url, 'https://huggingface.co': working.url }),
      onProgress: (message) => messages.push(message),
    });
    const file = await store.path('lama');
    expect(sha256(await readFile(file))).toBe(sha256(body));
    expect(broken.hits).toHaveLength(1);
    expect(working.hits).toHaveLength(1);
    expect(messages.join('\n')).toMatch(/下载 lama 失败：服务器返回 503/);
    expect(await readdir(dir)).toEqual(['lama.onnx', 'lama.onnx.verified.json']);
  });

  it('lists every endpoint it tried when all fail', async () => {
    const catalog = catalogOf({});
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: 'http://127.0.0.1:9' },
      fetch: routedFetch({}),
    });
    const error = (await store.path('lama').catch((e: unknown) => e)) as UiProError;
    expect(error.code).toBe('E_MODEL_UNAVAILABLE');
    const failures = (error.details as { failures: { endpoint: string }[] }).failures;
    expect(failures.map((failure) => failure.endpoint)).toEqual([
      'http://127.0.0.1:9',
      'https://huggingface.co',
      'https://hf-mirror.com',
    ]);
    for (const endpoint of failures.map((failure) => failure.endpoint))
      expect(error.message).toContain(endpoint);
    expect(await readdir(dir)).toEqual([]);
  });

  it('gives up on a download that stops sending data', async () => {
    const catalog = catalogOf({});
    const origin = await serve({
      [routeOf(catalog.lama)]: (_request, response) => {
        response.writeHead(200, { 'Content-Length': catalog.lama.bytes });
        response.write(randomBytes(100));
        // ...and then nothing.
      },
    });
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: origin.url },
      fetch: routedFetch({ [origin.url]: origin.url }),
      stallMs: 1100,
    });
    const error = (await store.path('lama').catch((e: unknown) => e)) as UiProError;
    expect(error.code).toBe('E_MODEL_UNAVAILABLE');
    expect(error.message).toMatch(/超过 1 秒没有收到数据/);
    expect(await readdir(dir)).toEqual([]);
  }, 15_000);
});

describe('createModelStore: files already there', () => {
  it('downloads again when the file in the cache is not the model', async () => {
    const body = randomBytes(4000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({ [routeOf(catalog.lama)]: send(body) });
    await writeFile(join(dir, 'lama.onnx'), randomBytes(4000));
    const messages: string[] = [];
    const store = createModelStore({
      dir,
      catalog,
      env: { HF_ENDPOINT: origin.url },
      onProgress: (m) => messages.push(m),
    });

    expect(await store.has('lama')).toBe(false);
    const file = await store.path('lama');
    expect(sha256(await readFile(file))).toBe(sha256(body));
    expect(messages.join('\n')).toMatch(/校验不通过，重新下载/);
  });

  it('notices a file changed after it was verified', async () => {
    const body = randomBytes(4000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({ [routeOf(catalog.lama)]: send(body) });
    const store = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    const file = await store.path('lama');
    expect(await store.has('lama')).toBe(true);

    await writeFile(file, randomBytes(4000));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    expect(await store.has('lama')).toBe(false);
    await store.path('lama');
    expect(origin.hits).toHaveLength(2);
    expect(sha256(await readFile(file))).toBe(sha256(body));
  });

  it('accepts a model the user put there by hand', async () => {
    const body = randomBytes(4000);
    const catalog = catalogOf({ lama: body });
    await writeFile(join(dir, 'lama.onnx'), body);
    const origin = await serve({});
    const store = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    expect(await store.has('lama')).toBe(true);
    expect(await store.path('lama')).toBe(join(dir, 'lama.onnx'));
    expect(origin.hits).toHaveLength(0);
  });

  it('removes old half-downloads but leaves recent ones alone', async () => {
    const body = randomBytes(4000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({ [routeOf(catalog.lama)]: send(body) });
    const old = join(dir, 'lama.onnx.111-aaaaaaaa.part');
    const recent = join(dir, 'lama.onnx.222-bbbbbbbb.part');
    await writeFile(old, 'x');
    await writeFile(recent, 'y');
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } }).path('lama');
    const names = await readdir(dir);
    expect(names).not.toContain('lama.onnx.111-aaaaaaaa.part');
    expect(names).toContain('lama.onnx.222-bbbbbbbb.part');
  });
});

describe('createModelStore: concurrency', () => {
  it('shares one download between simultaneous requests in a process', async () => {
    const body = randomBytes(300_000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({
      [routeOf(catalog.lama)]: send(body, { slice: 30_000, pause: 5 }),
    });
    const store = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    const paths = await Promise.all([store.path('lama'), store.path('lama'), store.path('lama')]);
    expect(new Set(paths).size).toBe(1);
    expect(origin.hits).toHaveLength(1);
  });

  it('lets two processes download the same model without corrupting it', async () => {
    const body = randomBytes(400_000);
    const catalog = catalogOf({ lama: body });
    const origin = await serve({
      [routeOf(catalog.lama)]: send(body, { slice: 20_000, pause: 5 }),
    });
    const first = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    const second = createModelStore({ dir, catalog, env: { HF_ENDPOINT: origin.url } });
    const [a, b] = await Promise.all([first.path('lama'), second.path('lama')]);
    expect(a).toBe(b);
    expect(sha256(await readFile(a))).toBe(sha256(body));
    expect((await readdir(dir)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect((await stat(a)).size).toBe(body.byteLength);
  });
});

describe('model locations', () => {
  it('puts the cache in UI_PRO_MODEL_DIR when set, else in the per-user cache', () => {
    expect(defaultModelDir({ UI_PRO_MODEL_DIR: dir })).toBe(dir);
    expect(defaultModelDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toMatch(/ui-pro/);
    expect(defaultModelDir({})).toMatch(/models$/);
  });

  it('tries HF_ENDPOINT first, then the built-in endpoints, without repeats or trailing slashes', () => {
    expect(modelEndpoints({})).toEqual(['https://huggingface.co', 'https://hf-mirror.com']);
    expect(modelEndpoints({ HF_ENDPOINT: 'https://mirror.example.com/' })).toEqual([
      'https://mirror.example.com',
      'https://huggingface.co',
      'https://hf-mirror.com',
    ]);
    expect(modelEndpoints({ HF_ENDPOINT: 'https://hf-mirror.com' })).toEqual([
      'https://hf-mirror.com',
      'https://huggingface.co',
    ]);
  });

  it('builds the HuggingFace resolve address', () => {
    const spec = catalogOf({}).lama;
    expect(modelUrl('https://huggingface.co/', spec)).toBe(
      'https://huggingface.co/org/lama/resolve/main/lama.onnx',
    );
  });
});
