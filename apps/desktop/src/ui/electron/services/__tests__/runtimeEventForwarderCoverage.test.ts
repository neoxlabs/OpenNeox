import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_TYPES = path.join(HERE, '../../../../../../../packages/core/src/runtime/runtimeTypes.ts');
const FORWARDER = path.join(HERE, '..', 'runtimeEventForwarder.ts');

const KNOWN_UI_GAPS = new Set<string>([
  /* 工具批的一行摘要。渲染层至今没有消费方 (要决定挂在哪张卡片上), 补 case 也无处可去。 */
  'tool_batch_summary',
]);

describe('runtimeEventForwarder 的事件覆盖面', () => {
  it('运行时声明的事件类型都有 case (或在 KNOWN_UI_GAPS 里显式豁免)', () => {
    const rt = fs.readFileSync(RUNTIME_TYPES, 'utf-8');
    const fw = fs.readFileSync(FORWARDER, 'utf-8');

    const declared = new Set([...rt.matchAll(/^\s*type:\s*'([a-z0-9_]+)';/gim)].map((m) => m[1]));
    expect(declared.size, '没解析出运行时事件类型 — 判据本身坏了').toBeGreaterThan(20);

    const handled = new Set([...fw.matchAll(/case\s+'([a-z0-9_]+)'/gi)].map((m) => m[1]));
    /* switch 之前的 type-guard 也算处理了 (ask_user_needed / session_title_changed 等) */
    for (const m of fw.matchAll(/type\s*===\s*'([a-z0-9_]+)'/gi)) handled.add(m[1]);

    const missing = [...declared].filter((t) => !handled.has(t) && !KNOWN_UI_GAPS.has(t)).sort();
    expect(missing, `这些运行时事件到不了界面 (补 case, 或写清理由加进 KNOWN_UI_GAPS): ${missing.join(', ')}`).toEqual([]);
  });

  it('KNOWN_UI_GAPS 里的类型确实还没人接 — 接上了就该从例外里删掉', () => {
    const fw = fs.readFileSync(FORWARDER, 'utf-8');
    for (const t of KNOWN_UI_GAPS) {
      expect(fw.includes(`case '${t}'`), `${t} 已经接上了, 把它从 KNOWN_UI_GAPS 删掉`).toBe(false);
    }
  });
});
