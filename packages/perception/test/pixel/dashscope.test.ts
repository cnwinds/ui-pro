import { UiProError } from '@ui-pro/core';
import { describe, expect, it, vi } from 'vitest';
import { createCloudImageModel } from '../../src/pixel';
import { DASHSCOPE_CAPABILITIES } from '../../src/pixel/dashscope';
import { blank, pngOf } from './helpers';

const KEY = 'sk-test-0123456789abcdef';
const SUBMIT = '/api/v1/services/aigc/image2image/image-synthesis';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: {
    model: string;
    input: Record<string, string | undefined>;
    parameters: Record<string, number | boolean | undefined>;
  };
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name] = value;
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

/** A well-behaved service: accepts the task, reports `statuses` while polling, then the results. */
function wellBehaved(options: {
  statuses?: string[];
  results?: { url?: string; code?: string; message?: string }[];
  pictures?: Record<string, Uint8Array>;
}) {
  const statuses = [...(options.statuses ?? ['PENDING', 'RUNNING'])];
  const results = options.results ?? [{ url: 'https://oss.example.com/a.png' }];
  return fakeFetch((call) => {
    if (call.method === 'POST') {
      return json({ output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'req-1' });
    }
    if (call.url.includes('/api/v1/tasks/')) {
      const next = statuses.shift();
      return next
        ? json({ output: { task_id: 'task-1', task_status: next } })
        : json({ output: { task_id: 'task-1', task_status: 'SUCCEEDED', results } });
    }
    const picture = options.pictures?.[call.url];
    return picture
      ? new Response(picture as unknown as BodyInit)
      : new Response('missing', { status: 404 });
  });
}

function modelWith(
  fetchImpl: typeof fetch,
  extra: { endpoint?: string; retries?: number; timeoutMs?: number } = {},
) {
  const sleep = vi.fn(async (_ms: number) => {});
  const model = createCloudImageModel(
    { provider: 'dashscope', endpoint: extra.endpoint },
    { DASHSCOPE_API_KEY: KEY },
    { fetch: fetchImpl, sleep, pollMs: 1000, timeoutMs: extra.timeoutMs, retries: extra.retries },
  );
  if (!model) throw new Error('model expected');
  return { model, sleep };
}

async function picture(size = 512, color: readonly [number, number, number] = [10, 20, 30]) {
  return pngOf(blank(size, size, color));
}

async function failureOf(run: Promise<unknown>): Promise<UiProError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UiProError);
  return error as UiProError;
}

function leaks(error: UiProError): boolean {
  return JSON.stringify([error.message, error.hint, error.details, error.code]).includes(KEY);
}

describe('createCloudImageModel', () => {
  it('is null for provider none, for no key, and for a blank key', () => {
    expect(createCloudImageModel({ provider: 'none' }, { DASHSCOPE_API_KEY: KEY })).toBeNull();
    expect(createCloudImageModel({ provider: 'dashscope' }, {})).toBeNull();
    expect(
      createCloudImageModel({ provider: 'dashscope' }, { DASHSCOPE_API_KEY: '   ' }),
    ).toBeNull();
  });

  it('declares the capabilities the pipeline relies on', () => {
    const model = createCloudImageModel({ provider: 'dashscope' }, { DASHSCOPE_API_KEY: KEY });
    expect(model?.id).toBe('dashscope/wanx2.1-imageedit');
    expect(model?.capabilities).toEqual({
      maskInput: true,
      transparentOutput: false,
      layerDecomposition: false,
      minSide: 512,
      maxSide: 4096,
      maxCandidates: 4,
    });
    expect(model?.capabilities).toEqual(DASHSCOPE_CAPABILITIES);
  });
});

