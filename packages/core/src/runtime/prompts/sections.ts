
import {
  registerSection,
  type SectionInput,
} from './sectionRegistry.js';

import { buildGeneralAssistantPrompt } from './layers/general-assistant.js';
import { buildWorkModePrompt } from './layers/work-mode.js';
import { buildUniversalConstraints } from './layers/universal-constraints.js';
import { buildVerificationMandate } from './layers/verification-mandate.js';
import { buildServiceAwarenessMandate } from './layers/service-awareness-mandate.js';
import { buildLengthBudget } from './layers/length-budget.js';
import { buildEnvironmentInfo, buildSkillsSection } from './layers/index.js';
import { getCachedInstructions, formatInstructionsForPrompt } from '@neoxlabs/kernel/core/projectInstructions.js';
import {
  getProviderSupplement,
  getMarkdownFormatConstraint,
  getModelIdentityNote,
} from './providerSupplements.js';
import { getToolServices } from '../../tools/runtimeToolServices.js';
import { getCurrentSandboxMode, SandboxMode } from '@neoxlabs/kernel';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSessionMemoryMarkdown, sessionMemoryForPrompt } from '../../memory/sessionMemorySummarizer.js';
import { knowledgeRegistry } from '../../knowledge/registry.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ============================================================================
// 内联常量 (从 systemPrompt.ts 搬来, 避免循环依赖)
// ============================================================================

const EDIT_TOOL_OVERRIDE = `File tools:
- \`edit\` (aka edit_file / apply_patch) is content-addressed: old_string / new_string, never line numbers or hashes. Follow the \`edit\` tool description — it is the only spec.
- \`write_file\` for new files / full rewrite. Not restricted.`;

const BROWSER_SURFACE_GUIDANCE = `Surface 画布 (桌面右栏) + Browser (Neox 内嵌浏览器, Playwright 远程控制):

**产出物主动推右栏**: 写/改了 \`.md\` / \`.html\` / \`.svg\` / \`.docx\` / \`.xlsx\` / \`.pdf\`、输出 \`\`\`mermaid 块、生成图片、dev server ready 后, 主动 \`open_surface\` 推到右栏画布 — 只在聊天里贴文本用户看不到渲染效果. 跟写完代码跑 typecheck 同级的收尾动作.
- \`open_surface({kind, source, title?})\`: kind = \`doc\`/\`diagram\`/\`image\`/\`html\`/\`svg\`/\`pdf\`/\`sheet\`/\`docx\`/\`web\`; source = \`{type:'file',path}\` / \`{type:'inline',content}\` / \`{type:'url',url}\`
- 不推的场景: 改源码 / 配置 / 测试 / 一次性 read. 同种产出已开过 → \`update_surface\` 替换 source, 别重复 open (file 模式自动 watch, 改文件即刷新).

**Browser: 用 \`browser_run\` 写脚本, 不要一步一步点**
- 入口: \`browser_list_surfaces\` (常驻) → \`tool_search({pack:"browser"})\` 解锁 → 用 \`browser_run\`.
- **一次调用跑一串动作**。你每发一个工具调用要花约 20 秒往返, 浏览器执行一个动作约 14ms
  (真站点实测: 39 个动作合计 547ms)。所以: **看一眼 → 写一段尽量长的脚本 → 只在失败时回来**。
  20 步任务逐个点是 7 分钟, 一段脚本是 20 多秒。等待和断言写进脚本里, 别写成单独的调用。
- **每个会改变页面的步骤都要带 \`expectChange\`**。没有它, "点了但没反应"会被当成成功, 后面所有
  步骤都建在错误前提上。真实踩过的三个坑:
  · 点到的是**折叠菜单组** → 只展开, URL 纹丝不动 (叶子菜单藏在组里, 先展开再点它)
  · 等一个这页面**根本没有**的 loading 元素 → 白等到超时
  · 断言写成 \`location.pathname.length > 1\` 这种**恒真**表达式 → 永远通过
  它的做法是动作前取基线、动作后等它变; 观察目标不存在会明确报"选择器没命中", 跟"动作没生效"
  分开报 —— 这两个指向完全不同的排查方向。
- **绝对不要在 eval 里写 \`setTimeout\` 睡等**。实测你会写 \`await new Promise(r=>setTimeout(r,3000))\`,
  甚至睡 10 秒 —— 一步 10 秒全是白等, 而动作本身只要几百毫秒。用 \`expectChange\`: 它 40ms 轮询一次,
  页面一变立刻继续 (通常几十毫秒), 等不到还会明确报错。**脚本里出现固定睡眠会被直接判失败**。
- 先看后写: \`get_aria_tree\` / \`query\` 看清结构再写脚本; \`screenshot\` 只在需要判断"看起来对不对"时用 (费 token).
- 浏览器**一轮结束不会自动关**, 登录态和页面都留着下一轮接着用。任务真做完了再用 \`browser_close_tab\` 收尾, 别每轮都关.
- 前端调试: \`get_console_logs({level:'error'})\` + \`get_network({failedOnly:true})\` + \`get_response_body({requestId})\` 找根因.
- 定位优先级: selector > role+name (aria_tree 后用) > text > 像素坐标 (最后手段, screenshot 后).
- 登录态: 浏览器 profile 持久化, 登录一次长期有效。遇到验证码/短信码**停下来让用户接管**, 别硬试 —— 他过完你接着跑, 状态还在.
- 用户没开浏览器时自己 \`open_surface({kind:'web', source:{type:'url', url}})\` → 立刻 list_surfaces + tool_search 解锁, 不要说"工具未激活".`;

