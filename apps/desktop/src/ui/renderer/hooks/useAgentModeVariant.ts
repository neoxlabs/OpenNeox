
import { useContext, useMemo } from 'react';
import { getSessionActiveContext } from '../../state/sessionStore';
import { useI18n } from './useI18n';

export type AgentModeValue = 'work' | 'code' | 'pilot';

export interface AgentModeVariant {
  mode: AgentModeValue;
  /** Work 口径的 UI (说人话的时间线、简化输入框) —— Pilot 也算, 它在 Work 之上 */
  isWork: boolean;
  isCode: boolean;
  isPilot: boolean;

  /* Sidebar 分化 */
  hideProjects: boolean;         // Work: 藏 Projects 组头 / workspace 卡 / + All projects —— 只有 Code 讲项目

  /* TopBar 分化 */
  workTitleOverride: string | null; // Work="工作台", Code=null (走原 workspace basename)

  /* Composer 分化 */
  hideModelPicker: boolean;
  simpleModelPicker: boolean;      // Work: 模型选择器展开时藏 effort 4 档 (小白不理解)
  hidePermissionMode: boolean;
  hideContextChip: boolean;
  hideMcpPicker: boolean;
  hideAgenticBadge: boolean;       // 顶部"Agentic"标签 (换成 modeBadgeLabel)
  hideRunDestination: boolean;     // 本地/云端选择
  hideComposerTopRule: boolean;    // Composer 顶部水平细线 (Work 藏, 更简洁)
  modeBadgeLabel: string | null;   // "工作"/"编码" — 换掉 Agentic 显示模式指示
  composerPlaceholder: string | null; // null = 用组件自带 (Code)
  /* Skills dropdown mode 过滤: 返回 skill category 是否在当前模式下可见 */
  isSkillVisibleForMode: (category: string | null | undefined) => boolean;
  /* 设置页 tab 过滤: 返回该 tab 在当前模式下是否显示 */
  isSettingsTabVisible: (tab: string) => boolean;
  /* 设置页组过滤: 该 group 在当前模式下是否显示 (全组隐藏时省个 group 头) */
  isSettingsGroupVisible: (group: string) => boolean;

  /* Timeline 空态 */
  emptyHeadline: string | null;
  emptySubtitle: string | null;
  hideMascot: boolean;             // Work 用轻空态, 不出 3D 猫

  /* 新会话命名 */
  newChatName: (now: Date) => string | null; // null = 用原 "New Chat - HH:MM:SS"
}

/** 会话未启动或未指定 mode 时的回落 = code (保持存量语义); 旧的 assistant 按 work。 */
function normalize(m: string | null | undefined): AgentModeValue {
  if (m === 'pilot') return 'pilot';
  if (m === 'work' || m === 'assistant') return 'work';
  return 'code';
}

/**
 * 判断会话名是否是系统自动生成的默认名 (切模式时可覆盖).
 * 已知格式:
 *   · New Chat / New Chat - HH:MM:SS   → sessionsStore 冷启动
 *   · 新会话                            → 冷启动 zh
 *   · 早上/下午/晚上和 Neox 聊聊 / Chat · Jul 10 → 已删除的 Life 模式留下的老会话名
 *   · 工作·7月10日 / Work · Jul 10       → Work 模式命名
 * 用户手动改过的名 (如"计划台北游") 不匹配, 切模式时保留.
 * 集中于此避免 AgentModeSwitcher / NeoxModePicker 两处正则漂移.
 */
export function isDefaultSessionName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  if (/^New Chat\b/i.test(n)) return true;
  if (n === '新会话') return true;
  if (/^Chat\s·\s\w/.test(n)) return true;
  if (/^Work\s·\s\w/.test(n)) return true;
  if (/^工作·\d+月\d+日$/.test(n)) return true;
  if (/^图片·\d+月\d+日$/.test(n)) return true;       // 图片会话默认名
  if (/^Images\s·\s\w/.test(n)) return true;
  if (/^(早上|下午|晚上)和\s?Neox\s?聊聊$/.test(n)) return true;
  return false;
}

