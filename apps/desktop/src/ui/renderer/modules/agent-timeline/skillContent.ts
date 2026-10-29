import type { TimelineEntry } from '../../utils/workspaceUtils';
import type { StepContent } from './types';
import { unwrapContextualOutput } from './unwrapToolOutput';
import { getGlobalLanguage } from '../../hooks/useI18n';

/* ---------- content: skill (use_skill / save_skill 富卡) ----------
 * useSkillTool.ts 输出 ContextualResult { metadata: {skillId, skillName, trustLevel, allowedTools, model},
 * content: 全文 markdown }; saveSkillTool.ts 的 metadata 带 description / whenToUse / scope / steps。
 * 这里读 metadata 组结构化 SkillCardView。从 mapTimeline.ts 拆出 (那个文件不能再长)。 */
export function buildSkillContent(entry: TimelineEntry, toolName: string): StepContent | undefined {
  if (toolName !== 'use_skill' && toolName !== 'save_skill') return undefined;
  const unwrapped = unwrapContextualOutput(entry.output);
  if (!unwrapped) return undefined;
  const md = (unwrapped.metadata ?? {}) as Record<string, unknown>;
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (toolName === 'save_skill') {
    const id = s(md.skillId) ?? s(args.id) ?? '';
    if (!id) return undefined;
    return {
      type: 'skill', skillId: id, skillName: s(md.skillName) ?? s(args.name) ?? id, body: '',
      saved: { description: s(md.description), whenToUse: s(md.whenToUse), scope: md.scope === 'workspace' ? 'workspace' : 'user', path: s(md.path), steps: typeof md.steps === 'number' ? md.steps : undefined },
    };
  }
  const skillName = s(md.skillName) ?? s(args.skill) ?? '';
  const skillId = s(md.skillId) ?? skillName;
  if (!skillName && !skillId) return undefined;
  const body = unwrapped.content ?? unwrapped.summary ?? '';
  const trustLevel = md.trustLevel === 'trusted' || md.trustLevel === 'limited' ? md.trustLevel : undefined;
  const allowedTools = Array.isArray(md.allowedTools)
    ? md.allowedTools.filter((t): t is string => typeof t === 'string')
    : undefined;
  return { type: 'skill', skillId, skillName: localizedSkillName(skillId, skillName || skillId), trustLevel, allowedTools, model: s(md.model), body };
}

/* 内置技能的 SKILL.md 名字是英文 (「PPT Deck Writer」), 中文界面录屏里一行英文很扎眼 —— 按 id 给中文名 */
const BUILTIN_ZH: Record<string, string> = {
  animation: '做动画', 'data-chart': '做图表', init: '生成项目说明', 'knowledge-curator': '整理资料库',
  'knowledge-ingest': '存进资料库', 'mini-game': '做小游戏', 'pptx-deck-writer': '做演示稿', review: '代码审查',
  'security-review': '安全审查', simplify: '精简代码', 'skill-creator': '写技能', 'team-requirements': '拆需求',
  'ui-testing': '界面测试', video: '做视频', 'web-data-extraction': '抓网页数据', 'web-page': '做网页',
};
export function localizedSkillName(id: string, name: string): string {
  return getGlobalLanguage() === 'zh' && BUILTIN_ZH[id] && /^[\x20-\x7e]+$/.test(name) ? BUILTIN_ZH[id]! : name;
}

/* 技能 id → 显示名。正在跑的那一步结果还没回来, 参数里只有 id (「正在用技能 · pptx-deck-writer」),
 * 第一次用到时拉一次技能列表记下来, 之后的渲染就是中文名。 */
const skillNames = new Map<string, string>();
let skillNamesLoading = false;
function loadSkillNames(): void {
  if (skillNamesLoading) return;
  skillNamesLoading = true;
  try {
    void (window as any).neox?.skillsList?.()?.then?.((r: any) => {
      const list = Array.isArray(r) ? r : (r?.skills ?? r?.data ?? []);
      for (const s of list) if (s?.id && s?.metadata?.name) skillNames.set(String(s.id), String(s.metadata.name));
    })?.catch?.(() => undefined);
  } catch { /* 非桌面环境 */ }
}

/** 步骤行标题里的技能名: 优先结果里的显示名 (「周报生成」), 参数里通常只有 id (weekly-report) */
export function skillTitleName(entry: TimelineEntry): string {
  const md = unwrapContextualOutput(entry.output)?.metadata as Record<string, unknown> | undefined;
  if (typeof md?.skillName === 'string' && md.skillName) return localizedSkillName(String(md.skillId ?? ''), md.skillName);
  const args = entry.toolArgs as Record<string, unknown> | undefined;
  for (const v of [args?.skill, args?.name, args?.skill_name]) {
    if (typeof v === 'string' && v) {
      loadSkillNames();
      return localizedSkillName(v, skillNames.get(v) ?? v);
    }
  }
  return '';
}
