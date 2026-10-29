
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, renameSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FEED_BASE = 'https://dl.neox-dev.com/desktop';
const ALLOWED_HOSTS = new Set(['dl.neox-dev.com']);

export interface MacUpdateManifest {
  version: string;
  zipUrl: string;
  sha512: string;
  size: number;
}

export interface StagedMacUpdate {
  version: string;
  /** 解压出来、已校验过版本号的 Neox.app 绝对路径 (临时目录里) */
  stagedAppPath: string;
}

export type MacUpdateProgress = (p: {
  percent: number; transferred: number; total: number; speed: number;
  /** 这一拍是不是"停下来了" —— UI 据此把进度条从流动改成静止, 而不是显示成卡住 */
  paused?: boolean;
}) => void;

/** 暂停时抛的这一个 —— 调用链上每一层都靠它区分"用户按了暂停"和"真的出错了" */
export class MacUpdatePaused extends Error {
  readonly paused = true;
  constructor() { super('paused'); this.name = 'MacUpdatePaused'; }
}
export function isMacUpdatePaused(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as any).paused === true;
}

// ──────────────────────────────────────────────────────────────
// feed 解析
// ──────────────────────────────────────────────────────────────

/**
 * 解析 electron-builder 生成的 latest-mac.yml。
 *
 * 只需要 version + files[] 三个字段, 结构极其固定, 手写解析避免为此拉一个 yaml 依赖
 * (主进程 bundle 越小越好)。格式:
 *
 *   version: 3.1.1
 *   files:
 *     - url: Neox-3.1.1-arm64.zip
 *       sha512: <base64>
 *       size: 609512160
 */
export function parseLatestMacYml(text: string): { version: string; files: Array<{ url: string; sha512: string; size: number }> } {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const files: Array<{ url: string; sha512: string; size: number }> = [];

  /* 逐条 "- url:" 块往下扫 sha512/size, 遇到下一个 "- url:" 或顶格键结束 */
  const lines = text.split(/\r?\n/);
  let cur: { url: string; sha512: string; size: number } | null = null;
  for (const line of lines) {
    const urlMatch = /^\s*-\s*url:\s*(.+)$/.exec(line);
    if (urlMatch) {
      if (cur?.url) files.push(cur);
      cur = { url: urlMatch[1].trim(), sha512: '', size: 0 };
      continue;
    }
    if (!cur) continue;
    const shaMatch = /^\s+sha512:\s*(.+)$/.exec(line);
    if (shaMatch) { cur.sha512 = shaMatch[1].trim(); continue; }
    const sizeMatch = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (sizeMatch) { cur.size = Number(sizeMatch[1]); continue; }
    /* 顶格键 (path: / releaseDate:) → files 段结束 */
    if (/^\S/.test(line)) { if (cur.url) { files.push(cur); cur = null; } }
  }
  if (cur?.url) files.push(cur);

  return { version, files };
}

function assertAllowedUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Update URL not allowed: ${parsed.hostname}`);
  }
}

/** 拉 latest-mac.yml 并挑出本机 arch 对应的 zip 条目 (zip 才是可解压替换的形态, dmg 不是). */
export async function fetchMacUpdateManifest(timeoutMs = 15_000): Promise<MacUpdateManifest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const res = await fetch(`${FEED_BASE}/latest-mac.yml?t=${Date.now()}`, {
      signal: controller.signal,
      headers: { 'user-agent': `Neox/${app.getVersion()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { version, files } = parseLatestMacYml(text);
  if (!version) throw new Error('latest-mac.yml missing version');

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const entry = files.find((f) => f.url.endsWith('.zip') && f.url.includes(`-${arch}.`));
  if (!entry) throw new Error(`latest-mac.yml has no ${arch} zip (feed 需要包含 zip target)`);
  if (!entry.sha512) throw new Error(`latest-mac.yml entry ${entry.url} missing sha512`);

  const zipUrl = `${FEED_BASE}/${entry.url}`;
  assertAllowedUrl(zipUrl);
  return { version, zipUrl, sha512: entry.sha512, size: entry.size };
}

// ──────────────────────────────────────────────────────────────
// 下载 + 落盘
// ──────────────────────────────────────────────────────────────

