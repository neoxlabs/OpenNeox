
import { getSchemaRegistry, type FamilySchema } from '@neoxlabs/kernel/schemas/index.js';

// ==================== Provider Supplement ====================

export interface ProviderSupplement {
  /** Provider 标识 */
  provider: string;
  /** 补充内容（追加到 base prompt 之后） */
  content: string;
  /** 是否有 thinking/reasoning 能力 */
  supportsThinking: boolean;
  /** 是否有原生工具并行调用 */
  supportsParallelToolUse: boolean;
  /** 是否有 prompt cache */
  supportsPromptCache: boolean;
  /** 是否有结构化输出 */
  supportsStructuredOutput: boolean;
}

// ==================== 富输出能力 (per-model) ====================
//
//   代价是**连该用表格的场合也没了**: 任务总结永远只有"标题 + 一级 bullet", 信息不直观。
//
// 现在这一段的职责变成: 告诉模型 Neox 渲染端支持哪些富组件 (GFM 表格 / mermaid / KaTeX /
//   neox-card:* 富卡片), 鼓励按信息形态选组件。畸形输出交给渲染端兜底 (卡片走
//   NeoxCards.tryParseLenient 容错解析, 表格走 GFM 原样降级), 不再靠 prompt 压。
//
// 保留 per-family 分档的原因: 弱模型给它一句"随便用"会写出坏结构, 所以变体只加**卫生提示**
//   (一格一值 / 列数对齐), 不再加**禁令**。约束仍注入在 prompt 末尾 (高 recency)。


/** 纯文本渲染端 (CLI) 也有的能力 */
const RICH_BLOCKS_TEXT = `### 富输出能力
按信息形态挑组件, 别把什么都压成 bullet:
- **GFM 表格**: 多行同结构的对比 / 清单 (文件×改动、方案×取舍、参数×默认值)。
- **\`\`\`mermaid**: 流程、时序、状态机、依赖关系。
- 数学用 KaTeX (\`$...$\` / \`$$...$$\`)。

**不要手写 \`<svg>\` / HTML 去"画"图表, 也不要用 \`█ ▇\` / \`*\` 在代码块里堆条形图。**
前者这个渲染端当纯文本, 用户只看到一堆标签源码; 后者要用户自己换算"每个 █ 约等于几"。
要图形就用 \`\`\`mermaid; 要对比数字就用表格。

复杂改动收尾时先给结论和数字 (改了几个文件 / 多少行 / 验证跑没跑), 再写为什么和风险。
写报告文件时: 关键数字用表格, 调用链和流程用 mermaid —— 一份从头到尾只有文字和 bullet 的报告是不合格的。`;

