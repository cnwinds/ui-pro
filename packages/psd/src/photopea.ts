import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { isUiProError, UiProError } from '@ui-pro/core';
import { chromium, type Page } from 'playwright-core';
import { PsdErrorCodes } from './errors';
import { decodePng } from './image';
import { layersById, type PsdDocument, type PsdLayer } from './model';
import type { LayerRenderer, RenderRequest, RenderStats, RenderUnit } from './renderer';

export const PHOTOPEA_URL =
  'https://www.photopea.com#%7B%22environment%22%3A%7B%22intro%22%3Afalse%7D%7D';

/** Photopea refuses clients that look headless; this is the user agent of a desktop Edge. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const BROWSER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const VIEWPORT = { width: 1200, height: 800 };

/** Units per script call: fewer round trips, but a bounded amount of PNG data in flight. */
const BATCH_SIZE = 8;

/** A lock file without a readable pid counts as held for this long. */
const LOCK_GRACE_MS = 10_000;

export interface PhotopeaOptions {
  /** The Photopea page to embed; replaced in tests to simulate an unreachable service. */
  url?: string;
  /** Use this browser executable instead of the installed Microsoft Edge. */
  executablePath?: string;
  /**
   * Browser profile directory that keeps Photopea's files cached between runs, which turns a
   * 15 to 50 second page load into about two seconds. Only one process can use a profile; while
   * another holds it, or when it cannot be used, the renderer starts a clean browser instead.
   */
  profileDir?: string;
  headless?: boolean;
  /** Browser launch, page load and Photopea start, together. */
  startupTimeoutMs?: number;
  /** Opening the PSD, and each batch of layer renders. */
  callTimeoutMs?: number;
}

interface Session {
  psd: Uint8Array;
  received: Map<string, Buffer>;
}

/**
 * The host page embeds Photopea in an iframe and talks to it over postMessage. The PSD goes in
 * and the PNGs come out through the local HTTP server, so no large payload crosses the browser
 * automation channel.
 */
const HOST_PAGE = (photopeaUrl: string): string => `<!doctype html>
<html><body style="margin:0">
<iframe id="pp" src=${JSON.stringify(photopeaUrl)} style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.getElementById('pp');
let current = null;
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  if (current === null) { if (event.data === 'done') markReady(); return; }
  if (event.data === 'done') {
    const finished = current;
    current = null;
    clearTimeout(finished.timer);
    finished.resolve(finished.messages);
  } else current.messages.push(event.data);
});
function call(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const entry = {
      messages: [],
      resolve,
      timer: setTimeout(() => { current = null; reject(new Error('timeout after ' + timeoutMs + ' ms')); }, timeoutMs),
    };
    current = entry;
    frame.contentWindow.postMessage(payload, '*');
  });
}
window.ppReady = () => ready;
window.ppOpen = async (token, timeoutMs) => {
  const response = await fetch('/psd/' + token);
  await call(await response.arrayBuffer(), timeoutMs);
  return true;
};
window.ppRun = async (script, token, timeoutMs) => {
  const messages = await call(script, timeoutMs);
  const out = [];
  let id = null;
  for (const message of messages) {
    if (typeof message !== 'string') {
      await fetch('/png/' + token + '/' + id, { method: 'POST', body: message });
      out.push('P' + id);
    } else if (message.startsWith('J')) id = message.slice(1);
    else out.push(message);
  }
  return out;
};
</script></body></html>`;

// Photopea scripts are ES3: no arrow functions, let/const or Array.prototype.map.
const STRUCTURE_SCRIPT = `(function () {
  function walk(layers) {
    var out = [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer.typename === 'LayerSet') out.push({ g: 1, c: walk(layer.layers) });
      else out.push({ g: 0 });
    }
    return out;
  }
  app.echoToOE('S' + JSON.stringify(walk(app.activeDocument.layers)));
})();`;

