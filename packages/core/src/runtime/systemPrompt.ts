
import type { PromptStyle, ResolvedModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { resolveBuiltinModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { kimiPromptBuilder } from '../models/prompts/kimi.js';
import { getCachedInstructions } from '@neoxlabs/kernel/core/projectInstructions.js';
import { setInstructionsBuilder } from '@neoxlabs/kernel/core/instructionsBridge.js';
import { skillRegistry } from '../skills/registry.js';
import { knowledgeRegistry } from '../knowledge/registry.js';

import { buildPrompt, type SectionInput } from './prompts/sectionRegistry.js';
import { initSectionsOnce, hostHasGuiCapability, djb2Hash } from './prompts/sections.js';
import { normalizeAgentMode, type AgentMode } from '@neoxlabs/platform/runtime/agentMode.js';

// ============================================================================
// ============================================================================

const CODEX_OFFICIAL_INSTRUCTIONS = "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.\n    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n    * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed.\n- **NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Codex CLI harness, sandboxing, and approvals\n\nThe Codex CLI harness supports several different configurations for sandboxing and escalation approvals that the user can choose from.\n\nFilesystem sandboxing defines which files can be read or written. The options for `sandbox_mode` are:\n- **read-only**: The sandbox only permits reading files.\n- **workspace-write**: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval.\n- **danger-full-access**: No filesystem sandboxing - all commands are permitted.\n\nNetwork sandboxing defines whether network can be accessed without approval. Options for `network_access` are:\n- **restricted**: Requires approval\n- **enabled**: No approval needed\n\nApprovals are your mechanism to get user consent to run shell commands without the sandbox. Possible configuration options for `approval_policy` are\n- **untrusted**: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n- **on-failure**: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n- **on-request**: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the `shell` command description.)\n- **never**: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is paired with `danger-full-access`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.\n\nWhen you are running with `approval_policy == on-request`, and sandboxing enabled, here are scenarios where you'll need to request approval:\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval. ALWAYS proceed to use the `sandbox_permissions` and `justification` parameters - do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for\n- (for all of these, you should weigh alternative paths that do not require approval)\n\nWhen `sandbox_mode` is set to read-only, you'll need to request approval for any command that isn't a read.\n\nYou will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing enabled, and approval on-failure.\n\nAlthough they introduce friction to the user because your work is paused until the user responds, you should leverage them when necessary to accomplish important work. If the completing the task requires escalated permissions, Do not let these settings or the sandbox deter you from attempting to accomplish the user's task unless it is set to \"never\", in which case never ask for approvals.\n\nWhen requesting approval to execute a command that will require escalated privileges:\n  - Provide the `sandbox_permissions` parameter with the value `\"require_escalated\"`\n  - Include a short, 1 sentence explanation for why you need escalated permissions in the justification parameter\n\n## Special user requests\n\n- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after enumerating the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Frontend tasks\nWhen doing frontend design tasks, avoid collapsing into \"AI slop\" or safe, average-looking layouts.\nAim for interfaces that feel intentional, bold, and a bit surprising.\n- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).\n- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.\n- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.\n- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.\n- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.\n- Ensure the page loads properly on both desktop and mobile\n\nException: If working within an existing website or design system, preserve the established patterns, structure, and visual language.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final‑answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n  * Lead with a quick explanation of the change, and then give more details on the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n- The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **…**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4–6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general → specific → supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self‑contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short—wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations → precise, structured with code refs; simple tasks → lead with outcome; big changes → logical walkthrough + rationale + next actions; casual one-offs → plain sentences, no headers/bullets.\n- File References: When referencing files in your response follow the below rules:\n  * Use inline code to make file paths clickable.\n  * Each reference should have a stand alone path. Even if it's the same file.\n  * Accepted: absolute, workspace‑relative, a/ or b/ diff prefixes, or bare filename/suffix.\n  * Optionally include line/column (1‑based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n  * Do not use URIs like file://, vscode://, or https://.\n  * Do not provide range of lines\n  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5"

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Instructions 构建选项
 * 注意：这是 Responses API 的 instructions 字段，不是 system message
 */
export interface InstructionsOptions {
  workDir: string;
  language?: 'zh' | 'en';
  useCodexStyle?: boolean;
  protocol?: string;
  model?: string;
  baseUrl?: string;
  profileId?: string;
  modelProfile?: ResolvedModelProfile;
  promptStyle?: PromptStyle;
  /** 用途模式 (assistant/work/code), 决定 general-assistant 差分段与 verification 门控. 缺省 code. */
  agentMode?: AgentMode;
  /** 跳过环境信息（日期/git），由调用方单独注入为 contextInjection */
  skipEnvironment?: boolean;
  disableCodexPrompt?: boolean;
}

// ============================================================================
// ============================================================================

function isOfficialCodexPath(options: InstructionsOptions): boolean {
  const proto = (options.protocol || '').toLowerCase();
  if (proto === 'openai-responses' || proto === 'codex' || proto === 'responses') return true;
  const base = (options.baseUrl || '').toLowerCase();
  if (!base) return proto.startsWith('openai'); /* 无 baseUrl + openai 协议 = 官方默认端点 */
  return /(^|\.|\/\/)(api\.openai\.com|chatgpt\.com)([/:]|$)/.test(base);
}

function resolvePromptStyle(options: InstructionsOptions): { style: PromptStyle; profile: ResolvedModelProfile } {
  const profile = options.modelProfile ?? resolveBuiltinModelProfile({
    protocol: options.protocol,
    model: options.model,
    baseUrl: options.baseUrl,
    explicitProfileId: options.profileId,
  });

  let style = options.promptStyle
    ?? (options.useCodexStyle ? 'codex_official' : undefined)
    ?? profile.prompt?.style
    ?? 'layered';

  /* profile 派生 (非调用方显式指定) 的 codex_official → 第三方 GPT 降级 layered。
   * 显式 promptStyle/useCodexStyle 仍尊重调用方 (测试/特殊接入自己负责)。 */
  if (
    style === 'codex_official'
    && !options.promptStyle
    && !options.useCodexStyle
    && (!isOfficialCodexPath(options) || options.disableCodexPrompt === true)
  ) {
    /* disableCodexPrompt: provider 设置里用户显式关闭 (第三方 responses 代理 400) */
    style = 'layered';
  }

  return { style, profile };
}

/**
 * 构建 Instructions
 *
 * 流程:
 *   1. 解析 profile + style (layered / codex_official / kimi)
 *   2. 决定 base segment:
 *      - profile.fullInstructions 存在 → 用之 (hasExternalBase=true)
 *      - codex_official → CODEX_OFFICIAL_INSTRUCTIONS (并跑 edit_file/apply_patch → edit alias 替换)
 *      - kimi → kimiPromptBuilder.buildSystemPrompt(...)
 *      - layered → base 留空, sectionRegistry 全包
 *   3. 准备 SectionInput, 调 buildPrompt() — sectionRegistry 按 injectInPromptStyle 自动 filter
 *   4. layered 模式: 直接返回 built.full
 *      其他模式: 拼 base + (appendInstructions?) + built.full
 *
 * 改造前后 byte-for-byte 等价 (除了 P0 改动的 universal-constraints / providerSupplements 内容
 * 本身已变).
 */
export function buildInstructions(options: InstructionsOptions): string {
  initSectionsOnce();

  const { workDir, language = 'zh' } = options;
  const { style, profile } = resolvePromptStyle(options);

  const fullInstructions = profile.prompt?.fullInstructions?.trim();
  const lang: 'zh' | 'en' = profile.prompt?.language ?? language;
  const appendInstructions = profile.prompt?.appendInstructions?.trim();

  /* ── 1. base segment ─────────────────────────────────────────────────── */
  let base: string;
  let hasExternalBase = false;

  if (fullInstructions) {
    base = fullInstructions;
    hasExternalBase = true;
  } else if (style === 'codex_official') {
    base = CODEX_OFFICIAL_INSTRUCTIONS;
    hasExternalBase = true;
  } else if (style === 'kimi') {
    base = kimiPromptBuilder.buildSystemPrompt({ workDir, language: lang, modelName: options.model });
    hasExternalBase = true;
  } else {
    /* layered: sectionRegistry 会注入完整 base (layer 1-4 + start-marker + profile-append) */
    base = '';
    hasExternalBase = false;
  }

  /* edit_file / apply_patch → edit alias 替换 — 仅 codex_official style. 跟 legacy 等价. */
  if (style === 'codex_official' && base) {
    base = base
      .replace(/\bedit_file\b/g, 'edit')
      .replace(/\bapply_patch\b/g, 'edit');
  }

  /* ── 2. SectionInput ─────────────────────────────────────────────────── */

  const projectInstr = getCachedInstructions();
  const skillsContent = skillRegistry.getSkillsForPrompt() || '';
  const knowledgeIndexContent = knowledgeRegistry.getIndexForPrompt(lang) || '';
  const hostCaps = { gui: hostHasGuiCapability() };

  /* Legacy marker preceding text: base + appendInstructions + projectInstructions content.
   * 三者中任一含 'File tools:' / '### Markdown 格式' / '你的底层模型是' 时, 相关 section
   * 的 enabledWhen 返 false 跳过, 避免重复 (legacy idempotent marker 检查的平移). */
  const precedingText = [
    base,
    appendInstructions,
    projectInstr?.content,
  ].filter((x): x is string => !!x).join('\n\n');

  const sectionInput: SectionInput = {
    workDir,
    language: lang,
    protocol: options.protocol,
    model: options.model,
    baseUrl: options.baseUrl,
    profileId: options.profileId,
    promptStyle: style,
    agentMode: normalizeAgentMode(options.agentMode),
    hostCapabilities: hostCaps,
    skipEnvironment: options.skipEnvironment,
    projectInstructionsHash: projectInstr?.contentHash,
    skillsHash: djb2Hash(skillsContent),
    knowledgeIndexHash: djb2Hash(knowledgeIndexContent),
    profileAppendInstructions: appendInstructions,
    precedingTextForLegacyCheck: precedingText,
    hasExternalBase,
  };

  /* ── 3. buildPrompt — section registry 按 promptStyle 自动 filter ─────── */
  const built = buildPrompt(sectionInput);

  /* ── 4. 组装最终 result ──────────────────────────────────────────────── */

  if (style === 'layered' && !hasExternalBase) {
    /* layered 模式 (无 fullInstructions): buildPrompt 已含 base + post-processing,
     * 包括 profile-append section 在 base 之后, 直接返回. */
    return built.full;
  }

  /* codex_official / kimi / fullInstructions 模式:
   *   base + (appendInstructions?) + built.full (= 只含 post-processing section)
   * 注: layered + hasExternalBase 也走这条路径 (fullInstructions 在 layered profile 下) */
  const parts: string[] = [];
  if (base) parts.push(base);
  if (appendInstructions) parts.push(appendInstructions);
  if (built.full) parts.push(built.full);
  return parts.join('\n\n');
}

// ============================================================================
// ============================================================================

/**
 * 构建编辑失败提示（用于工具结果）
 */
export { buildEditFailureHint } from '@neoxlabs/kernel';

/**
 * 构建迭代警告提示（用于性能监控）
 */
export function buildIterationWarning(
  currentIteration: number,
  maxIterations: number,
  language: 'zh' | 'en' = 'zh'
): string {
  const remaining = maxIterations - currentIteration;

  if (language === 'zh') {
    return `⚠️ 迭代警告：已完成 ${currentIteration}/${maxIterations} 次迭代，剩余 ${remaining} 次

建议：
- 检查是否陷入循环（重复相同操作）
- 考虑简化方案或分步执行
- 如果接近上限，总结当前进度`;
  } else {
    return `⚠️ Iteration Warning: ${currentIteration}/${maxIterations} iterations completed, ${remaining} remaining

Suggestions:
- Check if stuck in a loop (repeating same operations)
- Consider simplifying approach or breaking into steps
- If near limit, summarize current progress`;
  }
}

/* kernel models 批次 — core 自注册: systemPrompt 加载即把 buildInstructions 挂进 kernel
 * provider 的 instructionsBridge。整车行为不变; 纯 kernel 不含本模块 → provider 不自建 Neox 指令。 */
setInstructionsBuilder(buildInstructions);