/** 桌面端 — 额外有 neox-card 富卡片. 这是"你能画什么", 不是"你不许画什么"。 */
const RICH_BLOCKS_GUI = `### 富输出能力 (Neox 桌面端原生渲染)
按信息形态挑组件, 别把什么都压成 bullet:
- **GFM 表格**: 多行同结构的对比 / 清单 (文件×改动、方案×取舍、参数×默认值)。
- **\`\`\`mermaid**: 流程、时序、状态机、依赖关系。
- **\`\`\`neox-card:<kind>** + JSON body — 富卡片, 流式写一半也能正常渲染。
  **一共只有这四种**, 别发别的 kind:
  · \`chart\` 图表: \`{title, type:"bar|line|area|pie|donut|gauge|stacked|heatmap", series:[{label,value,tone?}], unit?}\`
    — gauge 另给 \`max\`; stacked 用 \`groups:[{label,parts:[{label,value}]}]\`; heatmap 用 \`columns:[]\` + \`rows:[{label,values:[]}]\`
  · \`diff\` 改动清单: \`{title?, files:[{path,add,del,note?}]}\` — \`add\`/\`del\` 必须是真行数; 全是 0 就不是 diff, 用正文写
  · \`report\` 报告入口: \`{title, path, summary, kind?:"audit|test|research|release|review", meta:[{label,value}], highlights:[], files:[{path,note?}]}\`
  · \`callout\` 提示框: \`{tone:"info|good|warn|bad", title?, text}\` — 只给**一句要紧的话**, 不是段落容器
  · \`summary\` 交付回执: \`{title, status:"done|partial|blocked", sections:[{title,items:[]}], files:[{path,add,del}]}\`
    —— **只在真改了文件时用**: 要么两个以上文件, 要么带真实增删行数。没有文件改动就直接写正文,
    渲染端会把这种卡整个丢掉 (它里面全是文字, 而那些字你正文里已经写过一遍了)。
- 数学用 KaTeX (\`$...$\` / \`$$...$$\`)。

**用户说"画一下/看看图/可视化", 或者你要展示一组数 → 出 \`neox-card:chart\`。** 照抄这个形状:
\`\`\`neox-card:chart
{"title":"测试数量","type":"bar","series":[{"label":"单元","value":128},{"label":"集成","value":34},{"label":"端到端","value":9}]}
\`\`\`

**不许用别的办法"画"图**: 手写 \`<svg>\`/\`<canvas>\`/HTML、用 \`█ ▇ ▆\` 或 \`*\` 在代码块里
堆条形、用空格对齐假装成图 —— 这三种都是**最差**的输出。它们尺寸配色字号全跟界面脱节,
暗色主题下经常看不见, 窄栏里溢出, 点不开选不中搜不到, 还要用户自己换算"每个 █ 约等于几"。
同一份数据交给 \`chart\` 卡, 渲染端按当前主题/栏宽/字号画好, 自带坐标轴、图例和数值。
(唯一例外: 用户要的就是一个 **SVG 文件**本身 —— 那是产物, 用工具写进文件, 不是贴进回复。)

**卡片的唯一存在理由: 文字表达不了。** 挑不出这样的理由就写正文 ——
  数量的**比较 / 构成 / 趋势** (要看出比例) → \`chart\`
  真实的**文件增删** (要看出改了多少)     → \`diff\`
  写出来的**报告文件** (要点得开)         → \`report\`
  **一句**要紧的话 (要跳出正文)           → \`callout\`
  真改了文件的**交付回执**                 → \`summary\`
  其它一切 —— 步骤、指标、时间线、对照表、网页、图片 —— **一律用正文 / 表格 / mermaid**。

**判据: 把卡里的内容原样写成一句话或一个列表, 信息有没有少?** 没少就说明它本来就是文字,
套卡只会多一枚图标、多一枚状态印记、多一个折叠器、多两层缩进和一圈留白, 信息量一点没涨,
而且正文里通常已经写过一遍了 —— 那是**同一段话说两次**。

反面例子 (都真出现过, 已被渲染端拦掉):
  ✗ 交付回执写成 \`{title:"当前工作区", files:[{path:"/Users/x/Neox"}]}\` —— files 那条是**目录**
    且零改动, 整张卡没有一样东西是文字表达不了的。
  ✗ 把三个探测点的返回值做成指标条: \`{label:"myip.ipip.net", value:"美国 新泽西锡考克斯"}\`
    —— value 是地名不是数, 这是键值列表, 该写成表格。
  ✗ 改动清单里所有文件 \`add:0, del:0\` 只带一段 note —— 那是文字说明, 不是改动清单。

**\`stats\` / \`metrics\` 里放的是数**(带单位), 不是文件名, 也不是 \`SYNTAX_OK\` 这种程序里的枚举名 ——
那一栏会被渲染成很大的粗体数字, 塞进去一个标识符就是把机器内部的字摆到用户脸上。
文件走 \`files\`, 结论走 \`sections\` 或 \`callout\`。

一轮里可以出多张卡 —— "跑了 12 个用例过 10 个" 是 \`chart\`, "接下来三步" 是 \`steps\`,
硬塞进一张 summary 的 sections 里就把两种形状压成了同一坨 bullet。
反过来: 只有一句话要说就用正文, 别为了"显得结构化"套一张卡。卡片里已经有的内容不要再用 bullet 复述一遍。

**写了报告文件就给一张 \`neox-card:report\`** (path 填报告的相对路径), 用户点卡片即在右栏打开 —— 不要只在正文里写一句"报告见 xxx.md"。
报告正文本身也要多模态: 关键数字用表格, 通过率/构成/分布用 \`\`\`neox-card:chart, 调用链和流程用 \`\`\`mermaid。一份从头到尾只有文字和 bullet 的报告是不合格的。`;

const richBlocks = (gui: boolean): string => (gui ? RICH_BLOCKS_GUI : RICH_BLOCKS_TEXT);

/** 卫生提示 — 结构容易写歪的模型加这一档 (只讲怎么写好, 不讲不许写) */
const mdHygiene = (gui: boolean): string => `

表格写法: 一格一个值 (别在格内堆逗号分句), 每行列数与表头一致, 分隔行用 \`|---|---|\`。内容长到一格塞不下就改用小标题 + 列表。`;