function renderScript(jobs: readonly { id: number; show: number[][] }[]): string {
  return `(function () {
  var jobs = ${JSON.stringify(jobs)};
  var d = app.activeDocument;
  function get(path) {
    var layer = d.layers[path[0]];
    for (var i = 1; i < path.length; i++) layer = layer.layers[path[i]];
    return layer;
  }
  function all(layers, acc) {
    for (var i = 0; i < layers.length; i++) {
      acc.push(layers[i]);
      if (layers[i].typename === 'LayerSet') all(layers[i].layers, acc);
    }
    return acc;
  }
  var every = all(d.layers, []);
  for (var j = 0; j < jobs.length; j++) {
    try {
      for (var i = 0; i < every.length; i++) every[i].visible = false;
      for (var s = 0; s < jobs[j].show.length; s++) {
        var path = jobs[j].show[s];
        for (var k = 1; k <= path.length; k++) get(path.slice(0, k)).visible = true;
      }
      app.echoToOE('J' + jobs[j].id);
      d.saveToOE('png');
    } catch (e) {
      app.echoToOE('ERR ' + jobs[j].id + ' ' + e);
    }
  }
})();`;
}

interface PhotopeaNode {
  g: 0 | 1;
  c?: PhotopeaNode[];
}

/** Photopea lists layers top first, ag-psd bottom first; this is the path Photopea knows. */
function photopeaPath(doc: PsdDocument, layer: PsdLayer): number[] {
  const path: number[] = [];
  let siblings = doc.layers;
  for (const position of layer.index) {
    path.push(siblings.length - 1 - position);
    siblings = siblings[position]?.children ?? [];
  }
  return path;
}

