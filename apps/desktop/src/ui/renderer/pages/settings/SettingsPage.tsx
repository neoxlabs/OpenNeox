import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { createPortal } from 'react-dom';
import type { ProviderConfig, ProviderProtocol, UserLanguage, StorageInfo, StorageFileInfo, UsageSummary, ProviderUsageStats, TokenUsageRecord, HealthCheckRequest, ProviderHealth, HealthRecord, HealthStatus, ModelRouteConfig, ModelRoutingConfig, RoutingStrategy } from '../../../shared/ipc';
import Icons from '../../components/Icons';
import { useAppStore, THEME_PRESETS } from '../../../state/appStore';
import { useI18n, setGlobalLanguage } from '../../hooks/useI18n';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { useSettingsLevel, hasStoredSettingsLevel, setSettingsLevel, ADVANCED_ONLY_TABS } from '../../state/settingsLevel';
import { CustomSelect } from '../../components/CustomSelect';
import {
  getNormalizedModelOptionsByProtocol,
  searchNormalizedModelOptions,
  normalizeModelId,
  type ProtocolModelOption,
} from '@neoxlabs/core/models/protocolModels';
import { SettingsContext } from './SettingsContext';
import { isProviderHealthCheckSkipped } from './providerHealthPrefs';
import { PROVIDER_HEALTH_UPDATED_EVENT, restartProviderHealthScheduler } from '../../state/providerHealthScheduler';
import { SettingTip } from './SettingTip';
import Markdown from '../../components/Markdown';
import { getContextSnapshot, useContextSnapshot } from '../../state/contextSnapshot';
/* 账号 / 会员 / 云端用量走发行版能力钩子与插槽 —— 公开构建里没有账户、订阅两页 */
import {
  getEditionHook, useEditionMembership as useMembership, useEditionMembershipStatus as useMembershipStatus,
  useCloudAgentAvailable,
} from '../../modules/shell/editionHooks';
import { UiSlot } from '../../modules/shell/uiSlots';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../shared/neoxCloud';
import { useNotifyConfig } from '../../state/notifyStore';
import { getDocumentParseMode, setDocumentParseMode, type DocumentParseMode } from '../../services/documentParseClient';
import { clearByokPinned, isByokPinned, setByokPinned } from '../../state/byokPickerPrefs';
import { confirmAsync } from '../../components/confirmEvents';
import { FeedbackNavRow } from './FeedbackNavRow';
import { dispatchHint, dispatchOpFailed, dispatchOpFailedFromError } from '../../components/notifyEvents';
import { useTimelineDensityPreference } from '../../modules/agent-timeline/timelinePreferences';
import { setApprovalMode as applyApprovalMode, preloadApprovalModeDefault } from '../../modules/agent-timeline/approvalModeStore';
import type { TimelineDensity } from '../../modules/agent-timeline/types';
import { syncWinTitleBar } from '../../utils/winTitleBarSync';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';

/* Tab 表单 → channels[]: 每 Tab {apiKey, protocol, models?, baseUrl?}。清洗掉无 key/无协议的 Tab。
 * 只在 >1 个 Tab 时返回 channels (单 Tab = 扁平字段, 不落 channels, 向后兼容)。 */
export function tabsToChannels(
  tabs: Array<{ protocol: string; apiKey: string; models?: string[]; baseUrl?: string }>,
): Array<{ apiKey: string; protocol: any; models?: string[]; baseUrl?: string }> | undefined {
  const cleaned = tabs
    .filter(t => t.protocol && t.protocol.trim() && t.apiKey && t.apiKey.trim())
    .map(t => ({
      apiKey: t.apiKey.trim(),
      protocol: t.protocol as any,
      models: t.models?.length ? t.models : undefined,
      baseUrl: t.baseUrl?.trim() || undefined,
    }));
  return cleaned.length > 1 ? cleaned : undefined;
}

// ==================== Lazy-loaded tab components ====================
const LazyProvidersTab = lazy(() => import('./tabs/ProvidersTab'));
const LazyRoutingTab = lazy(() => import('./tabs/RoutingTab'));
const LazyOrchestratorTab = lazy(() => import('./tabs/OrchestratorTab'));
const LazyAgentTab = lazy(() => import('./tabs/AgentTab'));
const LazyWebSearchTab = lazy(() => import('./tabs/WebSearchTab'));
const LazyCodeIndexTab = lazy(() => import('./tabs/CodeIndexTab'));
const LazyConversationTab = lazy(() => import('./tabs/ConversationTab'));
const LazyMcpTab = lazy(() => import('./tabs/McpTab'));
const LazySkillsTab = lazy(() => import('./tabs/SkillsTab'));
const LazyMemoryTab = lazy(() => import('./tabs/MemoryTab'));
import { usePluginCapability } from '../../hooks/usePluginCapability';const LazyBrowserTab = lazy(() => import('./tabs/BrowserTab'));
const LazyGithubTab = lazy(() => import('./tabs/GithubTab'));
const LazyContextTab = lazy(() => import('./tabs/ContextTab'));
/* LazyRemoteTab 删除 — 原 "远程访问" 是 v1 占位 (Coming Soon, 服务端没接入),
 * 新的 MobileBridge tab (lazy 在下面) 是它的真实施 + 升级 (Mobile App 配套). */
const LazyThemeTab = lazy(() => import('./tabs/ThemeTab'));
const LazyStorageTab = lazy(() => import('./tabs/StorageTab'));
const LazyModelProfileTab = lazy(() => import('./tabs/ModelProfileTab'));
const LazyAboutTab = lazy(() => import('./tabs/AboutTab'));
const LazyDiagnosticsTab = lazy(() => import('./tabs/DiagnosticsTab'));
const LazyShareTab = lazy(() => import('./tabs/ShareTab'));
const LazyProcessesTab = lazy(() => import('./tabs/ProcessesTab'));
const LazyTtsTab = lazy(() => import('./tabs/TtsTab'));
const LazyProfileTab = lazy(() => import('./tabs/ProfileTab'));
const LazyExperimentalTab = lazy(() => import('./tabs/ExperimentalTab'));
/* Perception tab 已从 UI 移除 (无后端 handler/消费方); LazyPerceptionTab 不再挂载。 */
const LazyRunconfigTab = lazy(() => import('./tabs/RunconfigTab'));
const LazyMobileBridgeTab = lazy(() => import('./tabs/MobileBridgeTab'));
const LazyCloudAgentTab = lazy(() => import('./tabs/CloudAgentTab'));
const LazyEditorTab = lazy(() => import('./tabs/EditorTab'));
/* 「我的账户」「订阅与账单」是发行版的页 (edition/), 经 settings.tab.* 插槽挂进来 (同样懒加载)。
 * 没有账号体系的构建里这两页不存在, 默认落点改成「个人信息」。 */
const ACCOUNT_ONLY_TABS = new Set<string>(['account', 'subscription']);
const homeTab = (): SettingsTab => (getEditionHook('hasAccount') ? 'account' : 'profile');
const LazyUsageTab = lazy(() => import('./tabs/UsageTab'));
const LazyNotifyTab = lazy(() => import('./tabs/NotifyTab'));
const LazyPetTab = lazy(() => import('./tabs/PetTab'));

const TabLoadingFallback = () => (
  <div className="settings-loading" style={{ padding: '40px', textAlign: 'center', opacity: 0.5 }}>
    <Icons.Loader />
  </div>
);

// ==================== 设置页面菜单项类型 ====================
type SettingsTab = 'conversation' | 'account' | 'subscription' | 'providers' | 'routing' | 'orchestrator' | 'agent' | 'websearch' | 'codeindex' | 'modelprofile' | 'mcp' | 'skills' | 'memory' | 'browser' | 'context' | 'general' | 'theme' | 'storage' | 'usage' | 'about' | 'processes' | 'tts' | 'profile' | 'experimental' | 'runconfig' | 'editor' | 'keymap' | 'mobile' | 'cloud-agent' | 'notify' | 'pet' | 'github' | 'diagnostics' | 'share';

const SETTINGS_SEARCH_INDEX: Array<{ tab: SettingsTab; zh: string; en: string; kw: string; anchor?: string }> = [
  /* 功能级直达项 (带 anchor, 点了滚到具体区块并高亮), 放最前优先展示 */
  { tab: 'conversation', zh: '字号', en: 'Font size', kw: '字体 字号 大小 放大 缩小 font size 太小 看不清 对话区', anchor: 'setting-timeline-font' },
  { tab: 'conversation', zh: '行间距', en: 'Line spacing', kw: '行距 行间距 间距 疏密 line height spacing 挤', anchor: 'setting-timeline-line-height' },
  { tab: 'conversation', zh: '显示密度', en: 'Density', kw: '密度 极简 debug density 折叠 工具细节', anchor: 'setting-timeline-density' },
  { tab: 'websearch', zh: '联网搜索', en: 'Web Search', kw: '联网 搜索 web search 网络 博查 bocha serper 谷歌 google 搜索引擎', anchor: 'setting-web-search' },
  { tab: 'codeindex', zh: '代码索引', en: 'Code Index', kw: '索引 index 代码索引 符号 symbol 检索 embedding 仓库 排除 exclude' },
  { tab: 'experimental', zh: '文件检查点 / 回滚', en: 'File Checkpoint / Rollback', kw: '检查点 checkpoint 文件回滚 rollback shadow git 撤销文件', anchor: 'setting-checkpoint' },
  { tab: 'account', zh: '我的账户', en: 'My Account', kw: '登录 logout 邮箱 email 身份 账号' },
  { tab: 'subscription', zh: '订阅', en: 'Subscription', kw: '套餐 plan pro ultra 会员 billing 付费' },
  { tab: 'usage', zh: '用量', en: 'Usage', kw: 'token 统计 花费 cost 额度 quota 消耗' },
  { tab: 'theme', zh: '语言', en: 'Language', kw: '语言 language 中文 english 界面语言', anchor: 'setting-language' },
  { tab: 'pet', zh: '选择宠物', en: 'Choose a pet', kw: '桌面伙伴 输入框 挂件 宠物 猫 柯基 开源 桌宠 mascot buddy cat corgi pet 隐藏', anchor: 'setting-mascot' },
  { tab: 'about', zh: 'CLI 调试日志', en: 'CLI Debug Logs', kw: 'cli 调试 debug 日志 log 排障', anchor: 'setting-cli-debug' },
  { tab: 'theme', zh: '界面', en: 'Appearance', kw: '外观 主题 theme 深色 dark 浅色 light 毛玻璃 vibrancy 动效 动画 motion 丝滑 侧栏' },
  { tab: 'agent', zh: 'Agent 策略', en: 'Agent Policy', kw: '沙箱 sandbox 审批 approval 内容保护 pii 超时 timeout 命令 bash pty 隔离 权限' },
  { tab: 'editor', zh: '编辑器', en: 'Editor', kw: 'monaco 代码 字号 diff 缩进' },
  { tab: 'pet', zh: '宠物', en: 'Pet', kw: '宠物 桌宠 pet 动画 桌面 精灵 角色 猫 柯基' },
  { tab: 'providers', zh: 'API 服务商 (BYOK)', en: 'Providers (BYOK)', kw: 'api key 模型 provider openai anthropic deepseek glm kimi qwen 豆包 密钥 endpoint' },
  { tab: 'mcp', zh: 'MCP', en: 'MCP', kw: 'mcp 工具服务器 server 搜索 tool 插件' },
  { tab: 'skills', zh: '技能', en: 'Skills', kw: 'skill 技能 命令 slash' },
  { tab: 'memory', zh: '记忆', en: 'Memory', kw: 'memory 记忆 长期 knowledge 知识' },
  { tab: 'context', zh: '上下文', en: 'Context', kw: 'context 压缩 compact 上下文窗口 window token' },
  { tab: 'mobile', zh: '远程访问', en: 'Remote Access', kw: '手机 mobile 局域网 lan relay 云端中继 二维码 pair' },
  { tab: 'cloud-agent', zh: '云端 Agent', en: 'Cloud Agent', kw: 'cloud 云 远程执行' },
  { tab: 'routing', zh: '模型路由', en: 'Routing', kw: 'routing 路由 自动 auto 分流 route' },
  { tab: 'modelprofile', zh: '模型适配', en: 'Model Adaptation', kw: 'profile 模型适配 禁用工具 工具 兼容 提示词 完成判定 超时 重试 vision thinking effort 上下文窗口' },
  { tab: 'orchestrator', zh: '子 Agent', en: 'Sub-agents', kw: 'orchestrator 运行模式 子agent subagent 侧路 后台 标题 递归 深度 并行' },
  { tab: 'experimental', zh: '实验功能', en: 'Experimental', kw: '实验 experimental 检查点 checkpoint 文件回滚 shadow git flag' },
  { tab: 'experimental', zh: 'Jev 加持', en: 'Jev boost', kw: 'jev typesafe 加持 预判 工具 提速 分类模型 system one', anchor: 'setting-jev' },
  { tab: 'profile', zh: '个人信息', en: 'About You', kw: 'profile 个人 信息 档案 城市 生日 偏好 记住 忌口 家人' },
  { tab: 'tts', zh: '语音', en: 'Voice', kw: 'tts stt 语音 播报 麦克风 voice 朗读' },
  { tab: 'notify', zh: '通知', en: 'Notifications', kw: 'notify 通知 提醒 push 声音' },
  { tab: 'browser', zh: '浏览器', en: 'Browser', kw: 'browser 浏览器 登录态 cookie chrome 登录 sign-in agent' },
  { tab: 'github', zh: 'GitHub', en: 'GitHub', kw: 'github pr pull request 评论 comment 集成 integration webhook 仓库 repo' },
  { tab: 'runconfig', zh: '运行配置', en: 'Run Config', kw: 'run 运行 脚本 命令 config' },
  { tab: 'editor', zh: '快捷键', en: 'Keymap', kw: 'keymap 快捷键 keybinding 键位 shortcut', anchor: 'setting-keymap' },
  { tab: 'processes', zh: '进程', en: 'Processes', kw: 'process 进程 服务 service 后台' },
  { tab: 'storage', zh: '存储', en: 'Storage', kw: 'storage 存储 数据 导入 导出 备份 数据库' },
  { tab: 'share', zh: '网页分享', en: 'Web sharing', kw: 'share 分享 发布 链接 cloudflare r2 上线 publish link' },
  { tab: 'diagnostics', zh: '诊断', en: 'Diagnostics', kw: 'diagnostics 诊断 缓存 cache 命中 侧路 side jev 请求 排障' },
  { tab: 'about', zh: '关于', en: 'About', kw: 'about 关于 版本 version 更新 update' },
];
type ModelDropdownTab = 'api' | 'common';
type RemoteModelsCacheEntry = {
  models: string[];
  sourceUrl: string | null;
  fetchedAt: number;
};

const REMOTE_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

const hashRemoteModelCredential = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};

/** AvatarMenu「我的账户」点击会先把这个 key 写到 localStorage,
 *  SettingsPage mount 时读出来作初始 tab 然后清掉 — 一次性跳转. */
const SETTINGS_INITIAL_TAB_KEY = 'neox-settings-initial-tab';
const SETTINGS_LAST_TAB_KEY = 'neox-settings-last-tab';
/** WelcomePage 的 BYOK 快速入口: 设置页消费后立即删除, 避免反复弹窗. */
const SETTINGS_PROVIDER_ACTION_KEY = 'neox-settings-provider-action';

type NavGroupKey = 'account' | 'core' | 'tools' | 'advanced' | 'system';

const NAV_GROUPS_ORDER: NavGroupKey[] = ['account', 'core', 'tools', 'advanced', 'system'];

const NAV_GROUP_OF_TAB: Record<string, NavGroupKey> = {
  profile: 'account', account: 'account', subscription: 'account', usage: 'account', security: 'account',
  theme: 'core', conversation: 'core', keymap: 'core', editor: 'core', tts: 'core', notify: 'core', pet: 'core',
  agent: 'tools', browser: 'tools', websearch: 'tools', codeindex: 'tools', memory: 'tools', skills: 'tools', mcp: 'tools',
  orchestrator: 'tools', context: 'tools',
  providers: 'advanced', routing: 'advanced', modelprofile: 'advanced', runconfig: 'advanced', processes: 'advanced',
  remote: 'system', mobile: 'system', github: 'system', 'cloud-agent': 'system', experimental: 'system',

  /* system — 系统层只剩 2 项 */
  storage: 'system', about: 'system',
};

/** Pro+ 用户判定 — Free / trial / 未登录 都视为非 Pro.
 *   advanced 分组的 nav 内容据此决定: Pro 看全部高级 tab 列表; Free 看升级占位. */
function isProTier(planId: string | undefined | null): boolean {
  const id = String(planId ?? '').toLowerCase();
  if (!id || id === 'free' || id === 'trial') return false;
  return true;
}

/* 模型 profile / MCP / Skills 类型 → ./settingsPageTypes */
import type {
  CurrentModelProfileInfo, ModelProfileListEntry, MCPTransport, MCPConfigScope,
  MCPServerEntry, SkillCategory, SkillSource, SkillInfo,
} from './settingsPageTypes';

// 6小时 = 360分钟，每60秒一条 = 360条记录
const MAX_HEALTH_HISTORY = 360;