function stagingDir(): string {
  return join(app.getPath('temp'), 'neox-mac-update');
}

/* ── 单飞 (single-flight) ────────────────────────────────────────
 *
 *   mac 上有【两条】路径会下载更新, 而且互相不知道对方存在:
 *     1. 后台自动更新   autoUpdate.ts:runMacUpdateCheck  (启动 15s 后 + 每 6h)
 *     2. 用户手动更新   updateHandlers.ts:update:download (设置→关于 里点的)
 *   两边各自维护自己的 in-flight 标志 (macUpdateInFlight / macStagedUpdate),
 *   都是模块内私有的, 拦不住对方。
 *
 *   而 stagingDir() 是【固定路径】, 下载第一步就 rmSync 整个目录 —— 于是后启动的
 *   那个会把先启动的那个正下到一半的 600MB 直接删掉。先跑的当场 ENOENT / sha512
 *   不匹配 → 报错甩到界面上; 后跑的正常完成 → 弹重启框。用户看到的就是
 *   "界面在报错, 但重启之后确实升级成功了"。
 *
 *   修法是把互斥放在这里 —— 这个模块是两条路径唯一的公共依赖。第二个调用者不再
 *   另起一份下载, 而是【汇入】第一个: 共享同一个 Promise, 进度也一起收到。 */
let inFlight: { version: string; promise: Promise<StagedMacUpdate> } | null = null;
let lastStaged: StagedMacUpdate | null = null;
/* 汇入者的进度回调 — 一份下载, 多处显示 */
const progressListeners = new Set<MacUpdateProgress>();

interface DownloadState {
  version: string;
  zipUrl: string;
  sha512: string;
  size: number;
}
let control: { version: string; abort: AbortController; pausing: boolean } | null = null;
/** 用户按了暂停以后留在这儿 —— 「继续」不需要再去 feed 查一遍 */
let pausedManifest: MacUpdateManifest | null = null;

function statePath(): string { return join(stagingDir(), 'download-state.json'); }
function partPathFor(version: string): string { return join(stagingDir(), `Neox-${version}.zip.part`); }

function readDownloadState(): DownloadState | null {
  try {
    const raw = readFileSync(statePath(), 'utf8');
    const s = JSON.parse(raw) as DownloadState;
    if (!s?.version || !s?.zipUrl || !s?.sha512) return null;
    return s;
  } catch { return null; }
}

function partSize(version: string): number {
  try { return statSync(partPathFor(version)).size; } catch { return 0; }
}

/** 暂停当前下载。没有正在下的返回 false。 */
export function pauseMacUpdateDownload(): boolean {
  if (!control) return false;
  control.pausing = true;
  control.abort.abort();
  return true;
}

/** 界面查"现在下到哪了 / 能不能续" —— 冷启动后也能答得上来 (读的是磁盘上的 .part)。 */
export function getMacDownloadState(): {
  active: boolean; paused: boolean; version: string; transferred: number; total: number;
} | null {
  const s = readDownloadState();
  const version = control?.version || pausedManifest?.version || s?.version || '';
  if (!version) return null;
  const transferred = partSize(version);
  if (!control && transferred <= 0) return null;
  return {
    active: !!control && !control.pausing,
    paused: !control && transferred > 0,
    version,
    transferred,
    total: s?.size ?? pausedManifest?.size ?? 0,
  };
}

export function cancelMacUpdateDownload(): void {
  if (control) { control.pausing = false; control.abort.abort(); }
  pausedManifest = null;
  lastStaged = null;
  stagedMarkerChecked = false;   /* 目录都删了, 下次老老实实重新查 */
  rmSync(stagingDir(), { recursive: true, force: true });
}

/** 「继续」—— 拿暂停时留下的 manifest (或磁盘上那份 state) 接着下。 */
export function resumeMacUpdateDownload(onProgress?: MacUpdateProgress): Promise<StagedMacUpdate> | null {
  const m = pausedManifest ?? (() => {
    const s = readDownloadState();
    return s ? { version: s.version, zipUrl: s.zipUrl, sha512: s.sha512, size: s.size } : null;
  })();
  if (!m) return null;
  return downloadAndStageMacUpdate(m, onProgress);
}

