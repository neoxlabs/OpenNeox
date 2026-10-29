/**
 * Runner Output Self-Heal — LLM 流式输出的常见破损自修复
 *
 *  C2 创建. 采用 兼容格式 / 兼容格式 内部的自愈逻辑:
 *   - LLM 输出被 max_output_tokens 截断 → 工具调用 JSON 半截
 *   - LLM 输出代码块 ``` 没闭合 → markdown 渲染崩溃
 *   - LLM 输出 stream 中断 → arguments 部分缺尾
 *
 * 设计原则:
 *   1. 只做"明确安全"的修复 — 不猜测语义, 只补结构
 *   2. 修复失败时返回 null 让 caller fallback 到原值
 *   3. 永远不 throw — 即便 input 是 garbage
 */

/**
 * 尝试把不合法 JSON 修成合法 JSON. 仅处理常见截断:
 *   · 末尾多余的 `,` → 删
 *   · 不平衡的 `{` / `[` → 补 `}` / `]`
 *   · 奇数个 `"` (字符串没闭合) → 补 `"`
 *
 * 例:
 *   tryFixToolArgsJson('{"a":1,')         → '{"a":1}'
 *   tryFixToolArgsJson('{"a":1,"b":')     → null  (值缺失, 不猜)
 *   tryFixToolArgsJson('{"path":"/a.ts')  → '{"path":"/a.ts"}'
 *   tryFixToolArgsJson('{"a":[1,2')       → '{"a":[1,2]}'
 *
 * 调用方应先 JSON.parse 原值; 失败再调本函数, 验证修复结果再次 JSON.parse 是否通过。
 */
export function tryFixToolArgsJson(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  /* 末尾 trailing comma 清理 (在 } 或 ] 之前) */
  s = s.replace(/,\s*$/, '');

  /* 检测 "(双引号) 是否为偶数. 跳过转义 \" */
  let unescaped = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      unescaped += s.slice(i, i + 2);
      i++;
      continue;
    }
    unescaped += s[i];
  }
  const quoteCount = (unescaped.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    s += '"';
  }

  /* 平衡 { } 和 [ ] — 字符串内的括号不计 */
  let openCurly = 0, openSquare = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i++; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') openCurly++;
    else if (c === '}') openCurly--;
    else if (c === '[') openSquare++;
    else if (c === ']') openSquare--;
  }
  while (openSquare > 0) { s += ']'; openSquare--; }
  while (openCurly > 0) { s += '}'; openCurly--; }

  /* 修完试 parse, 失败 → 再试清 }/] 前的 trailing comma (注释一直这么声称, 实现此前只清了
   * 字符串末尾的裸逗号)。此替换不区分字符串内外, 但只在原始 parse 已失败的前提下作为
   * 最后一搏, 修出的结果仍要过 JSON.parse 才会被采纳。 */
  try {
    JSON.parse(s);
    return s;
  } catch {
    const decommaed = s.replace(/,\s*([}\]])/g, '$1');
    if (decommaed !== s) {
      try {
        JSON.parse(decommaed);
        return decommaed;
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
}

/**
 * 给 LLM assistant text 的 markdown 围栏自动闭合.
 *
 * 检测 ``` 出现次数, 若奇数 → 末尾追加 ``` 关闭。
 * 不动语义只补结构。空 input → 原样返。
 *
 * 例:
 *   closeFencedBlocks('hi\n```ts\nfoo()')      → 'hi\n```ts\nfoo()\n```'
 *   closeFencedBlocks('```ts\nfoo()\n```')     → 不动 (已闭合)
 *   closeFencedBlocks('text only')             → 'text only'
 *   closeFencedBlocks('```\nincomplete')       → '```\nincomplete\n```'
 */
export function closeFencedBlocks(text: string): string {
  if (!text) return text;
  const matches = text.match(/```/g);
  if (!matches || matches.length % 2 === 0) return text;
  /* 奇数个 ``` → 需要补一个闭合. 末尾若已是换行, 不再加换行 */
  return text.endsWith('\n') ? `${text}\`\`\`` : `${text}\n\`\`\``;
}
