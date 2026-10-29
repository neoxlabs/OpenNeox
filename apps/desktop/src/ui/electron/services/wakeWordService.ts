
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { platform } from 'node:process';
import { app, ipcMain, type WebContents } from 'electron';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';

export interface WakeWordEvent {
  type: string;
  text?: string;
  keyword?: string;
  matched?: string;
  confidence?: number;
  speech?: string;
  mic?: string;
  message?: string;
  locale?: string;
  onDevice?: boolean;
}

interface WakeWordConfig {
  enabled: boolean;
  keywords: string[];
  locale: string;
}

const DEFAULT_KEYWORDS = ['hey neox', 'neox', '嘿 neox', '你好 neox'];

/** 持久化到 config.json 的 wakeWord 字段. 关掉设置面板/关 app 都不丢, 主进程重启也不丢. */
interface PersistedWakeWord {
  enabled?: boolean;
  keywords?: string[];
  locale?: string;
}

function readPersistedConfig(): WakeWordConfig {
  try {
    const cfg = loadConfig() as { wakeWord?: PersistedWakeWord };
    const w = cfg.wakeWord || {};
    return {
      enabled: w.enabled === true,
      keywords: Array.isArray(w.keywords) && w.keywords.length > 0 ? w.keywords : DEFAULT_KEYWORDS,
      locale: w.locale || 'zh-CN',
    };
  } catch {
    return { enabled: false, keywords: DEFAULT_KEYWORDS, locale: 'zh-CN' };
  }
}

function writePersistedConfig(cfg: WakeWordConfig): void {
  try {
    const full = loadConfig() as Record<string, unknown> & { wakeWord?: PersistedWakeWord };
    full.wakeWord = { enabled: cfg.enabled, keywords: cfg.keywords, locale: cfg.locale };
    saveConfig(full as unknown as Parameters<typeof saveConfig>[0]);
  } catch (e) {
    cliLogger.warn('wakeWord', `save config failed: ${(e as Error).message}`);
  }
}