export function useAgentModeVariant(): AgentModeVariant {
  const activeSession = useContext(getSessionActiveContext()) ?? null;
  const ambient = typeof window !== 'undefined' ? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode ?? null : null;
  const isImageSession = (activeSession as { kind?: string } | null)?.kind === 'image';
  const raw = (isImageSession ? null : (activeSession as { agentMode?: string | null } | null)?.agentMode) ?? ambient;
  const mode = normalize(raw);
  /* 用 useI18n 响应式读 isZh — 用户切 UI 语言时 placeholder / 空态文案自动跟随, 不再拿冷冻的 globalLanguage. */
  const { isZh: zh } = useI18n();

  return useMemo<AgentModeVariant>(() => {
    const isPilot = mode === 'pilot';
    const isWork = mode === 'work' || isPilot;
    const isCode = mode === 'code';

    const isSkillVisibleForMode = (category: string | null | undefined): boolean => {
      const cat = (category ?? '').toLowerCase();
      if (isWork) return !['git', 'debug', 'devops', 'test'].includes(cat);
      return true; // code: 全部
    };
    const WORK_HIDDEN_TABS = new Set([
      'orchestrator', 'modelprofile', 'runconfig', 'experimental', 'processes',
      'browser', 'cloud-agent', 'remote', 'agent',
    ]);

    /* Code 路径: 全部标志回落到"跟以前一样"。 */
    if (isCode) {
      return {
        mode, isWork, isCode, isPilot,
        hideProjects: false,
        workTitleOverride: null,
        hideModelPicker: false, simpleModelPicker: false, hidePermissionMode: false, hideContextChip: false,
        hideMcpPicker: false, hideAgenticBadge: false, hideRunDestination: false,
        hideComposerTopRule: false, modeBadgeLabel: null,
        composerPlaceholder: null,
        emptyHeadline: null, emptySubtitle: null, hideMascot: false,
        newChatName: () => null,
        isSkillVisibleForMode,
        isSettingsTabVisible: () => true,
        isSettingsGroupVisible: () => true,
      };
    }

    /* Pilot: Work 的底子, 换人设文案; 会话名由建 Pilot 时起 (联系人名), 不用日期 */
    if (isPilot) {
      return {
        mode, isWork, isCode, isPilot,
        hideProjects: true,
        workTitleOverride: 'Pilot',
        hideModelPicker: false,
        simpleModelPicker: true,
        hidePermissionMode: false,
        hideContextChip: true,
        hideMcpPicker: true,
        hideAgenticBadge: true,
        hideRunDestination: true,
        hideComposerTopRule: true,
        modeBadgeLabel: 'Pilot',
        composerPlaceholder: zh ? '跟它说点什么，或者点电话直接聊' : 'Say something, or tap the phone to talk',
        emptyHeadline: null,
        emptySubtitle: null,
        hideMascot: true,
        newChatName: () => null,
        isSkillVisibleForMode,
        isSettingsTabVisible: (tab: string) => !WORK_HIDDEN_TABS.has(tab),
        isSettingsGroupVisible: () => true,
      };
    }

    return {
      mode, isWork, isCode, isPilot,
      hideProjects: true,
      workTitleOverride: zh ? '工作台' : 'Workspace',
      hideModelPicker: false,
      simpleModelPicker: true,        // 藏 effort 4 档子菜单
      hidePermissionMode: false,
      hideContextChip: false,
      hideMcpPicker: false,
      hideAgenticBadge: true,         // 换成 modeBadgeLabel 显式模式指示
      hideRunDestination: false,
      hideComposerTopRule: true,
      modeBadgeLabel: zh ? '工作' : 'Work',
      composerPlaceholder: zh ? '要改稿、整理数据、写文档，或者让我帮你调研？' : 'Revise text, tidy data, draft a doc, or ask me to research?',
      emptyHeadline: zh ? '今天要处理点什么？' : "What are we working on?",
      emptySubtitle: zh ? '改稿、写报告、拉数据、跟进客户 —— 拿出你手头的活。' : 'Revise drafts, write reports, pull data, follow up on clients — bring your work over.',
      hideMascot: true,
      newChatName: (now) => (zh
        ? `工作·${now.getMonth() + 1}月${now.getDate()}日`
        : `Work · ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })}`),
      isSkillVisibleForMode,
      isSettingsTabVisible: (tab: string) => !WORK_HIDDEN_TABS.has(tab),
      isSettingsGroupVisible: () => true,
    };
  }, [mode, zh]);
}