const CLI_NO_GUI_COVERRECTION = {
  zh: `## 当前是 CLI 环境 — 无 surface 画布
- 以下 GUI 工具在 CLI **不存在, 禁止调用**: \`open_surface\` / \`update_surface\` / \`close_surface\` / \`update_plan\` / \`update_todos\`。
- 浏览器可以用: \`browser_*\` 会在本机拉起一个 Chrome (独立 profile, 没有右栏画布)。要操作网页就照常用 \`browser_run\`, 不要改用 curl 去读前端源码或直接调接口; 只有工具报错找不到 Chrome 时才退回 \`web_fetch\`。
- 给用户看产出物: 直接说文件路径 + 在回复里贴关键内容。规划任务用文字列步骤即可 (无 update_plan)。`,
  en: `## This is the CLI environment — no surface canvas
- These GUI tools DO NOT EXIST in CLI and must not be called: \`open_surface\` / \`update_surface\` / \`close_surface\` / \`update_plan\` / \`update_todos\`.
- The browser works: \`browser_*\` launches a local Chrome (separate profile, no side panel). For web tasks use \`browser_run\` as usual — don't switch to curl to read the page source or call its API directly; fall back to \`web_fetch\` only if the tool reports that Chrome was not found.
- To show artifacts: state the file path + paste key content in your reply. For planning, list steps as text (no update_plan).`,
};

// ============================================================================
// SectionInput 扩展字段
// ============================================================================

/**
 * 调用方 (systemPrompt.ts) 需要预先填好这些 SectionInput 派生字段:
 *
 *   - profileAppendInstructions:     profile.prompt.appendInstructions, 已 trim
 *   - projectInstructionsHash:       getCachedInstructions().hash
 *   - skillsHash:                    djb2Hash(skillRegistry.getSkillsForPrompt())
 *   - hostCapabilities.gui:          hostHasGuiCapability()
 *   - precedingTextForLegacyCheck:   profileAppendInstructions + projectInstructionsContent 拼接
 *
 * 不填则相应 section enabledWhen=false 或 cacheKey 退化为 STATIC.
 */

// ============================================================================
// 初始化 (idempotent)
// ============================================================================

let initialized = false;

/**
 * 注册所有 section. 多次调用是 no-op (registerSection 自带覆盖语义, 但跳过省 cycle).
 *
 * 调用时机: systemPrompt.ts 在 setInstructionsBuilder 时调一次.
 * 测试可显式调 __resetSectionsForTests() + 重新调本函数.
 */
