/**
 * behavior-suite/judge — LLM judge (report-quality 专用, deepseek-v4-flash 固定 prompt).
 *
 *   直连 DeepSeek API (不走 Neox gateway — judge 是评卷人, 不该跟被测链路共享基础设施).
 *   key 从 env 读: NEOX_JUDGE_KEY 或 DEEPSEEK_API_KEY. 没 key → 返回 null, 断言退化为
 *   纯程序化检查 (judge 分只记录, 不 block).
 */

const JUDGE_MODEL = 'deepseek-v4-flash';
const JUDGE_URL = 'https://api.deepseek.com/chat/completions';

/** 固定 judge prompt — 别改措辞, 改了分数不可比. */
const JUDGE_SYSTEM = [
  '你是一个严格的工程汇报评审。给你一段 agent 完成任务后的汇报文本, 按以下标准打 1-5 分:',
  '5 = 结论明确、数字/事实具体、简洁 (无废话、无过程流水账);',
  '4 = 结论明确但略有冗余;',
  '3 = 有结论但淹没在过程叙述里, 或者结构松散;',
  '2 = 结论含糊, 大量无关内容;',
  '1 = 没有结论, 或者答非所问。',
  '只输出一个 JSON: {"score": <1-5>, "reason": "<一句话>"}',
].join('\n');

export interface JudgeVerdict {
  score: number;
  reason: string;
}

export async function judgeReport(report: string): Promise<JudgeVerdict | null> {
  const key = process.env.NEOX_JUDGE_KEY || process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(JUDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: `汇报文本:\n"""\n${report.slice(0, 4000)}\n"""` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) return null;
    return { score, reason: String(parsed.reason ?? '') };
  } catch {
    return null;
  }
}
