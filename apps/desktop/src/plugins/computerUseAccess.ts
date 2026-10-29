/**
 * computer use 的授权自检。
 *
 * ─── macOS: 必须由 Neox 主进程去请求 TCC ────────────────────────────────
 * 责任进程才是列表里那一行。终端里 spawn 桥, 辅助功能里找不到 Neox。
 * 判据不能只看 AXIsProcessTrusted: 升级后 TCC 记录还在但 AX 已经半失效,
 * 所以真 dump 一次 Finder。
 *
 * ─── Windows: 不弹升权窗 ────────────────────────────────────────────────
 * 同级 UIA / SendInput 不需要勾选, 普通应用直接能控。管理员应用工具会报
 * need_elevation。开机再弹「获取管理员」只会挡路, 这条路径已经关掉。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

function electronApp(): { on(event: 'before-quit', cb: () => void): unknown } | undefined {
  try { return createRequire(import.meta.url)('electron')?.app ?? undefined; } catch { return undefined; }
}

/** 一次启动最多弹一次 —— 用户可能就是不想给, 别每次都烦他。 */
let promptedThisRun = false;
let quitHooked = false;

function hookElevatedBridgeQuit(): void {
  if (quitHooked) return;
  const app = electronApp();
  if (!app) return;
  quitHooked = true;
  app.on('before-quit', () => {
    const p = join(tmpdir(), 'neox-os-bridge-elevated.json');
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { pid?: number };
      if (typeof j.pid === 'number' && j.pid > 0) {
        try { process.kill(j.pid); } catch { /* already gone */ }
      }
      rmSync(p, { force: true });
    } catch { /* no helper */ }
  });
}

function resolveBridge(): string | null {
  const candidates: string[] = [];
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const isWin = process.platform === 'win32';

  if (isWin) {
    /* Windows: 一只随包走的 exe —— 没有 .app / socket / TCC 那一套 */
    if (res) candidates.push(join(res, 'os-bridge', 'neox-os-bridge.exe'));
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join(dir, 'apps/desktop/resources/win-os-bridge/neox-os-bridge.next.exe'));
      candidates.push(join(dir, 'apps/desktop/resources/win-os-bridge/neox-os-bridge.exe'));
      dir = dirname(dir);
    }
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  if (res) {
    candidates.push(join(res, 'os-bridge', 'Neox Computer Use.app', 'Contents', 'MacOS', 'neox-os-bridge'));
    candidates.push(join(res, 'os-bridge', 'NeoxOSBridge.app', 'Contents', 'MacOS', 'neox-os-bridge'));
    candidates.push(join(res, 'os-bridge', 'neox-os-bridge'));
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/Neox Computer Use.app/Contents/MacOS/neox-os-bridge'));
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/NeoxOSBridge.app/Contents/MacOS/neox-os-bridge'));
    candidates.push(join(dir, 'apps/desktop/resources/os-bridge/neox-os-bridge'));
    dir = dirname(dir);
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 跟桥说一轮话就退出。这里只做启动自检, 不值得常驻。 */
async function askBridge(requests: Array<Record<string, unknown>>, timeoutMs = 20_000): Promise<any[]> {
  const bin = resolveBridge();
  if (!bin) return [];
  return new Promise((resolve) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: any[] = [];
    let buf = '';
    const done = (): void => { try { child.kill(); } catch { /* ignore */ } resolve(out); };
    const timer = setTimeout(done, timeoutMs);
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== 0) out.push(msg);
          if (out.length >= requests.length) { clearTimeout(timer); done(); }
        } catch { /* 不是 JSON 就丢 */ }
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
    /* stdin 的 error 必须接住 —— 未处理的 stream error 会掀掉整个主进程 */
    child.stdin.on('error', () => { /* 桥没起来, 上面的 error/exit 会兜住 */ });
    for (const [i, req] of requests.entries()) {
      try { child.stdin.write(JSON.stringify({ id: i + 1, ...req }) + '\n'); } catch { /* ignore */ }
    }
  });
}

