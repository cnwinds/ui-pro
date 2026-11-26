import { UiProError } from '@ui-pro/core';
import sharp from 'sharp';
import { PerceptionErrorCodes } from '../errors';
import type { CloudImageModel, ImageModelCapabilities } from './types';

export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com';
export const DASHSCOPE_MODEL = 'wanx2.1-imageedit';
export const DASHSCOPE_KEY_VARIABLE = 'DASHSCOPE_API_KEY';

const SUBMIT_PATH = '/api/v1/services/aigc/image2image/image-synthesis';
const TASK_PATH = '/api/v1/tasks';
const MAX_PROMPT = 800;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPSCALE_FACTOR = 4;
const SUPER_RESOLUTION_PROMPT = '图像超分';
const REMOVE_TEXT_PROMPT = '去除图中的文字';

export const DASHSCOPE_CAPABILITIES: ImageModelCapabilities = {
  maskInput: true,
  transparentOutput: false,
  layerDecomposition: false,
  minSide: 512,
  maxSide: 4096,
  maxCandidates: 4,
};

export interface DashScopeOptions {
  /** Replaces the global `fetch` (tests). */
  fetch?: typeof fetch;
  /** Delay between two polls of a task, in ms. */
  pollMs?: number;
  /** Longest total wait for one task, in ms. */
  timeoutMs?: number;
  /** Retries after a throttled or failed request. */
  retries?: number;
  /** Replaces the real wait (tests). */
  sleep?: (ms: number) => Promise<void>;
}

interface ServiceBody {
  code?: string;
  message?: string;
  request_id?: string;
  output?: {
    task_id?: string;
    task_status?: string;
    code?: string;
    message?: string;
    results?: { url?: string; code?: string; message?: string }[];
  };
}

const fail = (
  message: string,
  options: { hint?: string; details?: unknown; cause?: unknown } = {},
) =>
  new UiProError(PerceptionErrorCodes.cloudImage, `云端图像模型（DashScope）${message}`, options);

const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;

/** 429 and 5xx are worth another try; other statuses are the request's own fault. */
const retryable = (status: number) => status === 429 || status >= 500;