function emitProgress(p: Parameters<MacUpdateProgress>[0]): void {
  for (const fn of progressListeners) {
    try { fn(p); } catch { /* 某个监听者抛错不该中断下载 */ }
  }
}

/**
 * 下载 zip → sha512 校验 → ditto 解压 → 校验解出来的 app 版本号。
 * 任何一步不过就抛错并清干净临时目录, 不留半成品。
 *
 * 同版本并发调用会汇入同一次下载 (见上方单飞说明), 不会重复下 600MB, 也不会互删目录。
 */
export async function downloadAndStageMacUpdate(
  manifest: MacUpdateManifest,
  onProgress?: MacUpdateProgress,
): Promise<StagedMacUpdate> {
  const alreadyStaged = await resolveStagedMacUpdate();
  if (alreadyStaged?.version === manifest.version) {
    onProgress?.({ percent: 100, transferred: 0, total: 0, speed: 0 });
    return alreadyStaged;
  }

  if (inFlight) {
    if (onProgress) progressListeners.add(onProgress);
    return inFlight.promise.finally(() => {
      if (onProgress) progressListeners.delete(onProgress);
    });
  }

  if (onProgress) progressListeners.add(onProgress);
  const promise = doDownloadAndStage(manifest)
    .then((staged) => { lastStaged = staged; return staged; })
    .finally(() => {
      inFlight = null;
      progressListeners.clear();
    });
  inFlight = { version: manifest.version, promise };
  return promise;
}

interface StagedMarker { version: string; stagedAppPath: string; verifiedAt: string }

function stagedMarkerPath(): string { return join(stagingDir(), 'staged.json'); }

function writeStagedMarker(staged: StagedMacUpdate): void {
  try {
    const marker: StagedMarker = { ...staged, verifiedAt: new Date().toISOString() };
    writeFileSync(stagedMarkerPath(), JSON.stringify(marker), { mode: 0o600 });
  } catch { /* 写不进去只影响下次启动少一次复用, 本次安装照常 */ }
}

/** 本次进程已经查过盘上的标记 (查不到就不必每次都再 spawn 一次 codesign) */
let stagedMarkerChecked = false;

/** a 是否比 b 新 (1.2.3 逐位比; 任一侧解析不出来都当"不比它新") */
function isNewerVersion(a: string, b: string): boolean {
  const seg = (v: string) => (v.replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/) ?? [0, '0', '0', '0']).slice(1).map(Number);
  const [am, an, ap] = seg(a);
  const [bm, bn, bp] = seg(b);
  return am > bm || (am === bm && (an > bn || (an === bn && ap > bp)));
}

