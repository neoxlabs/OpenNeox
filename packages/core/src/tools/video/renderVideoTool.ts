import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { findChromeExecutable } from '../../runtime/browser/chromeLauncher.js';

interface RenderVideoArgs {
  html: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  output?: string;
  audio?: string;
  preview_times?: number[];
}

/** ffmpeg 在哪: 安装包自带的 (桌面端主进程把路径放进 NEOX_FFMPEG_PATH), 否则 PATH 上的。都没有返回 null。 */
export function resolveFfmpeg(): string | null {
  const bundled = process.env['NEOX_FFMPEG_PATH'];
  if (bundled) return bundled;
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? 'ffmpeg' : null;
}

const err = (error: string) => JSON.stringify({ status: 'error', error });

/** 在目录里找 headless shell 可执行文件 (playwright 的目录结构随版本变, 按文件名找) */
function findHeadlessShell(dir: string, depth = 0): string | null {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /^(headless_shell|chrome-headless-shell)(\.exe)?$/.test(e.name)) return full;
  }
  if (depth >= 4) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findHeadlessShell(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function ensureRenderBrowser(): Promise<string> {
  const chrome = findChromeExecutable();
  if (chrome) return chrome;
  const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'browsers');
  const existing = findHeadlessShell(dir);
  if (existing) return existing;
  /* cli.js 不在 playwright-core 的 exports 里, 直接 resolve 会被拒; 从 package.json 所在目录拼 */
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: dir },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('download timed out')); }, 15 * 60_000);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`install exited ${code}`)); });
  });
  const installed = findHeadlessShell(dir);
  if (!installed) throw new Error('browser download finished but the executable was not found');
  return installed;
}

