import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';
import type { IpcMainInvokeEvent, BrowserWindow as ElectronBrowserWindow } from 'electron';

/* shell / BrowserWindow 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里
 * 加载失败, 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。
 * 极简版用得到的是 file:list / file:read / file:write 这些纯 fs 操作;
 * "在 Finder 里显示"之类真要 shell 的, 调到会拿到一句明确的错。 */
const shell = lazyElectron<typeof import('electron').shell>('shell');
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import * as fs from 'fs/promises';
import * as fsSyncTop from 'node:fs';
import * as osTop from 'node:os';
import { getNeoxArtifactsRoot } from '../services/neoxArtifacts.js';
/* printToPDF 的实现抽到了 services/htmlToPdf —— agent 侧那条路 (worker 反向 RPC) 共用它 */
import { renderHtmlToPdfFile } from '../services/htmlToPdf.js';
import * as pathTop from 'node:path';
import { extname, join } from 'path';
import { execFile, spawn } from 'child_process';
import { createInterface } from 'readline';
import type { ProjectManager } from '../context/ProjectManager.js';
import { validateWorkspacePath, validateAgainstWorkspaceRoots } from './fileEditHandlers.js';
import { makeWorkspaceResolver } from './scopeResolvers.js';
import { storageService } from '../../../platform-electron/storageService.js';
import { requireFilePath, requireString } from './_assertIpcArg.js';
import { sameWorkspace } from '../../shared/workspacePath.node.js';
import { isSensitiveReadPath } from '../../shared/localReadPolicy.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  hasUserApprovedPath,
  listApprovedRoots,
  rememberApprovedRoot,
  rememberUserApprovedPath,
} from './userApprovedPaths.js';
import { getRgPath } from '../util/rgBinary.js';
import { recoverRenamedTaskPath } from './recoverRenamedTaskPath.js';
import { openPathWithFallback } from './openPathFallback.js';

/* 本地文件日志 — 给 surface:list-external-apps 等 main 进程操作落盘.
 *   console.log 在 Electron main 的 stdout 经常看不到 (混在 npm/vite 输出 + Electron 自身日志),
 *   写文件最稳, 用户 tail -f ~/.neox/logs/surface-discovery.log 实时看. */
const SURFACE_LOG_FILE = pathTop.join(osTop.homedir(), NEOX_HOME_DIRNAME, 'logs', 'surface-discovery.log');
const SURFACE_LOG_MAX_BYTES = 4 * 1024 * 1024;
let _surfaceLogEnsured = false;
let _surfaceLogWrites = 0;
function surfaceLogEnabled(): boolean {
  const raw = String(process.env.NEOX_DIAG_LOG ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'all' || raw === 'true') return true;
  return raw.split(/[,\s]+/).includes('surface-discovery');
}
function surfaceLog(tag: string, msg: string): void {
  if (!surfaceLogEnabled()) return;
  try {
    if (!_surfaceLogEnsured) {
      fsSyncTop.mkdirSync(pathTop.dirname(SURFACE_LOG_FILE), { recursive: true });
      _surfaceLogEnsured = true;
    }
    /* 每 200 次量一回就够 —— 这条日志写得不频繁, 不值得每行 stat */
    if (_surfaceLogWrites++ % 200 === 0) {
      try {
        if (fsSyncTop.statSync(SURFACE_LOG_FILE).size > SURFACE_LOG_MAX_BYTES) {
          fsSyncTop.renameSync(SURFACE_LOG_FILE, `${SURFACE_LOG_FILE}.old`);
        }
      } catch { /* 文件还不存在 */ }
    }
    fsSyncTop.appendFileSync(SURFACE_LOG_FILE, `${new Date().toISOString()} [${tag}] ${msg}\n`, { mode: 0o600 });
  } catch { /* swallow */ }
}

type SurfaceCapability = 'read' | 'write';
type ExternalAppEntry = { id: string; name: string; exists: boolean; appPath?: string };

