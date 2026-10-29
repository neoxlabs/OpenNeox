/* ============================================================
 * 设置档位 — 普通 / 高级
 *
 * 为什么按「行」不按「页」:
 *   反例就在 Agent 策略页里 —— 「Agent 动手前问不问你」是普通人最需要的开关 (删文件、
 *   跑命令归它管), 它旁边躺着 OS 级沙箱、PTY、命令超时上限这些连作者自己都不配的东西。
 *   按页藏, 普通用户为了那一个开关必须切到高级档; 不藏, 他得在 11 个控件里找那一个。
 *   所以: 每一行自己标 advanced, 页面的显隐是结果 —— 一页在普通档下一行都不剩, 导航里
 *   自然就不出现 (整页皆高级的几页直接列在 ADVANCED_ONLY_TABS, 省一次全页试渲染)。
 *
 * 三条铁律 (写在这里, 改这个文件的人必须遵守):
 *   1. 普通档只是**不显示**高级项, 它们照常生效 —— 绝不重置成默认值。
 *   2. 改过任何高级项的老用户, 默认给高级档。否则他打开设置会以为"我配的东西没了"。
 *   3. 档位是设备级偏好 (localStorage), 不跟账号走 —— 跟动效/字号同类。
 *
 * 与「模式」(Life/Work/Code) 正交, 边界划死, 免得两者相乘爆炸:
 *   · 模式管**页**: 这个场景要不要这类功能 (Life 不需要代码索引)
 *   · 档位管**行**: 你想不想看细节
 * ========================================================== */
import { useEffect, useState } from 'react';

export type SettingsLevel = 'basic' | 'advanced';

const KEY = 'neox.settings.level';
const EVENT = 'neox:settings-level-change';

/** 整页都是高级内容的 tab —— 普通档下不出现在导航里。
 *  判据见 shouldBeAdvanced(): 改错会出事 / 必须动用内部名词才能解释 / 只有排障才用。 */
export const ADVANCED_ONLY_TABS = new Set<string>([
  'routing',        // 模型路由 — 多 Provider 故障转移
  'modelprofile',   // 模型适配 — 73 个模型 × 10 个字段
  'orchestrator',   // 子 Agent — 派生模型 / 递归层数
  'experimental',   // 实验功能 — FGTS / PTC 这类术语项
  'context',        // 上下文 — 压缩阈值 + token 占比诊断
  'diagnostics',
  'cloud-agent',    // 云端 Agent — 0 个设置的运行态列表, 入口在输入框「云端」

  'editor',         // 编辑器 — 行内补全模型 + 17 条 IDE 快捷键表, 都是看一眼就不再回来的
  'keymap',         // 快捷键 — 已并进编辑器页, 深链仍可达
  'codeindex',      // 代码索引 — 状态 + 构建/重建/清除, 纯维护动作
  'storage',        // 存储 — 数据库/导入导出/备份, 出事才来
  'tts',            // 语音 — 引擎/密钥/音色/唤醒词/声纹锁。开了输入框才多一个麦克风
  'websearch',      // 联网搜索 — 订阅用户走我们承担的搜索, 要自己配后端+Key 的是 DIY
]);

export function getSettingsLevel(): SettingsLevel {
  if (typeof window === 'undefined') return 'basic';
  try {
    return window.localStorage.getItem(KEY) === 'advanced' ? 'advanced' : 'basic';
  } catch {
    return 'basic';
  }
}

/** 有没有存过档位 —— 没存过才做「老用户自动进高级」的一次性判定 */
export function hasStoredSettingsLevel(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(KEY) !== null;
  } catch {
    return true;
  }
}

export function setSettingsLevel(level: SettingsLevel): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, level); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { level } })); } catch { /* ignore */ }
}

export function useSettingsLevel(): [SettingsLevel, (v: SettingsLevel) => void] {
  const [level, setLevel] = useState<SettingsLevel>(() => getSettingsLevel());
  useEffect(() => {
    const sync = () => setLevel(getSettingsLevel());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);   /* 多窗口 */
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [level, setSettingsLevel];
}

/** 只读版 —— 给 settings-base 那些原子组件用, 它们只需要知道当前档 */
export function useIsAdvancedLevel(): boolean {
  return useSettingsLevel()[0] === 'advanced';
}
