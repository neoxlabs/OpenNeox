/**
 * browserCapture — 给每个 Playwright Page 挂"console + network ring buffer".
 *
 *   场景: agent 调 browser_get_console_logs / browser_get_network 时, 不能现请求
 *   现拿 (这些是 push-style 事件, Playwright API 只在订阅期间触发). 必须在 resolvePage
 *   首次拿到 Page 时**立刻 attach 监听器**, 把后续事件缓到 ring buffer, 工具调用时
 *   按 filter / since 拉.
 *
 *   设计要点:
 *     · 每 page 一份独立 PageCapture (Map<surfaceId, PageCapture>), Page closed 自动清
 *     · ring buffer 上限 200 条 console + 200 条 network, 超了从头丢
 *     · response body **不存** (内存压力), 只存元数据 + requestId; 真要 body 调
 *       getResponseBody(requestId) 重发 response 取 (Playwright 自动缓存最近的 response 引用)
 *
 *   docs/NEOX_BROWSER_DESIGN.md §4.6.
 */

import type { Page, Request as PWRequest, Response as PWResponse, ConsoleMessage, Dialog } from 'playwright-core';
import { enforceBrowserPolicyOnPage } from './browserPolicy.js';

export interface ConsoleLog {
  /** server 接到事件的 timestamp (ms) */
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
  text: string;
  /** 文件:行 — 浏览器报告的 location */
  location?: string;
}

export interface NetworkLog {
  /** 自增 id, 给 get_response_body 引用 */
  id: string;
  timestamp: number;
  url: string;
  method: string;
  resourceType: string;          /* document / xhr / fetch / script / stylesheet / image / ... */
  /** 命中时填; 还没完成的请求为 undefined */
  status?: number;
  statusText?: string;
  /** response 收到时填 */
  responseAt?: number;
  durationMs?: number;
  failedReason?: string;
  /** 内部: Playwright Response 引用, 给 getResponseBody 拿 body 用 */
  _response?: PWResponse;
}

/** Record native page dialogs and the automatic response so tool results can
 * distinguish an accepted, dismissed, or unanswered dialog. */
export interface DialogLog {
  timestamp: number;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  /** 我们替页面怎么答的 */
  handled: 'accepted' | 'dismissed';
  /** prompt 被接受时填进去的文字 */
  text?: string;
}

/** 下一个弹出来的对话框怎么答。动作前设, 用一次就清。 */
export interface DialogAnswer {
  accept: boolean;
  text?: string;
}

const MAX_CONSOLE = 200;
const MAX_NETWORK = 200;
const MAX_DIALOGS = 20;

class PageCapture {
  console: ConsoleLog[] = [];
  network: NetworkLog[] = [];
  dialogs: DialogLog[] = [];
  /** 下一个对话框的答案; 没设时 alert 一律接受、confirm/prompt 一律取消 (跟没有我们时一样, 但会记下来) */
  pendingDialogAnswer: DialogAnswer | null = null;
  private byRequest = new WeakMap<PWRequest, NetworkLog>();
  private nextId = 1;

  attach(page: Page): void {
    page.on('console', (msg: ConsoleMessage) => this.onConsole(msg));
    page.on('pageerror', (err: Error) => this.onPageError(err));
    page.on('request', (req: PWRequest) => this.onRequest(req));
    page.on('response', (res: PWResponse) => this.onResponse(res));
    page.on('requestfailed', (req: PWRequest) => this.onRequestFailed(req));
    page.on('dialog', (dialog: Dialog) => { void this.onDialog(dialog); });
  }

  private async onDialog(dialog: Dialog): Promise<void> {
    const type = dialog.type() as DialogLog['type'];
    const answer = this.pendingDialogAnswer;
    this.pendingDialogAnswer = null;
    /* 没给答案时: alert 只能接受; 其它一律取消 —— 取消是不会造成不可逆后果的那个方向 */
    const accept = answer ? answer.accept : type === 'alert';
    const entry: DialogLog = {
      timestamp: Date.now(),
      type,
      message: dialog.message(),
      defaultValue: dialog.defaultValue() || undefined,
      handled: accept ? 'accepted' : 'dismissed',
      ...(accept && type === 'prompt' ? { text: answer?.text ?? dialog.defaultValue() } : {}),
    };
    this.push(this.dialogs, entry, MAX_DIALOGS);
    try {
      if (accept) await dialog.accept(type === 'prompt' ? entry.text : undefined);
      else await dialog.dismiss();
    } catch { /* 对话框可能已经被页面自己关掉了 */ }
  }