const MAC_EXTERNAL_APP_CANDIDATES: Array<{ id: string; name: string; keywords: string[]; exts: string[] }> = [
  { id: 'wps', name: 'WPS Office', keywords: ['wps'], exts: ['xlsx','xls','csv','tsv','docx','doc','pdf','pptx','ppt','rtf','txt'] },
  { id: 'msword', name: 'Microsoft Word', keywords: ['microsoft word'], exts: ['docx','doc','rtf'] },
  { id: 'msexcel', name: 'Microsoft Excel', keywords: ['microsoft excel'], exts: ['xlsx','xls','csv','tsv'] },
  { id: 'msppt', name: 'Microsoft PowerPoint', keywords: ['microsoft powerpoint'], exts: ['pptx','ppt'] },
  { id: 'numbers', name: 'Numbers', keywords: ['numbers'], exts: ['xlsx','xls','csv','tsv','numbers'] },
  { id: 'pages', name: 'Pages', keywords: ['pages'], exts: ['docx','doc','pages','rtf','txt'] },
  { id: 'keynote', name: 'Keynote', keywords: ['keynote'], exts: ['pptx','ppt','key'] },
  { id: 'preview', name: '预览', keywords: ['preview'], exts: ['pdf','png','jpg','jpeg','heic','gif','tiff','bmp','webp'] },
  { id: 'acrobat', name: 'Adobe Acrobat', keywords: ['adobe acrobat'], exts: ['pdf'] },
  { id: 'pdfexpert', name: 'PDF Expert', keywords: ['pdf expert'], exts: ['pdf'] },
  { id: 'skim', name: 'Skim', keywords: ['skim'], exts: ['pdf'] },
  { id: 'libreoffice', name: 'LibreOffice', keywords: ['libreoffice','libre office'], exts: ['xlsx','xls','csv','tsv','docx','doc','pptx','ppt','odt','ods','odp','rtf'] },
  { id: 'openoffice', name: 'OpenOffice', keywords: ['openoffice','open office'], exts: ['xlsx','xls','csv','tsv','docx','doc','pptx','ppt','odt','ods','odp'] },
  { id: 'onlyoffice', name: 'ONLYOFFICE', keywords: ['onlyoffice'], exts: ['xlsx','xls','csv','tsv','docx','doc','pptx','ppt'] },
  { id: 'vscode', name: 'Visual Studio Code', keywords: ['visual studio code'], exts: ['md','mdx','txt','json','yaml','yml','toml','xml','csv','tsv','log','ts','tsx','js','jsx','py','go','rs','java','c','cpp','h','hpp','rb','php','sh','sql','html','css','scss'] },
  { id: 'cursor', name: 'Cursor', keywords: ['cursor'], exts: ['md','mdx','txt','json','yaml','yml','toml','ts','tsx','js','jsx','py','go','rs'] },
  { id: 'typora', name: 'Typora', keywords: ['typora'], exts: ['md','mdx','markdown','txt'] },
  { id: 'obsidian', name: 'Obsidian', keywords: ['obsidian'], exts: ['md','mdx','markdown'] },
  { id: 'sublime', name: 'Sublime Text', keywords: ['sublime text'], exts: ['md','txt','json','yaml','yml','toml','xml','ts','tsx','js','py','go','rs'] },
  { id: 'photoshop', name: 'Adobe Photoshop', keywords: ['adobe photoshop','photoshop'], exts: ['png','jpg','jpeg','psd','tiff','bmp','webp','gif','heic'] },
  { id: 'pixelmator', name: 'Pixelmator Pro', keywords: ['pixelmator pro','pixelmator'], exts: ['png','jpg','jpeg','tiff','bmp','webp','gif'] },
  { id: 'affinity', name: 'Affinity Photo', keywords: ['affinity photo'], exts: ['png','jpg','jpeg','tiff','bmp','webp'] },
];

const WIN_EXTERNAL_APP_CANDIDATES: Array<{ id: string; name: string; paths: string[]; exts: string[] }> = [
  { id: 'wps', name: 'WPS Office', exts: ['xlsx','xls','csv','tsv','docx','doc','pdf','pptx','ppt'],
    paths: ['C:\\Program Files\\Kingsoft\\WPS Office\\office6\\wps.exe',
            'C:\\Program Files (x86)\\Kingsoft\\WPS Office\\office6\\wps.exe',
            `${process.env.LOCALAPPDATA}\\Kingsoft\\WPS Office\\office6\\wps.exe`] },
  { id: 'msword', name: 'Microsoft Word', exts: ['docx','doc'],
    paths: ['C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
            'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE'] },
  { id: 'msexcel', name: 'Microsoft Excel', exts: ['xlsx','xls','csv','tsv'],
    paths: ['C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
            'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE'] },
  { id: 'acrobat', name: 'Adobe Acrobat', exts: ['pdf'],
    paths: ['C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe'] },
];

function normalizeAbsoluteInput(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath required');
  }
  const normalizedInput = pathTop.normalize(filePath);
  if (!pathTop.isAbsolute(normalizedInput)) {
    throw new Error('filePath must be absolute');
  }
  return pathTop.resolve(normalizedInput);
}

function normalizeForCompare(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function isPathInside(base: string, target: string): boolean {
  const resolvedBase = normalizeForCompare(pathTop.resolve(base));
  const resolvedTarget = normalizeForCompare(pathTop.resolve(target));
  if (resolvedBase === resolvedTarget) return true;
  const rel = pathTop.relative(resolvedBase, resolvedTarget);
  return !!rel && !rel.startsWith('..') && !pathTop.isAbsolute(rel);
}

async function realpathOrResolve(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return pathTop.resolve(filePath);
  }
}

async function findExistingParent(filePath: string): Promise<{ path: string; stat: fsSyncTop.Stats }> {
  let current = pathTop.dirname(filePath);
  for (;;) {
    try {
      return { path: current, stat: await fs.lstat(current) };
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      const next = pathTop.dirname(current);
      if (next === current) throw err;
      current = next;
    }
  }
}