/** 规则型 — GLM 等「告诉即遵守」的模型 */
const mdRulesTerse = (gui: boolean): string => `${richBlocks(gui)}${mdHygiene(gui)}`;

/** 规则 + 正例 — DeepSeek/Kimi 等「需被示范」的模型 (光给抽象规则会反噬, 必须给样例) */
const mdRulesExample = (gui: boolean): string => `${mdRulesTerse(gui)}

示例 — **大部分回复一张卡都不该有**。下面每一张都是"不画出来就少了信息"才用的:
${gui
  ? `真改了文件的交付回执 → \`summary\` (注意: 增删是**真行数**, 没有文件改动就别用这张卡):
\`\`\`neox-card:summary
{"title":"违纪钉钉通知接入","status":"done",
 "sections":[{"title":"验证","items":["mvn compile 通过 (exit=0)","真实钉钉发送未跑 — 需真环境"]}],
 "files":[{"path":"backend/.../DingTalkRequirementNoticeService.java","add":93,"del":10}]}
\`\`\`

数字之间在比较 → 用 \`chart\`, 别写成三条 bullet:
\`\`\`neox-card:chart
{"title":"用例结果","type":"donut","series":[{"label":"通过","value":10,"tone":"good"},{"label":"失败","value":2,"tone":"bad"}]}
\`\`\`

只有一句要紧的话 → 用 \`callout\`:
\`\`\`neox-card:callout
{"tone":"warn","title":"需要真环境","text":"钉钉发送这条链路本机跑不通, 上线前必须在预发验一次。"}
\`\`\`

反例 — 下面这些**一律写正文**, 别套卡:
  "接下来三步" → 写成 bullet (曾经用 \`steps\`, 那是把文字塞进组件)
  "三个探测点的返回值" → 写成表格 (曾经用 \`metrics\`, 而 value 是地名不是数)
  "两版规则的差别" → 写成正文或表格 (曾经用 \`diff\`, 而 add/del 全是 0)`
  : `已完成。3 个文件 +134 −37, \`mvn compile\` 通过 (exit=0); 真实钉钉发送未跑 — 需真环境。

| 文件 | 改动 |
|---|---|
| \`DingTalkRequirementNoticeService.java\` | +93 −10 |`}`;

/** Kimi 专用 — 它结构最飘 */
const mdRulesKimi = (gui: boolean): string => `${mdRulesExample(gui)}
${gui
  ? '\n结构飘的时候优先选卡片而不是手画大表: 卡片是结构化 JSON, 渲染端会容错, 比 20 行手写表稳。'
  : '\n表格超过 8 行就拆成小标题 + 列表, 别硬撑成一张大表。'}`;

/** 轻量 — GPT/Claude/Gemini, 默认已规整, 只给能力清单 */
const mdRulesLight = (gui: boolean): string => richBlocks(gui);

/* model id → 人类可读展示名. deepseek-v4-pro → "DeepSeek V4 Pro" / mimo-v2.5-pro → "MiMo V2.5 Pro".
 * 覆盖国内主力家族; 拿不准的 token 首字母大写兜底。raw id 同时给出, 模型答错不了。 */
const MODEL_BRAND: Record<string, string> = {
  deepseek: 'DeepSeek', mimo: 'MiMo', glm: 'GLM', kimi: 'Kimi', moonshot: 'Kimi',
  claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', qwen: 'Qwen', doubao: 'Doubao',
  grok: 'Grok', llama: 'Llama', minimax: 'MiniMax', baichuan: 'Baichuan',
};
export function humanizeModelId(id: string): string {
  const s = (id || '').trim();
  if (!s) return '';
  return s.split(/[-_]/).map((p, i) => {
    if (i === 0 && MODEL_BRAND[p.toLowerCase()]) return MODEL_BRAND[p.toLowerCase()];
    if (/^v\d/i.test(p)) return p.toUpperCase();          // v4 → V4, v2.5 → V2.5
    if (/^k\d/i.test(p)) return p.toUpperCase();          // k2.6 → K2.6
    if (/^o\d/i.test(p)) return p.toLowerCase();          // o3 → o3
    if (/^\d/.test(p)) return p;                          // 4.7 / 5.5 原样
    return p.charAt(0).toUpperCase() + p.slice(1);        // pro → Pro, flash → Flash
  }).join(' ');
}

export function getModelIdentityNote(modelId: string | undefined, language: 'zh' | 'en' = 'zh'): string | null {
  const id = (modelId || '').trim();
  if (!id || id.toLowerCase() === 'auto') return null;
  const nice = humanizeModelId(id);
  if (language === 'en') {
    return `### Your model (runtime)
