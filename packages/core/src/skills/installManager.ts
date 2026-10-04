/**
 * SkillInstallManager — Skill 安装 / 更新 / 卸载 / 信任管理 (K4-MVP).
 *
 *   职责跟 SkillRegistry 分开:
 *     · SkillRegistry: 加载/查找 (启动期 + 热 refresh)
 *     · SkillInstallManager: lifecycle (install/update/uninstall/trust), 把
 *       元数据持久化到每个 skill 目录下的 `.neox-skill.json`
 *
 *   持久化模型 (per-skill JSON, 不 SQLite — 跟 Neox 现有 config 风格一致, <50 skill 量级):
 *     ~/.neox/skills/<skillId>/
 *       ├── SKILL.md              ← skill 本体
 *       └── .neox-skill.json      ← InstalledSkillMeta (本文件管理)
 *
 *     卸载 = `rm -rf <skillId>/`, 原子操作不需要事务.
 *     列表 = 扫 ~/.neox/skills/(skillId)/.neox-skill.json, <50 个 10ms 内.
 *
 *   trustLevel 策略 (跟 loader.ts deriveDefaultTrustLevel 对齐):
 *     install 默认 'limited' (商店来的不信任), 用户 `neox skill trust <id>` 升级.
 *     loader 会优先读 .neox-skill.json 的 trustLevel 字段 (K2 设计已预留).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SkillSource, SkillTrustLevel } from '@neoxlabs/kernel/skills/types.js';
import { skillRegistry } from './registry.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/* 本地安装的 skill metadata 持久化 schema.
 *   每个 skill 一份, 跟 SKILL.md 同目录. */
export interface InstalledSkillMeta {
  skillId: string;
  /** 安装来源 — 决定 update() 能不能再拉一次 */
  source: {
    type: 'url' | 'github' | 'local';
    /** type='url' / 'github': 远程 URL */
    url?: string;
    /** type='github': branch / tag / SHA. default 'main' */
    ref?: string;
    /** type='local': 原始文件路径 (仅记录, 不监听文件变化) */
    path?: string;
  };
  /** ISO 时间字符串 */
  installedAt: string;
  /** SKILL.md frontmatter 里的 version, 没有就 'unknown' */
  installedVersion: string;
  /** SKILL.md frontmatter 里的 author / 'Neox / Unknown' */
  author?: string;
  /** SKILL.md frontmatter 的 description (前 200 char) */
  description?: string;
  /** K2: 信任级别. install 默认 'limited', `trust` 命令升级到 'trusted' */
  trustLevel: SkillTrustLevel;
  /** ISO 时间, 用户执行 `trust` 的时间; 反映安全审计 */
  trustedAt?: string;
}

export interface InstallOptions {
  /** 覆盖默认 trustLevel. install 默认 'limited', 想强升 trusted 传 'trusted' (跳过 trust 二次操作) */
  trustLevel?: SkillTrustLevel;
  /** 目标位置. 默认 'user' (放 ~/.neox/skills/). 极少 install 到 workspace. */
  target?: 'user' | 'workspace';
  /** workspace 目标时必传, 用来定位 .neox/skills/ */
  workDir?: string;
}

export interface InstallResult {
  success: boolean;
  skillId?: string;
  /** 升级 / 安装 / 已存在等状态 */
  status?: 'installed' | 'already_exists' | 'failed';
  meta?: InstalledSkillMeta;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  skillId: string;
  status?: 'updated' | 'up_to_date' | 'failed';
  previousVersion?: string;
  newVersion?: string;
  error?: string;
}

const META_FILENAME = '.neox-skill.json';

function getUserSkillsDir(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'skills');
}

function getWorkspaceSkillsDir(workDir: string): string {
  return path.join(workDir, '.neox', 'skills');
}

function metaPathFor(skillsDir: string, skillId: string): string {
  return path.join(skillsDir, skillId, META_FILENAME);
}

function readMeta(metaFile: string): InstalledSkillMeta | null {
  try {
    if (!fs.existsSync(metaFile)) return null;
    return JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as InstalledSkillMeta;
  } catch {
    return null;
  }
}