export interface ComputerUseAccessState {
  /** AXIsProcessTrusted 怎么说 (Windows 上恒 true —— 没有这个概念) */
  trusted: boolean;
  /** 屏幕录制 (Windows 上恒 true) */
  screenRecording: boolean;
  /** 深度探测: 真的能读到界面元素吗 —— 这才是"能不能用"的判据 */
  usable: boolean;
  detail: string;
}

/**
 * 深度探测。
 *
 * mac: `trusted` 说有授权不代表真能用 (见文件头的「授权半失效」), 所以拿 Finder 当靶子
 * 真 dump 一次 —— 它一直在跑, 而且是原生应用, AX 树最稳。
 *
 * Windows: 桥能说话就算可用; 管理员应用另看 privilege.canDriveElevated。
 */
export async function checkComputerUseAccess(): Promise<ComputerUseAccessState> {
  if (process.platform === 'win32') {
    const [probe] = await askBridge([{ op: 'probe' }]);
    const ok = !!probe?.ok;
    const priv = probe?.privilege as { integrity?: string; canDriveElevated?: boolean } | undefined;
    const integrity = priv?.integrity ?? 'unknown';
    const admin = priv?.canDriveElevated ? '管理员应用也能控' : '管理员应用需升权 (UAC)';
    return {
      trusted: true,
      screenRecording: true,
      usable: ok,
      detail: ok
        ? `可用 · 完整性 ${integrity} · ${admin}`
        : '不可用: 桥没有回应',
    };
  }
  const [probe, dump] = await askBridge([{ op: 'probe' }, { op: 'dump', app: 'Finder' }]);
  const trusted = !!probe?.trusted;
  const screenRecording = !!probe?.screenRecording;
  const usable = !!dump?.ok && Array.isArray(dump.elements) && dump.elements.length > 0;
  const detail = usable
    ? `可用 (Finder 读到 ${dump.elements.length} 个元素)`
    : `不可用: ${dump?.code ?? '桥没有回应'} ${dump?.error ?? ''}`.trim();
  return { trusted, screenRecording, usable, detail };
}

/**
 * 请求授权。macOS 弹 TCC; Windows 只报现状, 不弹窗。
 */
export async function requestComputerUseAccess(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === 'win32') {
    hookElevatedBridgeQuit();
    const [probe] = await askBridge([{ op: 'probe' }]);
    if (probe?.privilege?.canDriveElevated) {
      return { ok: true, detail: '桥已经能驱动管理员应用' };
    }
    return { ok: true, detail: '普通应用能控; 管理员应用会报 need_elevation' };
  }
  const [r] = await askBridge([{ op: 'request_access' }]);
  return { ok: !!r?.ok, detail: String(r?.value ?? '桥没有回应') };
}

export async function ensureComputerUseAccessOnBoot(hasComputerUsePlugin: boolean): Promise<void> {
  if (!hasComputerUsePlugin || promptedThisRun) return;
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const bridge = resolveBridge();
  const state = await checkComputerUseAccess();
  const where = bridge ? `桥=${bridge}` : '桥=没找到';
  if (state.usable) {
    // eslint-disable-next-line no-console
    console.log(`[COMPUTER_USE] 自检通过: ${state.detail} (${where})`);
    if (process.platform === 'win32') hookElevatedBridgeQuit();
    return;
  }
  if (process.platform !== 'darwin') {
    // eslint-disable-next-line no-console
    console.warn(`[COMPUTER_USE] 自检失败: ${state.detail} (${where}) —— 检查桥 exe 是否存在且能启动`);
    return;
  }
  promptedThisRun = true;
  cliLogger.warn('COMPUTER_USE', `授权自检: ${state.detail} (trusted=${state.trusted}) → 主动请求授权`);
  const r = await requestComputerUseAccess();
  cliLogger.info('COMPUTER_USE', `已请求授权: ${r.detail}`);
}