function discoverExternalAppsForPath(filePath: string): ExternalAppEntry[] {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  surfaceLog('list-external-apps', `ext=${ext} platform=${process.platform}`);
  const apps: ExternalAppEntry[] = [
    { id: '__default__', name: '系统默认 app', exists: true },
  ];

  if (process.platform === 'darwin') {
    const homeDir = osTop.homedir();
    const dirs = ['/Applications', `${homeDir}/Applications`];
    const installedBundles: Array<{ lowerName: string; fullPath: string }> = [];
    for (const dir of dirs) {
      try {
        const entries = fsSyncTop.readdirSync(dir);
        surfaceLog('scan-dir', `${dir} -> ${entries.length} entries`);
        let appsInDir = 0;
        for (const e of entries) {
          const name = String(e);
          if (!name.toLowerCase().endsWith('.app')) continue;
          installedBundles.push({ lowerName: name.toLowerCase().replace(/\.app$/, ''), fullPath: pathTop.join(dir, name) });
          appsInDir++;
        }
        surfaceLog('scan-dir', `${dir} -> ${appsInDir} .app bundles`);
      } catch (err) {
        surfaceLog('scan-dir', `${dir} -> FAIL: ${(err as any)?.message}`);
      }
    }
    surfaceLog('all-bundles', JSON.stringify(installedBundles.map(b => b.lowerName)));

    for (const c of MAC_EXTERNAL_APP_CANDIDATES) {
      if (c.exts.length > 0 && !c.exts.includes(ext)) continue;
      const hit = installedBundles.find(b => c.keywords.some(k => b.lowerName.includes(k)));
      surfaceLog('match', `${c.id} keywords=${JSON.stringify(c.keywords)} -> ${hit ? hit.lowerName : '(no hit)'}`);
      apps.push({
        id: c.id,
        name: c.name,
        exists: !!hit,
        appPath: hit?.fullPath,
      });
    }
  } else if (process.platform === 'win32') {
    for (const c of WIN_EXTERNAL_APP_CANDIDATES) {
      if (c.exts.length > 0 && !c.exts.includes(ext)) continue;
      const existsAt = c.paths.find(p => p && fsSyncTop.existsSync(p));
      apps.push({ id: c.id, name: c.name, exists: !!existsAt, appPath: existsAt });
    }
  }

  return apps;
}

interface RegisterFileSystemIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerFileSystemIpcHandlers(options: RegisterFileSystemIpcHandlersOptions): void {
  const workspaceOf = makeWorkspaceResolver(options.projectManager);

  function getValidatedPath(event: IpcMainInvokeEvent, filePath: string): string {
    const workspacePath = workspaceOf(event);
    if (!workspacePath) {
      throw new Error('No workspace set');
    }
    return validateAgainstWorkspaceRoots(
      workspacePath,
      filePath,
      storageService.getWorkspaceRootsSync(workspacePath) || [],
    );
  }

  /** 多根工作区: 本窗口工作区的全部根 (primary 首位)。单根=[primary]。 */
  function rootsFor(event: IpcMainInvokeEvent): string[] {
    const primary = workspaceOf(event);
    if (!primary) return [];
    return storageService.getWorkspaceRootsSync(primary);
  }

