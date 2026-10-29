import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSectionsOnce } from '../prompts/sections.js';
import { buildPrompt } from '../prompts/sectionRegistry.js';

const TOLERANCE_CHARS = 200;

interface Combo {
  protocol: 'deepseek' | 'anthropic';
  model: string;
  mode: 'code' | 'work';
  gui: boolean;
}

const COMBOS: Combo[] = [];
for (const protocol of ['deepseek', 'anthropic'] as const) {
  const model = protocol === 'deepseek' ? 'deepseek-v4-pro' : 'claude-opus-4-8';
  for (const mode of ['code', 'work'] as const) {
    for (const gui of [true, false]) COMBOS.push({ protocol, model, mode, gui });
  }
}

const comboKey = (c: Combo): string => `${c.protocol}/${c.model}/${c.mode}/gui:${c.gui ? 1 : 0}`;

const BASELINE: Record<string, number> = {
  /* 10-28 review 后上调 (+326): 10-21 通用浏览器提示开头加了分流 (查自己做的网页用 check_page), 有意新增 */
  'deepseek/deepseek-v4-pro/code/gui:1': 17556,
  'deepseek/deepseek-v4-pro/code/gui:0': 12654,
  /* 10-28 review 后上调 (+655): 10-21 Work 提示词加了「名单 / Excel 开局放表格工具、禁止手拆 xlsx」和「做网页先加载技能」, 有意新增 */
  'deepseek/deepseek-v4-pro/work/gui:1': 16740,
  'deepseek/deepseek-v4-pro/work/gui:0': 12024, /* 同上 (+515) */
  'anthropic/claude-opus-4-8/code/gui:1': 16391, /* 同 deepseek code/gui:1 (+326) */
  'anthropic/claude-opus-4-8/code/gui:0': 12116,
  'anthropic/claude-opus-4-8/work/gui:1': 15575, /* 同 deepseek work (+655) */
  'anthropic/claude-opus-4-8/work/gui:0': 11486, /* 同 deepseek work (+515) */
};

/** 固定的临时工作区: 非 git 目录, 文件名单稳定 —— 只为了让环境段长度接近真实小项目。 */
function fixtureDir(): string {
  const dir = join(tmpdir(), 'neox-prompt-budget-fixture');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const answer = 42;\n');
  return dir;
}

function systemChars(workDir: string, c: Combo): number {
  return buildPrompt({
    workDir,
    language: 'zh',
    protocol: c.protocol,
    model: c.model,
    promptStyle: 'layered',
    agentMode: c.mode,
    hostCapabilities: { gui: c.gui },
    skipEnvironment: false,
    precedingTextForLegacyCheck: '',
  }).full.length;
}

describe('PROMPT-16 前缀预算快照', () => {
  it('system 前缀不超过登记基线 (超线即红)', () => {
    const workDir = fixtureDir();
    initSectionsOnce();

    const measured = COMBOS.map((c) => {
      const key = comboKey(c);
      const chars = systemChars(workDir, c);
      return { key, chars, baseline: BASELINE[key] ?? 0 };
    });

    /* 取值模式: 只打印, 不断言 (给人工写基线用) */
    if (process.env.PROMPT_BUDGET_WRITE === '1') {
      for (const row of measured) {
        // eslint-disable-next-line no-console
        console.log(`[prompt-budget] ${row.key} = ${row.chars}`);
      }
      return;
    }

    for (const row of measured) {
      expect(row.baseline, `基线缺 ${row.key}: 跑 PROMPT_BUDGET_WRITE=1 取数并登记`).toBeGreaterThan(0);
      expect(row.chars, `${row.key} 前缀变胖 (基线 ${row.baseline})`)
        .toBeLessThanOrEqual(row.baseline + TOLERANCE_CHARS);
    }
  });

  it('同一输入两次构建 byte-identical (前缀可缓存的前提)', () => {
    const workDir = fixtureDir();
    initSectionsOnce();
    for (const combo of COMBOS) {
      expect(systemChars(workDir, combo)).toBe(systemChars(workDir, combo));
    }
  });
});