/** 读一个 .app 的 CFBundleShortVersionString, 读不出来返回空串 */
async function readAppVersion(appPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', join(appPath, 'Contents', 'Info.plist')],
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * 拿"已下好、等重启"的那份包: 先看内存, 再看盘上的标记。
 *
 *   拿到标记包时会复核「路径还在 + 版本号对得上 + 签名仍与当前这份同源」——
 *   任一条不过就返回 null (调用方会走完整下载路径, 那边重新校验一切)。
 *   每次进程只做一次这种复核, 之后走内存缓存。
 */
export async function resolveStagedMacUpdate(): Promise<StagedMacUpdate | null> {
  if (lastStaged && existsSync(lastStaged.stagedAppPath)) return lastStaged;
  if (stagedMarkerChecked) return null;

  let marker: StagedMarker | null = null;
  try {
    marker = JSON.parse(readFileSync(stagedMarkerPath(), 'utf8')) as StagedMarker;
  } catch {
    stagedMarkerChecked = true;   /* 没有标记 = 没下好过, 别每次再读一遍 */
    return null;
  }

  try {
    if (!marker.version || !marker.stagedAppPath || !existsSync(marker.stagedAppPath)) return null;
    /* 只认"比当前这份更新"的暂存包。升级装完之后标记还在盘上, 不设这道闸的话每次退出
     * 都会照那条"退出时静默安装"的规矩再把同一个版本替换一遍 (helper 还会再拉起一次 app)。 */
    if (!isNewerVersion(marker.version, app.getVersion())) {
      console.log(`[MacUpdater] 暂存包不新于当前版本 (${marker.version} <= ${app.getVersion()}), 忽略`);
      return null;
    }
    if (await readAppVersion(marker.stagedAppPath) !== marker.version) {
      console.warn('[MacUpdater] 暂存包的版本与标记不符, 忽略:', marker.version);
      return null;
    }
    await verifyStagedSignature(marker.stagedAppPath);
  } catch (e: any) {
    console.warn('[MacUpdater] 暂存包复核未过, 忽略 (下次会重新下载):', e?.message ?? e);
    return null;
  } finally {
    stagedMarkerChecked = true;
  }

  lastStaged = { version: marker.version, stagedAppPath: marker.stagedAppPath };
  return lastStaged;
}

/**
 * 读一个 .app 的签名身份 —— 用于"新包跟当前这份是不是同一个来源"的比对。
 *
 *   返回 null = 读不出来 (codesign 不在 / 不是 bundle / 未签名)。
 */
async function readSigningIdentity(appPath: string): Promise<{ teamId: string; authority: string } | null> {
  try {
    /* codesign 把这些信息打到 stderr, 不是 stdout */
    const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { maxBuffer: 4 * 1024 * 1024 })
      .catch((e: any) => ({ stderr: String(e?.stderr ?? '') }));
    const text = String(stderr ?? '');
    if (!text) return null;
    const teamId = /^TeamIdentifier=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    /* Authority 有多行 (叶子 → 中间 → 根), 第一行是签名者本身 */
    const authority = /^Authority=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    const adhoc = /^Signature=adhoc$/m.test(text);
    if (!teamId && !authority && !adhoc) return null;
    return { teamId: teamId || (adhoc ? 'adhoc' : ''), authority: authority || (adhoc ? 'adhoc' : '') };
  } catch {
    return null;
  }
}

async function verifyStagedSignature(stagedAppPath: string): Promise<void> {
  /* 1) 签名自洽性 —— 内容被动过就验不过 */
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', stagedAppPath], { maxBuffer: 4 * 1024 * 1024 });
  } catch (e: any) {
    throw new Error(`更新包签名校验失败, 已丢弃 (可能在传输或解压中被改动): ${String(e?.stderr ?? e?.message ?? e).slice(0, 200)}`);
  }

  /* 2) 跟当前这份比来源 */
  const current = await readSigningIdentity(app.getAppPath().replace(/\/Contents\/Resources\/app(\.asar)?$/, ''));
  if (!current) return;                       /* 读不出当前身份 → 只保留第 1 条 */
  const staged = await readSigningIdentity(stagedAppPath);
  if (!staged) throw new Error('更新包没有可读的签名信息, 已丢弃');
  if (staged.teamId !== current.teamId || staged.authority !== current.authority) {
    throw new Error(
      `更新包的签名来源跟当前版本不一致, 已丢弃 (当前 ${current.teamId || current.authority || '未知'}, `
      + `包内 ${staged.teamId || staged.authority || '未知'})`,
    );
  }
}

