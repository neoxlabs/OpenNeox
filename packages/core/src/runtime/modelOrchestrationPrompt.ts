
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { getModelOrchestrationMode } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';

/** 跟 targetModeTools.getPromptLanguage 同款判断: config.language, 读不出当 zh。 */
function getPromptLanguage(): 'zh' | 'en' {
  try {
    return (loadConfig() as { language?: string }).language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

const SECTION_ZH = [
  '<model_orchestration>',
  '智能模型编排已开启: 用户配置了多模型池, 你可以按任务特征主动选用池内更合适的模型。',
  '· 查池: 用 tool_search select:neox_config 拿到 schema 后, 经 call_tool 调 neox_config —',
  '  get models = 池内模型清单 + 能力分数(coding/reasoning/speed/cost) + 各 provider 可用性;',
  '  get routing = 编排开关状态 + 用户的模型偏好提示。',
  '· 选型: 用 agent 工具派子任务时通过 model 参数指定池内模型 (explore 的模型由侧路策略自动选, 无需指定):',
  '  - 检索/摸排/机械类任务 → speed 分高的轻快模型;',
  '  - 审查/验证类任务 → 尽量选与实现者**不同 provider** 且 reasoning 分高的模型 (同源自审有盲区);',
  '  - 长上下文/大规模阅读 → 上下文窗口更大的模型。',
  '· 可解释: 每次主动选型, 在派发说明或产出里带一句理由 (如 "审查换 GPT 交叉把关")。',
  '· 尊重偏好: 用户表达过的模型偏好 (routing 域可查) 优先于以上启发式; 拿不准或池内没有合适模型时,',
  '  不传 model 继承主模型 — 这永远是安全的默认, 不要为了换而换。',
  '</model_orchestration>',
].join('\n');

const SECTION_EN = [
  '<model_orchestration>',
  'Smart model orchestration is ON: the user configured a multi-model pool; pick fitter pool models per task.',
  '· Inspect the pool: unlock via tool_search select:neox_config, then invoke neox_config through call_tool —',
  '  get models = pool models + capability scores (coding/reasoning/speed/cost) + per-provider availability;',
  '  get routing = orchestration switch state + the user\'s model preference hints.',
  '· Selection: when dispatching sub-tasks with the agent tool, set its model parameter (explore picks its own side-route model — do not specify):',
  '  - retrieval / recon / mechanical tasks → a light model with a high speed score;',
  '  - review / verification tasks → prefer a **different provider** from the implementer with high reasoning (same-source self-review has blind spots);',
  '  - long-context / bulk reading → a model with a larger context window.',
  '· Explainable: every deliberate pick carries a one-line reason in the dispatch note or output (e.g. "cross-check review on GPT").',
  '· Respect preferences: user-stated model preferences (query the routing domain) override these heuristics; when unsure',
  '  or no pool model fits, omit model to inherit the main model — always the safe default; never switch for its own sake.',
  '</model_orchestration>',
].join('\n');

/**
 * 编排知识段 — 开关 on 时返回知识文本, off 时返回 '' (调用方过滤)。
 * 每轮被 dynamicSystemPromptProvider 调用, 开关热切换下一轮生效
 * (设置页写 config 后 refreshAgentRuntimeConfig 已热刷缓存)。
 */
export function getModelOrchestrationPromptSection(): string {
  if (getModelOrchestrationMode() !== 'on') return '';
  return getPromptLanguage() === 'en' ? SECTION_EN : SECTION_ZH;
}