export function initSectionsOnce(): void {
  if (initialized) return;
  initialized = true;
  registerAllSections();
}

/** 仅供测试: 重置 + 重注册 */
export function __resetSectionsForTests(): void {
  initialized = false;
}

function registerAllSections(): void {
  // ==========================================================================
  // 1-4. Layered Layer 1-2.6 — stable, language-keyed
  // ==========================================================================

  /* base 段 (layered 模式专属) — codex_official 有自己完整 prompt, kimi 用 kimiPromptBuilder
   * 自己的 system prompt, 这两种模式下不要这 8 个 section. 此外 profile.fullInstructions
   * 也会让 layered base 段全 skip (调用方设 hasExternalBase=true). */
  const LAYERED_ONLY: string[] = ['layered'];
  const notExternalBase = (i: SectionInput) => !i.hasExternalBase;

  registerSection({
    name: 'general-assistant',
    layer: 'stable',
    compute: (i) => {
      if (i.agentMode === 'work') return buildWorkModePrompt(i.language);
      return buildGeneralAssistantPrompt(i.language);
    },
    cacheKeyFields: ['language', 'agentMode'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  registerSection({
    name: 'universal-constraints',
    layer: 'stable',
    /* workDir 进 cache key 是因为现在 universal-constraints 里 environment 段被注释了,
     *  实际上不依赖 workDir. 但 buildUniversalConstraints 签名是 (workDir, language),
     *  为了未来 workDir 重新启用时不漏 key, 这里保留. */
    compute: (i) => buildUniversalConstraints(i.workDir, i.language),
    cacheKeyFields: ['workDir', 'language'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  /* verification-mandate 是代码级验证契约 (tests/typecheck/运行证据), 只对 code 模式注入.
   * assistant/work 的轻量诚实约束 (来源可查/交付自查) 已写进各自 mode prompt 正文。 */
  registerSection({
    name: 'verification-mandate',
    layer: 'stable',
    compute: (i) => buildVerificationMandate(i.language),
    cacheKeyFields: ['language'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: (i) => notExternalBase(i) && (i.agentMode ?? 'code') === 'code',
  });

  registerSection({
    name: 'service-awareness-mandate',
    layer: 'stable',
    compute: (i) => buildServiceAwarenessMandate(i.language),
    cacheKeyFields: ['language'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  // ==========================================================================
  // 4.5 Length Budget — 数字硬约束 (替代 "be concise" 形容词)
  //
  //   设计依据: 内部设计文档 §7
  //   注入位置: 紧跟在 service-awareness 之后 (与其他 layered base 段一起做 cache),
  // ==========================================================================
  registerSection({
    name: 'length-budget',
    layer: 'stable',
    compute: (i) => buildLengthBudget(i.language),
    cacheKeyFields: ['language'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  // ==========================================================================
  // 5. Skills — context (项目级 / registry 内容变才重建)
  // ==========================================================================

  registerSection({
    name: 'skills',
    layer: 'context',
    // header 文案单一来源在 layers/index.ts buildSkillsSection (硬规则版, 见该处注释)
    compute: (i) => buildSkillsSection(i.language),
    cacheKeyFields: ['language', 'skillsHash'],
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  // ==========================================================================
  // 6. Environment info — volatile (env-info 含日期/git, 每轮变)
  // ==========================================================================

  registerSection({
    name: 'environment-info',
    layer: 'volatile',
    compute: (i) => {
      if (i.skipEnvironment) return null;
      return buildEnvironmentInfo(i.workDir, i.language);
    },
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  // ==========================================================================
  // 7. Start marker — "开始工作。" / "Start working."
  // ==========================================================================
  /* 位置注: 在 env-info 后, profile-append 前. 这是 legacy buildLayeredPrompt 行为 (start
   * marker 是 layered 内最后一行, 然后 systemPrompt 在外面继续追加 EDIT_TOOL_OVERRIDE 等).
   * "开始工作" 卡在中间不合理, 但改顺序会让所有 cache 失效一次, 留 P2 修. */

  registerSection({
    name: 'start-marker',
    layer: 'volatile',  // 本身是静态文本, 但跟着 env-info 走, 保持 layered 整段一起重建语义
    compute: (i) => i.language === 'zh' ? '开始工作。' : 'Start working.',
    injectInPromptStyle: LAYERED_ONLY,
    enabledWhen: notExternalBase,
  });

  // ==========================================================================
  // 8. Profile append instructions — stable (profile 内置, 切 profile 才变)
  // ==========================================================================

  registerSection({
    name: 'profile-append',
    layer: 'stable',
    compute: (i) => i.profileAppendInstructions?.trim() || null,
    cacheKeyFields: ['profileId', 'promptStyle'],
    /* 注: enabledWhen 同时要求 (1) appendInstructions 非空 (2) 不是 external base 模式
     * — fullInstructions 已经自带 base, 由 systemPrompt.ts 外层手动拼 base+append, 这里 skip 防重复 */
    enabledWhen: (i) => !!i.profileAppendInstructions?.trim() && !i.hasExternalBase,
    /* layered 模式: profile.appendInstructions 在 base 之后注入 (现有行为)
     * codex_official / kimi: 本 section 不注入, 它们的 base 构造时已经把 appendInstructions
     * 自己合进去 (见 systemPrompt.ts 改造后的 codex/kimi 分支) */
    injectInPromptStyle: LAYERED_ONLY,
  });

  // ==========================================================================
  // 9. Edit tool override — stable (完全静态)
  // ==========================================================================
  /* 历史幂等 marker: 'File tool conventions in this runtime:' / 'Tool naming override for this
   * runtime:'. 新文本是 'File tools:'. 改造期间用户的 profile.appendInstructions / project
   * instructions 可能预先包含这段 → 重复注入. 留 enabledWhen 探测一下. */

  registerSection({
    name: 'edit-tool-override',
    layer: 'stable',
    compute: () => EDIT_TOOL_OVERRIDE,
    /* Legacy marker 兼容: 老 profile.appendInstructions / project instructions 可能预先包含
     * 这段 (老措辞 'File tool conventions in this runtime:' 或 'Tool naming override for this
     * runtime:', 新措辞 'File tools:'). systemPrompt 调 buildPrompt 前会把
     * profile-append + project-instructions 组合给 precedingTextForLegacyCheck.
     * 这里检测三个 marker, 任一命中就 skip. */
    enabledWhen: (i) => {
      const ext = i.precedingTextForLegacyCheck ?? '';
      return !(
        ext.includes('File tool conventions in this runtime:') ||
        ext.includes('Tool naming override for this runtime:') ||
        ext.includes('File tools:\n- `edit`')
      );
    },
  });

  // ==========================================================================
  // 10. Browser surface guidance — stable, gui-only
  // ==========================================================================

  registerSection({
    name: 'browser-surface',
    layer: 'stable',
    compute: () => BROWSER_SURFACE_GUIDANCE,
    enabledWhen: (i) => i.hostCapabilities?.gui === true,
  });

  // ==========================================================================
  // 11. Project instructions (AGENTS.md / NEOX.md 等) — context
  // ==========================================================================

  registerSection({
    name: 'project-instructions',
    layer: 'context',
    compute: () => {
      const cached = getCachedInstructions();
      if (!cached?.content) return null;
      return formatInstructionsForPrompt(cached);
    },
    cacheKeyFields: ['projectInstructionsHash'],
  });

  // ==========================================================================
  // ==========================================================================

  registerSection({
    name: 'session-memory-context',
    layer: 'context',
    compute: (i) => {
      const raw = loadSessionMemoryMarkdown(i.workDir);
      const md = raw ? sessionMemoryForPrompt(raw) : '';
      if (!md) return null;
      const note = i.language === 'en'
        ? `Background only: a summary of an EARLIER, already-finished session in this workspace. This session's task is whatever the user says in the conversation — do it. Don't report on or continue the earlier session unless the user brings it up.`
        : `仅作背景: 本 workspace 之前一个已经结束的会话的摘要。本会话要做什么以对话里用户的消息为准, 直接去做; 用户没提起就别主动汇报或接着做上次的事。`;
      return `<previous_session>\n${note}\n\n${md}\n</previous_session>`;
    },
    cacheKeyFields: ['workDir'],
  });

  // ==========================================================================
  // 11.6 Knowledge base index (L0) — context
  // ==========================================================================
  /* 知识卡 L0 索引 — 每卡一行 title+description+路径, agent 永远知道"有什么知识",
   *   细节按需 readfile / knowledge_search (设计 内部设计文档 §2.1).
   *   knowledgeRegistry 由 runtime boot 时初始化 (skills 同一生命周期), 未初始化/空库返回 null. */

  registerSection({
    name: 'knowledge-index',
    layer: 'context',
    compute: (i) => {
      const index = knowledgeRegistry.getIndexForPrompt(i.language);
      return index || null;
    },
    cacheKeyFields: ['knowledgeIndexHash', 'language'],
  });

  // ==========================================================================
  // ==========================================================================
  /* 引导页建档勾选落 ~/.neox/user_profile_<mode>.md, 这里注入让模型"认识"用户。
   *   volatile: 文件 <1KB, 每次 build 直读, 建档更新后新 session 即生效 (frozen prompt
   *   cache 内的会话到下一个 cache key 变更才刷新)。code 模式不注入 (enabledWhen), 因此
   *   code 输出 byte-for-byte 不变。 */
  registerSection({
    name: 'user-mode-profile',
    layer: 'volatile',
    compute: (i) => {
      const mode = i.agentMode;
      if (mode !== 'work') return null;
      try {
        const txt = readFileSync(join(homedir(), NEOX_HOME_DIRNAME, `user_profile_${mode}.md`), 'utf8').trim();
        if (!txt) return null;
        const header = i.language === 'zh'
          ? '## 用户画像\n以下是用户建档时提供的长期背景 (常用场景/偏好), 作为理解需求的参考, 不是本次任务指令。'
          : '## User profile\nLong-term background the user provided during onboarding (common scenarios/preferences). Use as context for understanding needs — not instructions for this task.';
        return `${header}\n\n${txt}`;
      } catch { return null; /* 未建档 = 正常 */ }
    },
    enabledWhen: (i) => i.agentMode === 'work',
  });

  // ==========================================================================
  // 12. Provider supplement — stable (model family 匹配)
  // ==========================================================================

  registerSection({
    name: 'provider-supplement',
    layer: 'stable',
    compute: (i) => {
      const supp = getProviderSupplement({
        provider: i.protocol,
        protocol: i.protocol,
        model: i.model,
        language: i.language,
      });
      return supp?.content ?? null;
    },
    cacheKeyFields: ['protocol', 'model', 'baseUrl'],
    /* codex_official 有完整官方 prompt, 不叠加 supplement (legacy 行为) */
    injectInPromptStyle: ['layered', 'kimi'],
  });

  // ==========================================================================
  // 13. CLI no-gui correction — volatile, !gui only
  // ==========================================================================

  registerSection({
    name: 'cli-no-gui-correction',
    layer: 'volatile',  // 本身静态, 但跟 gui 状态强相关; gui 变就要 flip → 走 volatile 简单
    compute: (i) => i.language === 'en' ? CLI_NO_GUI_COVERRECTION.en : CLI_NO_GUI_COVERRECTION.zh,
    enabledWhen: (i) => i.hostCapabilities?.gui !== true,
  });

  // ==========================================================================
  // 14. Markdown format constraint — volatile, 末尾高 recency
  // ==========================================================================

  registerSection({
    name: 'markdown-format',
    layer: 'volatile',
    compute: (i) => {
      if (process.env.NEOX_DISABLE_MD_CONSTRAINT) return null;
      return getMarkdownFormatConstraint({
        provider: i.protocol,
        protocol: i.protocol,
        model: i.model,
        /* gui 决定给不给 neox-card 富卡片清单 — CLI 的 Ink renderer 不认那套围栏,
         * 给了就是往终端吐生 JSON。 */
        gui: i.hostCapabilities?.gui === true,
      });
    },
    enabledWhen: (i) => !(i.precedingTextForLegacyCheck?.includes('### Markdown 格式')),
    /* codex_official 不注入 (legacy: `style !== 'codex_official'`) */
    injectInPromptStyle: ['layered', 'kimi'],
  });

  // ==========================================================================
  // 15. Model identity note — volatile (运行时 model 决定)
  // ==========================================================================

  registerSection({
    name: 'model-identity',
    layer: 'volatile',
    compute: (i) => getModelIdentityNote(i.model, i.language),
    /* Legacy marker: '你的底层模型是' (zh) / 'Your underlying model is' (en) 是 identity note 开头.
     * 如果外部已经包含, 跳过避免重复. */
    enabledWhen: (i) => {
      const ext = i.precedingTextForLegacyCheck ?? '';
      return !(ext.includes('你的底层模型是') || ext.includes('Your underlying model is'));
    },
    /* codex_official 不注入 (legacy: `style !== 'codex_official'`) */
    injectInPromptStyle: ['layered', 'kimi'],
  });

  // ==========================================================================
  // 16. NEOX_APPEND_SYSTEM — volatile (A/B 测试 hook, 最末尾 recency 最强)
  // ==========================================================================

  registerSection({
    name: 'neox-append-system',
    layer: 'volatile',
    compute: () => process.env.NEOX_APPEND_SYSTEM?.trim() || null,
  });

  // ==========================================================================
  // 17. Sandbox mode info — volatile (mode 切换会变, 让 agent 自知当前权限范围)
  // ==========================================================================
  /* 注: 默认 WORKSPACE_WRITE 时不注入 (避免污染 prompt). 只在 READ_ONLY / DANGER_FULL_ACCESS
   *   时显式提示 — 因为这两档是 mode 切换的结果, agent 需要知道. */

  registerSection({
    name: 'sandbox-mode-info',
    layer: 'volatile',
    compute: (i) => {
      const mode = getCurrentSandboxMode();
      if (mode === SandboxMode.WORKSPACE_WRITE) return null;
      if (mode === SandboxMode.READ_ONLY) {
        return i.language === 'en'
          ? `### Sandbox: read-only\nThis session is in **read-only** sandbox mode. Any write / shell / git mutation tool will be **hard blocked** at the guardrail layer (not just asking for approval). You may use: readfile / grep / search / glob / show_tree / web_fetch / git status. Plan accordingly — don't propose edits, just analyze and report.`
          : `### Sandbox: read-only\n本会话处于 **read-only** 沙箱模式. 任何 write / shell / git mutation 工具会被 guardrail 层**硬拒** (不是询问审批). 可用: readfile / grep / search / glob / show_tree / web_fetch / git status. 调整计划 — 不要提出修改, 只做分析和报告.`;
      }
      if (mode === SandboxMode.DANGER_FULL_ACCESS) {
        return i.language === 'en'
          ? `### Sandbox: danger-full-access\nThis session is in **danger-full-access** sandbox mode. No approval is required for any tool call (only critical commands like rm -rf / / fork bombs are still blocked). The user is explicit about this — proceed efficiently, no extra confirmations.`
          : `### Sandbox: danger-full-access\n本会话处于 **danger-full-access** 沙箱模式. 所有工具调用**不审批** (只有 critical 命令如 rm -rf / / fork bomb 仍会拦). 用户明确选了此模式 — 高效推进, 不要额外确认.`;
      }
      return null;
    },
  });
}

// ============================================================================
// Helpers (供 systemPrompt.ts 在 build 前预先填好派生字段)
// ============================================================================

/** 返回 host 是否有 GUI 能力. 拿不到时 (boot 早期) 当 CLI / no-gui 兜底. */
export function hostHasGuiCapability(): boolean {
  try {
    return getToolServices()?.capabilities?.gui === true;
  } catch {
    return false;
  }
}

/**
 * 简单 djb2 hash, 用于 skills / 其他大字符串做 cache key 短摘要.
 * 不需要密码学强度 — 只要稳定 + 碰撞极少 + 快.
 */
export function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h | 0;  /* force int32 */
  }
  return (h >>> 0).toString(36);
}