class WakeWordService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private subscribers = new Set<WebContents>();
  private permissionState: { speech: string; mic: string } = { speech: 'notDetermined', mic: 'notDetermined' };
  private restartCount = 0;
  private lastConfig: WakeWordConfig = readPersistedConfig();
  private readyResolvers: Array<() => void> = [];
  private ready = false;

  /** 主进程启动时若配置里 enabled=true, 自动拉起 Swift 桥 (免用户每次开 Neox 手动勾) */
  bootstrapFromPersistedConfig(): void {
    if (this.lastConfig.enabled && this.isPlatformSupported()) {
      cliLogger.info('wakeWord', 'auto-start from persisted config');
      void this.setConfig(this.lastConfig);
    }
  }

  /** 解析 mac-speech 可执行文件路径 (dev / packaged 两种)。 */
  private resolveBinaryPath(): string | null {
    if (platform !== 'darwin') return null;
    /* 1. 打包后: process.resourcesPath/mac-speech/NeoxMacSpeech.app/Contents/MacOS/neox-mac-speech */
    if (process.resourcesPath) {
      const pkgApp = join(process.resourcesPath, 'mac-speech', 'NeoxMacSpeech.app', 'Contents', 'MacOS', 'neox-mac-speech');
      if (existsSync(pkgApp)) return pkgApp;
      const pkgBare = join(process.resourcesPath, 'mac-speech', 'neox-mac-speech');
      if (existsSync(pkgBare)) return pkgBare;
    }
    /* 2. dev 模式: 从主进程 main.js 的 __filename 逐层往上找 monorepo root
     * (含 apps/desktop 子目录), 再拼 resources/mac-speech/ */
    const roots: string[] = [];
    /* electron 主进程的 main.js 通常在 apps/cli/dist/ui-electron/electron/main.js */
    let cur = dirname(process.execPath);
    for (let i = 0; i < 12; i++) {
      cur = dirname(cur);
      if (cur === '/' || cur === '.') break;
      roots.push(cur);
    }
    /* app.getAppPath() 兜底 */
    try { roots.push(app.getAppPath()); } catch { /* app 未 ready */ }
    /* 直接从 cwd 往上找 (电脑上直接开发时 cwd 常是 monorepo root) */
    let cwd = process.cwd();
    for (let i = 0; i < 6; i++) {
      roots.push(cwd);
      const parent = dirname(cwd);
      if (parent === cwd) break;
      cwd = parent;
    }
    /* 优先找 .app bundle 里的 executable (macOS TCC 必须 .app 结构才认 Info.plist),
     * 兜底才用裸 binary (兼容旧版打包, 但 TCC 会拒). */
    const relative = [
      /* .app bundle path (推荐) */
      'apps/desktop/resources/mac-speech/NeoxMacSpeech.app/Contents/MacOS/neox-mac-speech',
      'resources/mac-speech/NeoxMacSpeech.app/Contents/MacOS/neox-mac-speech',
      'mac-speech/NeoxMacSpeech.app/Contents/MacOS/neox-mac-speech',
      /* 裸 binary 兜底 (不推荐, TCC 会拒 privacy 权限) */
      'apps/desktop/resources/mac-speech/neox-mac-speech',
      'resources/mac-speech/neox-mac-speech',
      'mac-speech/neox-mac-speech',
    ];
    for (const root of roots) {
      for (const rel of relative) {
        const p = join(root, ...rel.split('/'));
        if (existsSync(p)) return p;
      }
    }
    return null;
  }

  isPlatformSupported(): boolean {
    return platform === 'darwin' && this.resolveBinaryPath() !== null;
  }

  subscribe(wc: WebContents): void {
    this.subscribers.add(wc);
    wc.once('destroyed', () => this.subscribers.delete(wc));
  }

  private broadcast(evt: WakeWordEvent): void {
    for (const wc of this.subscribers) {
      if (!wc.isDestroyed()) {
        try { wc.send('wake-word:event', evt); } catch { /* window closing */ }
      }
    }
  }

  private handleLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let evt: WakeWordEvent;
    try {
      evt = JSON.parse(t) as WakeWordEvent;
    } catch {
      cliLogger.warn('wakeWord', `bad JSON from Swift: ${t.slice(0, 100)}`);
      return;
    }
    if (evt.type === 'ready') {
      this.ready = true;
      for (const r of this.readyResolvers.splice(0)) r();
      cliLogger.info('wakeWord', 'Swift bridge ready');
      return;
    }
    if (evt.type === 'started') {
      this.restartCount = 0;
    }
    if (evt.type === 'permission') {
      this.permissionState = { speech: evt.speech || 'unknown', mic: evt.mic || 'unknown' };
      cliLogger.info('wakeWord', `permission: speech=${evt.speech} mic=${evt.mic}`);
    }
    if (evt.type === 'wake') {
      cliLogger.info('wakeWord', `🎙️ wake fired: "${evt.keyword}" (matched: "${evt.matched}")`);
    }
    if (evt.type === 'error') {
      cliLogger.warn('wakeWord', `Swift error: ${evt.message}`);
    }
    this.broadcast(evt);
  }

  private send(cmd: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) {
      cliLogger.warn('wakeWord', 'send failed — child not running');
      return;
    }
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (e) {
      cliLogger.warn('wakeWord', `send failed: ${(e as Error).message}`);
    }
  }

  private async waitReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((r) => this.readyResolvers.push(r));
  }

  private lastStderr: string = '';
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private spawnChild(): boolean {
    const bin = this.resolveBinaryPath();
    if (!bin) {
      cliLogger.warn('wakeWord', 'binary not found — wake word disabled');
      this.broadcast({ type: 'error', message: 'wake word binary not found' });
      return false;
    }
    cliLogger.info('wakeWord', `spawning: ${bin}`);
    this.buffer = '';
    this.ready = false;
    this.lastStderr = '';
    try {
      this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const err = (e as Error).message;
      cliLogger.warn('wakeWord', `spawn threw: ${err}`);
      this.broadcast({ type: 'error', message: `spawn failed: ${err}` });
      return false;
    }
    /* helper 退出后再写 stdin 是异步 EPIPE, send()/shutdown() 的 try/catch 接不住 */
    this.child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      cliLogger.warn('wakeWord', `stdin write failed: ${e?.message}`);
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (data: string) => {
      this.buffer += data;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });
    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (data: string) => {
      const chunk = data.toString();
      this.lastStderr = (this.lastStderr + chunk).slice(-2000);   /* 只留最后 2KB */
      cliLogger.warn('wakeWord', `[swift stderr] ${chunk.trim().slice(0, 300)}`);
    });
    this.child.on('error', (e) => {
      cliLogger.warn('wakeWord', `child error: ${e.message}`);
      this.broadcast({ type: 'error', message: `child error: ${e.message}` });
    });
    this.child.on('exit', (code, signal) => {
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      cliLogger.info('wakeWord', `Swift bridge exited code=${code} signal=${signal}, stderr tail: ${this.lastStderr.slice(-300)}`);
      this.child = null;
      this.ready = false;
      if (this.lastConfig.enabled && this.restartCount < 3) {
        this.restartCount++;
        cliLogger.info('wakeWord', `restarting (${this.restartCount}/3)…`);
        setTimeout(() => {
          if (this.spawnChild()) {
            void this.applyConfig(this.lastConfig);
          }
        }, 1000);
      } else if (this.restartCount >= 3) {
        /* 崩溃详情附带上, 帮用户/我定位真因 */
        const detail = [
          `exit=${code}`,
          signal ? `signal=${signal}` : null,
          this.lastStderr ? `stderr: ${this.lastStderr.slice(-500)}` : null,
        ].filter(Boolean).join(' · ');
        this.broadcast({ type: 'error', message: `wake word 桥连崩 3 次, 已停. ${detail}` });
      }
    });
    return true;
  }

  /** 供设置页 UI 调, 返回最近一次崩溃诊断信息 */
  getDiagnostics(): { binaryPath: string | null; lastExitCode: number | null; lastExitSignal: string | null; lastStderr: string } {
    return {
      binaryPath: this.resolveBinaryPath(),
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastStderr: this.lastStderr,
    };
  }

  private async applyConfig(cfg: WakeWordConfig): Promise<void> {
    await this.waitReady();
    /* probePermission 触发系统弹窗 (首次) 或读缓存. Swift 会 emit permission 事件. */
    this.send({ cmd: 'probePermission' });
    if (cfg.enabled && cfg.keywords.length > 0) {
      this.send({ cmd: 'start', keywords: cfg.keywords, locale: cfg.locale });
    }
  }

  async setConfig(cfg: WakeWordConfig): Promise<{ ok: boolean; error?: string }> {
    this.lastConfig = { ...cfg };
    /* 每次 setConfig 都 persist 到 config.json — 关面板/关 app 都不丢, 下次 boot 从 config 恢复 */
    writePersistedConfig(this.lastConfig);
    this.restartCount = 0;
    if (!this.isPlatformSupported()) {
      return { ok: false, error: '仅支持 macOS' };
    }
    if (!cfg.enabled) {
      if (this.child) {
        this.send({ cmd: 'stop' });
        setTimeout(() => { this.child?.kill('SIGTERM'); }, 500);
      }
      return { ok: true };
    }
    if (!this.child) {
      if (!this.spawnChild()) return { ok: false, error: 'binary spawn failed' };
    }
    await this.applyConfig(cfg);
    return { ok: true };
  }

  getState(): {
    supported: boolean; running: boolean;
    permission: { speech: string; mic: string };
    /* 补: 让 UI 能读回持久化的 enabled/keywords/locale, 不再让 UI state 单独漂 */
    enabled: boolean;
    keywords: string[];
    locale: string;
  } {
    return {
      supported: this.isPlatformSupported(),
      running: this.child !== null,
      permission: this.permissionState,
      enabled: this.lastConfig.enabled,
      keywords: this.lastConfig.keywords,
      locale: this.lastConfig.locale,
    };
  }

  shutdown(): void {
    if (this.child) {
      try { this.child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* noop */ }
      setTimeout(() => { this.child?.kill('SIGTERM'); }, 300);
    }
  }
}

export const wakeWordService = new WakeWordService();

export function registerWakeWordIpc(): void {
  ipcMain.handle('wake-word:get-state', () => wakeWordService.getState());
  ipcMain.handle('wake-word:set-config', async (_event, cfg: WakeWordConfig) => {
    return wakeWordService.setConfig(cfg);
  });
  ipcMain.handle('wake-word:subscribe', (event) => {
    wakeWordService.subscribe(event?.sender);
    return { ok: true };
  });
  ipcMain.handle('wake-word:diagnostics', () => wakeWordService.getDiagnostics());
  /* app ready 后再启动 (避免 loadConfig 时电子还没准备好文件路径) */
  app.whenReady().then(() => {
    /* 稍延迟一下, 让 registerIpc 全部注册完再触发 (subscriber 才能收到事件) */
    setTimeout(() => wakeWordService.bootstrapFromPersistedConfig(), 500);
  });
  app.on('before-quit', () => wakeWordService.shutdown());
}