Your underlying model is **${nice}** (id: \`${id}\`), selected and routed by Neox. When the user asks which model powers you, answer truthfully: **${nice}**. Do NOT claim to be any other model or vendor, and do NOT say you're unsure — you ARE ${nice}. For *who you are* (your role), follow the identity section earlier in this prompt — do not restate a role here. Always keep clear that you operate within Neox.`;
  }
  return `### 你的模型（运行时）
你的底层模型是 **${nice}**（id: \`${id}\`），由 Neox 选定并路由。被问及"底层是什么模型"时如实回答 **${nice}**。**不要自称其它型号或厂商，也不要说"不确定"——你就是 ${nice}**。至于"你是谁"（你的角色），以本提示词前面的身份段为准，这里不再复述。同时始终让用户清楚你运行在 Neox 内。`;
}

/* family.markdown_constraint key → 对应 md rules builder.
   yaml 只存 key 字符串, 文本仍住在本文件 (改文本不算 schema 改动)。 */
const MD_RULES_BY_KEY: Record<string, (gui: boolean) => string> = {
  kimi: mdRulesKimi,
  deepseek_example: mdRulesExample,
  glm_terse: mdRulesTerse,
  light: mdRulesLight,
};

function detectFamilySafe(options: { provider?: string; protocol?: string; model?: string }): FamilySchema | null {
  return getSchemaRegistry().detectFamily(options);
}

export function getMarkdownFormatConstraint(options: {
  provider?: string;
  protocol?: string;
  model?: string;
  /** true = 桌面端 (能渲染 neox-card 富卡片); false/缺省 = CLI 等纯文本渲染端 */
  gui?: boolean;
}): string | null {
  const gui = options.gui === true;
  const fam = detectFamilySafe(options);
  const build = (fam && MD_RULES_BY_KEY[fam.markdown_constraint])
    /* 未识别 family — 给轻量清单兜底 (总比没有强), 跟旧实现行为一致 */
    ?? mdRulesLight;
  return build(gui);
}

// ==================== Anthropic (Claude) ====================

const ANTHROPIC_SUPPLEMENT = {
  zh: `## Provider 风格 (Anthropic Claude)

Claude 通常能很好遵守简洁的工程判断指令。不要用机械工具步骤淹没它；优先给高信号判断约束。

- 保持 senior collaborator 风格：先读相关代码，再形成工程判断。
- 支持 parallel tool use：互不依赖的读取/搜索/agent 可以同轮并行。
- 支持 extended thinking：thinking block 在前、工具调用在后；不要在用户可见回复里复述长思考。
- BYOK / Claude Code-compatible proxy 可能仍需要 Claude Code identity prefix 或 Anthropic cache/beta 兼容格式；不要在 prompt 中否定 runtime 的前缀策略。
- 完成前要验证，最终只汇报结论、改动、证据和风险。`,

  en: `## Provider Style (Anthropic Claude)

Claude usually follows concise engineering-judgment instructions well. Do not drown it in mechanical tool steps; prioritize high-signal judgment contracts.

- Keep the senior collaborator style: read relevant code first, then form an engineering judgment.
- Supports parallel tool use: independent reads/searches/agents can run in the same turn.
- Supports extended thinking: thinking comes before tool calls; do not repeat long reasoning in user-visible replies.
- BYOK / Claude Code-compatible proxies may still require a Claude Code identity prefix or Anthropic cache/beta-compatible format; do not contradict the runtime prefix strategy in prompt text.
- Verify before completion; final replies should report outcome, changes, evidence, and risk only.`,
};

// ==================== OpenAI (GPT) ====================