// ==================== JSON 树节点 — 可折叠 ====================
const ContextJsonNode: React.FC<{
  data: any; label: string; depth: number; defaultOpen?: boolean;
}> = ({ data, label, depth, defaultOpen = false }) => {
  const [open, setOpen] = React.useState(defaultOpen || depth < 1);
  const indent = depth * 16;

  if (data === null || data === undefined) {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-null">null</span>
      </div>
    );
  }
  if (typeof data === 'number') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-number">{data >= 1000 ? data.toLocaleString() : String(data)}</span>
      </div>
    );
  }
  if (typeof data === 'string') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-string">"{data}"</span>
      </div>
    );
  }
  if (typeof data === 'boolean') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-bool">{String(data)}</span>
      </div>
    );
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <div className="ctx-json-line" style={{ paddingLeft: indent }}>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">[]</span>
        </div>
      );
    }
    return (
      <div>
        <div className="ctx-json-line ctx-json-toggle" style={{ paddingLeft: indent }} onClick={() => setOpen(!open)}>
          <span className={`ctx-json-arrow ${open ? 'open' : ''}`}>&#9654;</span>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">[{!open && <span className="ctx-json-preview">{data.length} items</span>}]</span>
        </div>
        {open && data.map((item: any, i: number) => (
          <ContextJsonNode key={i} data={item} label={String(i)} depth={depth + 1} />
        ))}
      </div>
    );
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return (
        <div className="ctx-json-line" style={{ paddingLeft: indent }}>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">{'{}'}</span>
        </div>
      );
    }
    return (
      <div>
        <div className="ctx-json-line ctx-json-toggle" style={{ paddingLeft: indent }} onClick={() => setOpen(!open)}>
          <span className={`ctx-json-arrow ${open ? 'open' : ''}`}>&#9654;</span>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">{'{'}{!open && <span className="ctx-json-preview">{entries.length} keys</span>}{'}'}</span>
        </div>
        {open && entries.map(([k, v]) => (
          <ContextJsonNode key={k} data={v} label={k} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return null;
};

// ==================== 上下文数据查看器（显示实际会话内容） ====================
const ContextDataViewer: React.FC<{
  language: string;
}> = ({ language: lang }) => {
  const snap = useContextSnapshot();
  const [sessionData, setSessionData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const sid = snap?.sessionId;
    if (!sid) { setLoading(false); return; }
    setLoading(true);
    window.neox.getSession(sid)
      .then((session: any) => {
        if (!session) { setSessionData(null); return; }
        // 构建用户能看懂的上下文结构
        setSessionData({
          sessionId: session.id,
          model: session.modelId,
          createdAt: new Date(session.createdAt).toLocaleString(),
          totalTokens: session.totalTokens,
          contextUsed: session.contextUsed,
          contextWindow: session.contextWindow,
          messageCount: session.messageCount ?? session.messages?.length ?? 0,
          messages: (session.messages || []).map((msg: any) => ({
            role: msg.role,
            tokens: msg.tokens || 0,
            timestamp: msg.timestamp ? new Date(msg.timestamp).toLocaleString() : null,
            text: msg.text?.length > 500 ? msg.text.slice(0, 500) + '...' : msg.text,
          })),
        });
      })
      .catch(() => setSessionData(null))
      .finally(() => setLoading(false));
  }, [snap?.sessionId]);

  if (loading) {
    return <div className="neox-text-shimmer" style={{ padding: '12px 0', fontSize: 11, color: 'var(--text-muted)' }}>{lang === 'zh' ? '加载中...' : 'Loading...'}</div>;
  }
  if (!sessionData) {
    return <div style={{ padding: '12px 0', fontSize: 11, color: 'var(--text-muted)' }}>{lang === 'zh' ? '无会话数据' : 'No session data'}</div>;
  }

  return (
    <div className="ctx-json-viewer">
      <div className="ctx-json-toolbar">
        <button
          className="ctx-json-copy"
          onClick={() => void copyToClipboard(JSON.stringify(sessionData, null, 2))}
        >
          {lang === 'zh' ? '复制 JSON' : 'Copy JSON'}
        </button>
        <button
          className="ctx-json-copy"
          onClick={async () => {
            if (snap?.sessionId) {
              try { await window.neox.exportSession(snap.sessionId, 'json'); } catch {}
            }
          }}
          disabled={!snap?.sessionId}
        >
          {lang === 'zh' ? '导出完整会话' : 'Export Full Session'}
        </button>
      </div>
      <div className="ctx-json-tree">
        <ContextJsonNode data={sessionData} label="session" depth={0} defaultOpen />
      </div>
    </div>
  );
};

// ==================== 设置页面组件 ====================
const SettingsPage = ({
  onClose,
  onProvidersUpdated,
  embedded,
  prewarm = false,
}: {
  onClose: () => void;
  onProvidersUpdated?: () => void;
  /** 传了就走嵌入模式: 不画浮层外壳/chrome。tab 钉死某一页(技能/MCP); withNav 保留左侧导航(全屏设置页) */
  embedded?: { tab?: SettingsTab; withNav?: boolean };
  /** 预热态: 已挂载但对用户不可见 (AppShell 在空闲时先挂一次, 见那里的注释)。
   *  这时候不能挂全局键盘监听 —— 否则主界面上按 ESC 会被一个看不见的浮层吃掉。 */
  prewarm?: boolean;
}) => {
  const { t, language } = useI18n();
  const modeVariant = useAgentModeVariant();
  /* 设置档位 (普通 / 高级) —— 见 state/settingsLevel.ts。
   * 与模式正交: 模式管页 (Life 不需要代码索引), 档位管行 (你想不想看细节)。 */
  const [settingsLevel, setLevel] = useSettingsLevel();

  /* 老用户不能默认掉进普通档 —— 只要他动过任何一个高级项, 第一次就给高级档。
   * 否则他打开设置会以为"我配的东西没了"。只在从没存过档位时判一次。 */
  useEffect(() => {
    if (hasStoredSettingsLevel()) return;
    let cancelled = false;
    (async () => {
      try {
        const api = window.neox as any;
        const [rt, exp, routing, cfgTouched] = await Promise.all([
          api.getAgentRuntimeConfig?.().catch(() => null),
          api.experimentalGetConfig?.().catch(() => null),
          api.getModelRoutingConfig?.().catch(() => null),
          api.modelProfileGetTaskAgentMap?.().then((r: any) => Object.keys(r?.map || {}).length > 0).catch(() => false),
        ]);
        const touchedAdvanced =
          rt?.osSandbox?.enabled === true ||
          rt?.modelOrchestration === 'on' ||
          rt?.pty?.enabled === false ||
          (typeof rt?.threadDepth?.max === 'number' && rt.threadDepth.max !== 3) ||
          (typeof rt?.maxConcurrentTeams === 'number' && rt.maxConcurrentTeams !== 1) ||
          (typeof rt?.bashTimeout?.defaultMs === 'number' && rt.bashTimeout.defaultMs !== 120_000) ||
          exp?.enablePTC === true ||
          routing?.enabled === true ||
          cfgTouched === true;
        if (!cancelled && touchedAdvanced) setSettingsLevel('advanced');
      } catch { /* 判不出来就按新用户走普通档 */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const isBasicLevel = settingsLevel === 'basic';
  /* 云端 Agent 没放开时, 这一页整页都是空的 —— 见下面 isTabVisible 里的说明。 */
  const cloudAgentAvailable = useCloudAgentAvailable();
  const githubAgentAvailable = usePluginCapability('github-pr-agent');
  /* 导航项是否显示 = 模式允许 && (高级档 || 这一页不是纯高级内容)。
   * 深链 / 设置搜索仍然能进这些页 —— 只是不占普通用户的导航位。
   *
   * cloud-agent 是唯一一个**能力关了就整页拿掉**的: 它没有任何设置项, 通篇是云端 session
   * 的运行态列表 + [拉回]/[销毁]。云端入口既然已经全部关掉 (输入框「运行位置」/ 侧栏右键),
   * 用户根本造不出云端 session, 这一页只会永远是空列表 —— 留着就是承诺了一个进不去的能力。
   * 本机 override (neox.cloudAgent.enabled) 一开, 它跟着回来, 作者自测不受影响。 */
  const isTabVisible = useCallback(
    (tab: string) => modeVariant.isSettingsTabVisible(tab)
      && !(isBasicLevel && ADVANCED_ONLY_TABS.has(tab))
      && !(tab === 'cloud-agent' && !cloudAgentAvailable)
      && !(ACCOUNT_ONLY_TABS.has(tab) && !getEditionHook('hasAccount'))
      && !(tab === 'github' && githubAgentAvailable !== true),
    [modeVariant, isBasicLevel, cloudAgentAvailable, githubAgentAvailable],
  );
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (embedded?.tab) return embedded.tab;
    const migrate = (t: SettingsTab | null): SettingsTab | null => {
      if (!t) return null;
      if ((t as string) === 'runconfig') return 'orchestrator';
      /* theme tab 恢复独立入口 */
      if ((t as string) === 'processes') return homeTab();        /* Services Surface 替代 */
      if ((t as string) === 'general')   return 'theme';
      if ((t as string) === 'keymap')    return 'editor';
      return t;
    };
    /* AvatarMenu 跳过来时把目标 tab 写在 localStorage. 一次性消费掉. */
    try {
      const intended = migrate(localStorage.getItem(SETTINGS_INITIAL_TAB_KEY) as SettingsTab | null);
      if (intended) {
        localStorage.removeItem(SETTINGS_INITIAL_TAB_KEY);
        return intended;
      }
      const last = migrate(localStorage.getItem(SETTINGS_LAST_TAB_KEY) as SettingsTab | null);
      if (last) return last;
    } catch { /* localStorage may be blocked, fall back to default */ }
    return homeTab();
  });

  useEffect(() => {
    if (embedded?.tab && embedded.tab !== activeTab) setActiveTab(embedded.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded?.tab]);

  /* 每次切换 tab 时持久化, 下次打开设置直接回到该位置 */
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_LAST_TAB_KEY, activeTab); } catch { /* ignore */ }
  }, [activeTab]);

  useEffect(() => {
    if (!modeVariant.isSettingsTabVisible(activeTab)) setActiveTab(homeTab());
  }, [modeVariant, activeTab]);

  useEffect(() => {
    if (activeTab === 'cloud-agent' && !cloudAgentAvailable) setActiveTab(homeTab());
    if (activeTab === 'github' && githubAgentAvailable === false) setActiveTab(homeTab());
    if (ACCOUNT_ONLY_TABS.has(activeTab) && !getEditionHook('hasAccount')) setActiveTab(homeTab());
  }, [activeTab, cloudAgentAvailable, githubAgentAvailable]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      const t = detail?.tab as SettingsTab | undefined;
      if (!t) return;
      setActiveTab(t);
    };
    window.addEventListener('neox:open-settings', handler);
    return () => window.removeEventListener('neox:open-settings', handler);
  }, []);

  /* 存储信息懒加载: 仅当切到「存储管理」tab 且尚无数据时才探测一次. */
  useEffect(() => {
    if (activeTab === 'storage' && !storageInfo && !storageLoading) {
      loadStorageInfo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /* 当前展开的侧栏分组 — 默认跟随 active tab 所在组. 用户点别的分组头切换. */
  const [openGroup, setOpenGroup] = useState<NavGroupKey>(() => NAV_GROUP_OF_TAB[activeTab] ?? 'account');
  const [navQuery, setNavQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [navSel, setNavSel] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /* 导航滚动状态 —— 左栏里只有中间的 nav 能滚, 而它关了滚动条 (scrollbar-width: none)。
   * 指针停在底部 (「反馈问题 · 高级」那一行 / nav 和它之间的留白) 上滚轮完全不驱动 nav,
   * 用户以为列表到此为止, 去点被裁掉一半的那一行 (标签中心已经在裁切线之外) 就落空。
   * 所以: ① aside 上兜一层滚轮转发, ② 还有内容时 nav 底部渐隐 (data-more)。 */
  const navRef = useRef<HTMLElement | null>(null);
  const [navHasMore, setNavHasMore] = useState(false);
  const syncNavOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setNavHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);
  /* searchOpen 留作深链兼容: navigateToSetting 仍会把它置回 false, 而那个曾经的命令面板
   * 浮层 JSX 与其样式 (.settings-search-overlay / __pop 那 140 行) 均已删除。 */
  const settingsHits = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    const reachable = SETTINGS_SEARCH_INDEX.filter((it) =>
      (it.tab !== 'cloud-agent' || cloudAgentAvailable)
      && (!ACCOUNT_ONLY_TABS.has(it.tab) || getEditionHook('hasAccount'))
      && (it.tab !== 'github' || githubAgentAvailable === true));
    /* 空查询: 只列顶级菜单 (子功能项只在真正搜索命中时才浮现, 别默认就把"联网搜索"顶到最前) */
    if (!q) return reachable.filter((it) => !it.anchor);
    return reachable.filter((it) =>
      it.zh.toLowerCase().includes(q) || it.en.toLowerCase().includes(q) || it.kw.toLowerCase().includes(q) || it.tab.includes(q));
  }, [navQuery, cloudAgentAvailable, githubAgentAvailable]);
  /* 深链: 切到 tab 后, 若有 anchor 就滚动到具体功能区并高亮 (不只是落到页面顶部)。
   *   tab 是 lazy 组件, 用轮询等它 mount 出 anchor 元素。 */
  const navigateToSetting = useCallback((it: { tab: SettingsTab; anchor?: string }) => {
    setActiveTab(it.tab);
    setSearchOpen(false);
    if (!it.anchor) return;
    let tries = 0;
    const tick = () => {
      const el = document.getElementById(it.anchor!);
      if (el) {
        /* 落点是收起的一块 (如编辑器页的快捷键) —— 先展开, 不然跳过去只看到一行标题 */
        if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('settings-anchor-flash');
        setTimeout(() => el.classList.remove('settings-anchor-flash'), 1600);
        return;
      }
      if (tries++ < 40) setTimeout(tick, 50);
    };
    setTimeout(tick, 60);
  }, []);
  useEffect(() => {
    if (searchOpen) { setNavQuery(''); setNavSel(0); setTimeout(() => searchInputRef.current?.focus(), 0); }
  }, [searchOpen]);
  useEffect(() => { setNavSel(0); }, [navQuery]);
  useEffect(() => {
    const target = NAV_GROUP_OF_TAB[activeTab];
    if (target) setOpenGroup(target);
  }, [activeTab]);
  /* 导航内容变了 (切档 / 搜索 / 换语言 / 切模式) 重新量一次「下面还有没有」 */
  useEffect(() => {
    syncNavOverflow();
  }, [syncNavOverflow, navQuery, settingsLevel, language, modeVariant]);
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => syncNavOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncNavOverflow]);

  const membership = useMembership();
  useMembershipStatus(); // 维持 store 订阅
  /* membership 用于用量页: 登录后异步到账时要把「本地统计」切回「订阅用量」 */
  const membershipPlanId = membership?.plan?.id ?? null;

  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const requestClose = useCallback(() => {
    if (embedded) { onClose(); return; }
    if (closeTimerRef.current != null) return; /* 已在退场中, 防重复触发 */
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 160);
  }, [embedded, onClose]);
  useEffect(() => () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (prewarm) return;
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsClosing(false);
  }, [prewarm]);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (embedded) return;
    const el = overlayRef.current;
    if (!el) return;
    /* 让首帧的入场动画先跑, 再抢焦点 —— 立刻 focus 会让 overlay 滚动容器跳一下 */
    const t = window.setTimeout(() => {
      if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [embedded]);

  /* ESC 关弹窗 — 仅当用户没在编辑某个 input/textarea 时才触发。
   * 预热态(挂着但不可见)不挂: 那会在主界面吞掉 ESC。 */
  useEffect(() => {
    if (prewarm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      if (document.querySelector('[role="menu"], [role="listbox"]')) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, prewarm]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);

  // 健康状态 - providerId -> health（从文件系统加载，通过 IPC）
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({});
  const [healthDataLoaded, setHealthDataLoaded] = useState(false);
  const healthCheckTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [healthCheckIntervalMinutes, setHealthCheckIntervalMinutes] = useState<number>(1);
  const [showHealthIntervalPopover, setShowHealthIntervalPopover] = useState(false);
  const [autoHealthCheckEnabled, setAutoHealthCheckEnabled] = useState<boolean>(true); // 自动测速开关

  // 从文件系统加载持久化的健康数据
  const loadHealthData = useCallback(async () => {
    try {
      const data = await window.neox.getHealthData();
      setHealthMap(data);
      setHealthDataLoaded(true);
    } catch (e) {
      console.error('[HealthCheck] Failed to load health data:', e);
      setHealthDataLoaded(true);
    }
  }, []);

  /* 常驻调度器在后台跑完一轮后广播 —— 设置页此时可能正开着, 不重新拉一次
   * healthMap 就会一直显示打开那一刻的旧数据 (曲线也不会长)。 */
  useEffect(() => {
    const onUpdated = () => { void loadHealthData(); };
    window.addEventListener(PROVIDER_HEALTH_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(PROVIDER_HEALTH_UPDATED_EVENT, onUpdated);
  }, [loadHealthData]);

  // 语言 & 调试设置状态
  // 存储信息状态
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Record<string, StorageFileInfo[]>>({});
  const [storageAdvancedOpen, setStorageAdvancedOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string; name: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // 使用统计状态
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [providerStats, setProviderStats] = useState<ProviderUsageStats[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [selectedProviderRecords, setSelectedProviderRecords] = useState<{ provider: string; records: TokenUsageRecord[] } | null>(null);
  /* NeoxCloud 模式 — usage 数据来源切云端, 本地 "清除"/"详情记录" 按钮禁用. */
  const [usageIsCloud, setUsageIsCloud] = useState(false);
  const [usageSource, setUsageSource] = useState<'cloud' | 'local'>('cloud');
  const [usageHasMembership, setUsageHasMembership] = useState(false);
  /* 云端 usage 拉取错误状态 — NeoxCloud 不可达时, 让 UI 看到陈旧/失败提示
   * (而不是默默 console.error 后展示陈旧数据当最新). */
  const [cloudUsageError, setCloudUsageError] = useState<string | null>(null);
  const [cloudUsageLastSuccessAt, setCloudUsageLastSuccessAt] = useState<number>(0);

  // About 页面状态
  // _appInfo_state → extracted to tabs/

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formProtocol, setFormProtocol] = useState<ProviderProtocol>('openai');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formUrlSuffix, setFormUrlSuffix] = useState('/v1/chat/completions');
  const [formMaxTokens, setFormMaxTokens] = useState('8192');
  const [formMaxInputTokens, setFormMaxInputTokens] = useState('');
  const [formModels, setFormModels] = useState<string[]>([]);
  const [formShowInModelPicker, setFormShowInModelPicker] = useState(true);
  /* Anthropic 身份策略 (BYOK/订阅共用). 'auto'=按 baseUrl / 'on'=强制 Claude Code / 'off'=Neox 原生.
   *   只对 protocol='anthropic' 生效, UI 也只在 anthropic 时渲染选项. */
  const [formClaudeCodeMode, setFormClaudeCodeMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [formPresetId, setFormPresetId] = useState<string>('');
  /* 图生图编辑载荷格式 (协议层). '' = 默认 (images-array, 现代 gpt-image 代理); 'image-field' = 经典 OpenAI. */
  const [formImageEditFormat, setFormImageEditFormat] = useState<'' | 'images-array' | 'image-field'>('');
  const [formTabs, setFormTabs] = useState<Array<{ protocol: string; apiKey: string; models?: string[]; baseUrl?: string }>>([{ protocol: 'openai', apiKey: '', models: undefined, baseUrl: undefined }]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelDropdownPosition, setModelDropdownPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 360 });
  const [modelDropdownTab, setModelDropdownTab] = useState<ModelDropdownTab>('common');
  const [remoteModelOptions, setRemoteModelOptions] = useState<string[]>([]);
  const [remoteModelsLoading, setRemoteModelsLoading] = useState(false);
  const [remoteModelsError, setRemoteModelsError] = useState<string | null>(null);
  const [remoteModelsSourceUrl, setRemoteModelsSourceUrl] = useState<string | null>(null);
  const [remoteModelsFetchedAt, setRemoteModelsFetchedAt] = useState<number | null>(null);
  const autoFetchedProviderModelsRef = useRef<Set<string>>(new Set());
  const remoteModelsCacheRef = useRef<Map<string, RemoteModelsCacheEntry>>(new Map());
  const modelSelectorRef = useRef<HTMLDivElement | null>(null);
  const modelInputWrapperRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const modelSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [userLanguage, setUserLanguage] = useState<UserLanguage>('zh');
  const [cliDebugEnabled, setCliDebugEnabled] = useState(false);
  const [piiFilterEnabled, setPiiFilterEnabled] = useState(true); // 默认开启 PII 保护

  // Agent 设置状态
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [approvalMode, setApprovalMode] = useState<'auto' | 'manual' | 'dangerous'>('auto');
  const [timelineDensity, setTimelineDensity] = useTimelineDensityPreference();
  const [servicesStopConfirmation, setServicesStopConfirmation] = useState<'never' | 'always'>('never');

  interface AgentRuntimeUIState {
    osSandbox: { enabled: boolean; mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; level?: 'strict' | 'moderate' | 'permissive'; allowNetwork: boolean };
    adoptOnTimeout: { enabled: boolean };
    pty: { enabled: boolean };
    osNotifications: { enabled: boolean };
    threadDepth: { max: number };
    /** 同时最多几个团队 (默认 1) —— 见 OrchestratorTab */
    maxConcurrentTeams?: number;
    rollout: { dir: string | null };
    bashTimeout: { defaultMs: number };
    approvalCache: { enabled: boolean }; gitCoAuthor?: { enabled: boolean }; injectionGuard?: boolean;
    /** 智能模型编排 (Team P1 能力1) — 标量字段, 默认 'off' */
    modelOrchestration?: 'off' | 'on';
    /** 服务面板 Stop 二次确认 — undefined = 用户没设过 (触发 localStorage 老值迁移) */
    servicesStopConfirmation?: 'never' | 'always';
  }
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeUIState | null>(null);

  // Web Search 设置状态
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [webSearchEngine, setWebSearchEngine] = useState<'auto' | 'bocha' | 'serper' | 'custom'>('auto');
  const [webSearchUrl, setWebSearchUrl] = useState('');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchApiKeyVisible, setWebSearchApiKeyVisible] = useState(false);
  const [ttsApiKeyVisible, setTtsApiKeyVisible] = useState(false);
  const [webSearchSaving, setWebSearchSaving] = useState(false);

  // Java Debug 设置状态
  const [javaDebugEnabled, setJavaDebugEnabled] = useState(false);
  const [javaDebugHome, setJavaDebugHome] = useState('');
  const [javaDebugJarPath, setJavaDebugJarPath] = useState('');
  const [javaDebugStatus, setJavaDebugStatus] = useState<{
    javaAvailable: boolean;
    javaVersion?: string;
    jarFound: boolean;
    jarPath?: string;
    ready: boolean;
  } | null>(null);
  const [javaDebugSaving, setJavaDebugSaving] = useState(false);

  // MCP 服务器状态
  const [mcpServers, setMcpServers] = useState<MCPServerEntry[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpConnectionStatus, setMcpConnectionStatus] = useState<Record<string, 'connected' | 'disconnected' | 'connecting' | 'error'>>({});
  /* 连接失败的错误消息 — error 状态下显出来给用户排查, 不只靠一个 dot tooltip. */
  const [mcpLastErrors, setMcpLastErrors] = useState<Record<string, string>>({});
  const [mcpToolCounts, setMcpToolCounts] = useState<Record<string, number>>({});
  const [mcpServerTools, setMcpServerTools] = useState<Record<string, any[]>>({});
  const [viewingMcpServer, setViewingMcpServer] = useState<MCPServerEntry | null>(null);
  const [showMcpAddForm, setShowMcpAddForm] = useState(false);
  const [editingMcpServer, setEditingMcpServer] = useState<MCPServerEntry | null>(null);
  // MCP 表单状态
  const [mcpFormId, setMcpFormId] = useState('');
  const [mcpFormName, setMcpFormName] = useState('');
  const [mcpFormTransport, setMcpFormTransport] = useState<MCPTransport>('stdio');
  const [mcpFormCommand, setMcpFormCommand] = useState('');
  const [mcpFormArgs, setMcpFormArgs] = useState('');
  const [mcpFormUrl, setMcpFormUrl] = useState('');
  const [mcpFormEnv, setMcpFormEnv] = useState('');
  const [mcpFormScope, setMcpFormScope] = useState<MCPConfigScope>('user');
  /* 默认开: 新加的服务器就是要用的, 关着的话重启后它不连, 对话里没有它的工具 (10-21) */
  const [mcpFormAutoConnect, setMcpFormAutoConnect] = useState(true);
  /* 本次打开设置后已经向后台对过状态的服务器 —— 每台只对一次 */
  const mcpStatusSyncedRef = useRef<Set<string>>(new Set());

  // Skills 状态
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  /* K4-MVP: 商店装的 skill metadata (按 skillId 索引). 跟 skills 并行 fetch,
   *   有 meta = 商店装的, 显示 trustLevel badge + Update/Trust/Uninstall 按钮. */
  const [installedMetas, setInstalledMetas] = useState<Record<string, {
    skillId: string;
    source: { type: string; url?: string };
    installedVersion: string;
    trustLevel: 'trusted' | 'limited';
    trustedAt?: string;
  }>>({});
  const [showSkillAddForm, setShowSkillAddForm] = useState(false);
  const [showSkillImportForm, setShowSkillImportForm] = useState(false);
  /* A2: 装前预览 — 用户输 URL 后点 Preview, 拉 metadata 显示卡片, 看清 author/allowedTools 再装 */
  const [skillPreview, setSkillPreview] = useState<null | {
    success: boolean;
    skillId?: string; name?: string; version?: string; author?: string;
    description?: string; allowedTools?: string[]; contentLength?: number; bodyPreview?: string;
    error?: string;
  }>(null);
  const [skillPreviewLoading, setSkillPreviewLoading] = useState(false);
  const [showSkillViewer, setShowSkillViewer] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [viewingSkill, setViewingSkill] = useState<SkillInfo | null>(null);
  const [skillImportUrl, setSkillImportUrl] = useState('');
  const [skillImportTarget, setSkillImportTarget] = useState<'user' | 'workspace'>('user');
  const [skillFormId, setSkillFormId] = useState('');
  const [skillFormName, setSkillFormName] = useState('');
  const [skillFormDesc, setSkillFormDesc] = useState('');
  const [skillFormInstructions, setSkillFormInstructions] = useState('');
  const [skillFormCategory, setSkillFormCategory] = useState<SkillCategory>('custom');
  const [skillFormTarget, setSkillFormTarget] = useState<'user' | 'workspace'>('user');
  const [skillFilterSource, setSkillFilterSource] = useState<SkillSource | 'all' | 'mine'>('mine');
  const [skillFilterCategory, setSkillFilterCategory] = useState<SkillCategory | 'all'>('all');
  // 技能编辑和执行历史
  const [skillViewerRaw, setSkillViewerRaw] = useState(false);
  const [skillExecutionHistory, setSkillExecutionHistory] = useState<Array<{
    id: string;
    skillId: string;
    timestamp: number;
    status: 'success' | 'error';
    duration: number;
    args?: string;
  }>>([]);
  const [showSkillHistory, setShowSkillHistory] = useState(false);

  // 代码索引状态
  const [indexStats, setIndexStats] = useState<{
    hasIndex: boolean;
    fileCount: number;
    symbolCount: number;
    lastUpdated: string | null;
    size: number;
  } | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexBuilding, setIndexBuilding] = useState(false);
  const [indexBuildProgress, setIndexBuildProgress] = useState<{ current: number; total: number; file: string } | null>(null);
  const [showIndexExcludeConfig, setShowIndexExcludeConfig] = useState(false);
  const [indexExcludePatterns, setIndexExcludePatterns] = useState<string[]>([
    'node_modules/**', 'dist/**', 'build/**', '.git/**', '*.min.js', '*.map'
  ]);
  const [newExcludePattern, setNewExcludePattern] = useState('');

  // 记忆系统状态
  const [memoryStats, setMemoryStats] = useState<{
    shortTerm: { count: number; sizeBytes: number; path?: string };
    session: { count: number; sizeBytes: number; path?: string };
    longTerm: {
      total: { count: number; sizeBytes: number };
      progress: { count: number; sizeBytes: number; path?: string };
      standard: { count: number; sizeBytes: number; path?: string };
      lesson: { count: number; sizeBytes: number; path?: string };
    };
    pinned: { count: number; sizeBytes: number; path?: string };
    totals: { count: number; sizeBytes: number };
  } | null>(null);
  const [memoryConfig, setMemoryConfig] = useState<{
    autoMemoryEnabled: boolean;
  }>({ autoMemoryEnabled: true });
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryPreview, setMemoryPreview] = useState<string | null>(null);
  const [showMemoryPreview, setShowMemoryPreview] = useState(false);
  // 记忆浏览和搜索
  const [memorySearchQuery, setMemorySearchQuery] = useState('');
  const [memoryItems, setMemoryItems] = useState<Array<{
    id: string;
    type: 'shortTerm' | 'session' | 'longTerm' | 'pinned';
    content: string;
    timestamp?: number;
    tags?: string[];
  }>>([]);
  const [memoryBrowseType, setMemoryBrowseType] = useState<'all' | 'shortTerm' | 'session' | 'longTerm' | 'pinned'>('all');
  const [showMemoryBrowser, setShowMemoryBrowser] = useState(false);

  // 内嵌浏览器视图状态
  const [showEmbeddedBrowser, setShowEmbeddedBrowser] = useState(false);
  const [embeddedBrowserUrl, setEmbeddedBrowserUrl] = useState('');
  // 进程管理状态
  const [processes, setProcesses] = useState<Array<{
    id: string;
    name: string;
    status: 'running' | 'stopped' | 'error';
    pid?: number;
    startTime?: number;
    cpu?: number;
    memory?: number;
  }>>([]);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [showProcessOutput, setShowProcessOutput] = useState(false);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [processOutput, setProcessOutput] = useState<string>('');

  // 定价配置状态
  const [showPricingConfig, setShowPricingConfig] = useState(false);
  const [pricingList, setPricingList] = useState<Array<{
    pattern: string;
    inputPrice: number;
    outputPrice: number;
    cachedInputPrice?: number;
  }>>([]);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [editingPricing, setEditingPricing] = useState<{
    pattern: string;
    inputPrice: string;
    outputPrice: string;
    cachedInputPrice: string;
  } | null>(null);
  const [newPricing, setNewPricing] = useState({
    pattern: '',
    inputPrice: '',
    outputPrice: '',
    cachedInputPrice: '',
  });

  // 统计增强状态 — 'chart' / usageTimeRange / usageChartData 已删 (永远没 setter 调用,
  // 死 state). usageViewMode 留 overview/distribution 跟实际 tab 对齐.
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [usageViewMode, setUsageViewMode] = useState<'overview' | 'distribution'>('overview');
  // 费用估算和趋势图
  const [costEstimate, setCostEstimate] = useState<{
    daily: number;
    weekly: number;
    monthly: number;
  } | null>(null);
  const [showCostTrend, setShowCostTrend] = useState(false);

  // TTS 语音配置状态
  const [ttsConfig, setTtsConfig] = useState<{
    enabled: boolean;
    provider: 'edge' | 'neoxcloud' | 'openai' | 'custom';
    voice: string;
    speed: number;
    format: string;
    autoSummarize: boolean;
    maxSummaryChars: number;
    apiUrl: string;
    apiKey: string;
  }>({ enabled: false, provider: 'edge', voice: '', speed: 1.0, format: 'mp3', autoSummarize: true, maxSummaryChars: 200, apiUrl: '', apiKey: '' });
  const [ttsLoading, setTtsLoading] = useState(false);

  // 实验性功能配置状态
  const [experimentalConfig, setExperimentalConfig] = useState<{
    enableFGTS: boolean;
    enablePTC: boolean;
    enableCheckpoint: boolean;
  }>({ enableFGTS: false, enablePTC: false, enableCheckpoint: false });
  const [experimentalLoading, setExperimentalLoading] = useState(false);

  // F7+N4 v2: 文档解析模式 (local 客户端 pdfjs/mammoth/xlsx · cloud NeoxCloud)
  // 初始读 localStorage, 切换时立即生效, 下一次 attachment 走新 mode
  const [docParseMode, setDocParseModeState] = useState<DocumentParseMode>(() => getDocumentParseMode());
  const handleDocParseModeChange = useCallback((mode: DocumentParseMode) => {
    setDocumentParseMode(mode);
    setDocParseModeState(mode);
  }, []);

  // ✦ Editor / Inline completion (Ghost Text) settings
  const [inlineCompletionConfig, setInlineCompletionConfig] = useState<{
    enabled: boolean;
    providerId?: string;
    model?: string;
    effective?: { providerId: string; model: string; source: 'override' | 'auto'; isFast: boolean };
  }>({ enabled: true });


  // RunConfig 运行配置状态
  const [runconfigData, setRunconfigData] = useState<{
    runMode: string;
    modes: Record<string, any>;
  }>({ runMode: 'agentic', modes: {} });
  const [runconfigLoading, setRunconfigLoading] = useState(false);

  const [notifyConfig, updateNotifyConfig] = useNotifyConfig();
  /* 兼容旧 setter API: 旧代码 setNotifyConfig({...notifyConfig, enabled: x}) 全对象写,
   * useNotifyConfig 已接 partial merge, 这里包一层适配让 onChange 写法保持. */
  const setNotifyConfig = (next: typeof notifyConfig) => updateNotifyConfig(next);
  const [availableSounds, setAvailableSounds] = useState<Array<{
    id: string;
    name: string;
    path: string;
    type: 'system' | 'custom';
  }>>([
    { id: 'none', name: 'None', path: '', type: 'custom' },
    { id: 'default', name: 'Default', path: '', type: 'custom' },
  ]);

  // 上下文管理状态
  const [contextConfig, setContextConfig] = useState<{
    compressionMode: 'sync' | 'async';
    thresholdPercent: number;
  }>({ compressionMode: 'sync', thresholdPercent: 85 });
  const [contextLoading, setContextLoading] = useState(false);
  const [contextUsage, setContextUsage] = useState<{
    currentTokens: number;
    maxTokens: number;
    usagePercent: number;
    messageCount?: number;
    toolMessageCount?: number;
    toolResultRatio?: number;
    warnings?: string[];
    byType?: {
      ephemeral: { count: number; tokens: number };
      contextual: { count: number; tokens: number };
      summarized: { count: number; tokens: number };
      other: { count: number; tokens: number };
    };
    byRole?: {
      system: { count: number; tokens: number };
      user: { count: number; tokens: number };
      assistant: { count: number; tokens: number };
      tool: { count: number; tokens: number };
    };
  } | null>(null);
  // 上下文历史回溯
  const [contextHistory, setContextHistory] = useState<Array<{
    id: string;
    timestamp: number;
    tokens: number;
    summary: string;
  }>>([]);
  const [showContextHistory, setShowContextHistory] = useState(false);
  const [showContextData, setShowContextData] = useState(false);
  const [expandedRole, setExpandedRole] = useState<string | null>(null);


  // 模型路由状态
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [modelRoutes, setModelRoutes] = useState<Record<string, ModelRouteConfig>>({});
  const [editingRoute, setEditingRoute] = useState<ModelRouteConfig | null>(null);
  const [showAddRouteForm, setShowAddRouteForm] = useState(false);
  const [routeFormAlias, setRouteFormAlias] = useState('');
  const [routeFormStrategy, setRouteFormStrategy] = useState<RoutingStrategy>('priority');
  const [routeFormProviders, setRouteFormProviders] = useState<Array<{ providerId: string; modelName: string; priority: number; enabled: boolean }>>([]);
  // 健康检查配置表单
  // 拖拽状态
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  // Provider 下拉框状态
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 420, maxHeight: 240 });
  const providerDropdownRef = useRef<HTMLDivElement>(null);
  const providerDropdownMenuRef = useRef<HTMLDivElement>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);

  // 健康检测调度 - 使用 ref 存储 providers，避免依赖问题
  const providersRef = useRef<ProviderConfig[]>([]);
  /* 定时器已移交 providerHealthScheduler (App 级常驻);
   * 这里只留一个「本次挂载是否同步过开关」的一次性闸。 */
  const healthPrefsSyncedRef = useRef(false);
  const healthPopoverRef = useRef<HTMLDivElement | null>(null);
  const autoHealthCheckRef = useRef<boolean>(true); // 用于 startHealthCheckInterval 访问最新值

  // Win: 设置全屏实色后立刻跟 titleBarOverlay 对色; 关闭后再 sync 回壳
  useEffect(() => {
    syncWinTitleBar();
    const t1 = window.setTimeout(() => syncWinTitleBar(), 80);
    const t2 = window.setTimeout(() => syncWinTitleBar(), 300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      requestAnimationFrame(() => syncWinTitleBar());
      window.setTimeout(() => syncWinTitleBar(), 120);
    };
  }, []);

  // 加载 providers 和语言设置
  useEffect(() => {
    loadProviders();
    loadLanguagePreference();
    let cancelled = false;
    const idleHandles: number[] = [];
    const timerHandles: number[] = [];
    const scheduleIdle = (cb: () => void, timeout: number) => {
      if (typeof window.requestIdleCallback === 'function') {
        idleHandles.push(window.requestIdleCallback(() => { if (!cancelled) cb(); }, { timeout }));
      } else {
        timerHandles.push(window.setTimeout(() => { if (!cancelled) cb(); }, Math.min(timeout, 300)));
      }
    };
    // 第一批: 各 tab 的偏好开关 (轻 IPC)
    scheduleIdle(() => {
      loadCliDebugPreference();
      loadPiiFilterPreference();
      loadAgentSettings();
      loadAssistantConfig();
    }, 800);
    // 第二批: 统计/健康/路由/声音 (重 IPC, 存储信息另有按需 effect)
    scheduleIdle(() => {
      loadUsageStats();
      loadHealthCheckInterval();
      loadAutoHealthCheckSetting();
      loadHealthData();
      loadRoutingConfig();
      loadAvailableSounds();
    }, 2000);
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function') {
        idleHandles.forEach((h) => window.cancelIdleCallback(h));
      }
      timerHandles.forEach((h) => window.clearTimeout(h));
      if (healthCheckTimerRef.current) {
        clearTimeout(healthCheckTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showHealthIntervalPopover) return undefined;
    // 点击页面空白关闭弹窗
    const handlePointerOutside = (event: PointerEvent) => {
      if (showHealthIntervalPopover && healthPopoverRef.current && !healthPopoverRef.current.contains(event.target as Node)) {
        setShowHealthIntervalPopover(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHealthIntervalPopover(false);
    };
    document.addEventListener('pointerdown', handlePointerOutside, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [showHealthIntervalPopover]);

  // 当切换到使用统计 tab 时刷新数据
  useEffect(() => {
    if (activeTab === 'usage') {
      loadUsageStats();
    }
    if (activeTab === 'mcp') {
      loadMcpServers();
    }
    if (activeTab === 'skills') {
      loadSkills();
    }
  }, [activeTab]);

  // 取消检测的状态 - 记录被取消的 providerId
  const cancelledChecksRef = useRef<Set<string>>(new Set());

  // 取消单个 provider 的检测
  const cancelHealthCheck = useCallback((providerId: string) => {
    cancelledChecksRef.current.add(providerId);
    // 立即将状态从 testing 改为 error（表示已取消）
    setHealthMap(prev => {
      const existing = prev[providerId];
      // 使用上一次的状态，如果没有则用 error
      const lastStatus = existing?.history?.length ? existing.history[existing.history.length - 1].status : 'error';
      const lastLatency = existing?.history?.length ? existing.history[existing.history.length - 1].latency : 0;
      return {
        ...prev,
        [providerId]: {
          ...existing,
          current: lastStatus,
          latency: lastLatency,
          history: existing?.history || []
        }
      };
    });
  }, []);

  // 健康检测 - 通过 IPC 调用主进程执行，避免浏览器 CORS 限制
  // opts.model: 诊断弹窗里用户指定的模型; 不传则自动挑非图片模型.
  const checkProviderHealth = useCallback(async (
    provider: ProviderConfig,
    opts?: { model?: string },
  ) => {
    cancelledChecksRef.current.delete(provider.id);

    setHealthMap(prev => {
      const existing = prev[provider.id] || { current: 'testing', history: [] };
      return { ...prev, [provider.id]: { ...existing, current: 'testing' } };
    });

    const modelNames = (provider.models || []).map((m: any) => m?.name).filter(Boolean) as string[];
    const preferredChat = modelNames.find((name) => {
      const n = String(name).toLowerCase();
      return !/image|dall-?e|imagen|gpt-image|imagine|flux|sdxl/.test(n);
    });
    const probeModel = (opts?.model || '').trim()
      || preferredChat
      || provider.defaultModel
      || provider.lastSelectedModel
      || provider.models[0]?.name
      || 'gpt-4o';

    try {
      const request: HealthCheckRequest = {
        providerId: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl || getDefaultBaseUrl(provider.protocol),
        urlSuffix: provider.urlSuffix,
        apiKey: provider.apiKey || '',
        model: probeModel,
      };

      const result = await window.neox.checkProviderHealth(request);

      if (cancelledChecksRef.current.has(provider.id)) {
        cancelledChecksRef.current.delete(provider.id);
        return;
      }

      // 必须把 error/httpStatus/model 写进 history — 诊断弹窗靠这些字段渲染,
      const newRecord: HealthRecord = {
        status: result.status,
        latency: result.latency,
        timestamp: result.timestamp,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        model: probeModel,
      };

      setHealthMap(prev => {
        const existing = prev[provider.id] || { current: result.status, history: [] };
        const newHistory = [...existing.history, newRecord].slice(-MAX_HEALTH_HISTORY);
        return {
          ...prev,
          [provider.id]: { current: result.status, latency: result.latency, history: newHistory }
        };
      });

      try {
        await window.neox.updateHealthData(
          provider.id,
          result.status,
          result.latency,
          result.errorMessage,
          result.httpStatus,
          probeModel,
        );
      } catch (persistErr) {
        console.error('[HealthCheck] Failed to persist health data:', persistErr);
      }
    } catch (err: any) {
      if (cancelledChecksRef.current.has(provider.id)) {
        cancelledChecksRef.current.delete(provider.id);
        return;
      }

      console.error('[HealthCheck] IPC error:', err);
      const errText = err?.message ? String(err.message) : 'Unknown error';
      const newRecord: HealthRecord = {
        status: 'offline',
        latency: 0,
        timestamp: Date.now(),
        error: errText,
        model: probeModel,
      };
      setHealthMap(prev => {
        const existing = prev[provider.id] || { current: 'offline', history: [] };
        const newHistory = [...existing.history, newRecord].slice(-MAX_HEALTH_HISTORY);
        return {
          ...prev,
          [provider.id]: { current: 'offline', latency: 0, history: newHistory }
        };
      });

      try {
        await window.neox.updateHealthData(provider.id, 'offline', 0, errText, undefined, probeModel);
      } catch (persistErr) {
        console.error('[HealthCheck] Failed to persist health data:', persistErr);
      }
    }
  }, []);

  // 执行一次健康检测
  const runHealthCheck = useCallback(() => {
    /* 只测 BYOK 第三方服务商 — Neox Cloud 是订阅网关 (走 routing.json + OAuth, 不是 api.openai.com),
     * 拿 BYOK 探针去 ping 它必然报错 + 浪费调用, 直接排除。 */
    const list = providersRef.current.filter((p: any) =>
      p.id !== NEOX_CLOUD_PROVIDER_ID && !isProviderHealthCheckSkipped(p.id),
    );
    if (list.length === 0) return;
    list.forEach((provider, index) => {
      setTimeout(() => {
        if (!isProviderHealthCheckSkipped(provider.id)) checkProviderHealth(provider);
      }, index * 500);
    });
  }, [checkProviderHealth]);

  /* 定时器已交给 providerHealthScheduler (App 级常驻, 见该文件注释)。
   * 这里只剩两件事: 需要时立刻测一轮 + 通知调度器按新偏好重排。
   * 设置页自己再排一个 interval 会和调度器重复探测 —— 探测是真实计费调用, 不能打两遍。 */
  const startHealthCheckInterval = useCallback((_intervalMinutes?: number, forceRun?: boolean) => {
    if (forceRun) {
      runHealthCheck();
    }
    void restartProviderHealthScheduler();
  }, [runHealthCheck]);

  const notifyProvidersChanged = useCallback(() => {
    try {
      onProvidersUpdated?.();
    } catch (error) {
      console.error('[Settings] Failed to notify provider change', error);
    }
  }, [onProvidersUpdated]);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.neox.getProviders();
      setProviders(list);
      providersRef.current = list;
      /* 只在本次挂载的首次加载做一遍开关同步 —— 老守卫用的是 healthCheckIntervalRef,
       * 定时器交给常驻调度器之后那个 ref 再没人写, 守卫恒真, 每次 loadProviders
       * (config.json 热更新也会触发) 都会重排一次调度器。改用显式 once 标志。 */
      if (!healthPrefsSyncedRef.current) {
        healthPrefsSyncedRef.current = true;
        try {
          const autoEnabled = await window.neox.getAutoHealthCheck();
          autoHealthCheckRef.current = autoEnabled;
          setAutoHealthCheckEnabled(autoEnabled);
        } catch { }
        setTimeout(() => startHealthCheckInterval(), 500);
      }
    } catch (err) {
      console.error('Failed to load providers:', err);
    }
    setLoading(false);
  }, [startHealthCheckInterval]);

  /* 全局 config.json 改变后重拉 provider 列表。
   * 外部手改 ~/.neox/config.json、其他窗口保存、当前窗口保存都走同一条热更新链路。 */
  useEffect(() => {
    const onProvidersChanged = () => { void loadProviders(); };
    window.addEventListener('neox-providers-changed', onProvidersChanged);
    return () => window.removeEventListener('neox-providers-changed', onProvidersChanged);
  }, [loadProviders]);

  const loadLanguagePreference = async () => {
    try {
      // 助手回复语言 — 持久化在 backend config (agentBridge.userLanguage)
      const lang = await window.neox.getLanguagePreference();
      setUserLanguage(lang);
      /* UI 语言: 不再从 backend 读 — useI18n 自己从 localStorage 取持久化值,
       * 这两个 setting 真正独立. 启动时 useI18n 已经把 globalLanguage 初始化好了. */
    } catch (err) {
      console.error('Failed to load language preference:', err);
    }
  };

  // UI 界面语言 — 仅影响 desktop UI 显示, 持久化由 setGlobalLanguage 写 localStorage.
  // 不再调 setLanguagePreference (那个只控制助手回复语言).
  const handleLanguageChange = (lang: UserLanguage) => {
    setGlobalLanguage(lang);
  };

  // 助手回复语言 — 仅影响 AI agent 回复时用的语言, 走 backend config.
  // 不再 setGlobalLanguage (那个只控制 UI 语言).
  const handleAssistantLanguageChange = async (lang: UserLanguage) => {
    try {
      await window.neox.setLanguagePreference(lang);
      setUserLanguage(lang);
    } catch (err) {
      console.error('Failed to save assistant language preference:', err);
      dispatchOpFailed({ op: language === 'zh' ? '保存助手语言' : 'Save assistant language', message: (err as any)?.message || String(err) });
    }
  };

  const loadCliDebugPreference = async () => {
    try {
      const enabled = await window.neox.getCliDebugPreference();
      setCliDebugEnabled(enabled);
    } catch (err) {
      console.error('Failed to load CLI debug preference:', err);
    }
  };

  const handleCliDebugChange = async (enabled: boolean) => {
    try {
      await window.neox.setCliDebugPreference(enabled);
      setCliDebugEnabled(enabled);
    } catch (err) {
      console.error('Failed to update CLI debug preference:', err);
    }
  };

  const loadPiiFilterPreference = async () => {
    try {
      const enabled = await window.neox.getPiiFilterPreference();
      setPiiFilterEnabled(enabled);
    } catch (err) {
      console.error('Failed to load PII filter preference:', err);
    }
  };

  // 加载 Agent 设置
  const loadAgentSettings = async () => {
    try {
      const settings = await window.neox.getAgentSettings();
      if (settings) {
        setSandboxEnabled(settings.sandboxEnabled ?? false);
        /* 审批模式的真值在 approvalModeStore (ui_state + 后端 scope), 不在 agentSettings ——
           读错那份会出现"设置页显示自动, 实际在 dangerous 放行"。见 handleApprovalModeChange。 */
        void preloadApprovalModeDefault()
          .then((real) => setApprovalMode(real))
          .catch(() => setApprovalMode(settings.approvalMode ?? 'auto'));
        setWebSearchEnabled(settings.webSearchEnabled ?? true);
        setWebSearchEngine((settings.webSearchEngine as any) ?? 'auto');
        setWebSearchUrl(settings.webSearchUrl ?? '');
        setWebSearchApiKey(settings.webSearchApiKey ?? '');
        setJavaDebugEnabled(settings.javaDebugEnabled ?? false);
        setJavaDebugHome(settings.javaDebugHome ?? '');
        setJavaDebugJarPath(settings.javaDebugJarPath ?? '');
      }
      /* Java Debug UI 已移除 — 不再在设置打开时探测 Java 环境 (省一次 `java -version` spawn)。 */
      try {
        const rt = await (window.neox as any).getAgentRuntimeConfig?.();
        if (rt) setAgentRuntime(rt as AgentRuntimeUIState);
        let mode: 'never' | 'always' = rt?.servicesStopConfirmation === 'always' ? 'always' : 'never';
        try {
          const legacy = localStorage.getItem('neox.services.stopConfirmation');
          if ((legacy === 'always' || legacy === 'never') && rt?.servicesStopConfirmation == null) {
            mode = legacy;
            await (window.neox as any).setAgentRuntimeConfig?.({ servicesStopConfirmation: legacy });
            const after = await (window.neox as any).getAgentRuntimeConfig?.();
            if (after?.servicesStopConfirmation === legacy) {
              localStorage.removeItem('neox.services.stopConfirmation');
            }
          }
        } catch { /* localStorage 不可用就跳过迁移 */ }
        setServicesStopConfirmation(mode);
      } catch { /* ignore */ }
    } catch (err) {
      console.error('Failed to load agent settings:', err);
    }
  };

  // 加载 agentic 模式配置
  const loadAssistantConfig = async () => {
    try {
      const runconfig = await window.neox.runconfigGet?.();
      if (runconfig) {
        setRunconfigData(runconfig);
        const agenticModeConfig = runconfig.modes?.agentic || {};
        const agenticTaskAgent = agenticModeConfig.taskAgent;
        const sideAgent = agenticModeConfig.sideAgent || {};
        // explore 子开关: sideAgent.features.explore 优先,旧 claudeExploreUseHaiku 兜底
        setAgenticClaudeExploreUseHaiku(
          sideAgent.features?.explore ?? agenticModeConfig.claudeExploreUseHaiku ?? true,
        );
        setAgenticClaudeFallbackToOpusWhenNoHaiku(
          sideAgent.claudeFallbackToOpusWhenNoHaiku ?? agenticModeConfig.claudeFallbackToOpusWhenNoHaiku ?? false,
        );
        setAgenticSideAgentEnabled(sideAgent.enabled ?? true);
        setAgenticSideAgentToolUseSummary(sideAgent.features?.toolUseSummary ?? true);
        setAgenticSideAgentSessionTitle(sideAgent.features?.sessionTitle ?? true);
        setAgenticSideAgentProviderId(sideAgent.providerId ?? '');
        setAgenticSideAgentModel(sideAgent.model ?? '');
        setAgenticSideAgentDisableThinking(sideAgent.disableThinking ?? true);
        if (agenticTaskAgent?.providerId && agenticTaskAgent?.model) {
          setAgenticTaskAgentProviderId(agenticTaskAgent.providerId);
          setAgenticTaskAgentModel(agenticTaskAgent.model);
        } else {
          setAgenticTaskAgentProviderId('');
          setAgenticTaskAgentModel('');
        }
      }
    } catch (err) {
      console.error('Failed to load agentic config:', err);
    }
  };

  // 加载 Java Debug 状态
  const loadJavaDebugStatus = async () => {
    try {
      const status = await window.neox.getJavaDebugStatus?.();
      if (status) {
        setJavaDebugStatus(status);
      }
    } catch (err) {
      console.error('Failed to load Java Debug status:', err);
    }
  };

  // Web Search 设置处理函数
  const handleWebSearchToggle = async (enabled: boolean) => {
    try {
      await window.neox.setAgentSettings({ webSearchEnabled: enabled });
      setWebSearchEnabled(enabled);
    } catch (err) {
      console.error('Failed to update web search setting:', err);
    }
  };

  const handleWebSearchEngineChange = async (engine: 'auto' | 'bocha' | 'serper' | 'custom') => {
    setWebSearchEngine(engine);
    try {
      await window.neox.setAgentSettings({ webSearchEngine: engine });
    } catch (err) {
      console.error('Failed to save web search engine:', err);
      dispatchOpFailed({ op: language === 'zh' ? '保存搜索后端' : 'Save search backend', message: (err as any)?.message || String(err) });
    }
  };

  const handleWebSearchSave = async () => {
    setWebSearchSaving(true);
    const op = language === 'zh' ? '保存网络搜索' : 'Save Web Search';
    try {
      await window.neox.setAgentSettings({
        webSearchEngine,
        webSearchUrl: webSearchUrl.trim(),
        webSearchApiKey: webSearchApiKey.trim(),
      });
      dispatchHint(language === 'zh' ? '已保存' : 'Saved', 'success');
    } catch (err) {
      console.error('Failed to save web search settings:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
    setWebSearchSaving(false);
  };

  // Java Debug 设置处理函数
  const handleJavaDebugToggle = async (enabled: boolean) => {
    try {
      await window.neox.setAgentSettings({ javaDebugEnabled: enabled });
      setJavaDebugEnabled(enabled);
      if (enabled) {
        await loadJavaDebugStatus();
      }
    } catch (err) {
      console.error('Failed to update Java Debug setting:', err);
      dispatchOpFailed({ op: language === 'zh' ? 'Java 调试开关' : 'Java Debug toggle', message: (err as any)?.message || String(err) });
    }
  };

  const handleJavaDebugSave = async () => {
    setJavaDebugSaving(true);
    const op = language === 'zh' ? '保存 Java 调试' : 'Save Java Debug';
    try {
      await window.neox.setAgentSettings({
        javaDebugHome: javaDebugHome.trim() || undefined,
        javaDebugJarPath: javaDebugJarPath.trim() || undefined,
      });
      await loadJavaDebugStatus();
      dispatchHint(language === 'zh' ? '已保存' : 'Saved', 'success');
    } catch (err) {
      console.error('Failed to save Java Debug settings:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
    setJavaDebugSaving(false);
  };

  const handleJavaDebugDownload = async () => {
    const op = language === 'zh' ? '下载 Java 调试 JAR' : 'Download Java Debug JAR';
    try {
      await window.neox.downloadJavaDebugJar?.();
      await loadJavaDebugStatus();
      dispatchHint(language === 'zh' ? '下载完成' : 'Download complete', 'success');
    } catch (err) {
      console.error('Failed to download Java Debug JAR:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
  };

  const loadHealthCheckInterval = async () => {
    try {
      const minutes = await window.neox.getHealthCheckInterval();
      if (minutes && minutes > 0) {
        setHealthCheckIntervalMinutes(minutes);
      }
    } catch (err) {
      console.error('Failed to load health check interval:', err);
    }
  };

  const loadAutoHealthCheckSetting = async () => {
    try {
      const enabled = await window.neox.getAutoHealthCheck();
      setAutoHealthCheckEnabled(enabled);
      autoHealthCheckRef.current = enabled;
    } catch (err) {
      console.error('Failed to load auto health check setting:', err);
    }
  };

  const handleAutoHealthCheckToggle = async () => {
    const newValue = !autoHealthCheckEnabled;
    setAutoHealthCheckEnabled(newValue);
    autoHealthCheckRef.current = newValue;
    try {
      await window.neox.setAutoHealthCheck(newValue);
      void restartProviderHealthScheduler();
      if (newValue && providersRef.current.length > 0) {
        runHealthCheck();
      }
    } catch (err) {
      console.error('Failed to save auto health check setting:', err);
    }
  };

  // 加载存储信息
  // 永久停在骨架屏. 12s 还没回就当失败, 让 UI 落到错误态 + 可重试, 而不是无限转.
  const loadStorageInfo = async () => {
    setStorageLoading(true);
    try {
      const info = await Promise.race([
        window.neox.getStorageInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('storage-info-timeout')), 12000)),
      ]);
      setStorageInfo(info as Awaited<ReturnType<typeof window.neox.getStorageInfo>>);
    } catch (err) {
      console.error('Failed to load storage info:', err);
      // 不覆盖已有数据 (刷新失败时保留旧值); 仅首次失败时 storageInfo 仍为 null → 显错误态
    }
    setStorageLoading(false);
  };

  // 加载应用信息
  // _loadAppInfo → extracted to tabs/

  // 加载路由配置
  const loadRoutingConfig = async () => {
    try {
      const [enabled, routes] = await Promise.all([
        window.neox.getModelRoutingEnabled(),
        window.neox.getModelRoutes(),
      ]);
      setRoutingEnabled(enabled);
      setModelRoutes(routes);
    } catch (error) {
      console.error('Failed to load routing config:', error);
    }
  };

  // 加载可用声音列表
  const loadAvailableSounds = async () => {
    try {
      const sounds = await window.neox.listAvailableSounds?.();
      if (sounds && sounds.length > 0) {
        setAvailableSounds(sounds);
      }
    } catch (error) {
      console.error('Failed to load available sounds:', error);
    }
  };

  // ==================== MCP 服务器管理函数 ====================
  const loadMcpServers = async () => {
    setMcpLoading(true);
    try {
      const servers = await window.neox.mcpList();
      setMcpServers(servers ?? []);
      for (const s of (servers ?? []) as any[]) {
        if (s.enabled === false || s.trusted === false) continue;
        if (mcpStatusSyncedRef.current.has(s.id)) continue;
        mcpStatusSyncedRef.current.add(s.id);
        void handleMcpConnect(s.id);
      }
    } catch (e) {
      console.error('[Settings] mcpList failed:', e);
    }
    try {
      const enabled = await window.neox.mcpGetEnabled();
      setMcpEnabled(enabled);
    } catch (e) {
      console.error('[Settings] mcpGetEnabled failed:', e);
    }
    setMcpLoading(false);
  };

  const handleMcpToggle = async () => {
    const newValue = !mcpEnabled;
    setMcpEnabled(newValue);
    try {
      const r = await window.neox.mcpSetEnabled(newValue);
      /* P0-5: 透传 runtime push warning — config 落盘了但当前 session 没生效 */
      if ((r as { runtimeWarning?: string })?.runtimeWarning) {
        const m = await import('../../components/notifyEvents');
        m.dispatchHint(
          language === 'zh'
            ? 'MCP 已保存, 但当前会话未生效, 重启 app 后同步'
            : 'MCP saved — takes effect for new sessions after app restart',
          'warning',
        );
      }
    } catch (err) {
      console.error('Failed to toggle MCP:', err);
      setMcpEnabled(!newValue);
      const m = await import('../../components/notifyEvents');
      m.dispatchHint(
        (language === 'zh' ? 'MCP 切换失败: ' : 'Failed to toggle MCP: ')
        + (err instanceof Error ? err.message : String(err)),
        'warning',
      );
    }
  };

  const handleMcpConnect = async (serverId: string) => {
    setMcpConnectionStatus(prev => ({ ...prev, [serverId]: 'connecting' }));
    setMcpLastErrors(prev => { const { [serverId]: _, ...rest } = prev; return rest; });
    try {
      const connectResult: any = await window.neox.mcpConnect(serverId);
      if (connectResult && connectResult.success === false) {
        const err = connectResult.error || 'connect failed';
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
      }
      setMcpConnectionStatus(prev => ({ ...prev, [serverId]: 'connected' }));
      // 获取工具数量
      const result: any = await window.neox.mcpGetTools(serverId);
      /* 兼容三种返回形:  数组 / {success, tools} / {tools} */
      const tools = Array.isArray(result) ? result : (result?.tools ?? []);
      setMcpToolCounts(prev => ({ ...prev, [serverId]: tools?.length ?? 0 }));
      setMcpServerTools(prev => ({ ...prev, [serverId]: tools }));
    } catch (err) {
      console.error('Failed to connect MCP server:', err);
      setMcpConnectionStatus(prev => ({ ...prev, [serverId]: 'error' }));
      const msg = err instanceof Error ? err.message : String(err);
      setMcpLastErrors(prev => ({ ...prev, [serverId]: msg.slice(0, 1500) })); /* 带 server stderr 尾巴, 真因常在第二行后 —— 截 200 只剩 "Connection closed" */
    }
  };

  const handleMcpDisconnect = async (serverId: string) => {
    try {
      await window.neox.mcpDisconnect(serverId);
      setMcpConnectionStatus(prev => ({ ...prev, [serverId]: 'disconnected' }));
      setMcpToolCounts(prev => ({ ...prev, [serverId]: 0 }));
      setMcpServerTools(prev => ({ ...prev, [serverId]: [] }));
    } catch (err) {
      console.error('Failed to disconnect MCP server:', err);
    }
  };

  const handleMcpServerToggle = async (server: MCPServerEntry) => {
    const newEnabled = !server.enabled;
    try {
      await window.neox.mcpUpdate(server.scope, server.id, { enabled: newEnabled });
      loadMcpServers();
    } catch (err) {
      console.error('Failed to toggle MCP server:', err);
    }
  };

  const handleMcpDelete = async (server: MCPServerEntry) => {
    const ok = await confirmAsync({
      title: language === 'zh' ? '删除 MCP 服务器' : 'Delete MCP server',
      variant: 'danger',
      message: language === 'zh'
        ? <>确定删除 MCP 服务器 <strong>"{server.name || server.id}"</strong> 吗?</>
        : <>Delete MCP server <strong>"{server.name || server.id}"</strong>?</>,
      confirmLabel: language === 'zh' ? '删除' : 'Delete',
    });
    if (!ok) return;
    try {
      await window.neox.mcpRemove(server.scope, server.id);
      loadMcpServers();
    } catch (err) {
      console.error('Failed to delete MCP server:', err);
    }
  };

  const resetMcpForm = () => {
    setMcpFormId('');
    setMcpFormName('');
    setMcpFormTransport('stdio');
    setMcpFormCommand('');
    setMcpFormArgs('');
    setMcpFormUrl('');
    setMcpFormEnv('');
    setMcpFormScope('user');
    setMcpFormAutoConnect(true);
  };

  const handleMcpEdit = (server: MCPServerEntry) => {
    setEditingMcpServer(server);
    setMcpFormId(server.id);
    setMcpFormName(server.name || '');
    setMcpFormTransport(server.transport);
    setMcpFormCommand(server.command || '');
    setMcpFormArgs(server.args?.join(' ') || '');
    setMcpFormUrl(server.url || '');
    setMcpFormEnv(server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '');
    setMcpFormScope(server.scope);
    setMcpFormAutoConnect(server.autoConnect || false);
    setShowMcpAddForm(true);
  };

  const handleMcpSave = async () => {
    if (!mcpFormId.trim()) return;

    const envObj: Record<string, string> = {};
    if (mcpFormEnv.trim()) {
      mcpFormEnv.split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length > 0) {
          envObj[key.trim()] = rest.join('=').trim();
        }
      });
    }

    const serverConfig = {
      id: mcpFormId.trim(),
      name: mcpFormName.trim() || undefined,
      transport: mcpFormTransport,
      command: mcpFormTransport === 'stdio' ? mcpFormCommand.trim() : undefined,
      args: mcpFormTransport === 'stdio' && mcpFormArgs.trim() ? mcpFormArgs.trim().split(/\s+/) : undefined,
      url: mcpFormTransport !== 'stdio' ? mcpFormUrl.trim() : undefined,
      env: Object.keys(envObj).length > 0 ? envObj : undefined,
      autoConnect: mcpFormAutoConnect,
      enabled: true,
    };

    try {
      if (editingMcpServer) {
        await window.neox.mcpUpdate(mcpFormScope, mcpFormId, serverConfig);
        /* 改了命令 / 地址: 断开重连才用上新配置 */
        await window.neox.mcpDisconnect(serverConfig.id).catch(() => undefined);
      } else {
        await window.neox.mcpAdd(mcpFormScope, serverConfig);
        if (!mcpEnabled) await handleMcpToggle();
      }
      setShowMcpAddForm(false);
      setEditingMcpServer(null);
      resetMcpForm();
      await loadMcpServers();
      mcpStatusSyncedRef.current.add(serverConfig.id);
      void handleMcpConnect(serverConfig.id);
    } catch (err) {
      console.error('Failed to save MCP server:', err);
      dispatchOpFailed({ op: language === 'zh' ? '保存 MCP 服务器' : 'Save MCP server', message: (err as any)?.message || String(err) });
    }
  };

  // ==================== Skills 管理函数 ====================
  const loadSkills = async () => {
    setSkillsLoading(true);
    try {
      /* 并行拉 — skills 列出全部已注册的 (builtin/user/workspace),
       * installed metadata 仅商店装的 (K4 path 写过 .neox-skill.json 的). */
      const [list, metas] = await Promise.all([
        window.neox.skillsList(),
        (window.neox as any).skillsListInstalled?.() ?? Promise.resolve([]),
      ]);
      setSkills(list);
      const map: Record<string, any> = {};
      for (const m of (metas ?? [])) {
        if (m?.skillId) map[m.skillId] = m;
      }
      setInstalledMetas(map);
    } catch (error) {
      console.error('Failed to load skills:', error);
    } finally {
      setSkillsLoading(false);
    }
  };

  /* K4-MVP: skill 商店操作 — install / update / uninstall / trust / untrust. */
  const handleSkillK4Install = async (url: string) => {
    if (!url.trim()) return;
    const op = language === 'zh' ? '安装技能' : 'Install skill';
    try {
      const r = await (window.neox as any).skillsInstall(url.trim());
      if (!r?.success) {
        dispatchOpFailed({ op, message: r?.error ?? 'unknown' });
        return;
      }
      loadSkills();
    } catch (e: any) {
      dispatchOpFailed({ op, message: e?.message ?? String(e) });
    }
  };
  const handleSkillK4Update = async (skillId: string) => {
    const op = language === 'zh' ? '更新技能' : 'Update skill';
    try {
      const r = await (window.neox as any).skillsUpdate(skillId);
      if (!r?.success) {
        dispatchOpFailed({ op, message: r?.error ?? 'unknown' });
        return;
      }
      const msg = r.status === 'up_to_date'
        ? (language === 'zh' ? '已是最新版本' : 'Already up-to-date')
        : (language === 'zh' ? `已更新 ${r.previousVersion} → ${r.newVersion}` : `Updated ${r.previousVersion} → ${r.newVersion}`);
      dispatchHint(msg, 'success');
      loadSkills();
    } catch (e: any) {
      dispatchOpFailed({ op, message: e?.message ?? String(e) });
    }
  };
  const handleSkillK4Uninstall = async (skillId: string) => {
    if (!(await confirmAsync({
      title: language === 'zh' ? '卸载技能' : 'Uninstall Skill',
      message: language === 'zh' ? `确认卸载 ${skillId}?` : `Uninstall ${skillId}?`,
      confirmLabel: language === 'zh' ? '卸载' : 'Uninstall',
      variant: 'danger',
    }))) return;
    const op = language === 'zh' ? '卸载技能' : 'Uninstall skill';
    try {
      const r = await (window.neox as any).skillsUninstall(skillId);
      if (!r?.success) dispatchOpFailed({ op, message: r?.error ?? 'unknown' });
      loadSkills();
    } catch (e: any) {
      dispatchOpFailed({ op, message: e?.message ?? String(e) });
    }
  };
  const handleSkillK4Trust = async (skillId: string) => {
    if (!(await confirmAsync({
      title: language === 'zh' ? '信任技能' : 'Trust Skill',
      message: language === 'zh'
        ? `⚠ 信任后, ${skillId} 可以调用任意工具 (含 execute_shell). 确认?`
        : `⚠ Trusting allows ${skillId} to call ANY tool (including execute_shell). Confirm?`,
      confirmLabel: language === 'zh' ? '我了解风险, 信任' : 'I understand, trust',
      variant: 'danger',
    }))) return;
    const op = language === 'zh' ? '信任技能' : 'Trust skill';
    try {
      const r = await (window.neox as any).skillsTrust(skillId);
      if (!r?.success) dispatchOpFailed({ op, message: r?.error ?? 'unknown' });
      loadSkills();
    } catch (e: any) {
      dispatchOpFailed({ op, message: e?.message ?? String(e) });
    }
  };
  const handleSkillK4Untrust = async (skillId: string) => {
    const op = language === 'zh' ? '取消信任' : 'Untrust skill';
    try {
      const r = await (window.neox as any).skillsUntrust(skillId);
      if (!r?.success) dispatchOpFailed({ op, message: r?.error ?? 'unknown' });
      loadSkills();
    } catch (e: any) {
      dispatchOpFailed({ op, message: e?.message ?? String(e) });
    }
  };

  const handleSkillDelete = async (skillId: string, source: SkillSource) => {
    if (source === 'builtin') {
      dispatchOpFailed({
        op: language === 'zh' ? '删除技能' : 'Delete skill',
        message: language === 'zh' ? '无法删除内置技能' : 'Cannot delete built-in skills',
      });
      return;
    }
    if (!(await confirmAsync({
      title: language === 'zh' ? '删除技能' : 'Delete Skill',
      message: language === 'zh' ? `确定删除技能 "${skillId}" 吗？` : `Delete skill "${skillId}"?`,
      confirmLabel: language === 'zh' ? '删除' : 'Delete',
      variant: 'danger',
    }))) return;
    try {
      const result = await window.neox.skillsDelete(skillId);
      if (result.success) {
        loadSkills();
      } else {
        dispatchOpFailed({ op: language === 'zh' ? '删除技能' : 'Delete skill', message: result.error || 'Failed to delete' });
      }
    } catch (err) {
      console.error('Failed to delete skill:', err);
      dispatchOpFailed({ op: language === 'zh' ? '删除技能' : 'Delete skill', message: (err as any)?.message || String(err) });
    }
  };

  const resetSkillForm = () => {
    setSkillFormId('');
    setSkillFormName('');
    setSkillFormDesc('');
    setSkillFormInstructions('');
    setSkillFormCategory('custom');
    setSkillFormTarget('user');
  };

  const handleSkillView = async (skill: SkillInfo) => {
    setSelectedSkill(skill);
    setViewingSkill(skill);
  };

  const handleSkillEdit = async (skill: SkillInfo) => {
    if (skill.source !== 'builtin' && skill.path) {
      const raw = await (window.neox as any).skillsReadRaw?.(skill.id);
      if (!raw?.success) {
        dispatchOpFailed({
          op: language === 'zh' ? '编辑技能' : 'Edit skill',
          message: raw?.error || (language === 'zh' ? '读不到技能原文' : 'Could not read the skill file'),
        });
        return;
      }
    }
    setSelectedSkill(skill);
    setViewingSkill(skill);
  };

  // 技能导出
  const handleSkillExport = async (skill: SkillInfo) => {
    try {
      let content = `# ${skill.id}\n\n${skill.metadata?.description || ''}`;
      if (skill.path) {
        const result = await window.neox.readFile(skill.path);
        if (result?.success) {
          content = result.content || '';
        }
      }
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${skill.id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export skill:', err);
    }
  };

  const handleSkillImport = async () => {
    const op = language === 'zh' ? '导入技能' : 'Import skill';
    if (!skillImportUrl.trim()) {
      dispatchOpFailed({ op, message: language === 'zh' ? '请输入 URL' : 'Please enter a URL' });
      return;
    }
    try {
      if (skillImportTarget === 'user') {
        const r = await (window.neox as any).skillsInstall(skillImportUrl.trim());
        if (!r?.success) {
          dispatchOpFailed({ op, message: r?.error || (language === 'zh' ? '安装失败' : 'Install failed') });
          return;
        }
        setShowSkillImportForm(false);
        setSkillImportUrl('');
        setSkillPreview(null);
        loadSkills();
        return;
      }
      const result = await window.neox.skillsImportUrl(skillImportUrl.trim(), skillImportTarget);
      if (result.success) {
        setShowSkillImportForm(false);
        setSkillImportUrl('');
        loadSkills();
      } else {
        dispatchOpFailed({ op, message: result.error || 'Import failed' });
      }
    } catch (err) {
      console.error('Failed to import skill:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || (language === 'zh' ? '导入失败' : 'Import failed') });
    }
  };

  const handleSkillCreate = async () => {
    if (!skillFormId.trim() || !skillFormName.trim()) return;
    try {
      const result = await window.neox.skillsCreate({
        id: skillFormId.trim(),
        name: skillFormName.trim(),
        description: skillFormDesc.trim(),
        category: skillFormCategory,
        target: skillFormTarget,
        instructions: skillFormInstructions,
      });
      if (result.success) {
        setShowSkillAddForm(false);
        resetSkillForm();
        loadSkills();
      } else {
        dispatchOpFailed({ op: language === 'zh' ? '创建技能' : 'Create skill', message: result.error || 'Failed to create' });
      }
    } catch (err) {
      console.error('Failed to create skill:', err);
      dispatchOpFailed({ op: language === 'zh' ? '创建技能' : 'Create skill', message: (err as any)?.message || String(err) });
    }
  };

  const filteredSkills = skills.filter(skill => {
    if (skill.source === 'builtin') return false;
    if (skillFilterSource !== 'mine' && skillFilterSource !== 'all'
        && skill.source !== skillFilterSource) return false;
    if (skillFilterCategory !== 'all' && skill.metadata?.neox?.category !== skillFilterCategory) return false;
    return true;
  });

  /* K4-MVP A1: filteredSkills 按 (builtin / user-without-meta / installed-with-meta) 分 3 组.
   *   分组规则: 有 .neox-skill.json metadata = 商店装的 (无论 source); 否则按 source 分.
   *   workspace 装的也放 "我的" 段, 不单独切. */
  const skillGroups = React.useMemo(() => {
    const builtin: typeof filteredSkills = [];
    const mine: typeof filteredSkills = [];
    const installed: typeof filteredSkills = [];
    for (const s of filteredSkills) {
      if (installedMetas[s.id]) installed.push(s);
      else if (s.source === 'builtin') builtin.push(s);
      else mine.push(s);
    }
    return { builtin, mine, installed };
  }, [filteredSkills, installedMetas]);

  // ==================== 代码索引函数 ====================
  const loadIndexStats = async () => {
    setIndexLoading(true);
    try {
      const [stats, config] = await Promise.all([
        window.neox.indexGetStats(),
        window.neox.indexGetConfig?.(),
      ]);
      setIndexStats(stats);
      if (config?.excludePatterns) {
        setIndexExcludePatterns(config.excludePatterns);
      }
    } catch (error) {
      console.error('Failed to load index stats:', error);
    } finally {
      setIndexLoading(false);
    }
  };

  const saveIndexExcludePatterns = async (patterns: string[]) => {
    try {
      await window.neox.indexSetConfig?.({ excludePatterns: patterns });
    } catch (error) {
      console.error('Failed to save index config:', error);
      dispatchOpFailed({ op: language === 'zh' ? '保存索引配置' : 'Save index config', message: (error as any)?.message || String(error) });
    }
  };

  const handleBuildIndex = async (force: boolean = false) => {
    setIndexBuilding(true);
    setIndexBuildProgress(null);
    try {
      const result = await window.neox.indexBuild(force);
      if (result?.success) {
        loadIndexStats();
      } else {
        const detail = result?.errors?.length
          ? String(result.errors[0]?.error ?? '').slice(0, 120)
          : (language === 'zh' ? '索引服务没有响应' : 'The index service did not respond');
        console.error('Index build errors:', result?.errors ?? result);
        dispatchOpFailed({ op: language === 'zh' ? '构建索引' : 'Build index', message: detail });
      }
    } catch (error) {
      console.error('Failed to build index:', error);
      dispatchOpFailed({
        op: language === 'zh' ? '构建索引' : 'Build index',
        message: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      });
    } finally {
      setIndexBuilding(false);
      setIndexBuildProgress(null);
    }
  };

  const handleClearIndex = async () => {
    const ok = await confirmAsync({
      title: language === 'zh' ? '清除索引' : 'Clear index',
      variant: 'danger',
      message: language === 'zh' ? '确定清除整个项目的索引吗?' : 'Clear the entire project index?',
      description: language === 'zh'
        ? '清除后下次搜索 / 上下文召回会重新构建, 大型项目可能需要数分钟.'
        : 'Next search / context recall will rebuild from scratch (may take minutes on large projects).',
      confirmLabel: language === 'zh' ? '清除' : 'Clear',
    });
    if (!ok) return;
    try {
      await window.neox.indexClear();
      loadIndexStats();
    } catch (error) {
      console.error('Failed to clear index:', error);
    }
  };

  // 监听索引构建进度
  useEffect(() => {
    const unsubscribe = window.neox.onIndexProgress((progress) => {
      setIndexBuildProgress(progress);
    });
    return () => unsubscribe();
  }, []);

  // 切换到 index tab 时加载数据
  useEffect(() => {
    if (activeTab === 'codeindex') {
      loadIndexStats();
    }
  }, [activeTab]);

  // ==================== 记忆系统函数 ====================
  const loadMemoryStats = async () => {
    setMemoryLoading(true);
    try {
      const [stats, config] = await Promise.all([
        window.neox.memoryGetStats(),
        window.neox.memoryGetConfig(),
      ]);
      setMemoryStats(stats);
      setMemoryConfig(config);
    } catch (error) {
      console.error('Failed to load memory stats:', error);
    } finally {
      setMemoryLoading(false);
    }
  };

  const handleMemoryConfigChange = async (key: string, value: any) => {
    const newConfig = { ...memoryConfig, [key]: value };
    setMemoryConfig(newConfig);
    try {
      await window.neox.memorySetConfig({ [key]: value });
    } catch (error) {
      console.error('Failed to update memory config:', error);
    }
  };

  const loadMemoryPreview = async () => {
    try {
      const preview = await window.neox.memoryGetInjectionPreview();
      setMemoryPreview(preview);
      setShowMemoryPreview(true);
    } catch (error) {
      console.error('Failed to load memory preview:', error);
    }
  };

  // 记忆浏览功能
  /* overrideType: 点筛选片时**必须显式传**要切到的那个类型 ——
   * 调用方写的是 `setMemoryBrowseType(t); loadMemoryItems();`, setState 是异步的,
   * 这里读 memoryBrowseType 拿到的还是上一次的值 (经典 stale closure)。 */
  const loadMemoryItems = async (overrideType?: typeof memoryBrowseType) => {
    const t = overrideType ?? memoryBrowseType;
    try {
      const items = await window.neox.memoryBrowse?.({
        type: t === 'all' ? undefined : t,
        query: memorySearchQuery || undefined,
        limit: 50,
      });
      setMemoryItems(items || []);
    } catch (error) {
      console.error('Failed to browse memory:', error);
      setMemoryItems([]);
    }
  };

  const handleMemorySearch = () => {
    loadMemoryItems();
  };

  useEffect(() => {
    if (activeTab === 'memory') {
      loadMemoryStats();
      loadMemoryItems();
    }
  }, [activeTab]);

  // ==================== 上下文管理函数 ====================
  // 从 session 对象构建 byRole 数据
  const buildByRole = (bd: any) => {
    const details = bd?.details || {};
    const byRole: Record<string, { count?: number; tokens: number }> = {};
    if (bd?.systemTokens)  byRole.system    = { count: 1, tokens: bd.systemTokens };
    if (bd?.messageTokens) byRole.user      = { tokens: bd.messageTokens };
    if (bd?.toolTokens)    byRole.tool      = { tokens: bd.toolTokens };
    if (details.assistantTextTokens) {
      byRole.assistant = { tokens: details.assistantTextTokens };
      if (details.userTextTokens !== undefined) {
        byRole.user = { tokens: details.userTextTokens };
      }
    }
    return byRole;
  };

  /* 真条数: 会话消息里数一遍 (role 只有 user/assistant, 见 getSession 返回)。
   * 不阻塞首屏 —— 先把 token 那部分渲染出来, 条数到了再 patch 进去。 */
  const applyMessageCounts = (sessionId?: string | null) => {
    if (!sessionId) return;
    void Promise.resolve((window.neox as any).peekSession?.(sessionId) ?? null)
      .then((session: any) => {
        const msgs: any[] = Array.isArray(session?.messages) ? session.messages : [];
        if (!msgs.length) return;
        let user = 0, assistant = 0;
        for (const m of msgs) {
          if (m?.role === 'user') user++;
          else if (m?.role === 'assistant') assistant++;
        }
        setContextUsage((prev: any) => {
          if (!prev) return prev;
          const byRole = { ...(prev.byRole || {}) };
          byRole.user = { tokens: 0, ...(byRole.user || {}), count: user };
          byRole.assistant = { tokens: 0, ...(byRole.assistant || {}), count: assistant };
          return { ...prev, messageCount: msgs.length, byRole };
        });
      })
      .catch(() => { /* 取不到就保持空白, 不写假数 */ });
  };

  const loadContextConfig = async () => {
    setContextLoading(true);
    try {
      const withTimeout = <T,>(promise: Promise<T>, fallback: T, timeoutMs = 2500): Promise<T> =>
        Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
        ]);

      // 压缩配置（fire-and-forget，不阻塞数据加载）
      window.neox.contextGetConfig?.()
        ?.then((config: any) => { if (config) setContextConfig(config); })
        ?.catch(() => {});

      // ── contextWindow 与弹窗同源：直接取 snapshot（来自 selectedModel.contextWindow）──
      const snapshot = getContextSnapshot();
      const maxTokens = (snapshot?.contextWindow && snapshot.contextWindow > 0)
        ? snapshot.contextWindow : 128000;

      // 快照有 token 数据 → 直接用，不走 IPC
      if (snapshot && Number.isFinite(snapshot.tokensUsed) && snapshot.tokensUsed > 0) {
        const bd = snapshot.breakdown || {};
        const usageData = {
          currentTokens: snapshot.tokensUsed,
          maxTokens,
          usagePercent: maxTokens > 0 ? Math.round((snapshot.tokensUsed / maxTokens) * 100) : 0,
          messageCount: 0,
          byRole: buildByRole(bd),
          breakdown: bd,
          latestRequestUsage: snapshot.latestRequestUsage || null,
          sessionCache: snapshot.sessionCache || null,
        };
        setContextUsage(usageData as any);
        applyMessageCounts(snapshot?.sessionId);
        return;
      }

      // 快照无 token 数据 → IPC 补充 token 计数，但 contextWindow 仍以 snapshot 为准
      const usage = await withTimeout(
        window.neox.contextGetUsage?.('current') as Promise<any>,
        null as any,
      );
      if (usage) {
        const currentTokens = Math.max(usage.currentTokens || 0, 0);
        const bd = (usage as any).breakdown || {};
        setContextUsage({
          ...usage,
          currentTokens,
          maxTokens,
          usagePercent: maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 100) : 0,
          byRole: Object.keys((usage as any).byRole || {}).length > 0
            ? (usage as any).byRole
            : buildByRole(bd),
        } as any);
        applyMessageCounts(snapshot?.sessionId);
        return;
      }

      // 兜底
      setContextUsage({
        currentTokens: 0,
        maxTokens,
        usagePercent: 0,
        messageCount: 0,
      } as any);
    } catch (error) {
      console.error('[ContextTab] loadContextConfig error:', error);
    } finally {
      setContextLoading(false);
    }
  };

  const handleContextConfigChange = async (key: string, value: any) => {
    const newConfig = { ...contextConfig, [key]: value };
    setContextConfig(newConfig);
    try {
      /* P1-21: 透传 runtime push warning, 跟 P0-5 同款 */
      const r = await window.neox.contextSetConfig({ [key]: value });
      if ((r as { runtimeWarning?: string })?.runtimeWarning) {
        const m = await import('../../components/notifyEvents');
        m.dispatchHint(
          language === 'zh'
            ? '上下文配置已保存, 但当前会话未生效, 重启 app 后同步'
            : 'Context config saved — takes effect for new sessions after app restart',
          'warning',
        );
      }
    } catch (error) {
      console.error('Failed to update context config:', error);
      const m = await import('../../components/notifyEvents');
      m.dispatchHint(
        (language === 'zh' ? '上下文配置保存失败: ' : 'Failed to save context config: ')
        + (error instanceof Error ? error.message : String(error)),
        'warning',
      );
    }
  };

  // 切换到 context tab 时加载数据
  useEffect(() => {
    if (activeTab === 'context') {
      loadContextConfig();
    }
  }, [activeTab]);

  // remote tab 老占位 v1 删除, 'mobile' tab (label 远程访问) 自带 status 轮询不用这里
  useEffect(() => {
    if (activeTab === 'tts') {
      loadTtsConfig();
    }
    if (activeTab === 'experimental') {
      loadExperimentalConfig();
    }

    if (activeTab === 'runconfig') {
      loadRunconfigData();
    }

    if (activeTab === 'editor') {
      loadInlineCompletionConfig();
    }
  }, [activeTab]);

  // TTS 配置加载
  const loadTtsConfig = async () => {
    setTtsLoading(true);
    try {
      const config = await window.neox.ttsGetConfig?.();
      if (config) setTtsConfig(config);
    } catch (e) {
      console.error('Failed to load TTS config:', e);
    } finally {
      setTtsLoading(false);
    }
  };

  const handleTtsConfigChange = async (key: string, value: any) => {
    const updated = { ...ttsConfig, [key]: value };
    setTtsConfig(updated);
    try {
      /* P0-5: 透传 runtime push warning — config 已落盘, 但当前 session runtime 没收到时
       *  提示用户重启 app 生效, 而不是 silent. */
      const r = await window.neox.ttsSetConfig?.({ [key]: value });
      if ((r as { runtimeWarning?: string })?.runtimeWarning) {
        const m = await import('../../components/notifyEvents');
        m.dispatchHint(
          language === 'zh'
            ? 'TTS 已保存, 但当前会话未生效, 重启 app 后同步'
            : 'TTS saved — takes effect for new sessions after app restart',
          'warning',
        );
      }
    } catch (e) {
      console.error('Failed to update TTS config:', e);
      const m = await import('../../components/notifyEvents');
      m.dispatchHint(
        (language === 'zh' ? 'TTS 配置保存失败: ' : 'Failed to save TTS config: ')
        + (e instanceof Error ? e.message : String(e)),
        'warning',
      );
    }
  };

  // Experimental 配置加载
  const loadExperimentalConfig = async () => {
    setExperimentalLoading(true);
    try {
      const config = await window.neox.experimentalGetConfig?.();
      if (config) setExperimentalConfig(config);
    } catch (e) {
      console.error('Failed to load experimental config:', e);
    } finally {
      setExperimentalLoading(false);
    }
  };

  const handleExperimentalToggle = async (key: 'enableFGTS' | 'enablePTC' | 'enableCheckpoint') => {
    const newVal = !experimentalConfig[key];
    setExperimentalConfig({ ...experimentalConfig, [key]: newVal });
    try {
      await window.neox.experimentalSetConfig?.({ [key]: newVal });
    } catch (e) {
      console.error('Failed to update experimental config:', e);
    }
  };

  // ✦ Inline completion (Ghost Text) — load + persist
  const loadInlineCompletionConfig = async () => {
    try {
      const cfg = await (window as any).neox?.aiGetInlineCompleteConfig?.();
      if (cfg) setInlineCompletionConfig(cfg);
    } catch (e) {
      console.error('Failed to load inline completion config:', e);
    }
  };

  const updateInlineCompletionConfig = async (updates: {
    enabled?: boolean;
    providerId?: string | null;
    model?: string | null;
  }) => {
    try {
      await (window as any).neox?.aiSetInlineCompleteConfig?.(updates);
      // Re-read to pick up resolved `effective` fields (and any backend coercion).
      await loadInlineCompletionConfig();
    } catch (e) {
      console.error('Failed to save inline completion config:', e);
    }
  };

  // RunConfig 运行配置加载
  const loadRunconfigData = async () => {
    setRunconfigLoading(true);
    try {
      const data = await window.neox.runconfigGet?.();
      if (data) setRunconfigData(data);
    } catch (e) {
      console.error('Failed to load runconfig:', e);
    } finally {
      setRunconfigLoading(false);
    }
  };

  const handleRunconfigModeUpdate = async (mode: string, key: string, value: any) => {
    const currentModeConfig = runconfigData.modes?.[mode] || {};
    const updated = { ...currentModeConfig, [key]: value };
    setRunconfigData(prev => ({
      ...prev,
      modes: { ...prev.modes, [mode]: updated },
    }));
    try {
      await window.neox.runconfigSetModeConfig?.(mode, { [key]: value });
    } catch (e) {
      console.error('Failed to update runconfig:', e);
    }
  };

  // 进程管理函数
  const loadProcesses = async () => {
    setProcessesLoading(true);
    try {
      const list = await window.neox.processList?.() || [];
      setProcesses(list.map((p: any) => ({
        id: p.id,
        pid: p.pid,
        name: p.name,
        command: p.command,
        status: p.status,
        startTime: p.startTime,
        cwd: p.cwd,
      })));
    } catch (error) {
      console.error('Failed to load processes:', error);
    } finally {
      setProcessesLoading(false);
    }
  };

  const handleKillProcess = async (pid: number) => {
    try {
      await window.neox.processKill?.(pid);
      loadProcesses();
    } catch (error) {
      console.error('Failed to kill process:', error);
    }
  };

  // 切换路由开关
  const handleRoutingToggle = async () => {
    const newValue = !routingEnabled;
    setRoutingEnabled(newValue);
    try {
      await window.neox.setModelRoutingEnabled(newValue);
      notifyProvidersChanged(); // 通知模型列表更新
    } catch (err) {
      console.error('Failed to toggle routing:', err);
      setRoutingEnabled(!newValue); // 回滚
    }
  };

  // 删除路由
  const handleDeleteRoute = async (modelAlias: string) => {
    const ok = await confirmAsync({
      title: '删除模型路由',
      variant: 'danger',
      message: <>确定删除模型 <strong>"{modelAlias}"</strong> 的路由配置吗?</>,
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await window.neox.deleteModelRoute(modelAlias);
      loadRoutingConfig();
      notifyProvidersChanged();
    } catch (err) {
      console.error('Failed to delete route:', err);
    }
  };

  // 保存路由
  const handleSaveRoute = async () => {
    if (!routeFormAlias.trim()) {
      dispatchOpFailed({ op: '保存路由', message: '请输入模型别名' });
      return;
    }
    if (routeFormProviders.length < 2) {
      dispatchOpFailed({ op: '保存路由', message: '至少需要配置 2 个 Provider' });
      return;
    }

    const route: ModelRouteConfig = {
      modelAlias: routeFormAlias.trim(),
      displayName: routeFormAlias.trim(),
      routes: routeFormProviders.map((p, i) => ({
        ...p,
        priority: i + 1,
      })),
      strategy: routeFormStrategy,
      autoFailover: true,
    };

    try {
      await window.neox.setModelRoute(route.modelAlias, route);
      setShowAddRouteForm(false);
      setEditingRoute(null);
      resetRouteForm();
      loadRoutingConfig();
      notifyProvidersChanged();
    } catch (err) {
      console.error('Failed to save route:', err);
    }
  };

  // 重置路由表单
  const resetRouteForm = () => {
    setRouteFormAlias('');
    setRouteFormStrategy('priority');
    setRouteFormProviders([]);
    setDraggedIndex(null);
  };

  // 添加 Provider 到路由
  const handleAddProviderToRoute = (providerId: string, modelName: string) => {
    if (routeFormProviders.some(p => p.providerId === providerId)) {
      dispatchOpFailed({ op: '添加 Provider 到路由', message: '该 Provider 已添加' });
      return;
    }
    setRouteFormProviders([
      ...routeFormProviders,
      { providerId, modelName, priority: routeFormProviders.length + 1, enabled: true },
    ]);
  };

  // 移除 Provider 从路由
  const handleRemoveProviderFromRoute = (index: number) => {
    setRouteFormProviders(routeFormProviders.filter((_, i) => i !== index));
  };

  // 拖拽排序处理
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newProviders = [...routeFormProviders];
    const [draggedItem] = newProviders.splice(draggedIndex, 1);
    newProviders.splice(index, 0, draggedItem);

    // 更新优先级
    const updatedProviders = newProviders.map((p, i) => ({ ...p, priority: i + 1 }));
    setRouteFormProviders(updatedProviders);
    setDraggedIndex(index);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  const updateProviderDropdownPosition = useCallback(() => {
    const trigger = dropdownTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 360), window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(rect.left, viewportPadding), window.innerWidth - width - viewportPadding);
    const spaceBelow = window.innerHeight - rect.bottom;
    const maxHeight = Math.min(320, Math.max(140, spaceBelow - gap - viewportPadding));
    setDropdownPosition({
      top: rect.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, []);

  // Provider 下拉框点击外部关闭
  useEffect(() => {
    const handlePointerOutside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (providerDropdownRef.current?.contains(target)) return;
      if (providerDropdownMenuRef.current?.contains(target)) return;
      setProviderDropdownOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProviderDropdownOpen(false);
    };
    if (providerDropdownOpen) {
      updateProviderDropdownPosition();
      document.addEventListener('pointerdown', handlePointerOutside, true);
      document.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('scroll', updateProviderDropdownPosition, true);
      window.addEventListener('resize', updateProviderDropdownPosition);
    }
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', updateProviderDropdownPosition, true);
      window.removeEventListener('resize', updateProviderDropdownPosition);
    };
  }, [providerDropdownOpen, updateProviderDropdownPosition]);

  // 选择 Provider 添加到路由
  const handleSelectProviderModel = (providerId: string, modelName: string) => {
    handleAddProviderToRoute(providerId, modelName);
    setProviderDropdownOpen(false);
  };

  // 打开/关闭 Provider 下拉框
  const toggleProviderDropdown = () => {
    if (!providerDropdownOpen) {
      updateProviderDropdownPosition();
    }
    setProviderDropdownOpen(open => !open);
  };

  // 获取 Provider 健康状态
  const getProviderHealthStatus = (providerId: string): { status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; latency?: number } => {
    const health = healthMap[providerId];
    if (!health) return { status: 'unknown' };
    const current = health.current ?? health.status;
    if (!current) return { status: 'unknown' };
    if (current === 'excellent' || current === 'good') {
      return { status: 'healthy', latency: health.latency };
    }
    if (current === 'poor' || current === 'testing') {
      return { status: 'degraded', latency: health.latency };
    }
    return {
      status: 'unhealthy',
      latency: health.latency,
    };
  };

  // 加载定价配置
  const loadPricingConfig = async () => {
    setPricingLoading(true);
    try {
      const pricing = await window.neox.pricingGetAll?.() || [];
      setPricingList(
        (Array.isArray(pricing) ? pricing : []).filter(
          (p: { pattern?: string } | null | undefined) =>
            !!p && typeof p.pattern === 'string' && p.pattern.length > 0,
        ),
      );
    } catch (err) {
      console.error('Failed to load pricing config:', err);
    }
    setPricingLoading(false);
  };

  // 保存定价配置
  const savePricing = async (pricing: { pattern: string; inputPrice: number; outputPrice: number; cachedInputPrice?: number }) => {
    try {
      await window.neox.pricingUpsert?.(pricing);
      await loadPricingConfig();
    } catch (err) {
      console.error('Failed to save pricing:', err);
    }
  };

  // 删除定价配置
  const deletePricing = async (pattern: string) => {
    try {
      await window.neox.pricingDelete?.(pattern);
      await loadPricingConfig();
    } catch (err) {
      console.error('Failed to delete pricing:', err);
    }
  };

  const usageSourceMountedRef = useRef(false);
  useEffect(() => {
    if (!usageSourceMountedRef.current) { usageSourceMountedRef.current = true; return; }
    void loadUsageStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageSource]);

  const prevMembershipPlanRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevMembershipPlanRef.current;
    prevMembershipPlanRef.current = membershipPlanId;
    if (membershipPlanId && membershipPlanId !== prev) {
      setUsageHasMembership(true);
      if (usageSource === 'cloud') {
        void loadUsageStats();
      }
    } else if (!membershipPlanId && prev) {
      /* 登出 / membership 被清 */
      setUsageHasMembership(false);
      void loadUsageStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipPlanId]);

  // 加载使用统计
  //   NeoxCloud 模式 (已登录 + membership 存在) → 走云端 /api/v1/usage/summary,
  //     一切 token 累积来自 gateway 真实计费, 本地 SQLite 不再读
  //   BYOK 第三方模式 → 走原本地 IPC (tokenUsageService SQLite)
  const loadUsageStats = async () => {
    setUsageLoading(true);
    /* 已登录但 membership 还在路上 → 等一次刷新, 避免误判成本地模式 */
    let mem = getEditionHook('getMembershipNow')();
    if (!mem && getEditionHook('isAuthenticated')()) {
      try {
        mem = await getEditionHook('refreshMembership')();
      } catch {
        mem = getEditionHook('getMembershipNow')();
      }
    }
    const hasMembership = !!mem;
    setUsageHasMembership(hasMembership);
    /* 登录了也可以主动看本地那份 —— 切换器选了 local 就走本地 IPC。 */
    const isCloudMode = hasMembership && usageSource === 'cloud';
    setUsageIsCloud(isCloudMode);
    /* 兜底: 任何路径漏 setUsageLoading(false) (e.g. 上游 hang 远过预期) 都不会让 UI
     *   永久转圈. usage/summary 超时 20s × withRetry 2 次 + 退避 ≈ 41s, 给 50s 余量. */
    const watchdog = window.setTimeout(() => {
      console.warn('[UsageTab] loadUsageStats watchdog fired — force exit loading');
      setUsageLoading(false);
    }, 50_000);
    try {
      if (isCloudMode) {
        /* 发行版实现: 拉云端汇总 → 换算成本地形状, 并顺手刷新订阅面板用的 cloudUsageStore */
        const { summary, providerStats: cloudStats } = await getEditionHook('loadCloudUsage')(30);
        setUsageSummary(summary);
        setProviderStats(cloudStats);
        /* 云端模式下"费用估算"那套基于本地 pricingGetAll 的逻辑不适用 —
         *   云端按窗口限额计费, 服务端只下发百分比 (percentOfWeekly), 不下发单价,
         *   客户端根本估不出金额。所以这里清掉估算, 用量看 UsageTab 的窗口面板。 */
        setCostEstimate(null);
        setCloudUsageError(null);
        setCloudUsageLastSuccessAt(Date.now());
      } else {
        const [summary, stats] = await Promise.all([
          window.neox.getUsageSummary(),
          window.neox.getProviderUsageStats(),
        ]);
        setUsageSummary(summary);
        setProviderStats(stats);
        await calculateCostFromPricing(stats);
        setCloudUsageError(null);
      }
    } catch (err) {
      console.error('Failed to load usage stats:', err);
      if (isCloudMode) {
        const e = err as { code?: string; name?: string; message?: string } | null;
        const code = e?.code || e?.name || e?.message || 'NETWORK_ERROR';
        setCloudUsageError(String(code).slice(0, 64));
      }
    } finally {
      clearTimeout(watchdog);
      setUsageLoading(false);
    }
  };

  // 基于定价配置计算费用
  const calculateCostFromPricing = async (stats: ProviderUsageStats[]) => {
    try {
      const pricing = ((await window.neox.pricingGetAll?.()) || []).filter(
        (p: { pattern?: string } | null | undefined): p is { pattern: string; inputPrice: number; outputPrice: number; cachedInputPrice?: number } =>
          !!p && typeof p.pattern === 'string' && p.pattern.length > 0,
      );
      if (pricing.length === 0 || stats.length === 0) {
        setCostEstimate(null);
        return;
      }

      let totalCost = 0;
      for (const stat of stats) {
        // 按模型计算费用
        for (const [model, modelStat] of Object.entries(stat.models || {})) {
          const matchedPricing = pricing.find((p) => {
            if (p.pattern === model) return true;
            if (p.pattern.includes('*')) {
              const regex = new RegExp('^' + p.pattern.replace(/\*/g, '.*') + '$');
              return regex.test(model);
            }
            return false;
          });

          if (matchedPricing) {
            const billableInputTokens = modelStat.billableInputTokens ?? modelStat.inputTokens ?? 0;
            const cacheReadTokens = modelStat.cacheReadTokens || modelStat.cachedTokens || 0;
            const cacheWriteTokens = modelStat.cacheWriteTokens || 0;
            const inputCost = (billableInputTokens / 1_000_000) * matchedPricing.inputPrice;
            const outputCost = (modelStat.outputTokens || 0) / 1_000_000 * matchedPricing.outputPrice;
            const cacheReadCost = matchedPricing.cachedInputPrice !== undefined
              ? (cacheReadTokens / 1_000_000) * matchedPricing.cachedInputPrice
              : 0;
            const cacheWriteCost = (cacheWriteTokens / 1_000_000) * matchedPricing.inputPrice * 1.25;
            totalCost += inputCost + outputCost + cacheReadCost + cacheWriteCost;
          }
        }
      }

      // 估算日/周/月费用（基于总费用和时间范围）
      const daysSinceStart = Math.max(1, Math.ceil(
        (Date.now() - (stats[0]?.firstRequestTime || Date.now())) / (1000 * 60 * 60 * 24)
      ));
      const dailyAvg = totalCost / daysSinceStart;

      setCostEstimate({
        daily: dailyAvg,
        weekly: dailyAvg * 7,
        monthly: dailyAvg * 30,
      });
    } catch (err) {
      console.error('Failed to calculate cost:', err);
    }
  };

  // 加载 provider 详细记录
  const loadProviderRecords = async (provider: string) => {
    try {
      const records = await window.neox.getProviderUsageRecords(provider, 100);
      setSelectedProviderRecords({ provider, records });
    } catch (err) {
      console.error('Failed to load provider records:', err);
    }
  };

  // 清除所有使用统计
  const clearAllUsageStats = async () => {
    const ok = await confirmAsync({
      title: language === 'zh' ? '清除所有使用统计' : 'Clear all usage stats',
      variant: 'danger',
      message: t.settings.usage.clearAllConfirm,
      confirmLabel: language === 'zh' ? '清除' : 'Clear',
    });
    if (!ok) return;
    try {
      await window.neox.clearUsageStats();
      loadUsageStats();
    } catch (err) {
      console.error('Failed to clear usage stats:', err);
    }
  };

  // 清除单个 provider 的统计
  const clearProviderUsageStats = async (provider: string) => {
    const ok = await confirmAsync({
      title: language === 'zh' ? '清除 Provider 统计' : 'Clear provider stats',
      variant: 'danger',
      message: t.settings.usage.clearProviderConfirm,
      confirmLabel: language === 'zh' ? '清除' : 'Clear',
    });
    if (!ok) return;
    try {
      await window.neox.clearProviderUsageStats(provider);
      loadUsageStats();
      setSelectedProviderRecords(null);
    } catch (err) {
      console.error('Failed to clear provider stats:', err);
    }
  };

  // 导出使用统计报告
  const exportUsageReport = async () => {
    if (!usageSummary || !providerStats.length) return;

    const report = {
      exportTime: new Date().toISOString(),
      summary: usageSummary,
      providerStats: providerStats,
    };

    const content = JSON.stringify(report, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neox-usage-report-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 计算 Provider 分布数据
  const getProviderDistribution = () => {
    if (!providerStats.length) return [];
    const total = providerStats.reduce((sum, s) => sum + s.totalTokens, 0);
    return providerStats.map(s => ({
      name: s.provider,
      tokens: s.totalTokens,
      percent: total > 0 ? (s.totalTokens / total * 100) : 0,
      requests: s.totalRequests,
    })).sort((a, b) => b.tokens - a.tokens);
  };

  // 计算 Model 分布数据
  const getModelDistribution = () => {
    if (!providerStats.length) return [];
    const modelMap: Record<string, { tokens: number; requests: number }> = {};
    providerStats.forEach(stat => {
      Object.entries(stat.models).forEach(([model, data]) => {
        if (!modelMap[model]) {
          modelMap[model] = { tokens: 0, requests: 0 };
        }
        modelMap[model].tokens += data.totalTokens;
        modelMap[model].requests += data.requests;
      });
    });
    const total = Object.values(modelMap).reduce((sum, m) => sum + m.tokens, 0);
    return Object.entries(modelMap)
      .map(([name, data]) => ({
        name,
        tokens: data.tokens,
        percent: total > 0 ? (data.tokens / total * 100) : 0,
        requests: data.requests,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
  };

  // 格式化 Token 数量（自动 K/M 单位）
  const formatTokenCount = (count: number): string => {
    if (count >= 1000000) {
      const value = count / 1000000;
      const nearest = Math.round(value);
      if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
      const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
      return `${formatted}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  };

  // 格式化时间
  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return language === 'zh' ? '刚刚' : 'Just now';
    if (diffMins < 60) return language === 'zh' ? `${diffMins} 分钟前` : `${diffMins}m ago`;
    if (diffHours < 24) return language === 'zh' ? `${diffHours} 小时前` : `${diffHours}h ago`;
    if (diffDays < 7) return language === 'zh' ? `${diffDays} 天前` : `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 展开/收起目录
  const toggleDir = async (dirPath: string) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
      // 加载目录内容
      if (!dirContents[dirPath]) {
        try {
          const files = await window.neox.listConfigDir(dirPath);
          setDirContents(prev => ({ ...prev, [dirPath]: files }));
        } catch (err) {
          console.error('Failed to list directory:', err);
        }
      }
    }
    setExpandedDirs(newExpanded);
  };

  // 预览文件内容
  const previewConfigFile = async (filePath: string, fileName: string) => {
    setPreviewLoading(true);
    try {
      const result = await window.neox.readConfigFile(filePath);
      if (result.error) {
        setPreviewFile({ path: filePath, content: `Error: ${result.error}`, name: fileName });
      } else {
        setPreviewFile({ path: filePath, content: result.content, name: fileName });
      }
    } catch (err: any) {
      setPreviewFile({ path: filePath, content: `Error: ${err.message}`, name: fileName });
    }
    setPreviewLoading(false);
  };

  // 在系统文件管理器中打开
  const openInFinder = async (filePath: string) => {
    try {
      await window.neox.openInFinder(filePath);
    } catch (err) {
      console.error('Failed to open in Finder:', err);
    }
  };

  const handlePiiFilterChange = async (enabled: boolean) => {
    try {
      await window.neox.setPiiFilterPreference(enabled);
      setPiiFilterEnabled(enabled);
      window.dispatchEvent(new CustomEvent('pii-filter-change', { detail: enabled }));
    } catch (err) {
      console.error('Failed to update PII filter preference:', err);
    }
  };

  // Agent 设置处理函数
  const handleSandboxChange = async (enabled: boolean) => {
    try {
      await window.neox.setAgentSettings({ sandboxEnabled: enabled });
      try {
        /* sessionId 这一位服务端直接忽略 (setSandboxMode(_sessionId, enabled) —— 沙箱是
           全局开关不是 per-session), 传个可辨识的占位值, 别假装它有作用域。 */
        await (window.neox as any).setSandboxStatus?.('__neox_global_sandbox__', enabled, undefined);
      } catch (e) {
        console.error('Failed to push sandbox mode to runtime:', e);
        dispatchOpFailed({
          op: language === 'zh' ? '切换沙箱模式' : 'Change sandbox mode',
          message: (e as any)?.message || String(e),
        });
      }
      setSandboxEnabled(enabled);
      window.dispatchEvent(new CustomEvent('agent-settings-change', { detail: { sandboxEnabled: enabled } }));
    } catch (err) {
      console.error('Failed to update sandbox setting:', err);
    }
  };

  const handleApprovalModeChange = async (mode: 'auto' | 'manual' | 'dangerous') => {
    try {
      await applyApprovalMode(null, mode);
      await window.neox.setAgentSettings({ approvalMode: mode });
      setApprovalMode(mode);
      window.dispatchEvent(new CustomEvent('agent-settings-change', { detail: { approvalMode: mode } }));
    } catch (err) {
      console.error('Failed to update approval mode:', err);
      dispatchOpFailed({
        op: language === 'zh' ? '切换审批模式' : 'Change approval mode',
        message: (err as any)?.message || String(err),
      });
    }
  };

  // 获取不同协议的默认 URL 后缀
  const getDefaultUrlSuffix = (protocol: ProviderProtocol): string => {
    switch (protocol) {
      case 'openai':
        return '/chat/completions';
      case 'openai-responses':
        return '/responses';
      case 'anthropic':
        return '/v1/messages';
      case 'anthropic-openai':
        return '/v1/messages';
      case 'doubao':
        return '/chat/completions';
      case 'gemini':
        return '/v1beta/models';
      case 'kimi':
      case 'deepseek':
      case 'minimax':
      case 'qwen':
      case 'glm':
        return '/chat/completions';
      default:
        return '/chat/completions';
    }
  };

  /* 不同协议的官方 base URL — placeholder + 保存兜底都走这.
   *   原硬编码 'https://api.openai.com/v1' 不管选什么协议都显示 openai, 误导用户.
   *   跟 electron/ipc/providerModelHandlers.ts:DEFAULT_MODEL_LIST_BASE_URL 保持同源 — 两边都要改. */
  const getDefaultBaseUrl = (protocol: ProviderProtocol): string => {
    switch (protocol) {
      case 'openai':
      case 'openai-responses':
        return 'https://api.openai.com/v1';
      case 'anthropic':
        return 'https://api.anthropic.com';
      case 'anthropic-openai':
        return 'https://api.anthropic.com/v1';
      case 'doubao':
        return 'https://ark.cn-beijing.volces.com/api/v3';
      case 'gemini':
        return 'https://generativelanguage.googleapis.com';
      case 'kimi':
        return 'https://api.moonshot.cn/v1';
      case 'deepseek':
        return 'https://api.deepseek.com';
      case 'minimax':
        return 'https://api.minimax.chat/v1';
      case 'qwen':
        return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      case 'glm':
        return 'https://open.bigmodel.cn/api/paas/v4';
      default:
        return 'https://api.openai.com/v1';
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormProtocol('openai');
    setFormApiKey('');
    setFormBaseUrl('');
    setFormUrlSuffix(getDefaultUrlSuffix('openai'));
    setFormMaxTokens('8192');
    setFormMaxInputTokens('');
    setFormModels([]);
    setFormShowInModelPicker(true);
    setFormClaudeCodeMode('auto');
    setFormPresetId('');
    setFormImageEditFormat('');
    setFormTabs([{ protocol: 'openai', apiKey: '', models: undefined, baseUrl: undefined }]);
    setModelSearchQuery('');
    setShowModelDropdown(false);
    setModelDropdownTab('common');
    setRemoteModelOptions([]);
    setRemoteModelsError(null);
    setRemoteModelsSourceUrl(null);
    setRemoteModelsFetchedAt(null);
    setRemoteModelsLoading(false);
  };

  useEffect(() => {
    setRemoteModelOptions([]);
    setRemoteModelsError(null);
    setRemoteModelsSourceUrl(null);
    setRemoteModelsFetchedAt(null);
    setModelDropdownTab('common');
  }, [formProtocol, formBaseUrl, formUrlSuffix, formApiKey, editingProvider?.id]);

  useEffect(() => {
    if (activeTab !== 'providers' || loading || showAddForm || editingProvider) return;

    let action: string | null = null;
    try {
      action = localStorage.getItem(SETTINGS_PROVIDER_ACTION_KEY);
      if (action) localStorage.removeItem(SETTINGS_PROVIDER_ACTION_KEY);
    } catch {
      return;
    }
    if (action !== 'add-provider-if-empty') return;

    const hasByokProvider = providers.some(p => p.id !== NEOX_CLOUD_PROVIDER_ID);
    if (!hasByokProvider) {
      resetForm();
      setShowAddForm(true);
    }
  }, [activeTab, loading, showAddForm, editingProvider, providers]);

  /* Provider 表单公共校验 (add/update 共用): baseUrl 合法性 + maxTokens/maxInputTokens 正整数.
   * 返回错误文案 (null = 通过), 由调用方走 dispatchOpFailed 提示具体字段. */
  const validateProviderForm = (): string | null => {
    const baseUrl = formBaseUrl.trim();
    if (baseUrl) {
      try {
        new URL(baseUrl);
      } catch {
        return language === 'zh' ? 'Base URL 不是合法的 URL' : 'Base URL is not a valid URL';
      }
    }
    if (formMaxTokens.trim()) {
      const n = parseInt(formMaxTokens, 10);
      if (Number.isNaN(n) || n <= 0) {
        return language === 'zh' ? 'Max Tokens 必须是正整数' : 'Max Tokens must be a positive integer';
      }
    }
    if (formMaxInputTokens.trim()) {
      const n = parseInt(formMaxInputTokens, 10);
      if (Number.isNaN(n) || n <= 0) {
        return language === 'zh' ? 'Max Input Tokens 必须是正整数' : 'Max Input Tokens must be a positive integer';
      }
    }
    return null;
  };

  const handleAddProvider = async () => {
    const op = language === 'zh' ? '添加 Provider' : 'Add provider';
    if (!formName.trim()) {
      dispatchOpFailed({ op, message: language === 'zh' ? '名称必填' : 'Name is required' });
      return;
    }
    if (!(formTabs[0]?.apiKey || '').trim()) {
      dispatchOpFailed({ op, message: language === 'zh' ? 'API Key 必填' : 'API Key is required' });
      return;
    }
    if (formTabs.some(t => (t.protocol && !(t.apiKey || '').trim()))) {
      dispatchOpFailed({ op, message: language === 'zh' ? '每个 Tab 都要填 API Key' : 'Every tab needs an API Key' });
      return;
    }

    if (formModels.length === 0 && !formTabs.some(t => (t.models || []).length > 0)) {
      dispatchOpFailed({ op, message: language === 'zh' ? '至少需要一个模型' : 'At least one model is required' });
      return;
    }

    const formError = validateProviderForm();
    if (formError) {
      dispatchOpFailed({ op, message: formError });
      return;
    }


    try {
      const { PROVIDER_PRESETS } = await import('@neoxlabs/kernel/models/providerPresets.js');
      const preset = formPresetId ? PROVIDER_PRESETS.find(p => p.id === formPresetId) : undefined;
      const extraHeaders = preset?.extraHeadersHint;
      const capabilities = preset?.capabilities;
      /* Tab: 主 Tab (formTabs[0]) 镜像扁平 protocol/apiKey; >1 Tab 才落 channels[]。 */
      const primaryTab = formTabs[0] || { protocol: formProtocol, apiKey: formApiKey };
      const channels = tabsToChannels(formTabs);
      /* 账户 models = 所有 Tab 模型的并集 (+ 当前 formModels 兜底最新)。 */
      const allModels = Array.from(new Set([...formTabs.flatMap(t => t.models || []), ...formModels]));

      const byokProviderCount = providers.filter(p => p.id !== NEOX_CLOUD_PROVIDER_ID).length;
      const created = await window.neox.addProvider({
        name: formName.trim(),
        protocol: primaryTab.protocol as any,
        apiKey: (primaryTab.apiKey || '').trim(),
        channels,
        baseUrl: formBaseUrl.trim() || undefined,
        urlSuffix: formUrlSuffix.trim() || getDefaultUrlSuffix(primaryTab.protocol as any),
        maxTokens: formMaxTokens ? parseInt(formMaxTokens) : undefined,
        maxInputTokens: formMaxInputTokens ? parseInt(formMaxInputTokens) : undefined,
        models: allModels,
        setAsDefault: byokProviderCount === 0,
        /* 任一 Tab 是 anthropic 就存身份策略, 其它 undefined 避免污染 */
        claudeCodeMode: formTabs.some(t => t.protocol === 'anthropic') ? formClaudeCodeMode : undefined,
        presetId: formPresetId || undefined,
        capabilities,
        extraHeaders,
        imageEditFormat: formImageEditFormat || undefined,
      } as any);
      if (created?.id) {
        setByokPinned(created.id, formShowInModelPicker);
      }
      await loadProviders();
      notifyProvidersChanged();
      setShowAddForm(false);
      resetForm();
    } catch (err: any) {
      dispatchOpFailed({ op, message: err?.message || 'Failed to add provider' });
    }
  };

  const handleUpdateProvider = async () => {
    if (!editingProvider) return;
    const op = language === 'zh' ? '更新 Provider' : 'Update provider';

    /* 编辑时 apiKey 留空 = 不修改 (传 undefined), 但 name 是表单预填的, 清空视为非法. */
    if (!formName.trim()) {
      dispatchOpFailed({ op, message: language === 'zh' ? '名称必填' : 'Name is required' });
      return;
    }

    if (formModels.length === 0 && !formTabs.some(t => (t.models || []).length > 0)) {
      dispatchOpFailed({ op, message: language === 'zh' ? '至少需要一个模型' : 'At least one model is required' });
      return;
    }

    const formError = validateProviderForm();
    if (formError) {
      dispatchOpFailed({ op, message: formError });
      return;
    }


    try {
      // 更新基本信息
      const primaryTab = formTabs[0] || { protocol: formProtocol, apiKey: formApiKey };
      await window.neox.updateProvider(editingProvider.id, {
        name: formName.trim() || undefined,
        protocol: primaryTab.protocol as any,
        apiKey: (primaryTab.apiKey || '').trim() || undefined,
        channels: tabsToChannels(formTabs),
        baseUrl: formBaseUrl.trim() || undefined,
        urlSuffix: formUrlSuffix.trim() || getDefaultUrlSuffix(primaryTab.protocol as any),
        maxTokens: formMaxTokens ? parseInt(formMaxTokens) : undefined,
        maxInputTokens: formMaxInputTokens ? parseInt(formMaxInputTokens) : undefined,
        /* 任一 Tab 是 anthropic 就存身份策略 (账户级, 应用到该协议的 Tab)。 */
        claudeCodeMode: formTabs.some(t => t.protocol === 'anthropic') ? formClaudeCodeMode : undefined,
        imageEditFormat: formImageEditFormat || undefined,
      } as any);

      // 处理模型变化 —— 账户 models = 所有 Tab 模型并集 (+ 当前 formModels 最新)。
      const unionModels = Array.from(new Set([...formTabs.flatMap(t => t.models || []), ...formModels]));
      const oldModels = editingProvider.models.map(m => m.name);
      const toAdd = unionModels.filter(m => !oldModels.includes(m));
      const toRemove = oldModels.filter(m => !unionModels.includes(m));

      for (const model of toAdd) {
        await window.neox.addModel(editingProvider.id, model);
      }
      for (const model of toRemove) {
        await window.neox.removeModel(editingProvider.id, model);
      }

      setByokPinned(editingProvider.id, formShowInModelPicker);
      await loadProviders();
      notifyProvidersChanged();
      setEditingProvider(null);
      resetForm();
    } catch (err: any) {
      /* 走 FromError 而不是手拼 message: 它会剥掉 IPC 管道前缀 + 命中 code 时按语言翻译。
       * 手拼那条路把 "Error invoking remote method 'model:add': NeoxError: …" 原样弹了出来。 */
      dispatchOpFailedFromError(op, err, 'Failed to update provider');
    }
  };

  const handleDeleteProvider = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirmAsync({
      title: language === 'zh' ? '删除 Provider' : 'Delete Provider',
      message: language === 'zh' ? '确定删除该 Provider 吗?' : 'Are you sure you want to delete this provider?',
      confirmLabel: language === 'zh' ? '删除' : 'Delete',
      variant: 'danger',
    }))) return;
    try {
      await window.neox.deleteProvider(id);
      clearByokPinned(id);
      await loadProviders();
      notifyProvidersChanged();
    } catch (err: any) {
      dispatchOpFailed({ op: language === 'zh' ? '删除 Provider' : 'Delete provider', message: err?.message || 'Failed to delete provider' });
    }
  };

  /* 批量删除 —— 一次确认, 逐个删; 中途失败的报出来, 删掉的照样生效。
   * 不能复用上面那个: 它每个 id 都弹一次确认, 选 8 个就要点 8 次。 */
  const handleDeleteProviders = async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const zh = language === 'zh';
    if (!(await confirmAsync({
      title: zh ? `删除 ${ids.length} 个服务商` : `Delete ${ids.length} providers`,
      message: zh ? '它们的 API Key 和模型配置会一起删掉, 不能撤销。' : 'Their API keys and model settings will be removed. This cannot be undone.',
      confirmLabel: zh ? '删除' : 'Delete',
      variant: 'danger',
    }))) return false;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await window.neox.deleteProvider(id);
        clearByokPinned(id);
      } catch (err: any) {
        failed.push(`${providers.find(p => p.id === id)?.name ?? id}: ${err?.message || err}`);
      }
    }
    await loadProviders();
    notifyProvidersChanged();
    if (failed.length) {
      dispatchOpFailed({ op: zh ? '批量删除服务商' : 'Delete providers', message: failed.join('\n') });
    }
    return true;
  };

  const handleSetDefault = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.neox.setDefaultProvider(id);
      await loadProviders();
      notifyProvidersChanged();
    } catch (err: any) {
      dispatchOpFailed({ op: language === 'zh' ? '设为默认 Provider' : 'Set default provider', message: err?.message || 'Failed to set default provider' });
    }
  };

  const openEditModal = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setFormName(provider.name);
    setFormProtocol(provider.protocol);
    setFormApiKey('');
    setFormBaseUrl(provider.baseUrl || '');
    setFormUrlSuffix(provider.urlSuffix || getDefaultUrlSuffix(provider.protocol));
    setFormMaxTokens(provider.maxTokens?.toString() || '16384');
    setFormMaxInputTokens(provider.maxInputTokens?.toString() || '');
    setFormShowInModelPicker(isByokPinned(provider.id));
    /* 老 provider 没写 claudeCodeMode 时视作 'auto' (向后兼容). 只对 anthropic 有效, 其它 protocol
     *   的老 provider 就算存了 undefined, UI 不渲染, 保存时也传 undefined 不会污染. */
    setFormClaudeCodeMode(((provider as any).claudeCodeMode as 'auto' | 'on' | 'off' | undefined) ?? 'auto');
    setFormPresetId((provider as any).presetId || '');
    setFormImageEditFormat((provider as any).imageEditFormat || '');
    /* Tab 回填: provider.channels[] / apiKey 已是解密明文 (getProviders 解过)。回填真 key (password 掩码显示),
     * 保存时整批回传保留 —— 不用"空=保持"那套 (channels 整替换下空=保持会歧义)。无 channels = 单 Tab。 */
    const allModels = provider.models.map(m => m.name);
    const chans = Array.isArray((provider as any).channels) && (provider as any).channels.length
      ? (provider as any).channels.map((c: any) => ({ protocol: c.protocol, apiKey: c.apiKey || '', models: c.models || [], baseUrl: c.baseUrl }))
      /* 老单 Tab: 该 Tab 拥有账户全部模型。 */
      : [{ protocol: provider.protocol, apiKey: (provider as any).apiKey || '', models: allModels, baseUrl: undefined }];
    setFormTabs(chans);
    setFormModels(chans[0]?.models || []); // 模型 section 显当前(第一个)Tab 的模型
    setModelSearchQuery('');
    setShowModelDropdown(false);
    setModelDropdownTab('common');
    setRemoteModelOptions([]);
    setRemoteModelsError(null);
    setRemoteModelsSourceUrl(null);
    setRemoteModelsFetchedAt(null);
    setRemoteModelsLoading(false);
  };

  const normalizeRemoteModelId = (model: string): string => model.trim();

  const remoteModelToOption = (model: string): ProtocolModelOption => {
    const exactId = normalizeRemoteModelId(model);
    const normalized = normalizeModelId(exactId);
    return {
      id: exactId,
      displayName: exactId,
      aliases: normalized && normalized.toLowerCase() !== exactId.toLowerCase() ? [normalized] : [],
      shortContext: '',
      contextLabel: '',
      recent: false,
      source: 'custom',
    };
  };

  const modelMatchesQuery = (option: ProtocolModelOption, query: string): boolean => {
    const lowerQuery = query.trim().toLowerCase();
    if (!lowerQuery) return true;
    return option.id.toLowerCase().includes(lowerQuery)
      || option.displayName.toLowerCase().includes(lowerQuery)
      || option.aliases.some(alias => alias.toLowerCase().includes(lowerQuery));
  };

  // 模型选择相关函数
  const toggleModel = (model: string, options?: { preserveId?: boolean }) => {
    const normalized = options?.preserveId ? normalizeRemoteModelId(model) : normalizeModelId(model);
    if (!normalized) return;

    setFormModels(prev => {
      const exists = prev.some(m => m.toLowerCase() === normalized.toLowerCase());
      if (exists) {
        return prev.filter(m => m.toLowerCase() !== normalized.toLowerCase());
      }
      return [...prev, normalized];
    });
  };

  const addCustomModel = (candidate?: string) => {
    const trimmed = (candidate ?? modelSearchQuery).trim();
    if (!trimmed) return;
    const normalized = normalizeRemoteModelId(trimmed);
    if (!normalized) return;

    const exists = formModels.some(m => m.toLowerCase() === normalized.toLowerCase());
    if (exists) {
      setModelSearchQuery('');
      return;
    }

    setFormModels(prev => [...prev, normalized]);
    setModelSearchQuery('');

    if (formModels.length === 0) {
      const lower = normalized.toLowerCase();
      let detected: string | null = null;
      if (/gpt-image|gpt-[\d.]+-image|dall-e|imagen|flux|stable-diffusion|sdxl|recraft|riverflow|mai-image|seedream|cogview|wanx|grok.*image|gemini.*image|nano.?banana/.test(lower)) {
        /* OpenRouter 图像 slug 一律带 vendor/ 前缀 (openai/, black-forest-labs/, recraft/,
         * sourceful/, bytedance-seed/, microsoft/, x-ai/, google/...) → 归 openrouter-images. */
        const isOpenRouterSlug = lower.includes('/') && (
          formBaseUrl.toLowerCase().includes('openrouter.ai')
          || /^(openai|black-forest-labs|recraft|sourceful|bytedance-seed|microsoft|x-ai|google)\//.test(lower)
        );
        detected = isOpenRouterSlug ? 'openrouter-images'
          : lower.includes('gemini') ? 'gemini-images'
          : lower.includes('doubao') || lower.includes('seedream') ? 'doubao-images'
          : lower.includes('cogview') ? 'glm-images'
          : lower.includes('wanx') ? 'qwen-images'
          : lower.includes('grok') ? 'grok-images'
          : 'openai-images';
      } else if (/^tts-|cosyvoice/.test(lower)) {
        detected = lower.includes('cosyvoice') ? 'dashscope-tts' : 'openai-tts';
      } else if (/whisper|paraformer/.test(lower)) {
        detected = 'openai-stt';
      } else if (/^text-embedding|bge-|voyage-|embedding-3/.test(lower)) {
        detected = 'openai-embedding';
      } else if (/^claude/.test(lower)) {
        detected = 'anthropic';
      } else if (/^gemini/.test(lower)) {
        detected = 'gemini';
      } else if (/^grok/.test(lower)) {
        detected = 'grok';
      }
      if (detected && detected !== formProtocol) {
        setFormProtocol(detected as any);
        setFormUrlSuffix(getDefaultUrlSuffix(detected as any));
        /* 主 Tab (formTabs[0]) 协议同步 —— 只在单 Tab 时自动改, 多 Tab 时用户显式配, 不覆盖。 */
        setFormTabs(prev => prev.length <= 1
          ? [{ ...prev[0], protocol: detected as any }]
          : prev);
      }
    }
  };

  const protocolLocalModels = useMemo(() => {
    const fromProviders = providers
      .filter(provider => provider.protocol === formProtocol)
      .flatMap(provider => provider.models.map(model => model.name));

    const merged = [...fromProviders, ...formModels]
      .map(model => normalizeModelId(model))
      .filter(Boolean);

    return Array.from(new Set(merged));
  }, [providers, formProtocol, formModels]);

  const remoteModelOptionKeys = useMemo(() => {
    return new Set(
      remoteModelOptions
        .map(model => normalizeRemoteModelId(model).toLowerCase())
        .filter(Boolean),
    );
  }, [remoteModelOptions]);

  const remoteModelOrder = useMemo(() => {
    const order = new Map<string, number>();
    remoteModelOptions.forEach((model, index) => {
      const normalized = normalizeRemoteModelId(model).toLowerCase();
      if (normalized && !order.has(normalized)) {
        order.set(normalized, index);
      }
    });
    return order;
  }, [remoteModelOptions]);

  const apiModelOptions = useMemo<ProtocolModelOption[]>(() => {
    if (remoteModelOptions.length === 0) return [];

    const options = remoteModelOptions
      .map(remoteModelToOption)
      .filter(option => modelMatchesQuery(option, modelSearchQuery));

    return options
      .filter(option => remoteModelOptionKeys.has(option.id.toLowerCase()))
      .filter(option =>
        !formModels.some(existing => existing.toLowerCase() === option.id.toLowerCase()),
      )
      .sort((a, b) => {
        return (remoteModelOrder.get(a.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
          - (remoteModelOrder.get(b.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
      });
  }, [modelSearchQuery, formModels, remoteModelOptions, remoteModelOptionKeys, remoteModelOrder]);

  const commonModelOptions = useMemo<ProtocolModelOption[]>(() => {
    const options = modelSearchQuery.trim()
      /* 带上 presetId —— 选了 Mistral 就该看到 Mistral 的模型。不带的话下拉按协议
       * 去 registry 取, 而 mistral/groq/together/openrouter 四家在那张表里都被映射成
       * openai, 于是列出来的是一整列 OpenAI 模型 (见 protocolModels 里的说明)。 */
      ? searchNormalizedModelOptions(modelSearchQuery, formProtocol, protocolLocalModels, formPresetId || undefined)
      : getNormalizedModelOptionsByProtocol(formProtocol, protocolLocalModels, formPresetId || undefined);

    return options.filter(option =>
      !formModels.some(existing => existing.toLowerCase() === option.id.toLowerCase()),
    );
  }, [modelSearchQuery, formProtocol, protocolLocalModels, formModels, formPresetId]);

  const activeModelDropdownTab: ModelDropdownTab = remoteModelOptions.length > 0 ? modelDropdownTab : 'common';
  const visibleModelOptions = activeModelDropdownTab === 'api' ? apiModelOptions : commonModelOptions;

  const allModelOptions = useMemo<ProtocolModelOption[]>(() => {
    const merged = new Map<string, ProtocolModelOption>();
    for (const option of [...apiModelOptions, ...commonModelOptions]) {
      merged.set(option.id.toLowerCase(), option);
    }
    return Array.from(merged.values());
  }, [apiModelOptions, commonModelOptions]);

  const customModelCandidate = useMemo(() => {
    const trimmed = modelSearchQuery.trim();
    if (!trimmed) return '';
    const normalized = normalizeRemoteModelId(trimmed);
    if (!normalized) return '';

    const alreadySelected = formModels.some(m => m.toLowerCase() === normalized.toLowerCase());
    if (alreadySelected) return '';

    const lowerTrimmed = trimmed.toLowerCase();
    const canonical = normalizeModelId(trimmed).toLowerCase();
    const inPreset = allModelOptions.some(option =>
      option.id.toLowerCase() === normalized.toLowerCase() ||
      option.id.toLowerCase() === canonical ||
      option.aliases.some(alias => alias.toLowerCase() === lowerTrimmed),
    );
    if (inPreset) return '';

    return normalized;
  }, [modelSearchQuery, formModels, allModelOptions]);

  const remoteModelsAvailableToImport = useMemo(() => {
    return remoteModelOptions
      .map(model => normalizeRemoteModelId(model))
      .filter(Boolean)
      .filter(model => !formModels.some(existing => existing.toLowerCase() === model.toLowerCase()));
  }, [remoteModelOptions, formModels]);

  const updateModelDropdownPosition = useCallback(() => {
    const anchor = modelInputWrapperRef.current ?? modelSearchInputRef.current ?? modelSelectorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(rect.left, viewportPadding), window.innerWidth - width - viewportPadding);
    const spaceBelow = window.innerHeight - rect.bottom;
    const maxHeight = Math.min(360, Math.max(140, spaceBelow - gap - viewportPadding));
    setModelDropdownPosition({
      top: rect.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, []);

  const applyRemoteModels = useCallback((models: string[], sourceUrl: string | null, fetchedAt: number) => {
    const remoteByLower = new Map(models.map(model => [model.toLowerCase(), model]));

    setRemoteModelOptions(models);
    setFormModels(prev => prev.map(model => remoteByLower.get(model.toLowerCase()) ?? model));
    setRemoteModelsSourceUrl(sourceUrl);
    setRemoteModelsFetchedAt(fetchedAt);
    setModelDropdownTab(models.length > 0 ? 'api' : 'common');
  }, []);

  const getRemoteModelsCacheKey = useCallback((apiKey: string) => {
    return [
      editingProvider?.id || 'new-provider',
      formProtocol,
      formBaseUrl.trim(),
      formUrlSuffix.trim(),
      hashRemoteModelCredential(apiKey),
    ].join('|');
  }, [editingProvider?.id, formBaseUrl, formProtocol, formUrlSuffix]);

  const fetchRemoteModels = useCallback(async (options?: { silent?: boolean; force?: boolean; openDropdown?: boolean }) => {
    const op = language === 'zh' ? '获取模型列表' : 'Fetch models';
    const apiKey = formApiKey.trim() || editingProvider?.apiKey || '';
    const shouldOpenDropdown = options?.openDropdown ?? !options?.silent;

    if (!apiKey) {
      const message = language === 'zh'
        ? '需要先填写 API Key 才能从服务商拉取模型'
        : 'Enter an API key before fetching models from the provider';
      setRemoteModelsError(message);
      if (!options?.silent) {
        dispatchOpFailed({ op, message });
      }
      return;
    }

    const cacheKey = getRemoteModelsCacheKey(apiKey);
    if (options?.force) {
      remoteModelsCacheRef.current.delete(cacheKey);
    }
    const cached = remoteModelsCacheRef.current.get(cacheKey);
    if (!options?.force && cached && Date.now() - cached.fetchedAt < REMOTE_MODELS_CACHE_TTL_MS) {
      applyRemoteModels(cached.models, cached.sourceUrl, cached.fetchedAt);
      setRemoteModelsError(null);
      if (shouldOpenDropdown) {
        updateModelDropdownPosition();
        setShowModelDropdown(true);
      }
      return;
    }

    setRemoteModelsLoading(true);
    setRemoteModelsError(null);

    try {
      const result = await window.neox.fetchProviderModels({
        protocol: formProtocol,
        baseUrl: formBaseUrl.trim() || undefined,
        urlSuffix: formUrlSuffix.trim() || undefined,
        apiKey,
      });

      const normalizedModels = result.models
        .map(model => normalizeRemoteModelId(model))
        .filter(Boolean);
      const models = Array.from(new Map(normalizedModels.map(model => [model.toLowerCase(), model])).values());
      const fetchedAt = Date.now();
      const sourceUrl = result.sourceUrl || null;

      remoteModelsCacheRef.current.set(cacheKey, { models, sourceUrl, fetchedAt });
      applyRemoteModels(models, sourceUrl, fetchedAt);
      if (shouldOpenDropdown) {
        updateModelDropdownPosition();
        setShowModelDropdown(true);
      }

      if (models.length === 0) {
        const message = result.error || (language === 'zh'
          ? '服务商没有返回可用模型；可以继续手动输入模型 ID'
          : 'The provider returned no models. You can still enter a model ID manually.');
        setRemoteModelsError(message);
        if (!options?.silent) {
          dispatchHint(message, 'warning');
        }
        return;
      }

      if (!options?.silent) {
        dispatchHint(
          language === 'zh' ? `已从 API 获取 ${models.length} 个模型` : `Fetched ${models.length} models from the API`,
          'success',
        );
      }
    } catch (err: any) {
      const message = err?.message || (language === 'zh' ? '模型列表获取失败' : 'Failed to fetch models');
      setRemoteModelsError(message);
      if (!options?.silent) {
        dispatchOpFailed({ op, message });
      }
    } finally {
      setRemoteModelsLoading(false);
    }
  }, [applyRemoteModels, editingProvider?.apiKey, formApiKey, formBaseUrl, formProtocol, formUrlSuffix, getRemoteModelsCacheKey, language, updateModelDropdownPosition]);

  const importRemoteModels = useCallback(() => {
    if (remoteModelsAvailableToImport.length === 0) return;

    setFormModels(prev => {
      const next = [...prev];
      for (const model of remoteModelsAvailableToImport) {
        if (!next.some(existing => existing.toLowerCase() === model.toLowerCase())) {
          next.push(model);
        }
      }
      return next;
    });

    dispatchHint(
      language === 'zh'
        ? `已导入 ${remoteModelsAvailableToImport.length} 个远端模型`
        : `Imported ${remoteModelsAvailableToImport.length} fetched models`,
      'success',
    );
  }, [language, remoteModelsAvailableToImport]);

  useEffect(() => {
    if (!editingProvider?.id || !editingProvider.apiKey) return;
    const cacheKey = getRemoteModelsCacheKey(editingProvider.apiKey);
    const cached = remoteModelsCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_MODELS_CACHE_TTL_MS) {
      applyRemoteModels(cached.models, cached.sourceUrl, cached.fetchedAt);
      setRemoteModelsError(null);
      return;
    }
    if (autoFetchedProviderModelsRef.current.has(cacheKey)) return;

    autoFetchedProviderModelsRef.current.add(cacheKey);
    void fetchRemoteModels({ silent: true });
  }, [applyRemoteModels, editingProvider?.id, editingProvider?.apiKey, fetchRemoteModels, getRemoteModelsCacheKey]);

  useEffect(() => {
    if (!showModelDropdown) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && modelSelectorRef.current?.contains(target)) return;
      if (target && modelDropdownRef.current?.contains(target)) return;
      setShowModelDropdown(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowModelDropdown(false);
    };

    updateModelDropdownPosition();
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', updateModelDropdownPosition, true);
    window.addEventListener('resize', updateModelDropdownPosition);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', updateModelDropdownPosition, true);
      window.removeEventListener('resize', updateModelDropdownPosition);
    };
  }, [showModelDropdown, updateModelDropdownPosition]);

  // 获取健康状态百分比（已不再使用，但保留以备用）
  const getHealthPercent = (status: HealthStatus | 'testing'): number => {
    switch (status) {
      case 'excellent': return 100;
      case 'good': return 75;
      case 'poor': return 40;
      case 'testing': return 50;
      case 'offline': return 10;
      case 'error': return 5;
      default: return 0;
    }
  };

  const getHealthLabel = (status: HealthStatus | 'testing'): string => {
    switch (status) {
      case 'excellent': return t.settings.providers.health.excellent;
      case 'good': return t.settings.providers.health.good;
      case 'poor': return t.settings.providers.health.slow;
      case 'testing': return t.settings.providers.health.testing;
      case 'offline': return t.settings.providers.health.offline;
      case 'error': return t.settings.providers.health.error;
      default: return t.settings.providers.health.unknown;
    }
  };

  const formatHealthIntervalLabel = (minutes: number): string => {
    if (minutes < 60) {
      return language === 'zh' ? `${minutes} 分钟` : `${minutes} min`;
    }
    const hours = minutes / 60;
    return language === 'zh' ? `${hours} 小时` : `${hours} h`;
  };

  const handleHealthIntervalChange = async (minutes: number) => {
    try {
      setHealthCheckIntervalMinutes(minutes);
      await window.neox.setHealthCheckInterval(minutes);
      startHealthCheckInterval(minutes);
      setShowHealthIntervalPopover(false);
    } catch (err) {
      console.error('Failed to update health check interval:', err);
    }
  };

  // 渲染 Providers 内容
  // renderProvidersContent → extracted to tabs/

  // 主题相关
  const { themePreset, setThemePreset } = useAppStore();

  // 渲染路由配置内容
  // renderRoutingContent → extracted to tabs/

  // ==================== 多模型协作配置 ====================
  // Agentic 模式 taskagent 模型（可选，不配置则跟随当前会话模型）
  const [agenticTaskAgentProviderId, setAgenticTaskAgentProviderId] = useState('');
  const [agenticTaskAgentModel, setAgenticTaskAgentModel] = useState('');
  const [agenticClaudeExploreUseHaiku, setAgenticClaudeExploreUseHaiku] = useState(true);
  const [agenticClaudeFallbackToOpusWhenNoHaiku, setAgenticClaudeFallbackToOpusWhenNoHaiku] = useState(false);
  // 侧路 Agent — 总开关 + 子能力 + 独立模型(可选,留空则复用任务 Agent 配置)
  const [agenticSideAgentEnabled, setAgenticSideAgentEnabled] = useState(true);
  const [agenticSideAgentToolUseSummary, setAgenticSideAgentToolUseSummary] = useState(true);
  const [agenticSideAgentSessionTitle, setAgenticSideAgentSessionTitle] = useState(true);
  const [agenticSideAgentProviderId, setAgenticSideAgentProviderId] = useState('');
  const [agenticSideAgentModel, setAgenticSideAgentModel] = useState('');
  const [agenticSideAgentDisableThinking, setAgenticSideAgentDisableThinking] = useState(true);

  const handleAgenticTaskAgentConfigChange = async (providerId: string, model: string) => {
    const nextTaskAgent = providerId && model
      ? { providerId, model }
      : { providerId: '', model: '' };
    setAgenticTaskAgentProviderId(providerId);
    setAgenticTaskAgentModel(model);
    setRunconfigData(prev => ({
      ...prev,
      modes: {
        ...prev.modes,
        agentic: {
          ...(prev.modes?.agentic || {}),
          taskAgent: nextTaskAgent,
        },
      },
    }));
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', { taskAgent: nextTaskAgent });
    } catch (err) {
      console.error('Failed to update task agent model config:', err);
    }
  };

  const handleAgenticTaskAgentProviderChange = async (providerId: string) => {
    if (!providerId) {
      await handleAgenticTaskAgentConfigChange('', '');
      return;
    }
    const provider = providers.find(p => p.id === providerId);
    const fallbackModel = provider?.models?.[0]?.name || '';
    await handleAgenticTaskAgentConfigChange(providerId, fallbackModel);
  };

  const handleAgenticTaskAgentModelChange = async (model: string) => {
    if (!agenticTaskAgentProviderId) return;
    await handleAgenticTaskAgentConfigChange(agenticTaskAgentProviderId, model);
  };

  const handleAgenticClaudeExploreUseHaikuChange = async (enabled: boolean) => {
    setAgenticClaudeExploreUseHaiku(enabled);
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: {
            ...prevAgentic,
            claudeExploreUseHaiku: enabled,
            sideAgent: {
              ...prevSideAgent,
              features: { ...(prevSideAgent.features || {}), explore: enabled },
            },
          },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', {
        claudeExploreUseHaiku: enabled,
        sideAgent: { features: { explore: enabled } },
      });
    } catch (err) {
      console.error('Failed to update Claude→Haiku explore config:', err);
    }
  };

  const handleAgenticClaudeFallbackToOpusWhenNoHaikuChange = async (enabled: boolean) => {
    setAgenticClaudeFallbackToOpusWhenNoHaiku(enabled);
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: {
            ...prevAgentic,
            claudeFallbackToOpusWhenNoHaiku: enabled,
            sideAgent: { ...prevSideAgent, claudeFallbackToOpusWhenNoHaiku: enabled },
          },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', {
        claudeFallbackToOpusWhenNoHaiku: enabled,
        sideAgent: { claudeFallbackToOpusWhenNoHaiku: enabled },
      });
    } catch (err) {
      console.error('Failed to update Claude Opus fallback config for agentic mode:', err);
    }
  };

  const handleAgenticSideAgentEnabledChange = async (enabled: boolean) => {
    setAgenticSideAgentEnabled(enabled);
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: { ...prevAgentic, sideAgent: { ...prevSideAgent, enabled } },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', { sideAgent: { enabled } });
    } catch (err) {
      console.error('Failed to update sideAgent enabled:', err);
    }
  };

  const handleAgenticSideAgentDisableThinkingChange = async (disableThinking: boolean) => {
    setAgenticSideAgentDisableThinking(disableThinking);
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: { ...prevAgentic, sideAgent: { ...prevSideAgent, disableThinking } },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', { sideAgent: { disableThinking } });
    } catch (err) {
      console.error('Failed to update sideAgent disableThinking:', err);
    }
  };

  const handleAgenticSideAgentFeatureChange = async (
    feature: 'toolUseSummary' | 'sessionTitle',
    enabled: boolean,
  ) => {
    if (feature === 'toolUseSummary') setAgenticSideAgentToolUseSummary(enabled);
    if (feature === 'sessionTitle') setAgenticSideAgentSessionTitle(enabled);
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: {
            ...prevAgentic,
            sideAgent: {
              ...prevSideAgent,
              features: { ...(prevSideAgent.features || {}), [feature]: enabled },
            },
          },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', {
        sideAgent: { features: { [feature]: enabled } },
      });
    } catch (err) {
      console.error(`Failed to update sideAgent feature ${feature}:`, err);
    }
  };

  // 侧路 Agent 独立模型 — 留空则在 runtime 复用任务 Agent 配置
  const handleAgenticSideAgentModelConfigChange = async (providerId: string, model: string) => {
    setAgenticSideAgentProviderId(providerId);
    setAgenticSideAgentModel(model);
    const nextProviderId = providerId || undefined;
    const nextModel = model || undefined;
    setRunconfigData(prev => {
      const prevAgentic = prev.modes?.agentic || {};
      const prevSideAgent = prevAgentic.sideAgent || {};
      return {
        ...prev,
        modes: {
          ...prev.modes,
          agentic: {
            ...prevAgentic,
            sideAgent: { ...prevSideAgent, providerId: nextProviderId, model: nextModel },
          },
        },
      };
    });
    try {
      await window.neox.runconfigSetModeConfig?.('agentic', {
        sideAgent: { providerId: nextProviderId, model: nextModel },
      });
    } catch (err) {
      console.error('Failed to update sideAgent model config:', err);
    }
  };

  const handleAgenticSideAgentProviderChange = async (providerId: string) => {
    if (!providerId) {
      await handleAgenticSideAgentModelConfigChange('', '');
      return;
    }
    const provider = providers.find(p => p.id === providerId);
    const fallbackModel = provider?.models?.[0]?.name || '';
    await handleAgenticSideAgentModelConfigChange(providerId, fallbackModel);
  };

  const handleAgenticSideAgentModelChange = async (model: string) => {
    if (!agenticSideAgentProviderId) return;
    await handleAgenticSideAgentModelConfigChange(agenticSideAgentProviderId, model);
  };

  // 渲染多模型协作配置内容
  // renderOrchestratorContent → extracted to tabs/
  // renderAgentContent → extracted to tabs/

  // 渲染 MCP 内容
  // renderMcpContent → extracted to tabs/

  // 渲染 Memory 内容
  // renderMemoryContent → extracted to tabs/

  // 渲染浏览器工具内容
  // renderBrowserContent → extracted to tabs/

  // 渲染进程管理内容
  // renderProcessesContent → extracted to tabs/

  // 渲染上下文管理内容
  // renderContextContent → extracted to tabs/



  // 渲染 Skills 内容
  // renderSkillsContent → extracted to tabs/

  // 渲染 主题 (一键风格预设)
  // renderThemeContent → extracted to tabs/

  // 渲染 General 内容
  // renderGeneralContent → extracted to tabs/

  /* 通知设置面板 — 独立 tab. 完整闭环见 notifyStore.ts. */
  // renderNotifyContent → extracted to tabs/

  // 清理单个 workspace 的 checkpoint
  const handleClearCheckpoint = async (workspacePath: string, workspaceName: string) => {
    const warningMessage = language === 'zh'
      ? `确定要清理「${workspaceName}」的代码回退数据吗？\n\n⚠️ 警告：清理后该项目的所有代码变更将无法回退！`
      : `Are you sure you want to clear checkpoint data for "${workspaceName}"?\n\n⚠️ Warning: After clearing, all code changes in this project cannot be reverted!`;

    if (!(await confirmAsync({
      title: language === 'zh' ? '清理代码回退数据' : 'Clear Checkpoint Data',
      message: warningMessage,
      confirmLabel: language === 'zh' ? '确认清理' : 'Clear',
      variant: 'danger',
    }))) return;

    const op = language === 'zh' ? '清理 checkpoint' : 'Clear checkpoint';
    try {
      const result = await window.neox.clearCheckpointStorage(workspacePath);
      if (result.success) {
        loadStorageInfo();
      } else if (result.error) {
        dispatchOpFailed({ op, message: result.error });
      }
    } catch (err) {
      console.error('Failed to clear checkpoint:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
  };

  // 清理所有 checkpoint
  const handleClearAllCheckpoints = async () => {
    const warningMessage = language === 'zh'
      ? `确定要清理所有项目的代码回退数据吗？\n\n⚠️ 警告：清理后所有项目的代码变更将无法回退！此操作不可撤销！`
      : `Are you sure you want to clear ALL checkpoint data?\n\n⚠️ Warning: After clearing, code changes in ALL projects cannot be reverted! This action cannot be undone!`;

    if (!(await confirmAsync({
      title: language === 'zh' ? '清理所有 checkpoint' : 'Clear All Checkpoints',
      message: warningMessage,
      confirmLabel: language === 'zh' ? '全部清理' : 'Clear All',
      variant: 'danger',
    }))) return;

    const op = language === 'zh' ? '清理所有 checkpoint' : 'Clear all checkpoints';
    try {
      const result = await window.neox.clearAllCheckpointStorage();
      if (result.success) {
        loadStorageInfo();
      } else if (result.error) {
        dispatchOpFailed({ op, message: result.error });
      }
    } catch (err) {
      console.error('Failed to clear all checkpoints:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
  };

  // 渲染存储管理内容
  // 商业级重做: hero 总览 + 分类占比可视化条 + 一键清理, 明细/路径折叠进「高级」.
  // renderStorageContent → extracted to tabs/

  // 渲染文件预览模态框
  const renderPreviewModal = () => {
    if (!previewFile) return null;

    // 尝试解析 JSON
    let formattedContent = previewFile.content;
    let isValidJson = false;
    try {
      const parsed = JSON.parse(previewFile.content);
      formattedContent = JSON.stringify(parsed, null, 2);
      isValidJson = true;
    } catch {
      // 不是有效的 JSON
    }

    return (
      <div className="modal-overlay" onClick={() => setPreviewFile(null)}>
        <div className="modal-content preview-modal" onClick={e => e.stopPropagation()}>
          <div className="preview-header">
            <h3>{previewFile.name}</h3>
            <div className="preview-actions">
              <button className="btn-icon" onClick={() => openInFinder(previewFile.path)} title={revealInFileManagerLabel(language === 'zh')}>
                <Icons.ExternalLink />
              </button>
              <button className="btn-icon" onClick={() => setPreviewFile(null)} title={language === 'zh' ? '关闭预览' : 'Close preview'} aria-label={language === 'zh' ? '关闭预览' : 'Close preview'}>
                <Icons.Close />
              </button>
            </div>
          </div>
          <div className="preview-path">{previewFile.path}</div>
          <div className="preview-content">
            {previewLoading ? (
              <div className="preview-loading neox-text-shimmer">加载中...</div>
            ) : (
              <pre className={isValidJson ? 'json-content' : 'text-content'}>
                <code>{formattedContent}</code>
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  };

  // renderUsageContent → extracted to tabs/

  // ==================== TTS 语音配置 ====================
  // renderTtsContent → extracted to tabs/

  // ==================== 实验性功能 ====================
  // renderExperimentalContent → extracted to tabs/


  // ==================== ✦ 编辑器面板 (Ghost Text 模型选择) ====================
  // renderEditorContent → extracted to tabs/

  // ==================== RunConfig 渲染 ====================
  // _MODES_MODE_LABELS → extracted to tabs/

  // renderRunconfigContent → extracted to tabs/

  // ==================== Model Profile 状态 ====================
  const [modelProfile, setModelProfile] = useState<CurrentModelProfileInfo | null>(null);
  const [allModelProfiles, setAllModelProfiles] = useState<ModelProfileListEntry[]>([]);
  const [selectedModelProfile, setSelectedModelProfile] = useState<ModelProfileListEntry | null>(null);
  const [modelProfileQuery, setModelProfileQuery] = useState('');
  const [toolsetOverrideText, setToolsetOverrideText] = useState('');
  const [toolsetOverrideSource, setToolsetOverrideSource] = useState<'model' | 'profile' | 'builtin'>('builtin');
  const [toolsetOverrideLoading, setToolsetOverrideLoading] = useState(false);
  const [toolsetOverrideSaving, setToolsetOverrideSaving] = useState(false);
  const [toolPaletteQuery, setToolPaletteQuery] = useState('');
  const [globalEnabledTools, setGlobalEnabledTools] = useState<Record<string, boolean>>({});
  const [toolCatalog, setToolCatalog] = useState<Array<{ name: string; description: string }>>([]);

  /* 工具目录只在打开「模型适配」时拉一次 —— 它是静态表, 不用跟着别的 tab 走。 */
  useEffect(() => {
    if (activeTab !== 'modelprofile' || toolCatalog.length > 0) return;
    void (async () => {
      try {
        const list = await (window.neox as any).modelProfileListTools?.();
        if (Array.isArray(list)) setToolCatalog(list);
      } catch (err) { console.error('[settings] list tools failed:', err); }
    })();
  }, [activeTab, toolCatalog.length]);

  const parseToolList = (text: string): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of text.split(/[\n,]/)) {
      const toolName = raw.trim();
      if (!toolName || seen.has(toolName)) continue;
      seen.add(toolName);
      result.push(toolName);
    }
    return result;
  };

  const joinToolList = (tools: string[] | null | undefined): string => {
    if (!tools || tools.length === 0) return '';
    return tools.join('\n');
  };

  const filteredModelProfiles = useMemo(() => {
    const query = modelProfileQuery.trim().toLowerCase().replace(/^#/, '');
    if (!query) return allModelProfiles;
    return allModelProfiles.filter((mp) => (
      mp.model.toLowerCase().includes(query)
      || mp.providerName.toLowerCase().includes(query)
      || mp.profileId.toLowerCase().includes(query)
    ));
  }, [allModelProfiles, modelProfileQuery]);

  const toolDescByName = useMemo(() => {
    const m = new Map<string, string>();
    toolCatalog.forEach(t => m.set(t.name, t.description));
    return m;
  }, [toolCatalog]);

  const toolNameCandidates = useMemo(() => {
    const names = new Set<string>();
    toolCatalog.forEach(t => { if (t.name) names.add(t.name); });
    Object.keys(globalEnabledTools || {}).forEach((name) => {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    });
    allModelProfiles.forEach((mp) => {
      (mp.disabledTools || []).forEach(name => names.add(name));
      (mp.builtinDisabledTools || []).forEach(name => names.add(name));
      (mp.modelOverrideDisabledTools || []).forEach(name => names.add(name));
      (mp.profileOverrideDisabledTools || []).forEach(name => names.add(name));
    });
    parseToolList(toolsetOverrideText).forEach(name => names.add(name));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allModelProfiles, globalEnabledTools, toolsetOverrideText, toolCatalog]);

  const filteredToolCandidates = useMemo(() => {
    const query = toolPaletteQuery.trim().toLowerCase();
    /* 上限 32 是候选表只有寥寥几项时留的; 现在是真实工具表 (数十项), 截断会让人以为"就这些"。
       改成筛选后全给, 由 UI 自己滚动。 */
    if (!query) return toolNameCandidates;
    return toolNameCandidates.filter(name => (
      name.toLowerCase().includes(query) || (toolDescByName.get(name) || '').toLowerCase().includes(query)
    ));
  }, [toolNameCandidates, toolPaletteQuery, toolDescByName]);

  const selectedOverrideTools = useMemo(() => parseToolList(toolsetOverrideText), [toolsetOverrideText]);

  const loadToolsetOverrideForModel = async (target: ModelProfileListEntry) => {
    setToolsetOverrideLoading(true);
    try {
      const result = await window.neox.modelProfileGetToolsetOverride?.({
        model: target.model,
        profileId: target.profileId,
        builtinDisabledTools: target.builtinDisabledTools ?? target.disabledTools ?? [],
      });

      if (result?.success) {
        setToolsetOverrideSource(result.source || 'builtin');
        setToolsetOverrideText(joinToolList(result.effectiveDisabledTools));
        return;
      }

      setToolsetOverrideSource('builtin');
      setToolsetOverrideText(joinToolList(target.disabledTools));
    } catch (e) {
      console.error('Failed to load model toolset override:', e);
      setToolsetOverrideSource('builtin');
      setToolsetOverrideText(joinToolList(target.disabledTools));
    } finally {
      setToolsetOverrideLoading(false);
    }
  };


    const loadModelProfile = async () => {
      try {
        const current = await window.neox.modelProfileGetCurrent?.();
        setModelProfile(current || null);
        const all = await window.neox.modelProfileGetAll?.();
        const enabledTools = await window.neox.getEnabledTools();
        const allProfiles = all || [];
        setAllModelProfiles(allProfiles);
        setGlobalEnabledTools(enabledTools || {});

        let activeEntry: ModelProfileListEntry | undefined;
        try {
          const lastId = (await window.neox.uiStateGet?.('lastModelId'))?.value;
          if (typeof lastId === 'string' && lastId.includes(':')) {
            const idx = lastId.indexOf(':');
            const pid = lastId.slice(0, idx);
            const mdl = lastId.slice(idx + 1);
            activeEntry = allProfiles.find((mp) => mp.providerId === pid && mp.model === mdl);
          }
        } catch { /* uiState 读不到就用主进程那份 */ }
        if (activeEntry) {
          setModelProfile((prev: any) => (prev ? { ...prev, providerId: activeEntry!.providerId, model: activeEntry!.model, profileId: activeEntry!.profileId } : prev));
        }

        const preferred = selectedModelProfile
          ? allProfiles.find((mp) => mp.providerId === selectedModelProfile.providerId && mp.model === selectedModelProfile.model)
          : undefined;
        const currentMatch = activeEntry ?? (current
          ? allProfiles.find((mp) => mp.providerId === current.providerId && mp.model === current.model)
          : undefined);
        const nextSelection = preferred || currentMatch || allProfiles[0] || null;
        setSelectedModelProfile(nextSelection);
        if (nextSelection) {
          await loadToolsetOverrideForModel(nextSelection);
        } else {
          setToolsetOverrideText('');
          setToolsetOverrideSource('builtin');
        }
      } catch (e) {
        console.error('Failed to load model profile:', e);
      }
    };

    const handleSelectModelProfile = async (target: ModelProfileListEntry) => {
      setSelectedModelProfile(target);
      await loadToolsetOverrideForModel(target);
    };

    const toggleOverrideTool = (toolName: string) => {
      const currentTools = parseToolList(toolsetOverrideText);
      const nextTools = currentTools.includes(toolName)
        ? currentTools.filter(name => name !== toolName)
        : [...currentTools, toolName];
      setToolsetOverrideText(nextTools.join('\n'));
    };

    const handleSaveModelToolsetOverride = async () => {
      if (!selectedModelProfile) return;
      setToolsetOverrideSaving(true);
      try {
        const disabledTools = parseToolList(toolsetOverrideText);
        const result = await window.neox.modelProfileSetToolsetOverride?.({
          model: selectedModelProfile.model,
          disabledTools,
        });
        if (!result?.success) {
          throw new Error(result?.error || 'save_failed');
        }
        setToolsetOverrideSource('model');
        await loadModelProfile();
      } catch (e: any) {
        dispatchOpFailed({ op: language === 'zh' ? '保存模型工具集覆盖' : 'Save toolset override', message: e?.message || String(e) });
      } finally {
        setToolsetOverrideSaving(false);
      }
    };

    const handleResetModelToolsetOverride = async () => {
      if (!selectedModelProfile) return;
      setToolsetOverrideSaving(true);
      try {
        const result = await window.neox.modelProfileClearToolsetOverride?.({
          model: selectedModelProfile.model,
        });
        if (!result?.success) {
          throw new Error(result?.error || 'reset_failed');
        }
        await loadModelProfile();
      } catch (e: any) {
        dispatchOpFailed({ op: language === 'zh' ? '重置工具集覆盖' : 'Reset toolset override', message: e?.message || String(e) });
      } finally {
        setToolsetOverrideSaving(false);
      }
    };

    useEffect(() => {
      if (activeTab === 'modelprofile' || activeTab === 'orchestrator') {
        loadModelProfile();
      }
    }, [activeTab]);

    // ==================== Model Profile Content ====================



    const renderModelSelector = () => {
      const remoteStatusText = remoteModelsLoading
        ? (language === 'zh' ? '正在从 API 获取模型...' : 'Fetching models from the API...')
        : remoteModelOptions.length > 0
          ? (language === 'zh'
              ? `已获取 ${remoteModelOptions.length} 个远端模型${remoteModelsSourceUrl ? ' · API 列表' : ''}`
              : `Fetched ${remoteModelOptions.length} remote models${remoteModelsSourceUrl ? ' · API list' : ''}`)
          : remoteModelsError
            ? remoteModelsError
            : (language === 'zh'
                ? '优先从 API 获取最新模型；静态预设只作为离线兜底。'
                : 'Fetch current models from the API first. Static presets are only an offline fallback.');

      return (
        <div className="form-field full-width">
          <label>{t.settings.providers.models} * <span className="label-hint">({formModels.length} {t.settings.providers.modelsSelected})</span></label>
          <div ref={modelSelectorRef} className="model-selector" onBlur={(e) => {
            // 只有当焦点离开整个选择器时才关闭
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setTimeout(() => setShowModelDropdown(false), 150);
            }
          }}>
            <div className="model-fetch-row">
              <button
                type="button"
                className="model-fetch-btn"
                onClick={() => fetchRemoteModels({ force: true, openDropdown: true })}
                disabled={remoteModelsLoading}
              >
                {remoteModelsLoading
                  ? (language === 'zh' ? '获取中...' : 'Fetching...')
                  : (remoteModelOptions.length > 0 || remoteModelsFetchedAt
                      ? (language === 'zh' ? '刷新模型' : 'Refresh models')
                      : (language === 'zh' ? '自动获取模型' : 'Fetch models'))}
              </button>
              {remoteModelOptions.length > 0 && (
                <button
                  type="button"
                  className="model-fetch-btn model-fetch-btn--secondary"
                  onClick={importRemoteModels}
                  disabled={remoteModelsAvailableToImport.length === 0}
                >
                  {language === 'zh'
                    ? `导入全部${remoteModelsAvailableToImport.length > 0 ? ` (${remoteModelsAvailableToImport.length})` : ''}`
                    : `Import all${remoteModelsAvailableToImport.length > 0 ? ` (${remoteModelsAvailableToImport.length})` : ''}`}
                </button>
              )}
              <span className={`model-fetch-status${remoteModelsError ? ' is-error' : ''}`}>
                {remoteStatusText}
              </span>
            </div>

            {formModels.length > 0 && (() => {
              /* 按 model name 启发式判 modality, 分组显示. */
              const modalityOf = (name: string): '对话' | '图像' | '语音' | '向量' | '视频' | '其他' => {
                const l = name.toLowerCase();
                if (/gpt-image|gpt-[\d.]+-image|dall-e|imagen|flux|stable-diffusion|sdxl|recraft|riverflow|mai-image|seedream|cogview|wanx|grok.*image|gemini.*image|nano.?banana/.test(l)) return '图像';
                if (/^tts-|cosyvoice|whisper|paraformer|speech/.test(l)) return '语音';
                if (/^text-embedding|bge-|voyage-|embedding-|rerank/.test(l)) return '向量';
                if (/veo|sora|seedance|kling.*video/.test(l)) return '视频';
                return '对话';
              };
              const badgeColor: Record<string, { bg: string; fg: string }> = {
                '对话': { bg: 'rgba(59,130,246,0.10)', fg: '#2563eb' },
                '图像': { bg: 'rgba(168,85,247,0.12)', fg: '#9333ea' },
                '语音': { bg: 'rgba(245,158,11,0.12)', fg: '#d97706' },
                '向量': { bg: 'rgba(16,185,129,0.10)', fg: '#059669' },
                '视频': { bg: 'rgba(239,68,68,0.10)', fg: '#dc2626' },
                '其他': { bg: 'rgba(100,116,139,0.10)', fg: '#64748b' },
              };
              /* 分组按顺序: 对话/图像/语音/向量/视频/其他 */
              const groupOrder: Array<'对话' | '图像' | '语音' | '向量' | '视频' | '其他'> = ['对话', '图像', '语音', '向量', '视频', '其他'];
              const groups = new Map<string, string[]>();
              for (const m of formModels) {
                const g = modalityOf(m);
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g)!.push(m);
              }
              return (
                <div className="selected-models" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {groupOrder.filter(g => groups.has(g)).map(g => (
                    <div key={g} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 10.5, padding: '2px 7px', borderRadius: 4,
                          background: badgeColor[g].bg, color: badgeColor[g].fg,
                          fontWeight: 600, letterSpacing: '0.02em', flexShrink: 0,
                        }}
                      >
                        {language === 'zh' ? g : ({ 对话: 'Chat', 图像: 'Image', 语音: 'Speech', 向量: 'Embedding', 视频: 'Video', 其他: 'Other' } as Record<string, string>)[g]} · {groups.get(g)!.length}
                      </span>
                      {groups.get(g)!.map(model => (
                        <span key={model} className="model-tag">
                          {model}
                          <button type="button" onClick={() => toggleModel(model)}>×</button>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}
            {/* 搜索/添加输入框 */}
            <div ref={modelInputWrapperRef} className="model-input-wrapper">
              <input
                ref={modelSearchInputRef}
                type="text"
                value={modelSearchQuery}
                onChange={e => {
                  setModelSearchQuery(e.target.value);
                  updateModelDropdownPosition();
                  setShowModelDropdown(true);
                }}
                onFocus={() => {
                  updateModelDropdownPosition();
                  setShowModelDropdown(true);
	                }}
	                onKeyDown={e => {
	                  if (e.key === 'Enter') {
	                    e.preventDefault();
	                    if (visibleModelOptions.length > 0) {
	                      toggleModel(visibleModelOptions[0].id, { preserveId: activeModelDropdownTab === 'api' });
	                      setModelSearchQuery('');
	                    } else if (customModelCandidate) {
	                      addCustomModel(customModelCandidate);
	                    }
	                    setShowModelDropdown(false);
	                  }
                  if (e.key === 'Escape') {
                    setShowModelDropdown(false);
                  }
                }}
                placeholder={remoteModelOptions.length > 0
                  ? (language === 'zh' ? '搜索模型，或手动输入模型 ID' : 'Search models, or enter a model ID')
                  : (formModels.length === 0 ? t.settings.providers.modelsPlaceholder : t.settings.providers.addMoreModels)}
                autoComplete="off"
                spellCheck={false}
              />
              {/* 下拉模型列表：API 结果和常用模型分源展示，手动添加固定在底部。 */}
              {showModelDropdown && createPortal(
                <div
                  ref={modelDropdownRef}
                  className="model-preset-dropdown is-portaled"
                  style={{
                    top: modelDropdownPosition.top,
                    left: modelDropdownPosition.left,
                    width: modelDropdownPosition.width,
                    maxHeight: modelDropdownPosition.maxHeight,
                  }}
                >
                  {remoteModelOptions.length > 0 && (
                    <div
                      className="model-dropdown-tabs"
                      role="tablist"
                      aria-label={language === 'zh' ? '模型来源' : 'Model source'}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeModelDropdownTab === 'api'}
                        className={`model-dropdown-tab${activeModelDropdownTab === 'api' ? ' is-active' : ''}`}
                        onClick={() => setModelDropdownTab('api')}
                      >
                        <span>API</span>
                        <span className="model-dropdown-tab-count">{apiModelOptions.length}</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeModelDropdownTab === 'common'}
                        className={`model-dropdown-tab${activeModelDropdownTab === 'common' ? ' is-active' : ''}`}
                        onClick={() => setModelDropdownTab('common')}
                      >
                        <span>{language === 'zh' ? '常用' : 'Common'}</span>
                        <span className="model-dropdown-tab-count">{commonModelOptions.length}</span>
                      </button>
                    </div>
                  )}

                  <div className="model-preset-list">
                    {visibleModelOptions.length > 0 ? (
                      visibleModelOptions.map(option => {
                      const showSubtitle = option.id.toLowerCase() !== option.displayName.toLowerCase();
                      const isRemote = activeModelDropdownTab === 'api' && remoteModelOptionKeys.has(option.id.toLowerCase());
                      const contextText = isRemote ? 'API' : option.contextLabel;
                      return (
	                        <div
	                          key={option.id}
	                          className={`preset-option${isRemote ? ' is-remote' : ''}`}
	                          onMouseDown={(e) => e.preventDefault()}
	                          onClick={() => {
	                            toggleModel(option.id, { preserveId: isRemote });
	                            setModelSearchQuery('');
	                          }}
	                        >
                          <div className="preset-option-main">
                            <span className="preset-option-name">{option.displayName}</span>
                            {showSubtitle && (
                              <span className="preset-option-subtitle">{option.id}</span>
                            )}
                          </div>
                          {contextText && (
                            <span className="preset-option-context">{contextText}</span>
                          )}
                        </div>
                      );
                      })
                    ) : (
                      <div className="preset-option disabled">
                        {modelSearchQuery
                          ? (language === 'zh'
                              ? (activeModelDropdownTab === 'api' ? '没有匹配的 API 模型' : '没有匹配的常用模型')
                              : (activeModelDropdownTab === 'api' ? 'No matching API models' : 'No matching common models'))
                          : (language === 'zh'
                              ? (activeModelDropdownTab === 'api' ? '没有可选 API 模型' : '没有更多常用模型')
                              : (activeModelDropdownTab === 'api' ? 'No API models available' : 'No more common models'))}
                      </div>
                    )}
                  </div>

                  <div
                    className={`preset-option create-option model-custom-option${customModelCandidate ? '' : ' is-empty'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (customModelCandidate) {
                        addCustomModel(customModelCandidate);
                        setShowModelDropdown(false);
                        return;
                      }
                      setShowModelDropdown(true);
                      modelSearchInputRef.current?.focus();
                    }}
                  >
                    <div className="preset-option-main">
                      <span className="preset-option-name">{language === 'zh' ? '手动添加' : 'Manual model'}</span>
                      <span className="preset-option-subtitle">
                        {customModelCandidate
                          ? (language === 'zh' ? `添加 ${customModelCandidate}` : `Add ${customModelCandidate}`)
                          : (language === 'zh' ? '输入任意模型 ID，不在列表也可以' : 'Enter any model ID, even if it is not listed')}
                      </span>
                    </div>
                    <span className="preset-option-context">{customModelCandidate ? 'ADD' : 'ID'}</span>
                  </div>
                </div>,
                document.body,
              )}
            </div>
          </div>
        </div>
      );
    };

    const renderProviderDisplayControls = (mode: 'add' | 'edit') => (
      <aside className="provider-modal__side" aria-label={language === 'zh' ? '模型选择器显示控制' : 'Model picker display controls'}>
        <div className="provider-modal__side-head">
          <span className="provider-modal__side-kicker">{language === 'zh' ? '控制配置' : 'Controls'}</span>
          <strong>{language === 'zh' ? '模型选择器显示' : 'Model picker display'}</strong>
          <p>
            {language === 'zh'
              ? '控制这个 BYOK 服务商是否出现在模型选择器的“BYOK 可用”二级菜单。'
              : 'Controls whether this BYOK provider appears in the model picker under BYOK available.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={formShowInModelPicker}
          className={`provider-modal__switch${formShowInModelPicker ? ' is-on' : ''}`}
          onClick={() => setFormShowInModelPicker(v => !v)}
        >
          <span className="provider-modal__switch-copy">
            <strong>{language === 'zh' ? '显示到模型选择器' : 'Show in model picker'}</strong>
            <span>
              {formShowInModelPicker
                ? (language === 'zh' ? '会在 BYOK 菜单中显示' : 'Shown in the BYOK menu')
                : (language === 'zh' ? '保留配置，但从 BYOK 菜单隐藏' : 'Kept configured, hidden from BYOK menu')}
            </span>
          </span>
          <span className="provider-modal__switch-track" aria-hidden>
            <span />
          </span>
        </button>
        <div className="provider-modal__note">
          {mode === 'add'
            ? (language === 'zh' ? '新增服务商默认开启，保存后可以马上在模型选择器里找到。' : 'New providers are shown by default so they are immediately available in the model picker.')
            : (language === 'zh' ? '这里只影响入口显示，不影响 API Key、模型列表和调用能力。' : 'This only affects picker visibility. API key, models, and runtime calls are unchanged.')}
        </div>
      </aside>
    );

    // 渲染编辑模态框
    const renderEditModal = () => {
      if (!editingProvider) return null;
      return (
        <div className="modal-overlay" onClick={() => { setEditingProvider(null); resetForm(); }}>
          <div className="modal-content provider-modal" onClick={e => e.stopPropagation()}>
            <h3>{t.settings.providers.editProvider}</h3>
            <div className="modal-form">
              <div className="provider-modal__layout">
                <div className="provider-modal__main">
                  <div className="form-grid">
                    <div className="form-field">
                      <label>{t.settings.providers.name}</label>
                      <input type="text" value={formName} onChange={e => setFormName(e.target.value)} placeholder={editingProvider.name} />
                    </div>
                    <div className="form-field">
                      <label>{t.settings.providers.protocol}</label>
                      <CustomSelect
                        value={formProtocol}
                        onChange={(value) => {
                          const newProtocol = value as ProviderProtocol;
                          setFormProtocol(newProtocol);
                          setFormUrlSuffix(getDefaultUrlSuffix(newProtocol));
                        }}
                        options={[
                          { value: 'openai', label: 'OpenAI' },
                          { value: 'openai-responses', label: 'OpenAI Responses' },
                          { value: 'anthropic', label: 'Anthropic' },
                          { value: 'kimi', label: 'Kimi (Moonshot)' },
                          { value: 'deepseek', label: 'DeepSeek' },
                          { value: 'qwen', label: 'Qwen (阿里云百炼)' },
                          { value: 'minimax', label: 'MiniMax' },
                          { value: 'doubao', label: '豆包 (Doubao)' },
                          { value: 'gemini', label: 'Google Gemini' },
                          { value: 'glm', label: 'GLM (智谱 AI)' },
                        ]}
                      />
                    </div>
                    <div className="form-field full-width">
                      <label>{t.settings.providers.apiKey} ({t.settings.providers.apiKeyKeepEmpty})</label>
                      <input type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)} placeholder="••••••••" />
                    </div>
                    <div className="form-field full-width">
                      <label>{t.settings.providers.baseUrl}</label>
                      <div className="url-input-group">
                        <input type="text" value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)} placeholder={getDefaultBaseUrl(formProtocol)} />
                        <input
                          type="text"
                          className="url-suffix-input"
                          value={formUrlSuffix}
                          onChange={e => setFormUrlSuffix(e.target.value)}
                          placeholder={getDefaultUrlSuffix(formProtocol)}
                          title={language === 'zh' ? 'API 路径后缀' : 'API path suffix'}
                        />
                      </div>
                    </div>
                    <div className="form-field">
                      <label>{t.settings.providers.maxTokens}</label>
                      <input type="number" value={formMaxTokens} onChange={e => setFormMaxTokens(e.target.value)} placeholder="8192" />
                    </div>
                    <div className="form-field">
                      <label>{t.settings.providers.maxInputTokens}</label>
                      <input
                        type="number"
                        value={formMaxInputTokens}
                        onChange={e => setFormMaxInputTokens(e.target.value)}
                        placeholder="120000"
                      />
                    </div>
                    {renderModelSelector()}
                  </div>
                </div>
                {renderProviderDisplayControls('edit')}
              </div>
              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => { setEditingProvider(null); resetForm(); }}>{t.common.cancel}</button>
                <button className="btn-primary" onClick={handleUpdateProvider}>{t.common.save}</button>
              </div>
            </div>
          </div>
        </div>
      );
    };


  // ==================== Settings Context Value ====================
  /* All tab-specific state/handlers exposed to extracted tab components via useSettingsContext(). */
  const settingsContextValue: React.ComponentProps<typeof SettingsContext.Provider>['value'] = {
    t, language, setActiveTab,
    // providers (ProvidersTab + EditorTab + OrchestratorTab + RoutingTab)
    providers, loading, healthMap, healthDataLoaded,
    autoHealthCheckEnabled, handleAutoHealthCheckToggle,
    showHealthIntervalPopover, setShowHealthIntervalPopover,
    healthCheckIntervalMinutes, healthPopoverRef,
    formatHealthIntervalLabel, handleHealthIntervalChange,
    getHealthLabel, getHealthPercent, cancelHealthCheck, checkProviderHealth,
    resetForm, setShowAddForm, openEditModal, handleSetDefault, handleDeleteProvider,
    getProviderHealthStatus,
    showAddForm, editingProvider, setEditingProvider,
    formName, setFormName,
    formProtocol, setFormProtocol,
    formApiKey, setFormApiKey,
    formBaseUrl, setFormBaseUrl,
    formUrlSuffix, setFormUrlSuffix,
    formMaxTokens, setFormMaxTokens,
    formMaxInputTokens, setFormMaxInputTokens,
    formModels, setFormModels,
    formShowInModelPicker, setFormShowInModelPicker,
    formClaudeCodeMode, setFormClaudeCodeMode,
    formPresetId, setFormPresetId,
    formImageEditFormat, setFormImageEditFormat,
    formTabs, setFormTabs,
    handleAddProvider, handleUpdateProvider,
    getDefaultUrlSuffix,
    getDefaultBaseUrl,
    renderModelSelector, renderProviderDisplayControls,
    fetchRemoteModels, remoteModelOptions, remoteModelsLoading, remoteModelsError,
    handleDeleteProviders,
    // routing
    routingEnabled, handleRoutingToggle, modelRoutes,
    resetRouteForm, setShowAddRouteForm, showAddRouteForm,
    editingRoute, setEditingRoute,
    routeFormAlias, setRouteFormAlias,
    routeFormStrategy, setRouteFormStrategy,
    routeFormProviders, setRouteFormProviders,
    handleDeleteRoute, handleSaveRoute,
    handleSelectProviderModel, handleRemoveProviderFromRoute,
    handleDragStart, handleDragOver, handleDragEnd, draggedIndex,
    providerDropdownRef, providerDropdownMenuRef, dropdownTriggerRef,
    toggleProviderDropdown, providerDropdownOpen, dropdownPosition,
    // orchestrator
    agenticTaskAgentProviderId, agenticTaskAgentModel,
    agenticClaudeExploreUseHaiku,
    agenticSideAgentEnabled, agenticSideAgentDisableThinking,
    agenticSideAgentToolUseSummary, agenticSideAgentSessionTitle,
    handleAgenticTaskAgentConfigChange, handleAgenticClaudeExploreUseHaikuChange,
    handleAgenticSideAgentEnabledChange, handleAgenticSideAgentDisableThinkingChange,
    handleAgenticSideAgentFeatureChange,
    // agent
    sandboxEnabled, handleSandboxChange,
    approvalMode, handleApprovalModeChange,
    piiFilterEnabled, handlePiiFilterChange,
    agentRuntime, setAgentRuntime,
    servicesStopConfirmation, setServicesStopConfirmation,
    webSearchEnabled, handleWebSearchToggle,
    webSearchEngine, setWebSearchEngine: handleWebSearchEngineChange,
    webSearchUrl, setWebSearchUrl,
    webSearchApiKey, setWebSearchApiKey,
    webSearchApiKeyVisible, setWebSearchApiKeyVisible,
    handleWebSearchSave, webSearchSaving,
    indexLoading, indexStats, indexBuilding, indexBuildProgress,
    handleBuildIndex, handleClearIndex, setShowIndexExcludeConfig,
    // mcp
    mcpEnabled, handleMcpToggle, mcpLoading, mcpServers,
    mcpConnectionStatus, mcpToolCounts, mcpServerTools, mcpLastErrors,
    handleMcpDisconnect, handleMcpConnect, handleMcpServerToggle,
    handleMcpEdit, handleMcpDelete, loadMcpServers, setMcpLastErrors, setMcpConnectionStatus,
    showMcpAddForm, setShowMcpAddForm, editingMcpServer, setEditingMcpServer,
    viewingMcpServer, setViewingMcpServer,
    mcpFormId, setMcpFormId,
    mcpFormName, setMcpFormName,
    mcpFormTransport, setMcpFormTransport,
    mcpFormCommand, setMcpFormCommand,
    mcpFormArgs, setMcpFormArgs,
    mcpFormUrl, setMcpFormUrl,
    mcpFormEnv, setMcpFormEnv,
    mcpFormScope, setMcpFormScope,
    mcpFormAutoConnect, setMcpFormAutoConnect,
    handleMcpSave, resetMcpForm,
    // memory
    memoryLoading, memoryStats, memoryConfig, handleMemoryConfigChange,
    loadMemoryPreview, loadMemoryStats, loadMemoryItems,
    showMemoryPreview, setShowMemoryPreview, memoryPreview,
    memorySearchQuery, setMemorySearchQuery,
    memoryBrowseType, setMemoryBrowseType,
    memoryItems, handleMemorySearch,
    showMemoryBrowser, setShowMemoryBrowser,
    // context
    contextUsage, contextConfig, contextLoading,
    expandedRole, setExpandedRole,
    handleContextConfigChange, loadContextConfig, buildByRole,
    // skills
    skillFilterSource, setSkillFilterSource,
    skillFilterCategory, setSkillFilterCategory,
    loadSkills, skillsLoading, filteredSkills, skillGroups, installedMetas,
    /* 失败要能报给用户 —— 导入按钮之前失败和成功长得一模一样 */
    dispatchOpFailed,
    handleSkillView, handleSkillEdit, handleSkillExport, handleSkillDelete,
    handleSkillK4Update, handleSkillK4Trust, handleSkillK4Untrust, handleSkillK4Uninstall,
    resetSkillForm, setShowSkillAddForm, setShowSkillImportForm,
    setShowSkillHistory, setSkillExecutionHistory,
    showSkillAddForm, showSkillImportForm,
    skillFormId, setSkillFormId,
    skillFormName, setSkillFormName,
    skillFormDesc, setSkillFormDesc,
    skillFormInstructions, setSkillFormInstructions,
    skillFormCategory, setSkillFormCategory,
    skillFormTarget, setSkillFormTarget,
    skillImportUrl, setSkillImportUrl,
    skillImportTarget, setSkillImportTarget,
    skillPreview, setSkillPreview,
    skillPreviewLoading, setSkillPreviewLoading,
    handleSkillCreate, handleSkillImport,
    viewingSkill, setViewingSkill,
    /* 编辑现有技能 = 详情页里的原文编辑 (SKILL.md 所见即所存), 不再有独立的编辑表单视图 */
    selectedSkill,
    // storage
    storageInfo, storageLoading, storageAdvancedOpen, setStorageAdvancedOpen,
    handleClearAllCheckpoints, handleClearCheckpoint,
    formatSize, expandedDirs, toggleDir, previewConfigFile, dirContents, openInFinder,
    // usage
    usageSummary, usageIsCloud, cloudUsageError, cloudUsageLastSuccessAt,
    usageSource, setUsageSource, usageHasMembership,
    usageLoading, usageViewMode, setUsageViewMode, costEstimate,
    providerStats, expandedProviders, setExpandedProviders,
    selectedProviderRecords, setSelectedProviderRecords,
    showPricingConfig, setShowPricingConfig,
    newPricing, setNewPricing, pricingLoading, pricingList,
    exportUsageReport, clearAllUsageStats, loadUsageStats,
    getProviderDistribution, getModelDistribution,
    loadProviderRecords, clearProviderUsageStats,
    loadPricingConfig, savePricing, deletePricing,
    formatTokenCount, formatTime,
    // model profile
    modelProfile, selectedModelProfile, allModelProfiles,
    filteredModelProfiles, modelProfileQuery, setModelProfileQuery,
    toolsetOverrideText, setToolsetOverrideText,
    toolsetOverrideSource, toolsetOverrideLoading, toolsetOverrideSaving,
    toolPaletteQuery, setToolPaletteQuery,
    selectedOverrideTools, filteredToolCandidates, toolDescByName,
    loadModelProfile, handleSelectModelProfile,
    toggleOverrideTool, handleSaveModelToolsetOverride, handleResetModelToolsetOverride,
  };

  return (
    <SettingsContext.Provider value={settingsContextValue}>
    <div
      /* 嵌入模式【不挂 .settings-overlay】—— 那个 class 上堆着一层层主题遮罩规则
       * (`:root[data-theme="dark"] .settings-overlay { background: rgba(0,0,0,.62) !important }`
       *  等等, 还是逗号选择器组, 匹配分支的特异性各不相同)。
       * 我试过用 :root / [data-theme] / [data-theme-pack] 一路加前缀去压, 每次都正好打平
       * 或被下一条盖掉 —— 那是特异性军备竞赛, 不是修。
       * 换个独立 class, 主题规则根本匹配不到, 遮罩自然不存在。
       * (内层 .settings-page 必须保留 —— 页面内部几百条样式都挂在它下面。) */
      ref={overlayRef}
      /* tabIndex=-1: 让这层能接收焦点。打开时把焦点收进来 —— 见 overlayRef 的 effect。 */
      tabIndex={embedded ? undefined : -1}
      className={embedded ? 'neox-embedded-settings' : `settings-overlay${isClosing ? ' is-closing' : ''}`}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      onMouseDown={(e) => { if (!embedded && e.target === e.currentTarget) requestClose(); }}
    >
    <div className={`settings-page${embedded ? ' is-embedded' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      {!embedded && <div className="settings-chrome settings-chrome--close-only">
        <button
          className="settings-chrome__close"
          onClick={requestClose}
          title={language === 'zh' ? '关闭设置' : 'Close Settings'}
          aria-label={language === 'zh' ? '关闭设置' : 'Close Settings'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>}

      <div className="settings-layout">
        {/* 嵌入模式不画左侧 27 项导航 —— 点「技能」就只看技能 */}
        {(!embedded || embedded.withNav) && <aside
          className="settings-sidebar"
          onWheel={(e) => {
            const nav = navRef.current;
            if (!nav || nav.contains(e.target as Node) || !e.deltaY) return;
            const step = e.deltaMode === 1 ? e.deltaY * 16
              : e.deltaMode === 2 ? e.deltaY * nav.clientHeight
              : e.deltaY;
            nav.scrollTop += step;
            /* 指针在左栏, 就别再让事件冒到右侧内容区把它一起滚了 */
            e.stopPropagation();
          }}
        >
          {embedded?.withNav && (
            <button type="button" className="settings-sidebar__back" onClick={onClose}>
              <Icons.ChevronLeft /><span>{language === 'zh' ? '返回' : 'Back'}</span>
            </button>
          )}
          <div className="settings-sidebar__search">
            <Icons.Search />
            <input
              ref={searchInputRef}
              type="text"
              className="settings-sidebar__search-input"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setNavQuery(''); return; }
                if (e.key === 'ArrowDown') { e.preventDefault(); setNavSel((i) => Math.min(i + 1, settingsHits.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setNavSel((i) => Math.max(i - 1, 0)); return; }
                if (e.key === 'Enter') { e.preventDefault(); const hit = settingsHits[navSel]; if (hit) navigateToSetting(hit); }
              }}
              placeholder={language === 'zh' ? '搜索设置…' : 'Search settings…'}
            />
          </div>


          <nav
            className="settings-nav"
            ref={navRef}
            data-more={navHasMore ? '1' : undefined}
            onScroll={syncNavOverflow}
          >
            {/* 有查询就把这份导航换成命中列表 —— 分组在筛选态没有意义 (一组可能只剩一项,
              * 一堆空组头比结果还多)。清空输入即回到分组常驻态。 */}
            {navQuery.trim() ? (
              settingsHits.length === 0 ? (
                <div className="settings-nav__empty">{language === 'zh' ? '没有匹配的设置' : 'No matching settings'}</div>
              ) : settingsHits.map((it, i) => (
                <button
                  key={it.tab + (it.anchor || '')}
                  className={`nav-item${i === navSel ? ' is-sel' : ''}${activeTab === it.tab && !it.anchor ? ' active' : ''}`}
                  onMouseEnter={() => setNavSel(i)}
                  onClick={() => navigateToSetting(it)}
                >
                  <Icons.Sliders />
                  <span>{language === 'zh' ? it.zh : it.en}</span>
                </button>
              ))
            ) : NAV_GROUPS_ORDER
              .filter((g) => modeVariant.isSettingsGroupVisible(g))
              /* 「模型」组一页都看不见 (极简版没有 API 服务商、普通档没有路由 / 适配) 时整组不出现, 省一个空壳组头 */
              .filter((g) => g !== 'advanced' || ['providers', 'routing', 'modelprofile'].some(isTabVisible))
              .map((groupKey) => {
              /* 扁平常驻后组标题只是段落标签, 不再需要副标题 ——
               * 副标题原本是"折叠时替内容说话", 现在内容本身就摊在下面。
               * (顺带解决了它历史上两次"描述与内容不符": 副标题写着的 tab 在当前
               *  模式/档位下其实不可见。摊开之后不可能再对不上。) */
              const isCurrent = openGroup === groupKey;
              const zhL = language === 'zh';
              /* 没有账号体系的构建里这组只剩个人信息和本机用量, 叫「账户」名不副实 */
              const title = groupKey === 'account' ? (getEditionHook('hasAccount') ? (zhL ? '账户' : 'Account') : (zhL ? '我' : 'You'))
                : groupKey === 'core' ? (zhL ? '偏好' : 'Preferences')
                : groupKey === 'tools' ? 'Agent'
                : groupKey === 'advanced' ? (zhL ? '模型' : 'Models')
                : (zhL ? '连接与系统' : 'Connections & system');
              return (
                /* is-open 恒挂: 下面 items-shell 的展开高度靠它, 扁平化后不再有折叠态 */
                <div key={groupKey} className="settings-nav__group is-open">
                  <div className={`settings-nav__group-label${isCurrent ? ' is-current' : ''}`}>{title}</div>
                  <div className="settings-nav__group-items-shell">
                    <div className="settings-nav__group-items">
                      {groupKey === 'account' && <>
                        {isTabVisible('profile') && (
                          <button className={`nav-item ${activeTab === 'profile' ? 'active' : ''}`} onClick={() => setActiveTab('profile')}>
                          <Icons.User /><span>{language === 'zh' ? '个人信息' : 'About You'}</span>
                        </button>
                        )}
                        {isTabVisible('account') && (
                          <button className={`nav-item ${activeTab === 'account' ? 'active' : ''}`} onClick={() => setActiveTab('account')}>
                          <Icons.IdCard /><span>{language === 'zh' ? '我的账户' : 'My Account'}</span>
                        </button>
                        )}
                        {isTabVisible('subscription') && (
                          <button className={`nav-item ${activeTab === 'subscription' ? 'active' : ''}`} onClick={() => setActiveTab('subscription')}>
                          <Icons.CreditCard /><span>{language === 'zh' ? '订阅与账单' : 'Subscription'}</span>
                        </button>
                        )}
                        {isTabVisible('usage') && (
                          <button className={`nav-item ${activeTab === 'usage' ? 'active' : ''}`} onClick={() => setActiveTab('usage')}>
                          <Icons.ChartSquare /><span>{language === 'zh' ? '用量' : 'Usage'}</span>
                        </button>
                        )}
                        {/* 账户安全 / 设备会话 等深操作收敛到 Web 控制台,
                         * desktop 只保留只读入口在「我的账户」hero 按钮里 */}
                      </>}
                      {groupKey === 'core' && <>
                        {/* "偏好" — 全用户都看的基础体验配置. BYOK / Routing 等高级配置在 advanced 组. */}
                        {isTabVisible('theme') && (
                          <button className={`nav-item ${activeTab === 'theme' ? 'active' : ''}`} onClick={() => setActiveTab('theme')}>
                          <Icons.Palette /><span>{language === 'zh' ? '外观' : 'Appearance'}</span>
                        </button>
                        )}
                        {isTabVisible('conversation') && (
                          <button className={`nav-item ${activeTab === 'conversation' ? 'active' : ''}`} onClick={() => setActiveTab('conversation')}>
                          <Icons.Chat /><span>{language === 'zh' ? '对话' : 'Conversation'}</span>
                        </button>
                        )}
                        {isTabVisible('editor') && (
                          <button className={`nav-item ${activeTab === 'editor' ? 'active' : ''}`} onClick={() => setActiveTab('editor')}>
                          <Icons.Edit /><span>{language === 'zh' ? '编辑器' : 'Editor'}</span>
                        </button>
                        )}
                        {isTabVisible('tts') && (
                          <button className={`nav-item ${activeTab === 'tts' ? 'active' : ''}`} onClick={() => setActiveTab('tts')}>
                          <Icons.Mic /><span>{language === 'zh' ? '语音' : 'TTS'}</span>
                        </button>
                        )}
                        {isTabVisible('notify') && (
                          <button className={`nav-item ${activeTab === 'notify' ? 'active' : ''}`} onClick={() => setActiveTab('notify')}>
                          <Icons.Bell /><span>{language === 'zh' ? '通知' : 'Notifications'}</span>
                        </button>
                        )}
                        {/* 「宠物」页: 自研的猫 / 柯基 (输入框旁) 和开源桌宠 (桌面悬浮窗) 二选一。
                            极简版没有开源桌宠 (悬浮窗 handler 没注册, 3D 资源也跟定位冲突),
                            PetTab 在极简版里只列自研的两只, 不碰悬浮窗 IPC —— 所以入口两边都留。 */}
                        {isTabVisible('pet') && (
                          <button className={`nav-item ${activeTab === 'pet' ? 'active' : ''}`} onClick={() => setActiveTab('pet')}>
                          <Icons.Paw /><span>{language === 'zh' ? '宠物' : 'Pet'}</span>
                        </button>
                        )}
                      </>}
                      {groupKey === 'tools' && <>
                        {isTabVisible('agent') && (
                          <button className={`nav-item ${activeTab === 'agent' ? 'active' : ''}`} onClick={() => setActiveTab('agent')}>
                          <Icons.Shield /><span>{language === 'zh' ? '权限' : 'Permissions'}</span>
                        </button>
                        )}
                        {isTabVisible('browser') && (
                          <button className={`nav-item ${activeTab === 'browser' ? 'active' : ''}`} onClick={() => setActiveTab('browser')}>
                          <Icons.Globe /><span>{language === 'zh' ? '浏览器' : 'Browser'}</span>
                        </button>
                        )}
                        {isTabVisible('websearch') && (
                          <button className={`nav-item ${activeTab === 'websearch' ? 'active' : ''}`} onClick={() => setActiveTab('websearch')}>
                          <Icons.WebSearch /><span>{language === 'zh' ? '联网搜索' : 'Web Search'}</span>
                        </button>
                        )}
                        {isTabVisible('codeindex') && (
                          <button className={`nav-item ${activeTab === 'codeindex' ? 'active' : ''}`} onClick={() => setActiveTab('codeindex')}>
                          <Icons.Structure /><span>{language === 'zh' ? '代码索引' : 'Code Index'}</span>
                        </button>
                        )}
                        {isTabVisible('memory') && (
                          <button className={`nav-item ${activeTab === 'memory' ? 'active' : ''}`} onClick={() => setActiveTab('memory')}>
                          <Icons.Brain /><span>{language === 'zh' ? '记忆' : 'Memory'}</span>
                        </button>
                        )}
                        {isTabVisible('skills') && (
                          <button className={`nav-item ${activeTab === 'skills' ? 'active' : ''}`} onClick={() => setActiveTab('skills')}>
                          <Icons.Zap /><span>{language === 'zh' ? '技能' : 'Skills'}</span>
                        </button>
                        )}
                        {isTabVisible('mcp') && (
                          <button className={`nav-item ${activeTab === 'mcp' ? 'active' : ''}`} onClick={() => setActiveTab('mcp')}>
                          <Icons.Puzzle /><span>{modeVariant.isWork ? (language === 'zh' ? '外部服务' : 'Services') : (language === 'zh' ? 'MCP 工具' : 'MCP')}</span>
                        </button>
                        )}
                        {isTabVisible('orchestrator') && (
                          <button className={`nav-item ${activeTab === 'orchestrator' ? 'active' : ''}`} onClick={() => setActiveTab('orchestrator')}>
                          <Icons.Workflow /><span>{language === 'zh' ? '子 Agent' : 'Sub-agents'}</span>
                        </button>
                        )}
                        {isTabVisible('context') && (
                          <button className={`nav-item ${activeTab === 'context' ? 'active' : ''}`} onClick={() => setActiveTab('context')}>
                          <Icons.Layout /><span>{language === 'zh' ? '上下文' : 'Context'}</span>
                        </button>
                        )}
                      </>}
                      {groupKey === 'advanced' && <>
                        {isTabVisible('providers') && (
                          <button className={`nav-item ${activeTab === 'providers' ? 'active' : ''}`} onClick={() => setActiveTab('providers')}>
                          <Icons.Cube /><span>{modeVariant.isWork ? (language === 'zh' ? '模型服务' : 'Models') : (language === 'zh' ? 'API 服务商 (BYOK)' : 'Providers (BYOK)')}</span>
                        </button>
                        )}
                        {isTabVisible('routing') && (
                          <button className={`nav-item ${activeTab === 'routing' ? 'active' : ''}`} onClick={() => setActiveTab('routing')}>
                          <Icons.GitFork /><span>{language === 'zh' ? '模型路由' : 'Routing'}</span>
                        </button>
                        )}
                        {isTabVisible('modelprofile') && (
                          <button className={`nav-item ${activeTab === 'modelprofile' ? 'active' : ''}`} onClick={() => setActiveTab('modelprofile')}>
                          <Icons.Sliders /><span>{language === 'zh' ? '模型适配' : 'Model Adaptation'}</span>
                        </button>
                        )}
                      </>}
                      {groupKey === 'system' && <>
                        {/* "远程访问" = MobileBridge (Mode A LAN P2P + Mode B Cloud Relay). */}
                        {isTabVisible('mobile') && (
                          <button className={`nav-item ${activeTab === 'mobile' ? 'active' : ''}`} onClick={() => setActiveTab('mobile')}>
                          <Icons.Wifi /><span>{modeVariant.isWork ? (language === 'zh' ? '手机连接' : 'Phone') : (language === 'zh' ? '远程访问' : 'Remote Access')}</span>
                        </button>
                        )}
                        {isTabVisible('github') && (
                          <button className={`nav-item ${activeTab === 'github' ? 'active' : ''}`} onClick={() => setActiveTab('github')}>
                          <Icons.GitBranch /><span>GitHub</span>
                        </button>
                        )}
                        {isTabVisible('cloud-agent') && (
                          <button className={`nav-item ${activeTab === 'cloud-agent' ? 'active' : ''}`} onClick={() => setActiveTab('cloud-agent')}>
                          <Icons.Cloud /><span>{language === 'zh' ? '云端 Agent' : 'Cloud Agent'}</span>
                        </button>
                        )}
                        {isTabVisible('experimental') && (
                          <button className={`nav-item ${activeTab === 'experimental' ? 'active' : ''}`} onClick={() => setActiveTab('experimental')}>
                          <Icons.Flask /><span>{language === 'zh' ? '实验功能' : 'Experimental'}</span>
                        </button>
                        )}
                        {isTabVisible('storage') && (
                          <button className={`nav-item ${activeTab === 'storage' ? 'active' : ''}`} onClick={() => setActiveTab('storage')}>
                          <Icons.Folder /><span>{t.settings.menu.storage}</span>
                        </button>
                        )}
                        {isTabVisible('share') && (
                          <button className={`nav-item ${activeTab === 'share' ? 'active' : ''}`} onClick={() => setActiveTab('share')}>
                          <Icons.Link /><span>{language === 'zh' ? '网页分享' : 'Web sharing'}</span>
                        </button>
                        )}
                        {isTabVisible('diagnostics') && (
                          <button className={`nav-item ${activeTab === 'diagnostics' ? 'active' : ''}`} onClick={() => setActiveTab('diagnostics')}>
                          <Icons.Activity /><span>{language === 'zh' ? '诊断' : 'Diagnostics'}</span>
                        </button>
                        )}
                        {isTabVisible('about') && (
                          <button className={`nav-item ${activeTab === 'about' ? 'active' : ''}`} onClick={() => setActiveTab('about')}>
                          <Icons.Info /><span>{t.settings.menu.about}</span>
                        </button>
                        )}
                      </>}
                    </div>
                  </div>
                </div>
              );
            })}
          </nav>

          {/* 底部一行 (UI 3.0): 左「反馈问题」, 右「高级」开关 —— 原来两行占掉导航两格高 */}
          <div className="settings-sidebar__foot">
          <FeedbackNavRow zh={language === 'zh'} />

          {/* 「显示高级设置」放在导航**最底下**: 它不是一个设置项, 是决定上面这份导航有多长的
              总闸。放顶部会顶在标题和第一组之间, 切档时整份导航从眼睛落点开始往下窜。 */}
          <button
            type="button"
            className={`settings-level-row${settingsLevel === 'advanced' ? ' is-on' : ''}`}
            role="switch"
            aria-checked={settingsLevel === 'advanced'}
            onClick={() => setLevel(settingsLevel === 'advanced' ? 'basic' : 'advanced')}
            title={language === 'zh'
              ? '模型、沙箱、诊断这些平时用不到的设置'
              : 'Models, sandbox, diagnostics — the settings you rarely need'}
          >
            <span className="settings-level-row__label">
              {language === 'zh' ? '高级' : 'Advanced'}
            </span>
            <span className="settings-level-row__switch" aria-hidden="true" />
          </button>
          </div>
         </aside>}

        {/* 右侧内容 - lazy-loaded tab components.
         *  key={activeTab} 让 React 在切 tab 时把外层 div 重挂载,
         *  CSS 动画 (.settings-tab-anim) 因此每次都重新触发. */}
        <main className="settings-main">
          <Suspense fallback={<TabLoadingFallback />}>
            {/* data-tab: UI 3.0 页头陶土小图标按它挂 (shell/clay-studio.css), 不用一页页改 */}
            <div className="settings-tab-anim" key={activeTab} data-tab={activeTab}>
              {activeTab === 'account' && <UiSlot name="settings.tab.account" props={{}} />}
              {activeTab === 'subscription' && <UiSlot name="settings.tab.subscription" props={{}} />}
              {activeTab === 'usage' && <LazyUsageTab />}
              {activeTab === 'providers' && <LazyProvidersTab />}
              {activeTab === 'routing' && <LazyRoutingTab />}
              {activeTab === 'orchestrator' && <LazyOrchestratorTab />}
              {activeTab === 'conversation' && <LazyConversationTab />}
              {activeTab === 'agent' && <LazyAgentTab />}
              {activeTab === 'websearch' && <LazyWebSearchTab />}
              {activeTab === 'codeindex' && <LazyCodeIndexTab />}
              {activeTab === 'mcp' && <LazyMcpTab />}
              {activeTab === 'skills' && <LazySkillsTab />}
              {activeTab === 'memory' && <LazyMemoryTab />}
              {activeTab === 'browser' && <LazyBrowserTab />}
              {activeTab === 'github' && <LazyGithubTab />}
              {activeTab === 'processes' && <LazyProcessesTab />}
              {activeTab === 'context' && <LazyContextTab />}
              {/* activeTab === 'remote' 已废 (老占位删除), 用 'mobile' tab (远程访问 label) */}
              {activeTab === 'tts' && <LazyTtsTab />}
              {activeTab === 'profile' && <LazyProfileTab />}
              {activeTab === 'experimental' && <LazyExperimentalTab />}
              {activeTab === 'editor' && <LazyEditorTab />}
              {activeTab === 'runconfig' && <LazyRunconfigTab />}
              {activeTab === 'notify' && <LazyNotifyTab />}
              {activeTab === 'theme' && <LazyThemeTab />}
              {activeTab === 'pet' && <LazyPetTab />}
              {activeTab === 'mobile' && <LazyMobileBridgeTab />}
              {activeTab === 'cloud-agent' && <LazyCloudAgentTab />}
              {activeTab === 'storage' && <LazyStorageTab />}
              {activeTab === 'modelprofile' && <LazyModelProfileTab />}
              {activeTab === 'diagnostics' && <LazyDiagnosticsTab />}
              {activeTab === 'share' && <LazyShareTab />}
              {activeTab === 'about' && <LazyAboutTab />}
            </div>
          </Suspense>
        </main>
      </div>


      {/* 文件预览模态框 */}
      {renderPreviewModal()}



      {/* 代码索引排除规则配置 */}
      {showIndexExcludeConfig && (
        <div className="modal-overlay" onClick={() => setShowIndexExcludeConfig(false)}>
          <div className="modal-content index-exclude-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{language === 'zh' ? '索引排除规则' : 'Index Exclude Rules'}</h3>
              <button className="modal-close" onClick={() => setShowIndexExcludeConfig(false)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="modal-body">
              <p className="exclude-hint">
                {language === 'zh'
                  ? '配置不需要索引的文件和目录（支持 glob 模式）'
                  : 'Configure files and directories to exclude (glob patterns supported)'}
              </p>
              <div className="exclude-add-row">
                <input
                  type="text"
                  value={newExcludePattern}
                  onChange={e => setNewExcludePattern(e.target.value)}
                  placeholder={language === 'zh' ? '输入排除模式...' : 'Enter pattern...'}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newExcludePattern.trim()) {
                      setIndexExcludePatterns([...indexExcludePatterns, newExcludePattern.trim()]);
                      setNewExcludePattern('');
                    }
                  }}
                />
                <button
                  className="add-pattern-btn"
                  onClick={() => {
                    if (newExcludePattern.trim()) {
                      setIndexExcludePatterns([...indexExcludePatterns, newExcludePattern.trim()]);
                      setNewExcludePattern('');
                    }
                  }}
                 title={language === 'zh' ? '添加排除规则' : 'Add exclude pattern'} aria-label={language === 'zh' ? '添加排除规则' : 'Add exclude pattern'}>
                  <Icons.Plus />
                </button>
              </div>
              <div className="exclude-patterns-list">
                {indexExcludePatterns.map((pattern, i) => (
                  <div key={i} className="exclude-pattern-item">
                    <span className="pattern-text">{pattern}</span>
                    <button
                      className="remove-pattern-btn"
                      onClick={() => setIndexExcludePatterns(indexExcludePatterns.filter((_, idx) => idx !== i))}
                     title={language === 'zh' ? '移除这条规则' : 'Remove this pattern'} aria-label={language === 'zh' ? '移除这条规则' : 'Remove this pattern'}>
                      <Icons.Close />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowIndexExcludeConfig(false)}>
                {t.common.close}
              </button>
              <button
                className="save-btn"
                onClick={async () => {
                  await saveIndexExcludePatterns(indexExcludePatterns);
                  setShowIndexExcludeConfig(false);
                }}
              >
                {language === 'zh' ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}




      {showSkillHistory && activeTab === 'skills' && (
        <div className="modal-overlay" onClick={() => setShowSkillHistory(false)}>
          <div className="modal-content skill-history-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{language === 'zh' ? '执行历史' : 'Execution History'}</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {skillExecutionHistory.length > 0 && (
                  <button className="btn-secondary" style={{ fontSize: '12px', padding: '4px 8px' }} onClick={async () => {
                    try {
                      await (window as any).neox.skillsClearHistory();
                      setSkillExecutionHistory([]);
                    } catch (e) {
                      console.error('Failed to clear skill history:', e);
                    }
                  }}>
                    {language === 'zh' ? '清空' : 'Clear'}
                  </button>
                )}
                <button className="modal-close" onClick={() => setShowSkillHistory(false)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                  <Icons.Close />
                </button>
              </div>
            </div>
            <div className="modal-body">
              {skillExecutionHistory.length === 0 ? (
                <div className="empty-state">
                  <p>{language === 'zh' ? '暂无执行记录' : 'No execution history'}</p>
                </div>
              ) : (
                <div className="skill-history-list">
                  {[...skillExecutionHistory].reverse().map(item => (
                    <div key={item.id} className={`history-item ${item.status}`}>
                      <div className="history-info">
                        <span className="history-skill">/{item.skillId}</span>
                        <span className="history-time">
                          {new Date(item.timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="history-meta">
                        <span className={`status-badge ${item.status}`}>
                          {item.status === 'success'
                            ? (language === 'zh' ? '已调用' : 'Invoked')
                            : (language === 'zh' ? '失败' : 'Failed')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 进程输出对话框 → 已移入 ProcessesTab */}
    </div>
    </div>
    </SettingsContext.Provider>
  );
};


const RateLimitUsagePanel: React.FC<{ language: string }> = ({ language }) => {
  const [usage, setUsage] = React.useState<Array<{
    windowId: string;
    label: string;
    requests: number;
    tokens: number;
    maxRequests: number;
    maxTokens: number;
  }>>([]);

  React.useEffect(() => {
    // 注意: getRateLimitUsage 挂在 window.neox 上 (preload.cjs:754), 不是 window.api。
    // 历史笔误读 window.api → 永远 undefined → 整个"用量窗口"面板从不渲染。
    const api = (window as any).neox;
    if (api?.getRateLimitUsage) {
      api.getRateLimitUsage().then((data: any) => {
        if (Array.isArray(data)) setUsage(data);
      }).catch(() => {});
    }
  }, []);

  const hasUsage = usage.some(u => u.requests > 0);
  if (!hasUsage) return null;

  const formatK = (n: number): string => {
    if (n >= 1_000_000) {
      const value = n / 1_000_000;
      const nearest = Math.round(value);
      if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
      return `${(value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, ''))}M`;
    }
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  return (
    <div className="settings-section" style={{ borderBottom: 'none' }}>
      <h3 className="section-title">{language === 'zh' ? '用量窗口' : 'Rate Limit Windows'}</h3>
      <div className="usg-metrics" style={{ gap: '8px' }}>
        {usage.filter(u => u.requests > 0).map(u => {
          const pct = u.maxRequests > 0
            ? Math.min(100, Math.round((u.requests / u.maxRequests) * 100))
            : -1;
          return (
            <div key={u.windowId} className="usg-metric" style={{ flex: '1', minWidth: '120px' }}>
              <span className="usg-metric-val">{u.requests}</span>
              <span className="usg-metric-lbl">{language === 'zh' ? `${u.label} 请求` : `${u.label} requests`}</span>
              <span className="usg-metric-lbl" style={{ fontSize: '10px', opacity: 0.6 }}>{formatK(u.tokens)} tokens</span>
              {pct >= 0 && (
                <div style={{ width: '100%', height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '4px' }}>
                  <div style={{
                    width: `${pct}%`,
                    height: '100%',
                    borderRadius: '2px',
                    background: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e',
                  }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SettingsPage;
