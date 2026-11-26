import { isUiProError, UiProError } from '@ui-pro/core';
import {
  type ArtStyle,
  type ExtractRequest,
  type ExtractResult,
  type FillRequest,
  type FillResult,
  PerceptionErrorCodes,
  type PixelOps,
  type Quality,
  type TextStripRequest,
  type TextStripResult,
  type UpscaleRequest,
  type UpscaleResult,
} from '@ui-pro/perception';

const STEP_LABELS = {
  extract: '抠取',
  fill: '补全',
  stripText: '文字剥离',
  upscale: '提升分辨率',
} as const;
type PixelStep = keyof typeof STEP_LABELS;

export interface RunnerOptions {
  screen: string;
  /** Pixel ops over a context with the cloud image model on (`true`) or off (`false`). */
  makeOps: (cloud: boolean) => PixelOps;
  /** Whether the cloud image model may be used at first. */
  cloud: boolean;
  style: ArtStyle;
  /** Nodes whose requests must not be answered from the lock (`--regenerate`). */
  regenerate?: ReadonlySet<string>;
  onProgress?: (message: string) => void;
}

/**
 * Calls the pixel ops for one build: labels each request with the node it is for, retries on
 * local methods once the screen's cloud budget runs out, and says which node and step a missing
 * locked output (`--locked`) belongs to.
 */
export class PixelRunner {
  readonly #options: RunnerOptions;
  #ops: PixelOps;
  #cloud: boolean;
  #current: { node: string; related: readonly string[] } | undefined;
  /** True once the cloud image calls of the screen reached the budget during this build. */
  budgetExhausted = false;
  /** Warnings the pixel steps reported, in Simplified Chinese. */
  readonly warnings: string[] = [];

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#cloud = options.cloud;
    this.#ops = options.makeOps(options.cloud);
  }

  /** `final` while the cloud image model may be used, `draft` otherwise. */
  get quality(): Quality {
    return this.#cloud ? 'final' : 'draft';
  }

  /** Whether the request in flight belongs to a node `--regenerate` named. */
  bypassing(): boolean {
    const regenerate = this.#options.regenerate;
    if (regenerate === undefined || regenerate.size === 0 || this.#current === undefined)
      return false;
    return (
      regenerate.has(this.#current.node) || this.#current.related.some((id) => regenerate.has(id))
    );
  }

  async #run<T extends { warnings: string[] }>(
    step: PixelStep,
    node: string,
    related: readonly string[],
    call: (ops: PixelOps) => Promise<T>,
  ): Promise<T> {
    const label = STEP_LABELS[step];
    this.#options.onProgress?.(`#${node}：${label}`);
    this.#current = { node, related };
    try {
      const result = await this.#attempt(call);
      for (const warning of result.warnings) this.warnings.push(`#${node} ${label}：${warning}`);
      return result;
    } catch (error) {
      if (isUiProError(error) && error.code === PerceptionErrorCodes.notLocked) {
        throw new UiProError(
          PerceptionErrorCodes.notLocked,
          `界面 ${this.#options.screen} 的节点 #${node} 在「${label}」这一步需要模型输出，但锁文件里没有`,
          {
            hint: '去掉 --locked 构建一次，把结果锁定后再用 --locked 复现',
            details: {
              ...asRecord(error.details),
              screen: this.#options.screen,
              node,
              step: label,
            },
          },
        );
      }
      throw error;
    } finally {
      this.#current = undefined;
    }
  }

  async #attempt<T>(call: (ops: PixelOps) => Promise<T>): Promise<T> {
    try {
      return await call(this.#ops);
    } catch (error) {
      if (this.#cloud && isUiProError(error) && error.code === PerceptionErrorCodes.imageBudget) {
        this.#cloud = false;
        this.budgetExhausted = true;
        this.#ops = this.#options.makeOps(false);
        return call(this.#ops);
      }
      throw error;
    }
  }

  extract(node: string, request: Omit<ExtractRequest, 'style' | 'label'>): Promise<ExtractResult> {
    return this.#run('extract', node, [], (ops) =>
      ops.extract({
        ...request,
        style: this.#options.style,
        label: { screen: this.#options.screen, node },
      }),
    );
  }

  fill(
    node: string,
    related: readonly string[],
    request: Omit<FillRequest, 'quality' | 'style' | 'label'>,
  ): Promise<FillResult> {
    return this.#run('fill', node, related, (ops) =>
      ops.fill({
        ...request,
        quality: this.quality,
        style: this.#options.style,
        label: { screen: this.#options.screen, node },
      }),
    );
  }

  stripText(
    node: string,
    text: string,
    request: Omit<TextStripRequest, 'quality' | 'style' | 'label'>,
  ): Promise<TextStripResult> {
    return this.#run('stripText', node, [text], (ops) =>
      ops.stripText({
        ...request,
        quality: this.quality,
        style: this.#options.style,
        label: { screen: this.#options.screen, node },
      }),
    );
  }

  upscale(
    node: string,
    request: Omit<UpscaleRequest, 'quality' | 'style' | 'label'>,
  ): Promise<UpscaleResult> {
    return this.#run('upscale', node, [], (ops) =>
      ops.upscale({
        ...request,
        quality: this.quality,
        style: this.#options.style,
        label: { screen: this.#options.screen, node },
      }),
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
