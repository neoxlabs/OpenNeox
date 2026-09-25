
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

type ModeHomeKey = 'work' | 'code';

/** 人类可读的模式目录名 —— 直接进 Finder 展示给用户, 所以跟界面语言走。 */
const MODE_DIR_NAME: Record<'zh' | 'en', Record<ModeHomeKey, string>> = {
  zh: { work: '工作', code: '编码' },
  en: { work: 'Work', code: 'Code' },
};

/** 只读 config.json 的 language 字段 —— 不走 loadConfig: 这是 boot 极早期会调的路径 helper,
 *  不该触发 config 的迁移/写盘, 也避开潜在模块环。读不到按 zh (跟 config 默认一致)。 */
function currentLang(): 'zh' | 'en' {
  try {
    const raw = readFileSync(join(homedir(), NEOX_HOME_DIRNAME, 'config.json'), 'utf8');
    return (JSON.parse(raw) as { language?: string }).language === 'en' ? 'en' : 'zh';
  } catch { return 'zh'; }
}

/** Neox 用户产出物根目录 · macOS 惯例: 走 Documents。 */
export function getNeoxUserRoot(): string {
  return join(homedir(), 'Documents', 'Neox');
}

/** 已存在的目录优先于"当前语言该叫什么": 老用户和事后切语言的用户, 产出物继续落在原目录。 */
export function getModeHomeDir(mode: ModeHomeKey): string {
  const root = getNeoxUserRoot();
  const lang = currentLang();
  const preferred = join(root, MODE_DIR_NAME[lang][mode]);
  if (existsSync(preferred)) return preferred;
  const legacy = join(root, MODE_DIR_NAME[lang === 'zh' ? 'en' : 'zh'][mode]);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/** 确保模式 home 存在 (幂等, 失败静默)。Work 顺带静默迁移 v1 老路径下的产物。 */
export function ensureModeHome(mode: ModeHomeKey): string {
  const dir = getModeHomeDir(mode);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* 只读盘等极端情况: 落盘时自会报错, 不阻塞 */ }
  if (mode === 'work') {
    try { migrateLegacyIfNeeded(); } catch { /* 迁移失败不阻塞 */ }
  }
  return dir;
}

/** 一次性静默迁移: 老 ~/Neox/work/ 存在 + 新目录还没内容 → 整个 rename 过去。 */
function migrateLegacyIfNeeded(): void {
  const legacy = join(homedir(), 'Neox', 'work');
  if (!existsSync(legacy)) return;
  const target = getModeHomeDir('work');
  try {
    /* 新目录里已有内容 = 用户已经在新位置用了, 不动老的, 让用户自己决定要不要合并 */
    if (readdirSync(target).filter(n => !n.startsWith('.')).length > 0) return;
    rmdirSync(target);
    renameSync(legacy, target);
    const legacyRoot = join(homedir(), 'Neox');
    try {
      if (readdirSync(legacyRoot).length === 0) rmdirSync(legacyRoot);
    } catch { /* ignore */ }
  } catch { /* 迁不动不阻塞, 用户会看到两处路径, 手动挪即可 */ }
}

/** 用户画像文件路径 (onboarding 勾选场景 / 设置里改都落这里, 跨 workspace 用户级)。 */
export function getUserProfilePath(mode: ModeHomeKey): string {
  return join(homedir(), NEOX_HOME_DIRNAME, `user_profile_${mode}.md`);
}