function structureMismatch(
  layers: readonly PsdLayer[],
  nodes: readonly PhotopeaNode[],
  where: string,
): string | undefined {
  if (layers.length !== nodes.length) {
    return `${where}里 PSD 有 ${layers.length} 个图层，Photopea 读到 ${nodes.length} 个`;
  }
  for (let top = 0; top < nodes.length; top++) {
    const layer = layers[layers.length - 1 - top];
    const node = nodes[top];
    if (layer === undefined || node === undefined) continue;
    const label = `${where}第 ${top + 1} 个图层「${layer.name}」`;
    if ((layer.kind === 'group') !== (node.g === 1)) return `${label}的类型（组或图层）不一致`;
    if (node.g === 1) {
      const inner = structureMismatch(layer.children ?? [], node.c ?? [], `${label}里`);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function callFailure(cause: unknown, what: string, timeoutMs: number): UiProError {
  if (isUiProError(cause)) return cause;
  const reason = reasonOf(cause);
  if (reason.includes('timeout after')) {
    return new UiProError(
      PsdErrorCodes.renderTimeout,
      `Photopea ${what}超过 ${timeoutMs / 1000} 秒没有完成`,
      {
        hint: 'PSD 很大或网络很慢时可以重试；仍然超时就改用较小的文件，或改交交付包',
        cause,
      },
    );
  }
  return new UiProError(PsdErrorCodes.renderFailed, `Photopea ${what}失败：${reason}`, {
    hint: '重试一次；仍然失败请带上 --debug 反馈输出',
    cause,
  });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/** Whether the process that wrote `lockPath` still runs; an unreadable lock only expires. */
async function lockHeld(lockPath: string): Promise<boolean> {
  try {
    const pid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return errorCode(error) === 'EPERM';
      }
    }
    return Date.now() - (await stat(lockPath)).mtimeMs < LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

export interface ProfileLock {
  release(): Promise<void>;
}

/** Takes `<profile>.lock` for this process; `undefined` when someone else holds it. */
export async function lockProfile(profileDir: string): Promise<ProfileLock | undefined> {
  const lockPath = `${profileDir}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { release: () => rm(lockPath, { force: true }) };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return undefined;
      if (await lockHeld(lockPath)) return undefined;
      await rm(lockPath, { force: true });
    }
  }
  return undefined;
}

/** What the renderer needs of a started browser, with or without a persistent profile. */
interface BrowserHandle {
  profile: 'persistent' | 'temporary';
  alive(): boolean;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/**
 * Renders layers with Photopea, driven in the locally installed Microsoft Edge: for each unit it
 * hides every other layer and exports the canvas as PNG. The browser starts once and is reused
 * by every `render` call until `close`.
 */
export class PhotopeaRenderer implements LayerRenderer {
  readonly name = 'photopea';
  readonly capabilities = { network: true };

  private readonly url: string;
  private readonly executablePath?: string;
  private readonly profileDir?: string;
  private readonly headless: boolean;
  private readonly startupTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private browser?: BrowserHandle;
  private server?: Server;
  private readonly sessions = new Map<string, Session>();

  constructor(options: PhotopeaOptions = {}) {
    this.url = options.url ?? PHOTOPEA_URL;
    this.executablePath = options.executablePath;
    this.profileDir = options.profileDir;
    this.headless = options.headless ?? true;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const segments = (request.url ?? '/').split('/').filter((part) => part !== '');
    const [kind, token, id] = segments;
    const session = token === undefined ? undefined : this.sessions.get(token);
    if (request.method === 'GET' && kind === undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(HOST_PAGE(this.url));
    } else if (request.method === 'GET' && kind === 'psd' && session) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(session.psd);
    } else if (request.method === 'POST' && kind === 'png' && session && id !== undefined) {
      readBody(request).then(
        (body) => {
          session.received.set(id, body);
          response.writeHead(204).end();
        },
        () => response.writeHead(500).end(),
      );
    } else {
      response.writeHead(404).end();
    }
  }

  private async ensureServer(): Promise<string> {
    if (this.server === undefined) {
      const server = createServer((request, response) => this.handle(request, response));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.server = server;
    }
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private launchOptions() {
    return {
      ...(this.executablePath === undefined
        ? { channel: 'msedge' }
        : { executablePath: this.executablePath }),
      headless: this.headless,
      args: BROWSER_ARGS,
      timeout: this.startupTimeoutMs,
    };
  }

  /** A browser that keeps its cache in `profileDir`; `undefined` when it cannot have it. */
  private async launchPersistent(profileDir: string): Promise<BrowserHandle | undefined> {
    const lock = await lockProfile(profileDir).catch(() => undefined);
    if (lock === undefined) return undefined;
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        ...this.launchOptions(),
        userAgent: USER_AGENT,
        viewport: VIEWPORT,
      });
      let alive = true;
      context.on('close', () => {
        alive = false;
      });
      return {
        profile: 'persistent',
        alive: () => alive,
        newPage: () => context.newPage(),
        close: async () => {
          try {
            await context.close();
          } finally {
            await lock.release();
          }
        },
      };
    } catch {
      await lock.release();
      return undefined;
    }
  }

  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser?.alive()) return this.browser;
    try {
      const persistent =
        this.profileDir === undefined ? undefined : await this.launchPersistent(this.profileDir);
      if (persistent !== undefined) {
        this.browser = persistent;
        return persistent;
      }
      const browser = await chromium.launch(this.launchOptions());
      this.browser = {
        profile: 'temporary',
        alive: () => browser.isConnected(),
        newPage: () => browser.newPage({ viewport: VIEWPORT, userAgent: USER_AGENT }),
        close: () => browser.close(),
      };
      return this.browser;
    } catch (cause) {
      const reason = reasonOf(cause).split('\n')[0] ?? '';
      throw new UiProError(PsdErrorCodes.noBrowser, `无法启动 Microsoft Edge：${reason}`, {
        hint: 'Photopea 渲染需要本机安装 Microsoft Edge（Windows 自带），请确认它能正常打开；或改交交付包',
        cause,
      });
    }
  }

  /** Opens the host page and waits until Photopea answers; fails fast when it cannot be reached. */
  private async startPage(page: Page, hostUrl: string): Promise<void> {
    const origin = new URL(this.url).origin;
    let failUnreachable: (error: UiProError) => void = () => {};
    const unreachable = new Promise<never>((_, reject) => {
      failUnreachable = reject;
    });
    unreachable.catch(() => {});
    page.on('requestfailed', (request) => {
      if (request.resourceType() !== 'document' || !request.url().startsWith(origin)) return;
      failUnreachable(
        new UiProError(
          PsdErrorCodes.photopeaUnreachable,
          `连不上 Photopea（${origin}）：${request.failure()?.errorText ?? '请求失败'}`,
          { hint: '检查网络连接后重试；项目设为 egress: local 时不能使用在线版 Photopea' },
        ),
      );
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new UiProError(
              PsdErrorCodes.renderTimeout,
              `Photopea 在 ${this.startupTimeoutMs / 1000} 秒内没有就绪`,
              { hint: '检查网络连接后重试' },
            ),
          ),
        this.startupTimeoutMs,
      );
    });
    timeout.catch(() => {});
    const started = (async () => {
      await page.goto(hostUrl, { timeout: this.startupTimeoutMs });
      await page.evaluate('window.ppReady()');
    })();
    started.catch(() => {});
    try {
      await Promise.race([started, unreachable, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async render(request: RenderRequest): Promise<RenderStats> {
    const { document, units } = request;
    const startedAt = performance.now();
    const hostUrl = await this.ensureServer();
    const browser = await this.ensureBrowser();
    const token = randomBytes(16).toString('hex');
    const session: Session = { psd: document.bytes, received: new Map() };
    this.sessions.set(token, session);
    const page = await browser.newPage();
    try {
      await this.startPage(page, hostUrl);
      const readyAt = performance.now();
      await this.openDocument(page, token, document);
      const openedAt = performance.now();
      await this.renderUnits(page, token, session, request);
      return {
        renderer: this.name,
        startupMs: Math.round(readyAt - startedAt),
        openMs: Math.round(openedAt - readyAt),
        units: units.length,
        renderMs: Math.round(performance.now() - openedAt),
        profile: browser.profile,
      };
    } finally {
      this.sessions.delete(token);
      await page.close().catch(() => {});
    }
  }

  private async openDocument(page: Page, token: string, document: PsdDocument): Promise<void> {
    try {
      await page.evaluate(`window.ppOpen(${JSON.stringify(token)}, ${this.callTimeoutMs})`);
      const reply = (await page.evaluate(
        `window.ppRun(${JSON.stringify(STRUCTURE_SCRIPT)}, ${JSON.stringify(token)}, ${this.callTimeoutMs})`,
      )) as string[];
      const structure = reply.find((message) => message.startsWith('S'));
      if (structure === undefined)
        throw new Error(`没有读到图层结构（${reply.join('；') || '无回应'}）`);
      const mismatch = structureMismatch(document.layers, JSON.parse(structure.slice(1)), '顶层');
      if (mismatch !== undefined) {
        throw new UiProError(
          PsdErrorCodes.renderFailed,
          `Photopea 读到的图层结构与 PSD 不一致：${mismatch}`,
          {
            hint: '这个 PSD 里可能有 Photopea 不支持的图层类型；可以改交交付包',
          },
        );
      }
    } catch (cause) {
      throw callFailure(cause, '打开 PSD', this.callTimeoutMs);
    }
  }

  private async renderUnits(
    page: Page,
    token: string,
    session: Session,
    request: RenderRequest,
  ): Promise<void> {
    const { document, units } = request;
    const byId = layersById(document.layers);
    for (let from = 0; from < units.length; from += BATCH_SIZE) {
      const batch = units.slice(from, from + BATCH_SIZE);
      const jobs = batch.map((unit) => ({
        id: unit.id,
        show: unit.show.flatMap((id) => {
          const layer = byId.get(id);
          return layer === undefined ? [] : [photopeaPath(document, layer)];
        }),
      }));
      let reply: string[];
      try {
        reply = (await page.evaluate(
          `window.ppRun(${JSON.stringify(renderScript(jobs))}, ${JSON.stringify(token)}, ${this.callTimeoutMs})`,
        )) as string[];
      } catch (cause) {
        throw callFailure(cause, '渲染图层', this.callTimeoutMs);
      }
      const failure = reply.find((message) => message.startsWith('ERR '));
      if (failure !== undefined) {
        throw new UiProError(
          PsdErrorCodes.renderFailed,
          `Photopea 渲染图层失败：${failure.slice(4)}`,
        );
      }
      await this.deliver(batch, session, request);
    }
  }

  private async deliver(
    batch: readonly RenderUnit[],
    session: Session,
    request: RenderRequest,
  ): Promise<void> {
    for (const unit of batch) {
      const png = session.received.get(String(unit.id));
      session.received.delete(String(unit.id));
      if (png === undefined) {
        throw new UiProError(
          PsdErrorCodes.renderFailed,
          `Photopea 没有导出图层 #${unit.id} 的图片`,
        );
      }
      const image = await decodePng(png);
      if (image.width !== request.document.width || image.height !== request.document.height) {
        throw new UiProError(
          PsdErrorCodes.renderFailed,
          `Photopea 导出的图片是 ${image.width}×${image.height}，画布是 ${request.document.width}×${request.document.height}`,
        );
      }
      await request.onRendered(unit, image);
    }
  }

  async close(): Promise<void> {
    const { browser, server } = this;
    this.browser = undefined;
    this.server = undefined;
    this.sessions.clear();
    await browser?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
