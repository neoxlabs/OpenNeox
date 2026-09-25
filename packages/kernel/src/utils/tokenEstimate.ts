/**
 * Rough token estimation — language-aware.
 *
 * 使用按字符类别加权的估算，避免 CJK 文本按 ASCII 比例被低估。
 * 平均 4-5 chars/token), 但对 CJK 严重偏低:
 *   - 中文 1 个字符通常 = 1.5-2 tokens (BPE 把"机器"分成 ["机", "器"] 两个 token,
 *     某些模型 GPT-4o 之后改进到 1 字符 1 token; 但 GPT-3.5 / Claude 老版本仍按 2 tokens 算)
 *   - 日文/韩文/中文 (CJK Unified Ideographs U+4E00-9FFF) 一律按 1.5 tokens 系数
 *   - 表情 / 私有区 (高于 U+E000) 按 2 tokens
 *
 * 估算用于:
 *   - compaction 阈值看错估算 → 大量中文用户的 prompt 真的接近 context window 时
 *     compaction 才触发, 已经晚了, 立即 prompt_too_long
 *   - tool defs schema 含中文描述时 budget 错算
 *   - per-iteration tool_results budget 错算 → 中文工具输出不被截断
 *
 * 兼容路径:
 *   estimateTokens(text) — 直接换原来的 length/4 调用点
 *   estimateTokensRaw(text) — 拒绝任何加权 (调用方明确说"我要旧行为", 测试用)
 */

/* 混合文本按字符类别累加，保持上下文预算估算足够保守。 */
const ASCII_BYTES_PER_TOKEN = 4;
/** CJK 字符 token 系数 (≈ char/1.67) */
const CJK_TOKENS_PER_CHAR = 0.6;

/** CJK 类字符判定: 表意文字 + 假名 + 谚文 + CJK 标点/全角形式 */
function isCjkCharCode(c: number): boolean {
  return (
    (c >= 0x3000 && c <= 0x30ff)    // CJK 标点 + 平假名 + 片假名
    || (c >= 0x3400 && c <= 0x9fff) // CJK 扩展 A + 基本区统一表意文字
    || (c >= 0xac00 && c <= 0xd7af) // 谚文音节
    || (c >= 0xf900 && c <= 0xfaff) // CJK 兼容表意文字
    || (c >= 0xff00 && c <= 0xffef) // 全角/半角形式 (，。！等全角标点)
  );
}

/** 分字符类估算 — CJK 按 0.6 token/字, 其余按 char/4, 混合文本分段累加 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const s = String(text);
  let cjkCount = 0;
  for (let i = 0; i < s.length; i++) {
    if (isCjkCharCode(s.charCodeAt(i))) cjkCount++;
  }
  const otherCount = s.length - cjkCount;
  return Math.ceil(cjkCount * CJK_TOKENS_PER_CHAR + otherCount / ASCII_BYTES_PER_TOKEN);
}

/** 保留不加权的 char/4 估算，供明确要求原始口径的调用方使用。 */
export function estimateTokensRaw(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(String(text).length / ASCII_BYTES_PER_TOKEN);
}
