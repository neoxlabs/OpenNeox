/**
 * modelCapabilities — 模型能力判定 (vision 等), 全端共享单一来源.
 *
 *   vision (图片输入多模态):
 *     · 权威来源 = provider/model registry 的 model.vision 字段.
 *     · 拿不到权威值 → modelVisionHeuristic 按模型名兜底.
 *
 *   用处:
 *     · OpenAIProvider fail-fast: 纯文本模型 + 图片 → 不发网关 (用 heuristic, provider 层没 membership).
 *     · CLI / 桌面端模型选择器: 显示视觉徽标 (优先 registry.vision, 兜底 heuristic).
 */

/** 已知纯文本 (无视觉) 模型 family 关键词. */
const TEXT_ONLY_PATTERN = /deepseek|glm|kimi|moonshot|doubao|qwen|ernie|hunyuan|baichuan|minimax/i;
/** 已知支持视觉的 family. */
const VISION_FAMILY_PATTERN = /gpt|claude|gemini|qwen-vl|llava|pixtral/i;

/**
 * 可注入的 vision 权威判定 — schema registry (schemas/models + schemas/families yaml) 在
 * node 侧加载完成后通过 setModelVisionAuthority 注入; renderer / schemas 不可用时保持 null,
 * 一切回落名字启发式。返回 null = 该模型 schema 不认识, 交给下一级。
 *
 * 本模块被 Electron renderer 直接 import, 严禁在这里静态引 fs / js-yaml / loader。
 */
type VisionAuthority = (model: string) => boolean | null;
let visionAuthority: VisionAuthority | null = null;

export function setModelVisionAuthority(fn: VisionAuthority | null): void {
  visionAuthority = fn;
}

function visionByAuthority(model: string): boolean | null {
  if (!visionAuthority) return null;
  try {
    return visionAuthority(model);
  } catch {
    return null;
  }
}

/**
 * 启发式判 vision (按模型名) — 只认"已知纯文本"为 false, 其余 (gpt/claude/gemini/未知) 一律 true.
 * 设计: 宁可放行未知模型 (让网关判), 不误伤新模型; 只拦确定打不了图的。
 * schema 权威值优先 (修 glm-5.2/doubao-pro/qwen-3-max 等新视觉模型被 TEXT_ONLY 正则误杀)。
 */
export function modelVisionHeuristic(model: string): boolean {
  const authoritative = visionByAuthority(model);
  if (authoritative !== null) return authoritative;
  return !TEXT_ONLY_PATTERN.test((model || '').toLowerCase());
}

/** 按 family 判 vision. 命中 vision family → true; 命中纯文本 → false; 未知 → null. */
export function familyVision(family?: string | null): boolean | null {
  const f = (family || '').toLowerCase();
  if (!f) return null;
  if (VISION_FAMILY_PATTERN.test(f)) return true;
  if (TEXT_ONLY_PATTERN.test(f)) return false;
  return null;
}

/**
 * 解析 vision 能力 — 优先级: server 权威 flag > schema 权威 (yaml, node 侧注入) > family 派生 > 模型名 heuristic.
 * @param model        模型 id/name
 * @param explicitVision provider registry model.vision (undefined = 没给)
 * @param family       provider registry model.family, 用来派生
 */
export function resolveModelVision(model: string, explicitVision?: boolean | null, family?: string | null): boolean {
  if (typeof explicitVision === 'boolean') return explicitVision;
  const authoritative = visionByAuthority(model);
  if (authoritative !== null) return authoritative;
  const byFamily = familyVision(family);
  if (byFamily !== null) return byFamily;
  // 走到这里 = authority 未注入或不认识该模型, modelVisionHeuristic 内部的 authority 查询也必然 null
  return modelVisionHeuristic(model);
}