const OPENAI_SUPPLEMENT = {
  zh: `## Provider 风格 (OpenAI GPT / OpenAI-compatible Chat)

GPT / OpenAI-compatible 模型要特别防路径、API 和仓库结构幻觉。

- 不要编辑未确认存在的路径；不要凭常见项目结构猜文件名。
- edit 前必须 readfile；找不到文件/函数时先 search，不要换相似名字硬试。
- 操作 git 前确认当前目录确实在 git repo 内；遇到 “not a git repository” 先定位工作目录。
- 对代码修改必须有运行验证；read/search 只算探索。
- 如果当前 profile 是 Codex/Responses official style，优先遵守官方 Codex 指令；不要把 generic chat 行为覆盖 official 校验。`,

  en: `## Provider Style (OpenAI GPT / OpenAI-Compatible Chat)

GPT / OpenAI-compatible models need extra care around paths, APIs, and repository structure hallucinations.

- Never edit a path you have not confirmed exists; do not infer filenames from common project layouts.
- Before edit, readfile is mandatory; if a file/function is missing, search instead of trying similar names.
- Before git operations, confirm the current directory is a git repo; after “not a git repository”, locate the workspace root.
- Code changes require runtime verification; read/search count as exploration only.
- If the current profile is Codex/Responses official style, follow the official Codex instructions first; do not override official validation with generic chat behavior.`,
};

// ==================== 通用 (openai-function shape + 支持并行工具) ====================

const GENERIC_PARALLEL_SUPPLEMENT = {
  zh: `## Provider 风格 (通用 · 支持并行工具调用)

- **支持 parallel tool use**：同一轮里把互不依赖的读取/搜索一次全发出去（例如要看 5 个文件就同轮发 5 个 readfile），不要一轮一个挤牙膏。有依赖关系的步骤才串行。
- 优先用专用工具而不是 shell 拼凑：读文件用 \`readfile\` 不要 \`cat/head/tail\`，改文件用 \`edit\`/\`write_file\` 不要 \`sed\`/重定向，搜索用 \`search\` 不要 \`grep\`。专用工具带 diff 卡片、去重和右栏联动，shell 全都没有。
- \`execute_shell\` 留给真正只有命令行能做的事：构建、测试、安装、git、进程管理。
- 不要编辑未确认存在的路径；edit 前必须 readfile；找不到就 search，不要换个相似名字硬试。
- 代码改动必须有运行验证；read/search 只算探索。`,

  en: `## Provider Style (Generic · Parallel Tool Use Supported)

- **Parallel tool use is supported**: issue all independent reads/searches in the same turn (need 5 files? send 5 readfile calls at once). Only dependent steps must be sequential.
- Prefer dedicated tools over shell improvisation: \`readfile\` not \`cat/head/tail\`, \`edit\`/\`write_file\` not \`sed\`/redirection, \`search\` not \`grep\`. Dedicated tools carry diff cards, dedup, and right-pane wiring; shell carries none.
- Reserve \`execute_shell\` for what genuinely needs a shell: build, test, install, git, process management.
- Never edit a path you have not confirmed exists; readfile before edit; if something is missing, search instead of trying similar names.
- Code changes require runtime verification; read/search count as exploration only.`,
};

// ==================== Google Gemini ====================

const GEMINI_SUPPLEMENT = {
  zh: `## Provider 风格 (Google Gemini)

- 协议级差异：通常不可靠支持 parallel tool use；一次回复优先只调用一个工具，按搜索/读取 → 分析 → 修改 → 验证串行推进。
- 路径验证要严格：edit 前必须 readfile，git 命令前确认 repo。
- 回答保持短而具体，避免把长推理展开给用户。`,

  en: `## Provider Style (Google Gemini)

- Protocol difference: parallel tool use is usually unreliable; prefer one tool call per turn and proceed search/read → analyze → modify → verify sequentially.
- Be strict about path verification: readfile before edit, confirm repo before git commands.
- Keep replies short and specific; do not expand long reasoning to the user.`,
};

// ==================== DeepSeek ====================