function writeMeta(metaFile: string, meta: InstalledSkillMeta): void {
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

/** 从 SKILL.md 内容里抽 author / version / description 写进 meta. */
function extractMetadataFromSkillMd(content: string): { version: string; author?: string; description?: string } {
  /* 简单解析 YAML frontmatter (跟 loader.ts parseSkillFile 同范式, 不复用是为了
   *  解耦 — loader 输出的是已经 validateMetadata 过的, 这里只要原始字符串). */
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const out: { version: string; author?: string; description?: string } = { version: 'unknown' };
  if (!match) return out;
  const fm = match[1] ?? '';
  for (const line of fm.split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const k = kv[1];
    const v = kv[2].replace(/^["']|["']$/g, '');
    if (k === 'version') out.version = v;
    else if (k === 'author') out.author = v;
    else if (k === 'description') out.description = v.slice(0, 200);
  }
  return out;
}

export interface InstallPreview {
  success: boolean;
  /** 提取的 skill 元信息 — UI 用来在安装前给用户预览 */
  skillId?: string;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  /** SKILL.md 里声明的 allowedTools — 没声明就 [] (用户该提防 limited skill 啥都不能调) */
  allowedTools?: string[];
  /** SKILL.md 字节数, 估算装上后会占多少 token */
  contentLength?: number;
  /** body 前 N 行 (不含 frontmatter) — 给用户看 skill 长啥样 */
  bodyPreview?: string;
  error?: string;
}

export class SkillInstallManager {
  /** preview: 不写盘, 只 fetch + parse, 返 metadata 给 UI 在装之前给用户看.
   *
   *   防呆: 不预览就敢装 = 用户根本不知道 skill 会调什么工具. K2 limited 配合 preview
   *   才是完整安全模型 — 用户先看 allowedTools 觉得合理再装. */
  async preview(url: string): Promise<InstallPreview> {
    let content: string;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
      content = await resp.text();
    } catch (err: any) {
      return { success: false, error: `Download failed: ${err?.message ?? String(err)}` };
    }
    return this.parsePreview(content);
  }

  /** previewLocal: 同 preview 但从本地路径读, 不走网络. CLI 装本地 skill 时用. */
  previewLocal(filePath: string): InstallPreview {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
      const stat = fs.statSync(filePath);
      const skillMdPath = stat.isDirectory() ? path.join(filePath, 'SKILL.md') : filePath;
      if (!fs.existsSync(skillMdPath)) return { success: false, error: `SKILL.md not found at ${skillMdPath}` };
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      return this.parsePreview(content);
    } catch (err: any) {
      return { success: false, error: `Read failed: ${err?.message ?? String(err)}` };
    }
  }

  /** 共用: 从 SKILL.md content 抽 preview 信息 */
  private parsePreview(content: string): InstallPreview {
    const fm = extractMetadataFromSkillMd(content);
    const nameMatch = content.match(/^---[\s\S]*?\nname\s*:\s*(.+?)\n[\s\S]*?\n---/);
    const skillName = nameMatch?.[1]?.replace(/^["']|["']$/g, '').trim();
    if (!skillName) return { success: false, error: 'Invalid SKILL.md: missing name field' };

    /* allowedTools: frontmatter neox.allowedTools 是 YAML list, 提一遍 */
    const allowedTools: string[] = [];
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fmText = fmMatch[1];
      /* 简单匹配 allowedTools: 后跟 - item 行 */
      const atMatch = fmText.match(/allowedTools\s*:\s*\n((?:\s*-\s*\S+\n?)+)/);
      if (atMatch) {
        for (const line of atMatch[1].split('\n')) {
          const m = line.match(/^\s*-\s*(\S+)\s*$/);
          if (m) allowedTools.push(m[1]);
        }
      }
    }

    const skillId = skillName.toLowerCase().trim()
      .replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';

    /* body 前 8 行 (跳过 frontmatter), 给 UI 当 "skill 长啥样" 预览 */
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n([\s\S]*)/);
    const bodyPreview = bodyMatch ? bodyMatch[1].trim().split('\n').slice(0, 8).join('\n') : '';

    return {
      success: true,
      skillId,
      name: skillName,
      version: fm.version,
      author: fm.author,
      description: fm.description,
      allowedTools,
      contentLength: content.length,
      bodyPreview,
    };
  }

  /** install: 从 URL 下载 SKILL.md → 写盘 → 写 .neox-skill.json → 刷新 registry.
   *   url 也支持本地路径 (file:// 或绝对路径 / 相对路径), 自动判断走 fetch 或 fs.readFile. */
  async install(url: string, options: InstallOptions = {}): Promise<InstallResult> {
    const target: 'user' | 'workspace' = options.target ?? 'user';
    if (target === 'workspace' && !options.workDir) {
      return { success: false, status: 'failed', error: 'workDir required when target=workspace' };
    }
    const skillsDir = target === 'user' ? getUserSkillsDir() : getWorkspaceSkillsDir(options.workDir!);

    /* A3: 自动识别 url 是远程还是本地路径. 远程走 fetch, 本地走 fs.readFile. */
    const isLocal = url.startsWith('file://') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
    let content: string;
    let resolvedSourceType: 'url' | 'github' | 'local' = 'url';
    let resolvedPath: string | undefined;
    try {
      if (isLocal) {
        const localPath = url.startsWith('file://') ? url.slice('file://'.length) : path.resolve(url);
        if (!fs.existsSync(localPath)) return { success: false, status: 'failed', error: `File not found: ${localPath}` };
        const stat = fs.statSync(localPath);
        const skillMdPath = stat.isDirectory() ? path.join(localPath, 'SKILL.md') : localPath;
        if (!fs.existsSync(skillMdPath)) return { success: false, status: 'failed', error: `SKILL.md not found at ${skillMdPath}` };
        content = fs.readFileSync(skillMdPath, 'utf-8');
        resolvedSourceType = 'local';
        resolvedPath = skillMdPath;
      } else {
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, status: 'failed', error: `HTTP ${resp.status}: ${resp.statusText}` };
        content = await resp.text();
        resolvedSourceType = url.includes('github.com') ? 'github' : 'url';
      }
    } catch (err: any) {
      return { success: false, status: 'failed', error: `${isLocal ? 'Read' : 'Download'} failed: ${err?.message ?? String(err)}` };
    }

    /* 必须含 frontmatter + name. 解析失败 = 不是合法 SKILL.md, 拒绝写盘. */
    const fm = extractMetadataFromSkillMd(content);
    const nameMatch = content.match(/^---[\s\S]*?\nname\s*:\s*(.+?)\n[\s\S]*?\n---/);
    const skillName = nameMatch?.[1]?.replace(/^["']|["']$/g, '').trim();
    if (!skillName) return { success: false, status: 'failed', error: 'Invalid SKILL.md: missing name field' };

    /* skillId 简单标准化: 小写, 空格→hyphen, 限 [a-z0-9_-]. 跟 registry.generateSkillId 一致. */
    const skillId = skillName.toLowerCase().trim()
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill';

    const skillDir = path.join(skillsDir, skillId);
    if (fs.existsSync(skillDir)) {
      return { success: false, status: 'already_exists', skillId, error: `Skill "${skillId}" already exists. Use 'update' to refresh or 'uninstall' first.` };
    }

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
    } catch (err: any) {
      return { success: false, status: 'failed', error: `Write failed: ${err?.message ?? String(err)}` };
    }

    const trustLevel: SkillTrustLevel = options.trustLevel ?? 'limited';
    const meta: InstalledSkillMeta = {
      skillId,
      source: resolvedSourceType === 'local'
        ? { type: 'local', path: resolvedPath }
        : { type: resolvedSourceType, url },
      installedAt: new Date().toISOString(),
      installedVersion: fm.version,
      author: fm.author,
      description: fm.description,
      trustLevel,
      trustedAt: trustLevel === 'trusted' ? new Date().toISOString() : undefined,
    };
    writeMeta(metaPathFor(skillsDir, skillId), meta);

    /* 让 registry 立即看到新 skill (热 refresh 也会兜底, 但同步刷新更可预测). */
    try {
      await skillRegistry.refresh(options.workDir);
    } catch { /* 刷新失败不影响安装结果 */ }

    return { success: true, status: 'installed', skillId, meta };
  }

  /** update: 同 URL 重新下载, 替换文件; trustLevel 保留 (用户 trust 过的不被回退). */
  async update(skillId: string, opts: { workDir?: string } = {}): Promise<UpdateResult> {
    const meta = this.getMeta(skillId, opts);
    if (!meta) return { success: false, skillId, status: 'failed', error: `Skill not installed: ${skillId}` };
    if (meta.source.type === 'local') {
      return { success: false, skillId, status: 'failed', error: 'Local-imported skill cannot be auto-updated (no remote URL)' };
    }
    if (!meta.source.url) {
      return { success: false, skillId, status: 'failed', error: 'Skill metadata missing source URL' };
    }

    let content: string;
    try {
      const resp = await fetch(meta.source.url);
      if (!resp.ok) return { success: false, skillId, status: 'failed', error: `HTTP ${resp.status}` };
      content = await resp.text();
    } catch (err: any) {
      return { success: false, skillId, status: 'failed', error: `Download failed: ${err?.message ?? String(err)}` };
    }

    const fm = extractMetadataFromSkillMd(content);
    const previousVersion = meta.installedVersion;
    if (fm.version === previousVersion && fm.version !== 'unknown') {
      /* 同版本 — 不写盘 (但仍可能内容微调, 保守起见还是不写). */
      return { success: true, skillId, status: 'up_to_date', previousVersion, newVersion: fm.version };
    }

    const skillsDir = opts.workDir ? getWorkspaceSkillsDir(opts.workDir) : getUserSkillsDir();
    const skillDir = path.join(skillsDir, skillId);
    try {
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
    } catch (err: any) {
      return { success: false, skillId, status: 'failed', error: `Write failed: ${err?.message ?? String(err)}` };
    }

    const newMeta: InstalledSkillMeta = {
      ...meta,
      installedAt: new Date().toISOString(),
      installedVersion: fm.version,
      author: fm.author ?? meta.author,
      description: fm.description ?? meta.description,
      /* trustLevel + trustedAt 保留 — 用户已经信任过, update 不该回退 */
    };
    writeMeta(metaPathFor(skillsDir, skillId), newMeta);

    try { await skillRegistry.refresh(opts.workDir); } catch { /* ignore */ }

    return { success: true, skillId, status: 'updated', previousVersion, newVersion: fm.version };
  }

  /** uninstall: rm -rf <skillId>/. 原子, 不留残. registry 刷新一下. */
  async uninstall(skillId: string, opts: { workDir?: string } = {}): Promise<{ success: boolean; error?: string }> {
    const skillsDir = opts.workDir ? getWorkspaceSkillsDir(opts.workDir) : getUserSkillsDir();
    const skillDir = path.join(skillsDir, skillId);
    if (!fs.existsSync(skillDir)) return { success: false, error: `Skill not found: ${skillId}` };
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
    } catch (err: any) {
      return { success: false, error: `Remove failed: ${err?.message ?? String(err)}` };
    }
    try { await skillRegistry.refresh(opts.workDir); } catch { /* ignore */ }
    return { success: true };
  }

  /** trust: 升级 limited → trusted. 写 .neox-skill.json, loader 下次加载用新 trustLevel. */
  async trust(skillId: string, opts: { workDir?: string } = {}): Promise<{ success: boolean; error?: string }> {
    return this.setTrust(skillId, 'trusted', opts);
  }

  /** untrust: trusted → limited. */
  async untrust(skillId: string, opts: { workDir?: string } = {}): Promise<{ success: boolean; error?: string }> {
    return this.setTrust(skillId, 'limited', opts);
  }

  private async setTrust(skillId: string, level: SkillTrustLevel, opts: { workDir?: string }): Promise<{ success: boolean; error?: string }> {
    const meta = this.getMeta(skillId, opts);
    if (!meta) return { success: false, error: `Skill not installed: ${skillId}` };
    const skillsDir = opts.workDir ? getWorkspaceSkillsDir(opts.workDir) : getUserSkillsDir();
    const newMeta: InstalledSkillMeta = {
      ...meta,
      trustLevel: level,
      trustedAt: level === 'trusted' ? new Date().toISOString() : undefined,
    };
    writeMeta(metaPathFor(skillsDir, skillId), newMeta);
    try { await skillRegistry.refresh(opts.workDir); } catch { /* ignore */ }
    return { success: true };
  }

  /** 单个 skill 的 meta. */
  getMeta(skillId: string, opts: { workDir?: string } = {}): InstalledSkillMeta | null {
    const skillsDir = opts.workDir ? getWorkspaceSkillsDir(opts.workDir) : getUserSkillsDir();
    return readMeta(metaPathFor(skillsDir, skillId));
  }

  /** 扫所有已安装的 skill metadata (仅 ~/.neox/skills/, 不含 builtin / workspace).
   *   workspace skills 也想列时传 workDir, 会合并 user + workspace. */
  listInstalled(opts: { workDir?: string } = {}): InstalledSkillMeta[] {
    const out: InstalledSkillMeta[] = [];
    const dirs = [getUserSkillsDir()];
    if (opts.workDir) dirs.push(getWorkspaceSkillsDir(opts.workDir));
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const meta = readMeta(metaPathFor(dir, entry));
        if (meta) out.push(meta);
      }
    }
    return out;
  }
}

export const skillInstallManager = new SkillInstallManager();

/** 给 SkillRegistry 用的纯函数 — 用 source 决定默认 source 字段 (不写盘, 仅返 object). */
export function buildSourceFromHint(hint: { type?: 'url' | 'github' | 'local'; url?: string; path?: string }): InstalledSkillMeta['source'] {
  if (hint.type === 'local' || hint.path) return { type: 'local', path: hint.path };
  return { type: hint.url?.includes('github.com') ? 'github' : 'url', url: hint.url };
}

/** 从 SkillSource (builtin/user/...) 反推: 这是不是商店装的 skill? */
export function isMarketplaceInstalled(source: SkillSource): boolean {
  return source === 'user' || source === 'marketplace';
}
