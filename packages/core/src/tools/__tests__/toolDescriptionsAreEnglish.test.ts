import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 常驻工具的 description 必须是英文。
 *
 * 工具定义随每次请求发送，且 description 没有独立的语言版本；常驻工具因此使用英文描述，
 * 控制提示词体积并保持跨语言请求的一致性。测试只检查 payload 中的 description 字面量。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = path.resolve(HERE, '..');
const RUNTIME_AGENT = path.resolve(HERE, '../../runtime/agent');

const CJK = /[一-鿿]/;
/* 代码注释里的示例 (如 `// 旧格式: [{label:"选项A", description:"说明"}]`) 不进 payload,
 * 扫之前先剥掉, 否则门禁会拦一条根本不影响成本的注释。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/* description: '...' | "..." | `...` —— 取字面量内容 */
const DESC = /description:\s*(['"`])([\s\S]*?)\1/g;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(__tests__|node_modules|dist)$/.test(e.name)) walk(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('工具 description 必须是英文', () => {
  const files = [...walk(TOOLS_ROOT), ...walk(RUNTIME_AGENT)];

  it('扫到了文件 (防止 glob 写错导致空跑通过)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  /* The check is ratio-based: Chinese examples demonstrate accepted input,
   * while predominantly Chinese descriptions fail the guard. */
  const cjkRatio = (s: string): number => ((s.match(/[一-鿿]/g) ?? []).length / Math.max(1, s.length));
  const MAX_CJK_RATIO = 0.25;

  it('没有整段中文的 description', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(DESC)) {
        if (cjkRatio(m[2]) > MAX_CJK_RATIO) {
          const line = src.slice(0, m.index ?? 0).split('\n').length;
          offenders.push(`${path.relative(TOOLS_ROOT, f)}:${line} (${(cjkRatio(m[2]) * 100).toFixed(0)}% 中文) → ${m[2].slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('判据确实会咬 (变异验证: 整段中文必须被拦, 带示例的英文必须放行)', () => {
    const allZh = `description: '向用户提问并等待回答, 用于需要确认时'`;
    const enWithZhExample = `description: 'City name, Chinese or English. e.g. "上海" / "Tokyo". Use the most specific place.'`;
    expect([...allZh.matchAll(DESC)].filter((m) => cjkRatio(m[2]) > MAX_CJK_RATIO)).toHaveLength(1);
    expect([...enWithZhExample.matchAll(DESC)].filter((m) => cjkRatio(m[2]) > MAX_CJK_RATIO)).toHaveLength(0);
  });
});