const DEEPSEEK_SUPPLEMENT = {
  zh: `## Provider 风格 (DeepSeek)

DeepSeek 更适合显式步骤和具体执行协议。

- 对编码任务按顺序执行：识别相关文件和既有模式 → 判断根因或实现目标 → 做最小聚焦改动 → 运行具体验证 → 汇报精确结果。
- 思考内容用户不一定会看，**不能替代正文**：在思考里得出的判断（根因是什么、打算怎么改、为什么），调工具前用一两句正文告诉用户。不要连续十几次工具调用一句话都不说。
- 不要把长思考原样搬进正文；正文写结论和依据，思考里再比较多种可能。
- **并行工具调用**：互不依赖的读取 / 搜索 / edit 同一轮一次全发（要看 5 个文件就 \`readfile(paths=[...])\` 一次读完，要改 3 个文件就同轮发 3 个 edit），不要一轮一个；有依赖关系的步骤才串行。
- edit 的 old_string 必须逐字符照抄你**看到过**的原文：readfile 或 search 结果里出现过的行都算，没看过的文件不要猜它的内容——猜错一次就是两个来回。往某行旁边加东西用 insert_after / insert_before。
- edit 回执里已带改后原文，不必再 readfile 复核；只有要改别处时才读。`,

  en: `## Provider Style (DeepSeek)

DeepSeek benefits from explicit steps and concrete execution protocols.

- For coding tasks, execute in order: identify relevant files and existing patterns → determine root cause or implementation target → make the smallest focused change → run concrete verification → report exact results.
- The user may never open your reasoning — it **does not replace visible text**: when your reasoning reaches a judgment (the root cause, how you'll change it, why), tell the user in a sentence or two before the tool calls. Never run a dozen tool calls without a single sentence.
- Don't paste long reasoning into the reply; write the conclusion and its basis, and keep comparing alternatives inside reasoning.
- **Parallel tool calls**: issue all independent reads / searches / edits in the same turn (5 files to look at → one \`readfile(paths=[...])\`; 3 files to change → 3 edit calls at once). Only dependent steps run sequentially.
- edit's old_string must be copied verbatim from text you have actually seen — lines from readfile or search results both count; never guess the contents of a file you have not seen (one wrong guess costs two round trips). To add code next to a known line use insert_after / insert_before.
- The edit result already shows the region after the change; do not readfile to verify — only read again when editing elsewhere.`,
};

// ==================== GLM (智谱) ====================

const GLM_SUPPLEMENT = {
  zh: `## Provider 风格 (GLM 智谱)

- 单文件读取偏好精准定位：优先 \`readfile(path, symbol="xxx")\` / pattern，避免无意义全文件 dump。
- 任务执行保持显式：定位 → 修改 → 验证 → 汇报。`,

  en: `## Provider Style (GLM)

- Prefer precise single-file reads: use \`readfile(path, symbol="xxx")\` / pattern before dumping whole files.
- Keep execution explicit: locate → modify → verify → report.`,
};

// ==================== Kimi (月之暗面) ====================

const KIMI_SUPPLEMENT = {
  zh: `## Provider 风格 (Kimi 月之暗面)

- 协议级差异：k2 系列 parallel tool use 不可靠；一次回复优先只调用一个工具，按读取 → 分析 → 修改 → 验证串行推进。
- 内置 web_search：Moonshot 服务端代发，结果以 tool_result 形式回到对话时直接使用。
- 128K+ 长上下文：适合一次吸入大量代码/文档做全局分析；不要过度小块读取。
- 输出要克制：长上下文分析后仍只给关键结论和证据。`,

  en: `## Provider Style (Kimi)

- Protocol difference: parallel tool use is unreliable on the k2 series; prefer one tool call per turn and proceed read → analyze → modify → verify sequentially.
- Built-in web_search: Moonshot may run server-side search and return results as tool_result; use them directly.
- 128K+ long context: suitable for large code/doc analysis in fewer reads; do not over-fragment unnecessarily.
- Keep output controlled: after long-context analysis, report only key conclusions and evidence.`,
};

// ==================== 查找逻辑 ====================

/* family.supplement_key → localized supplement 文本 */
const SUPPLEMENT_BY_KEY: Record<string, { zh: string; en: string }> = {
  anthropic: ANTHROPIC_SUPPLEMENT,
  openai: OPENAI_SUPPLEMENT,
  gemini: GEMINI_SUPPLEMENT,
  deepseek: DEEPSEEK_SUPPLEMENT,
  glm: GLM_SUPPLEMENT,
  kimi: KIMI_SUPPLEMENT,
  generic_parallel: GENERIC_PARALLEL_SUPPLEMENT,
};

export function getProviderSupplement(options: {
  provider?: string;
  protocol?: string;
  model?: string;
  language?: 'zh' | 'en';
}): ProviderSupplement | null {
  const fam = detectFamilySafe(options);
  if (!fam) return null;
  const key = fam.supplement_key;
  if (!key) return null;
  const localized = SUPPLEMENT_BY_KEY[key];
  if (!localized) return null;
  const language = options.language ?? 'zh';
  return {
    provider: fam.id,
    content: localized[language].trim(),
    supportsThinking: !!fam.capabilities.thinking.native,
    supportsParallelToolUse: !!fam.capabilities.parallel_tool_use,
    supportsPromptCache: !!fam.capabilities.prompt_cache,
    supportsStructuredOutput: !!fam.capabilities.structured_output,
  };
}