async function doDownloadAndStage(
  manifest: MacUpdateManifest,
): Promise<StagedMacUpdate> {
  const dir = stagingDir();
  mkdirSync(dir, { recursive: true });

  const zipPath = join(dir, `Neox-${manifest.version}.zip`);
  const partPath = partPathFor(manifest.version);

  /* 换版本了 (feed 翻新) → 旧的半成品没用了, 清掉再开始。同版本则保留 .part 续传。 */
  const prev = readDownloadState();
  if (prev && prev.version !== manifest.version) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath(), JSON.stringify({
    version: manifest.version, zipUrl: manifest.zipUrl, sha512: manifest.sha512, size: manifest.size,
  } satisfies DownloadState));

  // ── 下载 (流式落盘; 断点续传靠 Range, sha512 留到下完整份文件再算) ──
  assertAllowedUrl(manifest.zipUrl);
  let already = partSize(manifest.version);
  const abort = new AbortController();
  control = { version: manifest.version, abort, pausing: false };
  pausedManifest = manifest;

  const res = await fetch(manifest.zipUrl, {
    signal: abort.signal,
    headers: {
      'user-agent': `Neox/${app.getVersion()}`,
      ...(already > 0 ? { range: `bytes=${already}-` } : {}),
    },
  }).catch((e) => {
    control = null;
    /* abort 抛的是 AbortError —— 是暂停还是真断网, 只有 pausing 标志分得清 */
    throw (abort.signal.aborted && (e?.name === 'AbortError')) ? new MacUpdatePaused() : e;
  });
  if (!res.ok || !res.body) {
    control = null;
    throw new Error(`下载失败: HTTP ${res.status}`);
  }
  /* 服务端不支持 Range (返回 200 而不是 206) → 之前那半个作废, 从头来。
     不这么判会把新的完整响应追加在旧数据后面, 得到一个长度翻倍的垃圾文件。 */
  if (already > 0 && res.status !== 206) {
    rmSync(partPath, { force: true });
    already = 0;
  }

  const total = already + Number(res.headers.get('content-length') || 0)
    || manifest.size || 0;
  const { createWriteStream } = await import('node:fs');
  const writer = createWriteStream(partPath, { flags: already > 0 ? 'a' : 'w' });
  let writerError: Error | null = null;
  writer.on('error', (e: Error) => { writerError = e; });
  const reader = res.body.getReader();
  let transferred = already;
  const started = Date.now();
  const startedAt = already;
  let lastEmit = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writerError) throw writerError;
      const chunk = Buffer.from(value);
      if (!writer.write(chunk)) {
        /* 等排水的同时盯住错误 —— 只等 'drain' 的话, 写失败时这里会永远挂住 */
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { writer.off('error', onError); resolve(); };
          const onError = (e: Error) => { writer.off('drain', onDrain); reject(e); };
          writer.once('drain', onDrain);
          writer.once('error', onError);
        });
      }
      transferred += chunk.length;

      /* 进度节流到 200ms 一次 — 600MB 包按 chunk 推会把 IPC 打爆 */
      const now = Date.now();
      if (progressListeners.size > 0 && now - lastEmit > 200) {
        lastEmit = now;
        const elapsed = Math.max(0.001, (now - started) / 1000);
        emitProgress({
          percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
          transferred,
          total,
          /* 速度只按**这一程**算 —— 把续传前已有的字节算进去, 显示的就是个假均速 */
          speed: Math.round((transferred - startedAt) / elapsed),
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      /* 错误可能在我们挂监听之前就发完了 (常驻监听者只是把它存下来) —— 不补这一次,
       * 'finish' 永远不会来, 这里会静默挂到天荒地老。 */
      const pendingError: Error | null = writerError;
      if (pendingError) { reject(pendingError); return; }
      writer.once('error', reject);
      writer.once('finish', () => resolve());
      writer.end();
    });
  } catch (e: any) {
    writer.destroy();
    const paused = control?.pausing || (abort.signal.aborted && e?.name === 'AbortError');
    control = null;
    if (paused) {
      /* 暂停: 什么都不删 —— .part 和 state.json 就是续传的全部本钱。
         (取消是另一个入口 cancelMacUpdateDownload, 那个才清目录。) */
      emitProgress({
        percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
        transferred, total, speed: 0, paused: true,
      });
      throw new MacUpdatePaused();
    }
    /* 真出错也**不删** .part: 断网/超时下次进来还能接着下, 这正是续传的意义。
       损坏的情况由下面的 sha512 兜底 —— 对不上会整个丢弃重来。 */
    throw e;
  }
  control = null;

  /* 落到最终文件名, 再整份读一遍算 sha512 (续传过的流没法边下边算) */
  renameSync(partPath, zipPath);
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(zipPath);
    rs.on('data', (c) => hash.update(c));
    rs.once('error', reject);
    rs.once('end', () => resolve());
  });

  // ── 完整性校验 (这是我们的 "签名" — 替代 Squirrel 的 Apple 代码签名校验) ──
  const actual = hash.digest('base64');
  if (actual !== manifest.sha512) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('更新包完整性校验失败 (sha512 不匹配), 已丢弃');
  }
  emitProgress({ percent: 100, transferred, total: total || transferred, speed: 0 });

  // ── 解压 (ditto 保留 mac 的资源分支/符号链接/权限位, unzip 不行) ──
  const extractDir = join(dir, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  try {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir], { maxBuffer: 8 * 1024 * 1024 });
  } catch (dittoErr: any) {
    const msg = String(dittoErr?.stderr || dittoErr?.message || dittoErr);
    console.warn('[MacUpdater] ditto 解压失败, 改用 unzip -o 重试:', msg.slice(0, 300));
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    try {
      await execFileAsync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', extractDir], { maxBuffer: 8 * 1024 * 1024 });
    } catch (unzipErr: any) {
      console.warn('[MacUpdater] unzip 报了非零退出, 交给后续 app/版本校验把关:',
        String(unzipErr?.stderr || unzipErr?.message || unzipErr).slice(0, 300));
    }
  }

  const stagedAppPath = join(extractDir, 'Neox.app');
  if (!existsSync(stagedAppPath)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('更新包解压后没有 Neox.app');
  }

  // ── 校验解出来的确实是目标版本 (防 feed 与产物错配, 避免"更新完还是老版本") ──
  const stagedVersion = await readAppVersion(stagedAppPath);
  if (stagedVersion !== manifest.version) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`更新包版本与 feed 不一致 (包内 ${stagedVersion || '未知'}, feed 声明 ${manifest.version})`);
  }

  try {
    await verifyStagedSignature(stagedAppPath);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  /* zip 已经没用了, 早删省 600MB 磁盘 */
  rmSync(zipPath, { force: true });

  const staged: StagedMacUpdate = { version: manifest.version, stagedAppPath };
  /* 三道校验都过了才写标记 —— 它让这个状态活过重启 (见 resolveStagedMacUpdate) */
  writeStagedMarker(staged);
  return staged;
}

