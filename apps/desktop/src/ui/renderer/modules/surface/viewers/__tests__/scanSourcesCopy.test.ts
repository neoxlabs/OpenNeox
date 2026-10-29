
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../../../../../..');
const CORE = path.join(REPO, 'packages/core/src/runtime/services/scanSources.ts');
const VIEWER = path.join(REPO, 'apps/desktop/src/ui/renderer/modules/surface/viewers/ServicesSurfaceViewer.tsx');

/** 从 core 源码里把 SCAN_SOURCES 的字符串项抠出来 */
function coreSources(): string[] {
  const src = fs.readFileSync(CORE, 'utf8');
  const block = src.slice(src.indexOf('export const SCAN_SOURCES'), src.indexOf('] as const;'));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function viewerConst(name: string): string {
  const src = fs.readFileSync(VIEWER, 'utf8');
  const m = new RegExp(`const ${name} = '([^']*)'`).exec(src);
  if (!m) throw new Error(`${name} 在 ServicesSurfaceViewer.tsx 里找不到 —— 改名了就同步这条测试`);
  return m[1];
}

describe('扫描文案 vs 扫描能力', () => {
  const sources = coreSources();

  test('清单本身解析得出来 (16 种起步, 解析炸了下面全是假绿)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(16);
    expect(sources[0]).toBe('package.json');
  });

  test('中文文案报的种类数 = 清单长度', () => {
    expect(viewerConst('SCAN_SOURCES_SUMMARY_ZH')).toContain(`等 ${sources.length} 种工程文件`);
  });

  test('英文文案报的"还有几种" = 清单长度 - 已列出的 5 个', () => {
    expect(viewerConst('SCAN_SOURCES_SUMMARY_EN')).toContain(`and ${sources.length - 5} more`);
  });

  test('文案列出的前 5 个 = 清单前 5 个, 顺序也一致', () => {
    const head = sources.slice(0, 5).join(' / ');
    expect(viewerConst('SCAN_SOURCES_SUMMARY_ZH')).toContain(head);
    expect(viewerConst('SCAN_SOURCES_SUMMARY_EN')).toContain(head);
  });

  test('不许再承诺清单里没有的东西 (Dockerfile 是原案发点)', () => {
    for (const copy of [viewerConst('SCAN_SOURCES_SUMMARY_ZH'), viewerConst('SCAN_SOURCES_SUMMARY_EN')]) {
      for (const word of copy.split(/[\s/]+/).filter((w) => /[.]/.test(w))) {
        expect(sources).toContain(word);
      }
    }
  });
});
