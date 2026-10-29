
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

type ModeHomeKey = 'work' | 'code' | 'pilot';

/** 模式目录名 —— **固定英文**, 不再跟界面语言走 (见文件头 v2.2)。
 *  中文名只作为 legacy 回退, 让老用户的 工作 / 编码 / 领航 目录继续被找到。 */
const MODE_DIR_NAME: Record<ModeHomeKey, string> = {
  work: 'Work', code: 'Code', pilot: 'Pilot',
};

const LEGACY_MODE_DIR_NAME: Record<ModeHomeKey, string> = {
  work: '工作', code: '编码', pilot: '领航',
};

export function getNeoxUserRoot(): string {
  return join(homedir(), DISTRIBUTION.userRootDirname);
}

/** 下面的老位置迁移 (~/Documents/Neox、~/Neox/work) 都是商业版的历史包袱。别的发行版去搬,
 *  搬走的是商业版用户的文件。 */
const ownsLegacyRoots = (): boolean => DISTRIBUTION.userRootDirname === 'Neox';

/** 已存在的目录优先: 老用户的中文目录和事后改过名的目录, 产出物继续落在原处 (不静默搬文件)。 */
export function getModeHomeDir(mode: ModeHomeKey): string {
  const root = getNeoxUserRoot();
  const preferred = join(root, MODE_DIR_NAME[mode]);
  if (existsSync(preferred)) return preferred;
  const legacy = join(root, LEGACY_MODE_DIR_NAME[mode]);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * v3 搬家后, 老模式目录 → 新模式目录的对照 (只列**老的已不在、新的在**的, 即确实搬走了的)。
 *
 * 会话记录里存的是绝对路径 (workspace_path / task_dir), 目录搬走后它们全部失效:
 * 老任务继续跑时 cwd 不存在。启动迁移拿这张表给库里的路径换前缀 (main.ts)。
 * 老目录还在 (目标已存在被跳过的那种) 就不列 —— 文件还在原处, 路径本来就对。
 */
export function movedLegacyModeHomes(): Array<{ from: string; to: string }> {
  const oldRoot = join(homedir(), 'Documents', 'Neox');
  const out: Array<{ from: string; to: string }> = [];
  if (!ownsLegacyRoots()) return out;
  for (const mode of ['work', 'code', 'pilot'] as const) {
    const to = join(getNeoxUserRoot(), MODE_DIR_NAME[mode]);
    if (!existsSync(to)) continue;
    for (const name of [LEGACY_MODE_DIR_NAME[mode], MODE_DIR_NAME[mode]]) {
      const from = join(oldRoot, name);
      if (!existsSync(from)) out.push({ from, to });
    }
  }
  return out;
}

export function ensureModeHome(mode: ModeHomeKey): string {
  try { migrateDocumentsRootIfNeeded(); } catch { /* 迁移失败不阻塞 */ }
  if (mode === 'work') {
    try { migrateLegacyIfNeeded(); } catch { /* 迁移失败不阻塞 */ }
  }
  const dir = getModeHomeDir(mode);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* 只读盘等极端情况: 落盘时自会报错, 不阻塞 */ }
  return dir;
}

/**
 * v3 一次性静默迁移: ~/Documents/Neox/<模式目录> → ~/Neox/<英文名>。
 *
 * 中文老目录 (工作/编码/领航) 迁移时**顺手改成英文名** —— 用户明确要求产物目录以后都用英文,
 * 只把文件搬到 ~/Neox/工作 等于没解决。匹配时新旧两个中文/英文名都认, 但落点统一是 MODE_DIR_NAME。
 *
 * 目标已存在就跳过 (用户已经在新位置用了, 不合并、不覆盖)。整目录同卷 rename (原子),
 * 失败就留给用户手动处理。老根搬空后收掉; 里面还有别的东西 (用户自己放的) 就不动。
 */
function migrateDocumentsRootIfNeeded(): void {
  const oldRoot = join(homedir(), 'Documents', 'Neox');
  const newRoot = getNeoxUserRoot();
  if (!ownsLegacyRoots() || resolve(newRoot) === resolve(oldRoot) || !existsSync(oldRoot)) return;
  const modes: ModeHomeKey[] = ['work', 'code', 'pilot'];
  for (const mode of modes) {
    const to = join(newRoot, MODE_DIR_NAME[mode]);
    if (existsSync(to)) continue;
    /* 老根里可能叫 工作 (中文) 也可能叫 Work (英文, 切过语言的用户) —— 两个都认 */
    const from = [LEGACY_MODE_DIR_NAME[mode], MODE_DIR_NAME[mode]]
      .map(n => join(oldRoot, n))
      .find(p => existsSync(p));
    if (!from) continue;
    try {
      mkdirSync(newRoot, { recursive: true });
      renameSync(from, to);
    } catch { /* 搬不动就留着 */ }
  }
  try {
    const rest = readdirSync(oldRoot).filter(n => !n.startsWith('.'));
    if (rest.length === 0) rmdirSync(oldRoot);
  } catch { /* ignore */ }
}

/** 一次性静默迁移: 老 ~/Neox/work/ 存在 + 目标 ~/Neox/Work 不存在 → 整个 rename 过去。 */
function migrateLegacyIfNeeded(): void {
  const legacy = join(homedir(), 'Neox', 'work');
  if (!ownsLegacyRoots() || !existsSync(legacy)) return;
  const target = join(getNeoxUserRoot(), MODE_DIR_NAME.work);
  if (resolve(legacy) === resolve(target)) return;
  /* 同 migrateDocumentsRootIfNeeded: 目标存在就跳过, 绝不删。 */
  if (existsSync(target)) return;
  try {
    renameSync(legacy, target);
  } catch { /* 迁不动不阻塞, 用户会看到两处路径, 手动挪即可 */ }
}

/** 用户画像文件路径 (onboarding 勾选场景 / 设置里改都落这里, 跨 workspace 用户级)。 */
export function getUserProfilePath(mode: ModeHomeKey): string {
  return join(homedir(), NEOX_HOME_DIRNAME, `user_profile_${mode}.md`);
}