// ──────────────────────────────────────────────────────────────
// 安装 (替换 + 重启)
// ──────────────────────────────────────────────────────────────

/** 当前运行的 .app 绝对路径 — exe 在 <App>.app/Contents/MacOS/Neox, 往上三级. */
export function currentAppBundlePath(): string {
  return dirname(dirname(dirname(app.getPath('exe'))));
}

/**
 * 装之前先问清楚能不能装 — 不能装就在【下载之前】告诉用户去手动下 DMG,
 * 而不是下完 600MB 再失败 (旧 Squirrel 路径就是这么坑的)。
 */
export function canSelfReplace(): { ok: true } | { ok: false; reason: string } {
  const appPath = currentAppBundlePath();
  if (!appPath.endsWith('.app')) return { ok: false, reason: 'not-a-bundle' };
  if (!existsSync(appPath)) return { ok: false, reason: 'bundle-missing' };
  try {
    /* 替换要动的是父目录 (通常 /Applications) 里的条目 → 检父目录写权限 */
    accessSync(dirname(appPath), constants.W_OK);
    accessSync(appPath, constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'not-writable' };
  }
}

/**
 * 生成 detached helper 脚本并启动, 然后退出本进程。
 *
 * helper 做的事 (顺序即回滚保证):
 *   1. 等本进程真正退出 (最多 30s)
 *   2. 旧 app → 同目录 .neox-rollback (同卷 mv, 原子)
 *   3. 新 app ditto 到目标位置
 *   4. 成功 → 删备份 + open 新 app; 失败 → mv 回备份 + open 旧 app
 * 任何一步炸掉用户手里都还有一个能跑的 Neox, 不会出现"更新完 app 没了"。
 */
export interface ApplyScriptSpec {
  targetApp: string;
  rollback: string;
  stagedAppPath: string;
  version: string;
  logPath: string;
  extractedDir: string;
  relaunch?: boolean;
}

/**
 * 生成 apply helper 的 shell 源码。
 *
 * 抽成纯函数是为了能【真的测】替换与回滚 — 这是整条更新链里唯一会动用户已安装 app 的一步,
 * 出错的代价是用户没有 Neox 可用。测试用假 .app 目录跑真脚本, 覆盖成功替换 / 新包损坏回滚
 * / mv 失败三条路径 (见 __tests__/macUpdater.test.ts)。
 */