describe('dashscope: inpaint', () => {
  it('submits an asynchronous task, polls it, and downloads every result', async () => {
    const first = await picture(512, [1, 2, 3]);
    const second = await picture(512, [4, 5, 6]);
    const service = wellBehaved({
      results: [{ url: 'https://oss.example.com/a.png' }, { url: 'https://oss.example.com/b.png' }],
      pictures: { 'https://oss.example.com/a.png': first, 'https://oss.example.com/b.png': second },
    });
    const { model, sleep } = modelWith(service.fetch);
    const image = await picture();
    const mask = await picture(512, [255, 255, 255]);

    const pictures = await model.inpaint({ image, mask, prompt: '补全底图', candidates: 2 });

    expect(pictures).toHaveLength(2);
    expect(Array.from(pictures[0] as Uint8Array)).toEqual(Array.from(first));
    expect(Array.from(pictures[1] as Uint8Array)).toEqual(Array.from(second));

    const [submit, ...rest] = service.calls;
    expect(submit?.method).toBe('POST');
    expect(submit?.url).toBe(`https://dashscope.aliyuncs.com${SUBMIT}`);
    expect(submit?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(submit?.headers['X-DashScope-Async']).toBe('enable');
    expect(submit?.headers['Content-Type']).toBe('application/json');
    expect(submit?.body).toMatchObject({
      model: 'wanx2.1-imageedit',
      input: { function: 'description_edit_with_mask', prompt: '补全底图' },
      parameters: { n: 2, watermark: false },
    });
    expect(submit?.body?.input.base_image_url).toBe(
      `data:image/png;base64,${Buffer.from(image).toString('base64')}`,
    );
    expect(submit?.body?.input.mask_image_url).toBe(
      `data:image/png;base64,${Buffer.from(mask).toString('base64')}`,
    );

    const polls = rest.filter((call) => call.url.includes('/api/v1/tasks/'));
    expect(polls).toHaveLength(3);
    expect(
      polls.every((call) => call.method === 'GET' && call.url.endsWith('/api/v1/tasks/task-1')),
    ).toBe(true);
    expect(polls.every((call) => call.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1000);
    // The result addresses are signed: the key is not sent along.
    const downloads = rest.filter((call) => call.url.startsWith('https://oss.example.com/'));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((call) => call.headers.Authorization === undefined)).toBe(true);
  });

  it('uses the endpoint from the project config', async () => {
    const service = wellBehaved({
      statuses: [],
      pictures: { 'https://oss.example.com/a.png': await picture() },
    });
    const { model } = modelWith(service.fetch, {
      endpoint: 'https://ws-1234.cn-beijing.example.com/',
    });
    await model.inpaint({
      image: await picture(),
      mask: await picture(),
      prompt: 'x',
      candidates: 1,
    });
    expect(service.calls[0]?.url).toBe(`https://ws-1234.cn-beijing.example.com${SUBMIT}`);
    expect(service.calls[1]?.url).toBe(
      'https://ws-1234.cn-beijing.example.com/api/v1/tasks/task-1',
    );
  });

  it('keeps the number of candidates within what the service takes', async () => {
    const service = wellBehaved({
      statuses: [],
      pictures: { 'https://oss.example.com/a.png': await picture() },
    });
    const { model } = modelWith(service.fetch);
    const args = { image: await picture(), mask: await picture(), prompt: 'x' };
    await model.inpaint({ ...args, candidates: 9 });
    await model.inpaint({ ...args, candidates: 0 });
    const submitted = service.calls.filter((call) => call.method === 'POST');
    expect(submitted.map((call) => call.body?.parameters.n)).toEqual([4, 1]);
  });

  it('refuses an empty prompt and pictures outside 512–4096 before any request', async () => {
    const service = wellBehaved({});
    const { model } = modelWith(service.fetch);
    const ok = await picture();
    const small = await picture(300);
    expect(
      (await failureOf(model.inpaint({ image: ok, mask: ok, prompt: '  ', candidates: 1 }))).code,
    ).toBe('E_CLOUD_IMAGE');
    const tooSmall = await failureOf(
      model.inpaint({ image: small, mask: ok, prompt: 'x', candidates: 1 }),
    );
    expect(tooSmall.message).toMatch(/300x300/);
    expect(tooSmall.message).toMatch(/512–4096/);
    const hugeFile = await failureOf(
      model.inpaint({
        image: new Uint8Array(10 * 1024 * 1024 + 1),
        mask: ok,
        prompt: 'x',
        candidates: 1,
      }),
    );
    expect(hugeFile.message).toMatch(/10 MB/);
    expect(service.calls).toHaveLength(0);
  });

  it('cuts a long prompt to what the service accepts', async () => {
    const service = wellBehaved({
      statuses: [],
      pictures: { 'https://oss.example.com/a.png': await picture() },
    });
    const { model } = modelWith(service.fetch);
    await model.inpaint({
      image: await picture(),
      mask: await picture(),
      prompt: '字'.repeat(2000),
      candidates: 1,
    });
    expect(service.calls[0]?.body?.input.prompt).toHaveLength(800);
  });
});

describe('dashscope: errors', () => {
  const args = async () => ({
    image: await picture(),
    mask: await picture(),
    prompt: 'x',
    candidates: 1,
  });

  it('retries a throttled request with growing waits, then succeeds', async () => {
    const service = fakeFetch((call, index) => {
      if (call.method === 'POST') {
        return index < 2
          ? json({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }, 429)
          : json({ output: { task_id: 'task-1' } });
      }
      if (call.url.includes('/tasks/')) {
        return json({
          output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss.example.com/a.png' }] },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const { model, sleep } = modelWith(service.fetch);
    const result = await model.inpaint(await args());
    expect(result).toHaveLength(1);
    expect(service.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
    // The waits before the second and third try come first, before any poll.
    expect(sleep.mock.calls.slice(0, 2).map(([ms]) => ms)).toEqual([500, 1000]);
  });

  it('retries a failed connection', async () => {
    let attempts = 0;
    const service = fakeFetch((call) => {
      if (call.method === 'POST') {
        if (attempts++ === 0) throw new TypeError('fetch failed');
        return json({ output: { task_id: 'task-1' } });
      }
      if (call.url.includes('/tasks/')) {
        return json({
          output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss.example.com/a.png' }] },
        });
      }
      return new Response(new Uint8Array([9]));
    });
    const { model } = modelWith(service.fetch);
    await expect(model.inpaint(await args())).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('gives up after the retries, says why in Chinese, and never prints the key', async () => {
    const service = fakeFetch(() => json({ code: 'Throttling', message: 'slow down' }, 429));
    const { model } = modelWith(service.fetch, { retries: 2 });
    const error = await failureOf(model.inpaint(await args()));
    expect(error.code).toBe('E_CLOUD_IMAGE');
    expect(error.message).toMatch(/HTTP 429/);
    expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
    expect(error.hint).toMatch(/--draft/);
    expect(service.calls).toHaveLength(3);
    expect(leaks(error)).toBe(false);
  });

  it('does not retry a rejected key, and points at the variable', async () => {
    const service = fakeFetch(() =>
      json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 401),
    );
    const { model } = modelWith(service.fetch);
    const error = await failureOf(model.inpaint(await args()));
    expect(service.calls).toHaveLength(1);
    expect(error.message).toMatch(/401/);
    expect(error.message).toMatch(/InvalidApiKey/);
    expect(error.hint).toMatch(/DASHSCOPE_API_KEY/);
    expect(leaks(error)).toBe(false);
  });

  it('reports a failed task with the service reason', async () => {
    const service = fakeFetch((call) =>
      call.method === 'POST'
        ? json({ output: { task_id: 'task-1' } })
        : json({
            request_id: 'req-9',
            output: { task_status: 'FAILED', code: 'InvalidParameter', message: 'mask is invalid' },
          }),
    );
    const { model } = modelWith(service.fetch);
    const error = await failureOf(model.inpaint(await args()));
    expect(error.message).toMatch(/任务失败/);
    expect(error.message).toMatch(/InvalidParameter：mask is invalid/);
    expect(leaks(error)).toBe(false);
  });

  it.each(['CANCELED', 'UNKNOWN'])('reports a %s task', async (status) => {
    const service = fakeFetch((call) =>
      call.method === 'POST'
        ? json({ output: { task_id: 't' } })
        : json({ output: { task_status: status } }),
    );
    const { model } = modelWith(service.fetch);
    const error = await failureOf(model.inpaint(await args()));
    expect(error.message).toMatch(status === 'CANCELED' ? /被取消/ : /状态未知/);
  });

  it('keeps the good results when some come back as errors, and fails when all do', async () => {
    const good = await picture();
    const mixed = wellBehaved({
      statuses: [],
      results: [
        { code: 'DataInspectionFailed', message: 'blocked' },
        { url: 'https://oss.example.com/a.png' },
      ],
      pictures: { 'https://oss.example.com/a.png': good },
    });
    const kept = await modelWith(mixed.fetch).model.inpaint(await args());
    expect(kept).toHaveLength(1);
    expect(Array.from(kept[0] as Uint8Array)).toEqual(Array.from(good));

    const none = wellBehaved({
      statuses: [],
      results: [{ code: 'DataInspectionFailed', message: 'blocked' }],
    });
    const error = await failureOf(modelWith(none.fetch).model.inpaint(await args()));
    expect(error.message).toMatch(/DataInspectionFailed：blocked/);
  });

  it('fails when a result cannot be fetched', async () => {
    const service = wellBehaved({ statuses: [] });
    const error = await failureOf(modelWith(service.fetch).model.inpaint(await args()));
    expect(error.message).toMatch(/取回失败/);
    expect(error.message).toMatch(/404/);
  });

  it('gives up when the task takes too long, and says how long it waited', async () => {
    const service = wellBehaved({ statuses: Array.from({ length: 100 }, () => 'RUNNING') });
    const { model, sleep } = modelWith(service.fetch, { timeoutMs: 5000 });
    const error = await failureOf(model.inpaint(await args()));
    expect(error.message).toMatch(/5 秒内没有完成/);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(error.details).toMatchObject({ taskId: 'task-1' });
  });

  it('fails when the submission names no task', async () => {
    const service = fakeFetch(() => json({ request_id: 'req-3', output: {} }));
    const error = await failureOf(modelWith(service.fetch).model.inpaint(await args()));
    expect(error.message).toMatch(/没有返回任务编号/);
  });
});

describe('dashscope: other functions', () => {
  it('removes text with remove_watermark and the default prompt', async () => {
    const service = wellBehaved({
      statuses: [],
      pictures: { 'https://oss.example.com/a.png': await picture() },
    });
    const { model } = modelWith(service.fetch);
    const image = await picture();
    await model.removeText({ image, candidates: 1 });
    const [submit] = service.calls;
    expect(submit?.body?.input.function).toBe('remove_watermark');
    expect(submit?.body?.input.prompt).toBe('去除图中的文字');
    expect(submit?.body?.input.mask_image_url).toBeUndefined();
  });

  it.each([
    [2.4, 2],
    [3, 3],
    [9, 4],
    [0.2, 1],
  ])('upscales with super_resolution: factor %s is sent as %s', async (factor, sent) => {
    const result = await picture(512, [7, 7, 7]);
    const service = wellBehaved({
      statuses: [],
      pictures: { 'https://oss.example.com/a.png': result },
    });
    const { model } = modelWith(service.fetch);
    const returned = await model.upscale({ image: await picture(), factor });
    expect(Array.from(returned)).toEqual(Array.from(result));
    const [submit] = service.calls;
    expect(submit?.body?.input.function).toBe('super_resolution');
    expect(submit?.body?.parameters).toMatchObject({
      n: 1,
      upscale_factor: sent,
      watermark: false,
    });
  });
});