function resolveIn(workspace: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

/** 按帧序写进 ffmpeg 的有界并行截帧: 每个 worker 一页, 领下一个帧号, 领先写入点太多就等。 */
async function captureFrames(opts: {
  pages: import('playwright-core').Page[];
  total: number;
  fps: number;
  write: (buf: Buffer) => Promise<void>;
}): Promise<void> {
  const { pages, total, fps, write } = opts;
  const WINDOW = 48;
  const ready = new Map<number, Buffer>();
  let next = 0;
  let written = 0;
  let failed: unknown = null;
  let wake: (() => void) | null = null;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  const waitNudge = () => new Promise<void>((r) => { wake = r; });

  const worker = async (page: import('playwright-core').Page) => {
    while (!failed) {
      while (next - written >= WINDOW && !failed) await waitNudge();
      if (next >= total || failed) return;
      const i = next++;
      try {
        await page.evaluate((t) => (globalThis as any).seek(t), i / fps);
        ready.set(i, await page.screenshot({ type: 'jpeg', quality: 92 }));
      } catch (e) {
        failed = e;
      }
      nudge();
    }
  };

  const writer = async () => {
    while (written < total && !failed) {
      const buf = ready.get(written);
      if (!buf) { await waitNudge(); continue; }
      ready.delete(written);
      await write(buf);
      written++;
      nudge();
    }
  };

  /* 单一唤醒槽会丢通知: 写入方和 worker 都可能在等。用短轮询兜住唤醒竞态, 不影响吞吐 (截一帧 ~50ms)。 */
  const ticker = setInterval(nudge, 20);
  try {
    await Promise.all([...pages.map(worker), writer()]);
  } finally {
    clearInterval(ticker);
  }
  if (failed) throw failed;
}

export const renderVideoTool: Tool = {
  name: 'render_video',
  description: `Render an HTML animation to an MP4 (or GIF) — the way to make explainer videos, animated clips and slideshow videos. Neox runs the browser and the encoder; nothing to install, no scripts to write.

Page contract: the HTML must define \`window.seek(t)\` (t in seconds) that draws the exact frame at time t (it may return a Promise). Do NOT rely on real-time playback, CSS animations running on their own, or requestAnimationFrame timing — everything must be a pure function of t. Size the stage to exactly width×height.

Workflow:
1. Write the page (keep build files under .neox-tmp/ in the workspace).
2. Call with \`preview_times\` (e.g. [0.5, 10, 30, 55]) to get a few still PNGs; look at them and fix layout/subtitles BEFORE rendering.
3. Call once without preview_times to render the final video into the user's folder.

Returns { output, duration, frames, size_bytes, elapsed_ms } or { previews: [png paths] }.`,
  group: 'write',
  timeoutMs: 30 * 60_000,
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'HTML file (absolute or workspace-relative) that defines window.seek(t)' },
      duration: { type: 'number', description: 'Video length in seconds (required for the final render)' },
      fps: { type: 'number', description: 'Frames per second (default 30; GIF is capped at 15)' },
      width: { type: 'number', description: 'Default 1920' },
      height: { type: 'number', description: 'Default 1080' },
      output: { type: 'string', description: '.mp4 or .gif path (absolute or workspace-relative). Put it in the user\'s folder, not .neox-tmp' },
      audio: { type: 'string', description: 'Optional soundtrack / narration file to mux in (trimmed to the video length)' },
      preview_times: { type: 'array', items: { type: 'number' }, description: 'Only render these moments (seconds) as PNG stills for checking — no video' },
    },
    required: ['html'],
  },
  permission: { category: ToolCategory.WRITE, allowInAskMode: false },

  async function(args: RenderVideoArgs): Promise<string> {
    const workspace = getWorkspaceRootFromContext() ?? process.cwd();
    const htmlAbs = resolveIn(workspace, String(args.html || ''));
    try { await fs.access(htmlAbs); } catch { return err(`HTML not found: ${htmlAbs}`); }
    const width = Math.round(Number(args.width) || 1920);
    const height = Math.round(Number(args.height) || 1080);

    let chrome: string;
    try {
      chrome = await ensureRenderBrowser();
    } catch (e: any) {
      return err(`Could not prepare the video renderer (first use downloads it once, needs internet): ${e?.message ?? e}. Tell the user to check the network and try again.`);
    }
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ['--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio'],
    });
    const t0 = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const openPage = async () => {
        const page = await context.newPage();
        await page.goto(pathToFileURL(htmlAbs).href, { waitUntil: 'load' });
        await page.evaluate(() => (globalThis as any).document?.fonts?.ready);
        const ok = await page.evaluate(() => typeof (globalThis as any).seek === 'function');
        if (!ok) throw new Error('The page does not define window.seek(t). Add it: it must draw the exact frame for time t (seconds).');
        return page;
      };

      /* 关键帧预览: 只截几张图给 agent 看 */
      if (Array.isArray(args.preview_times) && args.preview_times.length > 0) {
        const page = await openPage();
        const dir = path.join(workspace, '.neox-tmp', 'video-preview');
        await fs.mkdir(dir, { recursive: true });
        const previews: string[] = [];
        for (const t of args.preview_times.slice(0, 12)) {
          await page.evaluate((s) => (globalThis as any).seek(s), Number(t) || 0);
          const p = path.join(dir, `t_${(Number(t) || 0).toFixed(2)}.png`);
          await page.screenshot({ path: p, type: 'png' });
          previews.push(p);
        }
        return JSON.stringify({ status: 'success', previews, note: 'Look at these stills (readfile) and fix the page before the final render.' });
      }

      const duration = Number(args.duration);
      if (!(duration > 0)) return err('duration (seconds) is required for the final render');
      if (!args.output) return err('output (.mp4 or .gif path) is required for the final render');
      const ffmpeg = resolveFfmpeg();
      if (!ffmpeg) return err('Video encoder is missing from this Neox install. Tell the user to update Neox to the latest version.');

      const outAbs = resolveIn(workspace, args.output);
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      const isGif = /\.gif$/i.test(outAbs);
      const fps = Math.max(1, Math.min(isGif ? 15 : 60, Math.round(Number(args.fps) || (isGif ? 12 : 30))));
      const total = Math.max(1, Math.round(duration * fps));

      const ffArgs = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
      if (args.audio && !isGif) ffArgs.push('-i', resolveIn(workspace, args.audio));
      if (isGif) {
        ffArgs.push('-vf', `scale='min(${width},800)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`);
      } else {
        ffArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
        if (args.audio) ffArgs.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
      }
      ffArgs.push(outAbs);

      const proc = spawn(ffmpeg, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
      const exited = new Promise<number>((resolve) => proc.on('close', (code) => resolve(code ?? -1)));
      const write = (buf: Buffer) => new Promise<void>((resolve, reject) => {
        if (proc.stdin.destroyed) return reject(new Error(`encoder exited: ${stderr}`));
        proc.stdin.write(buf, (e) => (e ? reject(e) : resolve()));
      });

      const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
      const pages = await Promise.all(Array.from({ length: workers }, openPage));
      try {
        await captureFrames({ pages, total, fps, write });
      } finally {
        proc.stdin.end();
      }
      const code = await exited;
      if (code !== 0) return err(`Encoding failed (exit ${code}): ${stderr.trim()}`);
      const st = await fs.stat(outAbs);
      return JSON.stringify({
        status: 'success',
        output: outAbs,
        duration,
        fps,
        frames: total,
        width,
        height,
        size_bytes: st.size,
        elapsed_ms: Date.now() - t0,
      });
    } catch (e: any) {
      return err(String(e?.message ?? e));
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