export function buildApplyScript(spec: ApplyScriptSpec): string {
  const { targetApp, rollback, stagedAppPath, version, logPath, extractedDir } = spec;
  /* relaunch=false 时**每一处** open 都要哑掉, 成功路径和三条回滚路径都算 ——
   * 漏掉任何一条, 用户就会在退出之后看到应用自己跳回来。 */
  const reopen = spec.relaunch === false ? 'true' : `open "${targetApp}" || true`;
  return `#!/bin/bash
# Neox 自更新 apply helper — 由 macUpdater.installStagedMacUpdate 生成, 用完自删.
set -u
exec >>"${logPath}" 2>&1
echo "[$(date)] apply start pid=$$ target=${targetApp}"

PARENT_PID="$1"

# 1. 等主进程退出 (最多 30s)
for _ in $(seq 1 300); do
  kill -0 "$PARENT_PID" 2>/dev/null || break
  sleep 0.1
done
sleep 0.5

# 2. 旧 app 挪到同目录备份位 (同卷 mv, 原子)
rm -rf "${rollback}"
if ! mv "${targetApp}" "${rollback}"; then
  echo "mv old app failed — 放弃更新, 原 app 未动"
  ${reopen}
  exit 1
fi

# 3. 新 app 就位
if ! /usr/bin/ditto "${stagedAppPath}" "${targetApp}"; then
  echo "ditto new app failed — 回滚"
  rm -rf "${targetApp}"
  mv "${rollback}" "${targetApp}"
  ${reopen}
  exit 1
fi

# 4. 自检: 新 app 的可执行文件在不在
if [ ! -x "${targetApp}/Contents/MacOS/Neox" ]; then
  echo "new app missing executable — 回滚"
  rm -rf "${targetApp}"
  mv "${rollback}" "${targetApp}"
  ${reopen}
  exit 1
fi

# 成功: 清备份 + 去掉可能的 quarantine + 重启
rm -rf "${rollback}"
xattr -dr com.apple.quarantine "${targetApp}" 2>/dev/null || true
echo "[$(date)] apply ok → ${version}"
${reopen}

# 清理暂存 (含本脚本自己 — bash 已把脚本读进内存, 删得掉)
rm -rf "${extractedDir}"
exit 0
`;
}

/**
 * 生成 detached helper 脚本并启动, 然后退出本进程。
 *
 * helper 做的事 (顺序即回滚保证):
 *   1. 等本进程真正退出 (最多 30s)
 *   2. 旧 app → 同目录 .neox-rollback (同卷 mv, 原子)
 *   3. 新 app ditto 到目标位置
 *   4. 成功 → 删备份 + open 新 app; 失败 → mv 回备份 + open 旧 app
 * 任何一步炸掉用户手里都还有一个能跑的 Neox, 不会出现"更新完 app 没了"。
 */
/* 这一轮进程里 helper 已经放出去了没有。
 *
 *   两条路都会走到 installStagedMacUpdate: 用户点「立即重启」, 和退出时的静默安装。
 *   而"点重启"那条自己会调 app.quit() —— 于是 before-quit 里的静默安装紧接着又触发一次,
 *   两个 helper 同时抢着 mv 同一个 .app。这个 latch 就是为了那一下。 */
let applyHelperSpawned = false;

export function installStagedMacUpdate(staged: StagedMacUpdate, opts?: { onQuit?: boolean }): boolean {
  if (applyHelperSpawned) return false;
  const onQuit = opts?.onQuit === true;
  const targetApp = currentAppBundlePath();
  const helperPath = join(stagingDir(), 'neox-apply-update.sh');

  const script = buildApplyScript({
    targetApp,
    rollback: `${targetApp}.neox-rollback`,
    stagedAppPath: staged.stagedAppPath,
    version: staged.version,
    logPath: join(stagingDir(), 'apply-update.log'),
    extractedDir: join(stagingDir(), 'extracted'),
    relaunch: !onQuit,
  });

  mkdirSync(stagingDir(), { recursive: true });
  writeFileSync(helperPath, script, 'utf-8');
  chmodSync(helperPath, 0o755);

  const child = spawn('/bin/bash', [helperPath, String(process.pid)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  applyHelperSpawned = true;

  /* 让 helper 拿到 pid 后再退。app.quit() 会走正常清理链 (before-quit 那套). */
  if (!onQuit) setTimeout(() => app.quit(), 300);
  return true;
}

export function readApplyLog(): string | null {
  const p = join(stagingDir(), 'apply-update.log');
  try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; }
}
