#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const MIN_ENTRIES = Number(process.argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 6);
const HAN = /[一-龥]/;
const FIELD = /\b(title|message|label|hint|placeholder|desc|description|actionLabel|summary|tooltip)\s*:\s*'([^']{2,})'/g;
const LANG = /isZh|zh\s*[:?]|[Ll]anguage|locale|useI18n|getLanguage|\bt\(/;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const files = globSync('packages/**/*.{ts,tsx}', { exclude: (p) =>
  p.includes('/dist/') || p.includes('/node_modules/') || p.includes('__tests__') || p.endsWith('.d.ts') });

const rows = [];
for (const f of files) {
  let src;
  try { src = stripComments(readFileSync(f, 'utf8')); } catch { continue; }
  const zh = [...src.matchAll(FIELD)].map((m) => m[2]).filter((v) => HAN.test(v));
  if (zh.length < MIN_ENTRIES) continue;
  if (LANG.test(src)) continue;
  rows.push({ file: f, count: zh.length, sample: zh[0].slice(0, 46) });
}
rows.sort((a, b) => b.count - a.count);

console.log(`[zh-only] 扫了 ${files.length} 个源文件`);
console.log(`[zh-only] 成规模的纯中文文案表 (≥${MIN_ENTRIES} 条且文件内零语言分支): ${rows.length} 个\n`);
for (const r of rows) console.log(`  ${String(r.count).padStart(3)} 条  ${r.file}\n           例: ${r.sample}`);
console.log(`\n⚠️ 命中不等于 bug —— 给模型看的工具描述 / prompt / 测试用例描述本来就不需要 i18n。`);
console.log(`   请逐个分诊: 这张表的字符串会不会出现在用户屏幕上?`);