  /** 从某个时刻起弹过的对话框 —— 动作回执用 */
  dialogsSince(ts: number): DialogLog[] {
    return this.dialogs.filter((d) => d.timestamp >= ts);
  }

  private push<T>(arr: T[], item: T, max: number): void {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }

  private onConsole(msg: ConsoleMessage): void {
    const type = msg.type();
    /* Playwright 的 type 比标准多了 'log/debug/info/error/warning/dir/dirxml/table/trace/...';
     * 我们 normalize 到常见 5 个 */
    const level: ConsoleLog['level'] =
        type === 'warning' ? 'warn'
      : (type === 'log' || type === 'info' || type === 'error' || type === 'debug' || type === 'trace')
        ? (type as any)
      : 'log';
    const loc = msg.location();
    this.push(this.console, {
      timestamp: Date.now(),
      level,
      text: msg.text(),
      location: loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined,
    }, MAX_CONSOLE);
  }

  private onPageError(err: Error): void {
    /* uncaught exception 也归 console.error */
    this.push(this.console, {
      timestamp: Date.now(),
      level: 'error',
      text: `[pageerror] ${err?.message ?? String(err)}`,
    }, MAX_CONSOLE);
  }

  private onRequest(req: PWRequest): void {
    const entry: NetworkLog = {
      id: `req-${this.nextId++}`,
      timestamp: Date.now(),
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
    };
    this.byRequest.set(req, entry);
    this.push(this.network, entry, MAX_NETWORK);
  }

  private onResponse(res: PWResponse): void {
    const req = res.request();
    const entry = this.byRequest.get(req);
    if (!entry) return;
    entry.responseAt = Date.now();
    entry.durationMs = entry.responseAt - entry.timestamp;
    entry.status = res.status();
    entry.statusText = res.statusText();
    entry._response = res;
  }

  private onRequestFailed(req: PWRequest): void {
    const entry = this.byRequest.get(req);
    if (!entry) return;
    entry.failedReason = req.failure()?.errorText || 'unknown';
    entry.responseAt = Date.now();
    entry.durationMs = entry.responseAt - entry.timestamp;
  }

  findById(id: string): NetworkLog | undefined {
    /* 直接 array 查 — N <= 200, O(N) 可接受 */
    return this.network.find(n => n.id === id);
  }
}

const captureBySurface = new Map<string, PageCapture>();

/** 拿到给定 surfaceId 的 capture; 不存在则创建并 attach 到 page. */
export function getOrAttachCapture(surfaceId: string, page: Page): PageCapture {
  let cap = captureBySurface.get(surfaceId);
  if (cap) return cap;
  /* Closed pages cannot accept listeners; return an uncached empty capture. */
  if (page.isClosed?.()) {
    return new PageCapture();
  }
  cap = new PageCapture();
  cap.attach(page);
  captureBySurface.set(surfaceId, cap);
  /* 站点名单钉到页面上 —— 链接点击和 JS 跳转都不经过 browser_navigate, 只查那一处等于没查。
   * 用户没配名单时 enforceBrowserPolicyOnPage 自己会直接返回, 一个 route 都不挂。
   * 这里刻意不 await: attach 是同步契约, 而挂 route 是页面级的一次性设置, 挂晚几毫秒
   * 也只影响这几毫秒内的导航 —— 拿它把整条 attach 路径改成异步的代价大得多。 */
  void enforceBrowserPolicyOnPage(page as any).catch(() => { /* 挂不上就退回只有 navigate 那道闸 */ });
  /* page 关闭时清掉这份 capture, 防止内存泄漏. listener 本身用 try-catch 防御
   *   (虽然 Map.delete 几乎不抛, 但同时还要清 byRequest 等内部 ref, 哪一步异常都不能让 page
   *   关闭流程挂死). */
  page.once('close', () => {
    try {
      captureBySurface.delete(surfaceId);
    } catch { /* swallow — 关闭流程必须无副作用 */ }
  });
  return cap;
}

export function getCapture(surfaceId: string): PageCapture | undefined {
  return captureBySurface.get(surfaceId);
}