  /** 用户曾在本机打开过的全部 Neox 工程根 (含多根) — 仅 Surface *读* 放行.
   *  窗口切到别的 workspace 时, 会话仍绑定旧工程的文件预览不应红字拒载. */
  function knownProjectRoots(): string[] {
    try {
      const state = storageService.getCachedUIState();
      const primaries = (state?.workspaces || []).map((w) => w.path).filter(Boolean);
      const out: string[] = [];
      const seen = new Set<string>();
      for (const primary of primaries) {
        for (const root of storageService.getWorkspaceRootsSync(primary)) {
          const resolved = pathTop.resolve(root);
          if (!seen.has(resolved)) {
            seen.add(resolved);
            out.push(resolved);
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function surfaceBasePaths(
    event: IpcMainInvokeEvent,
    capability: SurfaceCapability,
    extraRoots: string[] = [],
  ): string[] {
    const bases = [
      ...rootsFor(event),
      /* 本窗口内会话/Surface 显式绑定过的根 */
      ...listApprovedRoots(event?.sender),
      /* 调用方传入的会话 workspace (viewer / openSurface 带下来) */
      ...extraRoots,
      /* 读: 放行所有已登记工程 — 用户已信任过这些目录加入 Neox */
      ...(capability === 'read' ? knownProjectRoots() : []),
      osTop.tmpdir(),
      ...(process.platform !== 'win32' ? ['/tmp'] : []),
      ...(process.platform === 'darwin' ? ['/private/tmp'] : []),
      getNeoxArtifactsRoot(),
    ].map(p => pathTop.resolve(p));
    return Array.from(new Set(bases));
  }

  function normalizeExtraRoots(raw?: string | string[]): string[] {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .filter((p): p is string => typeof p === 'string' && p.length > 0 && pathTop.isAbsolute(p))
      .map((p) => pathTop.resolve(pathTop.normalize(p)));
  }

  async function resolveSurfacePath(
    event: IpcMainInvokeEvent,
    filePath: string,
    capability: SurfaceCapability,
    extraRoots: string[] = [],
  ): Promise<string> {
    const resolvedPath = normalizeAbsoluteInput(filePath);
    const userApproved = hasUserApprovedPath(event?.sender, resolvedPath, capability);
    const rawAllowedBases = surfaceBasePaths(event, capability, extraRoots);
    const realAllowedBases = await Promise.all(rawAllowedBases.map(base => realpathOrResolve(base)));
    const allowedBases = Array.from(new Set([...rawAllowedBases, ...realAllowedBases]));
    const allowedByBase = allowedBases.some(base => isPathInside(base, resolvedPath));
    const home = osTop.homedir();
    const readAnywhere = capability === 'read' && !isSensitiveReadPath(resolvedPath, home, process.platform);
    if (!userApproved && !allowedByBase && !readAnywhere) {
      throw new Error('surface file access denied: path is outside workspace, temp, or a user-approved file');
    }
    const existing = await fs.lstat(resolvedPath).catch((err: any) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (existing?.isSymbolicLink()) {
      throw new Error('surface file access denied: symbolic links are not allowed');
    }
    if (capability === 'read' && existing && !existing.isFile()) {
      throw new Error(existing.isDirectory()
        ? 'path is a directory (not a regular file)'
        : 'not a regular file');
    }
    if (capability === 'write' && existing && !existing.isFile()) {
      throw new Error(existing.isDirectory()
        ? 'path is a directory (not a regular file)'
        : 'not a regular file');
    }
    let containmentProbe = resolvedPath;
    if (existing) {
      containmentProbe = await fs.realpath(resolvedPath);
    } else if (capability === 'write') {
      const parent = await findExistingParent(resolvedPath);
      if (parent.stat.isSymbolicLink()) {
        throw new Error('surface file access denied: symbolic links are not allowed');
      }
      if (!parent.stat.isDirectory()) {
        throw new Error('parent is not a directory');
      }
      const realParent = await fs.realpath(parent.path);
      containmentProbe = pathTop.join(realParent, pathTop.relative(parent.path, resolvedPath));
    }
    if (capability === 'read' && isSensitiveReadPath(containmentProbe, home, process.platform)) {
      throw new Error('surface file access denied: sensitive file (keys / credentials)');
    }
    if (!userApproved && !readAnywhere && !allowedBases.some(base => isPathInside(base, containmentProbe))) {
      throw new Error('surface file access denied: resolved path is outside workspace or temp');
    }
    return resolvedPath;
  }

  ipcMain.handle('file:read', async (event, filePath: string) => {
    try {
      requireFilePath(filePath);
      const absolutePath = getValidatedPath(event, filePath);
      const content = await fs.readFile(absolutePath, 'utf-8');
      return { success: true, content };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /**
   * surface:read-file — Surface viewer 专用读取.
   *   允许: 当前窗口 workspace roots、本窗口会话绑定根、已登记 Neox 工程 (只读)、
   *   系统临时目录、dialog/显式批准路径, 以及 options.workspacePath 提示根.
   * 限制: 绝对路径 + 不超过 8 MB + 文本编码.
   */
  ipcMain.handle('surface:read-file', async (
    event,
    filePath: string,
    options?: { encoding?: 'utf-8' | 'base64'; workspacePath?: string | string[]; ifChangedSince?: number },
  ) => {
    try {
      const extraRoots = normalizeExtraRoots(options?.workspacePath);
      /* 打开预览即绑定: 会话 workspace 记入本窗口, 后续切工程也不红字 */
      for (const root of extraRoots) {
        rememberApprovedRoot(event?.sender, root);
      }
      const resolvedPath = recoverRenamedTaskPath(await resolveSurfacePath(event, filePath, 'read', extraRoots)) ?? filePath; // 老会话指向已改名的任务文件夹: 找回现在的位置
      /* 成功读过的文件也记一下 — 即使工程列表被清, 仍可继续预览 */
      rememberUserApprovedPath(event?.sender, resolvedPath, 'read');
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        return {
          success: false,
          error: stats.isDirectory()
            ? 'path is a directory (not a regular file)'
            : 'not a regular file',
        };
      }
      if (typeof options?.ifChangedSince === 'number' && options.ifChangedSince === stats.mtimeMs) {
        return { success: true, unchanged: true, mtimeMs: stats.mtimeMs };
      }
      const MAX = 8 * 1024 * 1024;
      if (stats.size > MAX) {
        return { success: false, error: `file too large: ${stats.size} > ${MAX}` };
      }
      /* encoding: utf-8 (default, 文本 viewer 用) / base64 (二进制 viewer 用, 如 SheetSurfaceViewer 解 .xlsx) */
      const encoding: 'utf-8' | 'base64' = options?.encoding === 'base64' ? 'base64' : 'utf-8';
      const content = await fs.readFile(resolvedPath, encoding);
      return { success: true, content, mtimeMs: stats.mtimeMs, encoding };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:remember-access — 打开 Surface / Agent 触达文件时预批准路径与工作区根.
   *   用户无感: 不弹窗; 仅本窗口 webContents 生命周期内有效.
   */
  ipcMain.handle('surface:remember-access', async (
    event,
    payload?: { path?: string; root?: string | string[]; capability?: 'read' | 'write' },
  ) => {
    try {
      const capability = payload?.capability === 'write' ? 'write' : 'read';
      if (payload?.path) {
        rememberUserApprovedPath(event?.sender, payload.path, capability);
      }
      for (const root of normalizeExtraRoots(payload?.root)) {
        rememberApprovedRoot(event?.sender, root);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * export:html-to-pdf — 任意 HTML 渲染成 PDF 写盘.
   *   用 Electron 自带 Chromium (BrowserWindow.printToPDF) — 零外部依赖, 跨平台,
   *   字体/CSS/中文 渲染 1:1 (浏览器引擎). docx/xlsx/md 都先转 html 再走这条路统一导.
   *
   *   options:
   *     - pageSize: 'A4' (默认) | 'A3' | 'Letter' | 'Legal'
   *     - landscape: false
   *     - margins: { top, bottom, left, right } in inches
   *     - printBackground: true (默认)
   *
   *   savePath 必须绝对路径; 父目录缺自动建.
   */
  ipcMain.handle('export:html-to-pdf', async (
    event,
    html: string,
    savePath: string,
    options?: {
      pageSize?: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';
      landscape?: boolean;
      margins?: { top?: number; bottom?: number; left?: number; right?: number };
    },
  ) => {
    if (!html || typeof html !== 'string') {
      return { success: false, error: 'html required' };
    }
    /* 隐藏 BrowserWindow 渲染 HTML → printToPDF → 写盘.
     * 关键: webPreferences.nodeIntegration=false + offscreen 减开销.
     * 用 loadURL data:text/html;base64,... 比 loadFile 简单 (不用 tmpfile). */
    try {
      const resolvedSavePath = await resolveSurfacePath(event, savePath, 'write');
      return await renderHtmlToPdfFile({
        html,
        savePath: resolvedSavePath,
        pageSize: options?.pageSize,
        landscape: options?.landscape,
        margins: options?.margins,
      });
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:open-external — Surface viewer "用外部 app 打开" 按钮.
   *   shell.openPath 让 OS 用用户默认 app 启动文件 (WPS/Word/Excel/Numbers/Acrobat...).
   *   跟 surface:read-file 复用同一套 workspace/tmp/dialog-approved 路径边界.
   *   只接绝对路径; 不传递参数到 app, 不执行代码 — 安全性等同于双击文件.
   */
  ipcMain.handle('surface:open-external', async (event, filePath: string) => {
    try {
      const targetPath = (typeof filePath === 'string' ? recoverRenamedTaskPath(filePath) : null) ?? filePath;
      const isDir = typeof targetPath === 'string' && pathTop.isAbsolute(targetPath) && (await fs.stat(targetPath).catch(() => null))?.isDirectory();
      const resolvedPath = isDir ? pathTop.resolve(pathTop.normalize(targetPath)) : await resolveSurfacePath(event, targetPath, 'read');
      const err = await openPathWithFallback(resolvedPath);
      if (err) return { success: false, error: err };
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:list-external-apps — 按文件扩展名返回适用的外部 app 列表 + 是否已安装.
   *   mac: 查 /Applications/{app}.app + ~/Applications/{app}.app 存在
   *   windows: 简化为只返"系统默认", 不检测具体 app (注册表查询复杂, fallback OK)
   *   linux: 同 windows
   *
   *   返 [{ id, name, exists }]. 第一项永远是系统默认 (shell.openPath).
   */
  ipcMain.handle('surface:list-external-apps', async (event, filePath: string) => {
    surfaceLog('list-external-apps', `IPC called, filePath=${filePath}`);
    try {
      const resolvedPath = await resolveSurfacePath(event, filePath, 'read');
      const apps = discoverExternalAppsForPath(resolvedPath);
      surfaceLog('list-external-apps', `RESULT: ${apps.length} apps, installed=[${apps.filter(a => a.exists && a.id !== '__default__').map(a => a.id).join(',') || '(none)'}]`);
      return {
        success: true,
        apps: apps.map(({ id, name, exists }) => ({ id, name, exists })),
      };
    } catch (error: any) {
      surfaceLog('list-external-apps', `THROWN: ${error?.message || String(error)} stack=${error?.stack || ''}`);
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:open-with — 用指定 app 打开文件.
   *   mac: open -a "Microsoft Excel" <file>
   *   windows: start "" "C:\path\app.exe" <file>
   *   appPath 参数保留旧 preload 兼容, main 进程会忽略并按 appId 自行解析已安装路径.
   */
  ipcMain.handle('surface:open-with', async (event, filePath: string, appId: string, _appPath?: string) => {
    try {
      const resolvedPath = await resolveSurfacePath(event, filePath, 'read');
      if (!appId || appId === '__default__') {
        const err = await openPathWithFallback(resolvedPath);
        if (err) return { success: false, error: err };
        return { success: true };
      }
      const appPath = discoverExternalAppsForPath(resolvedPath).find(app => app.id === appId && app.exists)?.appPath;
      if (!appPath) return { success: false, error: `${appId} not installed`, notInstalled: true };
      if (process.platform === 'darwin') {
        /* open -a "AppName" file. 用 appPath 也可以, open -a 接 .app bundle. */
        execFile('open', ['-a', appPath, resolvedPath], (e: any) => {
          if (e) console.error('[surface:open-with]', e);
        });
        return { success: true };
      } else if (process.platform === 'win32') {
        /* start "" "C:\path\app.exe" file — start 需要 cmd shell wrapper */
        spawn('cmd.exe', ['/c', 'start', '""', appPath, resolvedPath], { detached: true, stdio: 'ignore' }).unref();
        return { success: true };
      } else {
        /* linux: 直接 exec app file */
        spawn(appPath, [resolvedPath], { detached: true, stdio: 'ignore' }).unref();
        return { success: true };
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:copy-file — 把产物另存到用户选的位置 (视频/图片「下载」按钮).
   *   源走 surface 读边界, 目标走写边界 (dialog:save-file 选过的路径已预批准)。
   *   不用 surface:read-file + surface:write-file 传 base64: 那条路读盘上限 8MB, 一段视频就超了。
   */
  ipcMain.handle('surface:copy-file', async (event, srcPath: string, destPath: string) => {
    try {
      /* 老会话的产物路径可能已经失效 (任务改名 / 产物根搬家), 先找回现在的位置 */
      const recoveredSrc = recoverRenamedTaskPath(typeof srcPath === 'string' ? srcPath : '') ?? srcPath;
      const resolvedSrc = await resolveSurfacePath(event, recoveredSrc, 'read');
      const resolvedDest = await resolveSurfacePath(event, destPath, 'write');
      if (pathTop.resolve(resolvedSrc) === pathTop.resolve(resolvedDest)) return { success: true, path: resolvedDest };
      await fs.mkdir(pathTop.dirname(resolvedDest), { recursive: true });
      await fs.copyFile(resolvedSrc, resolvedDest);
      return { success: true, path: resolvedDest };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  /**
   * surface:write-file — Surface viewer 反向写盘 (SheetSurfaceViewer 自动 save 用).
   *   跟 surface:read-file 对称, 仅允许 workspace/tmp/dialog-approved 路径.
   *   限制: 绝对路径 + content 大小 8 MB 上限 + utf-8 或 base64 写.
   */
  ipcMain.handle('surface:write-file', async (
    event,
    filePath: string,
    content: string,
    options?: { encoding?: 'utf-8' | 'base64'; workspacePath?: string | string[] },
  ) => {
    try {
      if (typeof content !== 'string') {
        return { success: false, error: 'content must be string (utf-8 or base64)' };
      }
      const MAX = 8 * 1024 * 1024;
      /* base64 byte size ≈ content.length * 3 / 4; 用估算就行不严格 */
      if (content.length > MAX * 2) {
        return { success: false, error: `content too large: ~${content.length}B > ${MAX * 2}B` };
      }
      const encoding: 'utf-8' | 'base64' = options?.encoding === 'base64' ? 'base64' : 'utf-8';
      const extraRoots = normalizeExtraRoots(options?.workspacePath);
      for (const root of extraRoots) {
        rememberApprovedRoot(event?.sender, root);
      }
      const resolvedPath = await resolveSurfacePath(event, filePath, 'write', extraRoots);
      await fs.writeFile(resolvedPath, content, encoding);
      rememberUserApprovedPath(event?.sender, resolvedPath, 'write');
      const stats = await fs.stat(resolvedPath);
      return { success: true, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('surface:patch-xlsx', async (
    event,
    filePath: string,
    sheet: string | undefined,
    edits: Array<{ cell: string; value?: string | number | boolean | null; formula?: string }>,
    options?: { workspacePath?: string | string[] },
  ) => {
    try {
      if (!Array.isArray(edits)) return { success: false, error: 'edits must be an array' };
      if (edits.length === 0) return { success: true, changes: [], skipped: [] };
      if (edits.length > 20000) return { success: false, error: `too many edits: ${edits.length}` };
      const extraRoots = normalizeExtraRoots(options?.workspacePath);
      for (const root of extraRoots) {
        rememberApprovedRoot(event?.sender, root);
      }
      const resolvedPath = await resolveSurfacePath(event, filePath, 'write', extraRoots);
      if (!/\.(xlsx|xlsm)$/i.test(resolvedPath)) return { success: false, error: 'only .xlsx / .xlsm can be patched in place' };
      const { patchXlsxFile } = await import('@neoxlabs/core/tools/runtimeTools.js');
      const r = await patchXlsxFile(resolvedPath, typeof sheet === 'string' && sheet ? sheet : undefined, edits, { overwriteFormulas: true });
      rememberUserApprovedPath(event?.sender, resolvedPath, 'write');
      const stats = await fs.stat(resolvedPath);
      return { success: true, changes: r.changes, skipped: r.skipped, written: r.written, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('file:write', async (event, filePath: string, content: string) => {
    try {
      requireFilePath(filePath);
      requireString(content, 'content', { maxLen: 50 * 1024 * 1024, allowEmpty: true, noNull: false });
      const absolutePath = getValidatedPath(event, filePath);
      await fs.writeFile(absolutePath, content, 'utf-8');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    'file:list',
    async (
      event,
      dirPath: string,
      _pattern?: string,
      options?: { showHidden?: boolean; withMtime?: boolean }
    ) => {
      try {
        const absoluteDirPath = getValidatedPath(event, dirPath);
        const entries = await fs.readdir(absoluteDirPath, { withFileTypes: true });
        const showHidden = options?.showHidden === true;
        const result = entries
          .filter(entry => showHidden || !entry.name.startsWith('.'))
          .map(entry => ({
            name: entry.name,
            path: join(absoluteDirPath, entry.name),
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
            mtime: undefined as number | undefined,
          }))
          .sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
          });
        if (options?.withMtime === true && result.length <= 3000) {
          await Promise.all(result.map(async (f) => {
            try {
              const st = await fs.stat(f.path);
              f.mtime = st.mtimeMs;
            } catch { /* 坏软链等 stat 失败 → 该项无 mtime, 排序按 0 */ }
          }));
        }
        return { success: true, files: result };
      } catch (error: any) {
        return { success: false, error: error.message, files: [] };
      }
    }
  );

  ipcMain.handle('file:stat', async (event, filePath: string) => {
    try {
      requireFilePath(filePath);
      const absolutePath = getValidatedPath(event, filePath);
      const stats = await fs.stat(absolutePath);
      return {
        success: true,
        stats: {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          mtime: stats.mtime.getTime(),
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('file:read-data-url', async (event, filePath: string) => {
    try {
      const absolutePath = getValidatedPath(event, filePath);
      const buffer = await fs.readFile(absolutePath);
      const ext = extname(absolutePath).toLowerCase();
      const mime = ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.avif': 'image/avif',
      } as Record<string, string>)[ext] || 'application/octet-stream';
      return {
        success: true,
        dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64'),
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
  // ==================== 全局搜索 ====================

  const SEARCH_IGNORE = [
    'node_modules', '.git', 'dist', 'build', 'out', '.next',
    'coverage', '__pycache__', 'target', 'vendor', '.DS_Store',
  ];

  /**
   * 内容搜索 — ripgrep
   */
  ipcMain.handle('file:search-content', async (
    event,
    query: string,
    options?: { caseSensitive?: boolean; regex?: boolean; filePattern?: string; maxResults?: number },
  ) => {
    const roots = rootsFor(event);
    if (roots.length === 0) return { success: false, error: 'No workspace', matches: [] };
    if (!query.trim()) return { success: true, matches: [] };

    const maxResults = options?.maxResults ?? 500;
    const caseSensitive = options?.caseSensitive ?? false;
    const useRegex = options?.regex ?? false;

    try {
      const rgBin = await getRgPath();
      const opts = { caseSensitive, useRegex, filePattern: options?.filePattern, maxResults };
      if (roots.length === 1) {
        // 单根: 行为完全不变 (相对路径)
        const results = await runRipgrepSearch(rgBin, roots[0], query, opts);
        return { success: true, matches: results };
      }
      // 多根: 逐根搜, 命中的 file 转绝对路径 (跨根去歧义 + 可直接打开), 汇总封顶
      const all: Array<{ file: string; line: number; column: number; text: string; matchStart: number; matchEnd: number }> = [];
      for (const root of roots) {
        if (all.length >= maxResults) break;
        const res = await runRipgrepSearch(rgBin, root, query, { ...opts, maxResults: maxResults - all.length });
        for (const m of res) all.push({ ...m, file: join(root, m.file) });
      }
      return { success: true, matches: all };
    } catch (error: any) {
      // Fallback: grep (只对 primary, 极少触发)
      try {
        const results = await runGrepFallback(roots[0], query, { caseSensitive, maxResults });
        return { success: true, matches: results };
      } catch (grepError: any) {
        return { success: false, error: `rg: ${error.message}; grep: ${grepError.message}`, matches: [] };
      }
    }
  });

  /**
   * 文件名搜索
   */
  ipcMain.handle('file:search-files', async (
    event,
    pattern: string,
    options?: { maxResults?: number },
  ) => {
    const roots = rootsFor(event);
    if (roots.length === 0) return { success: false, error: 'No workspace', files: [] };
    if (!pattern.trim()) return { success: true, files: [] };

    const maxResults = options?.maxResults ?? 200;

    try {
      const rgBin = await getRgPath();
      if (roots.length === 1) {
        const files = await runFileSearch(rgBin, roots[0], pattern, maxResults);
        return { success: true, files };
      }
      // 多根: 逐根搜文件名, 转绝对路径汇总
      const all: Array<{ file: string; type: 'file' | 'directory' }> = [];
      for (const root of roots) {
        if (all.length >= maxResults) break;
        const res = await runFileSearch(rgBin, root, pattern, maxResults - all.length);
        for (const f of res) all.push({ ...f, file: join(root, f.file) });
      }
      return { success: true, files: all };
    } catch (error: any) {
      return { success: false, error: error.message, files: [] };
    }
  });

  /**
   * semantic:list-files —— 一次性列出工作区所有文件，给 Command Palette 用。
   *
   * 为什么需要这个：
   *   - file:search-files 必须传 pattern，内部会 substring 过滤；我们不要过滤，
   *     要把全量文件拉回 renderer 让我们自己的 FuzzyMatcher 做更精细的排序
   *   - 返回的是相对 workspace 的路径（跟 IDEA Project View 展示一致）
   *
   * 性能：一个 10K 文件的仓库，rg --files + IPC 传输 ~100ms
   */
  ipcMain.handle('semantic:list-files', async (
    event,
    options?: { maxResults?: number },
  ) => {
    const roots = rootsFor(event);
    if (roots.length === 0) return { success: false, error: 'No workspace', files: [] };

    const maxResults = options?.maxResults ?? 50_000;

    try {
      const rgBin = await getRgPath();
      if (roots.length === 1) {
        const files = await runListAllFiles(rgBin, roots[0], maxResults);
        return { success: true, files };
      }
      // 多根: 逐根列全量, 转绝对路径汇总 (Cmd+P 跨根; 渲染端按 basename 模糊匹配)
      const all: string[] = [];
      for (const root of roots) {
        if (all.length >= maxResults) break;
        const files = await runListAllFiles(rgBin, root, maxResults - all.length);
        for (const f of files) all.push(join(root, f));
      }
      return { success: true, files: all };
    } catch (error: any) {
      return { success: false, error: error.message, files: [] };
    }
  });

  /**
   * Streaming ripgrep — uses spawn + readline to process matches as they come.
   * Stops early once maxResults is hit (kills process).
   */
  function runRipgrepSearch(
    rgBin: string,
    cwd: string,
    query: string,
    opts: { caseSensitive: boolean; useRegex: boolean; filePattern?: string; maxResults: number },
  ): Promise<Array<{ file: string; line: number; column: number; text: string; matchStart: number; matchEnd: number }>> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        '--json',
        '--max-count', '50',         // max matches per file
        '--max-filesize', '2M',
        '--max-columns', '500',      // truncate long lines
        '--color', 'never',
        '--no-heading',
        '--no-messages',             // suppress permission errors
        '--mmap',                    // memory-mapped IO for speed
      ];

      if (!opts.caseSensitive) args.push('--ignore-case');
      if (!opts.useRegex) args.push('--fixed-strings');

      for (const ig of SEARCH_IGNORE) args.push('--glob', `!${ig}`);
      if (opts.filePattern) args.push('--glob', opts.filePattern);

      args.push('--', query, '.');

      const child = spawn(rgBin, args, {
        cwd,
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const matches: Array<{ file: string; line: number; column: number; text: string; matchStart: number; matchEnd: number }> = [];
      let killed = false;
      const killChild = () => {
        if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch {} }
      };

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (matches.length >= opts.maxResults) { killChild(); return; }
        if (!line) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match' && obj.data) {
            const d = obj.data;
            const filePath = typeof d.path === 'object' ? d.path.text : d.path;
            const cleanPath = filePath?.replace(/^\.\//, '') || '';
            const lineText = typeof d.lines === 'object' ? d.lines.text : (d.lines || '');
            const submatches = d.submatches || [];
            const firstMatch = submatches[0] || { start: 0, end: 0 };

            matches.push({
              file: cleanPath,
              line: d.line_number || 0,
              column: (firstMatch.start || 0) + 1,
              text: (lineText || '').replace(/\n$/, '').slice(0, 500),
              matchStart: firstMatch.start || 0,
              matchEnd: firstMatch.end || 0,
            });

            if (matches.length >= opts.maxResults) killChild();
          }
        } catch { /* skip */ }
      });

      child.on('error', (err) => { rl.close(); reject(err); });
      child.on('close', () => { rl.close(); resolve(matches); });

      // Hard timeout
      const timer = setTimeout(killChild, 20_000);
      child.on('close', () => clearTimeout(timer));
    });
  }

  /** grep fallback when ripgrep is unavailable */
  function runGrepFallback(
    cwd: string,
    query: string,
    opts: { caseSensitive: boolean; maxResults: number },
  ): Promise<Array<{ file: string; line: number; column: number; text: string; matchStart: number; matchEnd: number }>> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-rn'];
      if (!opts.caseSensitive) args.push('-i');
      for (const ig of SEARCH_IGNORE) {
        args.push(`--exclude-dir=${ig}`);
      }
      args.push('--', query, '.');

      execFile('grep', args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000,
      }, (error, stdout) => {
        if (error && !stdout) { reject(error); return; }

        const matches: Array<{ file: string; line: number; column: number; text: string; matchStart: number; matchEnd: number }> = [];
        const lines = (stdout || '').split('\n');

        for (const line of lines) {
          if (matches.length >= opts.maxResults) break;
          // grep output: ./file:linenum:text
          const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
          if (!m) continue;
          const [, file, lineStr, text] = m;
          const lineNum = parseInt(lineStr, 10);
          const lowerText = opts.caseSensitive ? text : text.toLowerCase();
          const lowerQuery = opts.caseSensitive ? query : query.toLowerCase();
          const idx = lowerText.indexOf(lowerQuery);
          matches.push({
            file,
            line: lineNum,
            column: idx >= 0 ? idx + 1 : 1,
            text: text.slice(0, 500),
            matchStart: Math.max(0, idx),
            matchEnd: idx >= 0 ? idx + query.length : 0,
          });
        }

        resolve(matches);
      });
    });
  }

  /**
   * 列出工作区内所有文件（尊重 SEARCH_IGNORE / .gitignore）。
   * 用 ripgrep --files，路径返回是相对 cwd 的。
   */
  function runListAllFiles(
    rgBin: string,
    cwd: string,
    maxResults: number,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['--files', '--color', 'never'];
      for (const ig of SEARCH_IGNORE) {
        args.push('--glob', `!${ig}`);
      }
      args.push('.');

      execFile(rgBin, args, {
        cwd,
        maxBuffer: 50 * 1024 * 1024, // 50MB，10 万文件的路径 ~5MB
        timeout: 15_000,
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      }, (error, stdout) => {
        if (error && !stdout) { reject(error); return; }

        const files: string[] = [];
        const lines = (stdout || '').split('\n');
        for (const line of lines) {
          if (files.length >= maxResults) break;
          const trimmed = line.trim().replace(/^\.\//, '');
          if (!trimmed) continue;
          files.push(trimmed);
        }
        resolve(files);
      });
    });
  }

  function runFileSearch(
    rgBin: string,
    cwd: string,
    pattern: string,
    maxResults: number,
  ): Promise<Array<{ file: string; type: 'file' | 'directory' }>> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['--files', '--color', 'never'];
      for (const ig of SEARCH_IGNORE) {
        args.push('--glob', `!${ig}`);
      }
      args.push('.');

      execFile(rgBin, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10_000,
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      }, (error, stdout) => {
        if (error && !stdout) { reject(error); return; }

        const lowerPattern = pattern.toLowerCase();
        const files: Array<{ file: string; type: 'file' | 'directory' }> = [];
        const lines = (stdout || '').split('\n');

        for (const line of lines) {
          if (files.length >= maxResults) break;
          const trimmed = line.trim().replace(/^\.\//, '');
          if (!trimmed) continue;
          if (trimmed.toLowerCase().includes(lowerPattern)) {
            files.push({ file: trimmed, type: 'file' });
          }
        }

        resolve(files);
      });
    });
  }
}