/** The DashScope (通义万相) image editing service behind the Provider interface. */
export function createDashScopeModel(
  apiKey: string,
  endpoint: string | undefined,
  options: DashScopeOptions = {},
): CloudImageModel {
  const base = (endpoint ?? DASHSCOPE_ENDPOINT).replace(/\/+$/, '');
  const call = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const retries = options.retries ?? 3;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  async function send(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: ServiceBody }> {
    let lastProblem = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await call(url, init);
      } catch (error) {
        lastProblem = `连接失败（${error instanceof Error ? error.message : String(error)}）`;
        continue;
      }
      let body: ServiceBody = {};
      try {
        body = (await response.json()) as ServiceBody;
      } catch {
        // A non-JSON error page; the status says enough.
      }
      if (response.ok) return { status: response.status, body };
      if (retryable(response.status) && attempt < retries) {
        lastProblem = `HTTP ${response.status}`;
        continue;
      }
      const detail = [body.code, body.message].filter(Boolean).join('：');
      throw fail(`返回错误 HTTP ${response.status}${detail ? `（${detail}）` : ''}`, {
        hint:
          response.status === 401 || response.status === 403
            ? `检查环境变量 ${DASHSCOPE_KEY_VARIABLE} 是否正确、账号是否开通了通义万相`
            : response.status === 429
              ? '调用太频繁或额度不足，稍后重试，或改用本地模型出初稿（ui-pro build --draft）'
              : undefined,
        details: { status: response.status, code: body.code, requestId: body.request_id },
      });
    }
    throw fail(`多次重试后仍然失败：${lastProblem}`, {
      hint: '检查网络，或在 image_model.endpoint 里配置业务空间专属域名',
    });
  }

  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  });

  async function checkSent(label: string, png: Uint8Array): Promise<void> {
    if (png.byteLength > MAX_IMAGE_BYTES) {
      throw fail(`的${label}超过 10 MB，不能发送`);
    }
    const { width = 0, height = 0 } = await sharp(png).metadata();
    const { minSide, maxSide } = DASHSCOPE_CAPABILITIES;
    if (width < minSide || height < minSide || width > maxSide || height > maxSide) {
      throw fail(`的${label}是 ${width}x${height}，宽和高都必须在 ${minSide}–${maxSide} 像素之间`);
    }
  }

  async function runTask(
    input: Record<string, unknown>,
    parameters: Record<string, unknown>,
  ): Promise<Uint8Array[]> {
    const submitted = await send(`${base}${SUBMIT_PATH}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' }),
      body: JSON.stringify({
        model: DASHSCOPE_MODEL,
        input,
        parameters: { watermark: false, ...parameters },
      }),
    });
    const taskId = submitted.body.output?.task_id;
    if (!taskId)
      throw fail('没有返回任务编号', { details: { requestId: submitted.body.request_id } });

    let waited = 0;
    for (;;) {
      const polled = await send(`${base}${TASK_PATH}/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: headers(),
      });
      const output = polled.body.output;
      const status = output?.task_status ?? 'UNKNOWN';
      if (status === 'SUCCEEDED') return download(output?.results ?? []);
      if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
        const detail = [output?.code, output?.message].filter(Boolean).join('：');
        throw fail(
          `任务${status === 'FAILED' ? '失败' : status === 'CANCELED' ? '被取消' : '状态未知'}${detail ? `（${detail}）` : ''}`,
          {
            details: { taskId, status, code: output?.code, requestId: polled.body.request_id },
          },
        );
      }
      if (waited >= timeoutMs) {
        throw fail(`任务 ${timeoutMs / 1000} 秒内没有完成`, {
          hint: '稍后重试；任务仍在云端排队时，重复提交会重复计入用量',
          details: { taskId, status },
        });
      }
      await sleep(pollMs);
      waited += pollMs;
    }
  }

  /** Result addresses are valid for 24 hours and signed: fetched at once, without the key. */
  async function download(results: NonNullable<NonNullable<ServiceBody['output']>['results']>) {
    const pictures: Uint8Array[] = [];
    const problems: string[] = [];
    await Promise.all(
      results.map(async (result, index) => {
        if (!result.url) {
          problems.push(
            `第 ${index + 1} 张：${[result.code, result.message].filter(Boolean).join('：') || '没有图片'}`,
          );
          return;
        }
        try {
          const response = await call(result.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          pictures[index] = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          problems.push(
            `第 ${index + 1} 张取回失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    const got = pictures.filter((picture): picture is Uint8Array => picture !== undefined);
    if (got.length === 0) {
      throw fail(`没有返回可用的图片（${problems.join('；') || '结果为空'}）`);
    }
    return got;
  }

  const prompted = (prompt: string | undefined, fallback?: string) => {
    const text = (prompt ?? fallback ?? '').trim().slice(0, MAX_PROMPT);
    if (!text) throw fail('的提示词不能为空');
    return text;
  };
  const candidatesOf = (n: number) =>
    Math.max(1, Math.min(DASHSCOPE_CAPABILITIES.maxCandidates, Math.round(n)));

  return {
    id: `dashscope/${DASHSCOPE_MODEL}`,
    capabilities: DASHSCOPE_CAPABILITIES,

    async inpaint({ image, mask, prompt, candidates }) {
      await checkSent('原图', image);
      await checkSent('遮罩', mask);
      return runTask(
        {
          function: 'description_edit_with_mask',
          prompt: prompted(prompt),
          base_image_url: dataUrl(image),
          mask_image_url: dataUrl(mask),
        },
        { n: candidatesOf(candidates) },
      );
    },

    async removeText({ image, prompt, candidates }) {
      await checkSent('原图', image);
      return runTask(
        {
          function: 'remove_watermark',
          prompt: prompted(prompt, REMOVE_TEXT_PROMPT),
          base_image_url: dataUrl(image),
        },
        { n: candidatesOf(candidates) },
      );
    },

    async upscale({ image, factor }) {
      await checkSent('原图', image);
      const [picture] = await runTask(
        {
          function: 'super_resolution',
          prompt: SUPER_RESOLUTION_PROMPT,
          base_image_url: dataUrl(image),
        },
        { n: 1, upscale_factor: Math.max(1, Math.min(MAX_UPSCALE_FACTOR, Math.round(factor))) },
      );
      if (!picture) throw fail('没有返回放大后的图片');
      return picture;
    },
  };
}
