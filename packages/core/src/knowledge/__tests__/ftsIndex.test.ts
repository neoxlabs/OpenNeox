/**
 * KnowledgeFtsIndex 单测 — 万级知识库的 SQLite FTS5 磁盘索引
 *
 * 覆盖: 建库/中文 bigram 检索/snippet/增量 sync (无变化零写入/变更重建/删除清理)/
 *       文档文本入索引/fileId 变化触发重抽。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeFtsIndex, ftsIndexPathFor } from '../ftsIndex.js';
import type { KnowledgeCard } from '../types.js';
import type { KnowledgeDocumentStatus } from '../documents.js';

let tmpDir: string;
let index: KnowledgeFtsIndex;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-fts-test-'));
  index = new KnowledgeFtsIndex(ftsIndexPathFor(tmpDir));
});

afterEach(() => {
  index.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCard(id: string, title: string, body: string): KnowledgeCard {
  return {
    id,
    filePath: `/x/${id}.md`,
    displayPath: `.neox/knowledge/${id}.md`,
    origin: 'workspace',
    meta: { title, description: `${title} 的描述`, trust: 'verified' },
    body,
  };
}

function makeDoc(id: string, filePath: string): KnowledgeDocumentStatus {
  const stat = fs.statSync(filePath);
  return {
    id,
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    collection: 'project',
    importedAt: Date.now(),
    missing: false,
    modified: false,
  };
}

describe('KnowledgeFtsIndex', () => {
  it('中文 bigram 检索命中 + snippet + 标题加权', async () => {
    const first = await index.sync(
      [
        makeCard('a', '报销政策', '差旅报销上限为每日三百元, 需提供发票。'),
        makeCard('b', '其他主题', '正文里顺带提了一句报销两个字, 其余是别的内容。'),
      ],
      [],
    );
    expect(first.upserted).toBe(2);

    const hits = index.search('报销 上限');
    expect(hits.length).toBe(2);
    expect(hits[0].card.meta.title).toBe('报销政策'); /* 标题命中权重高 */
    expect(hits[0].snippet).toContain('三百元');
    expect(index.search('完全无关词汇qqzz')).toHaveLength(0);
  });

  it('增量: 无变化零写入 / 变更重建 / 移除清理', async () => {
    const cardV1 = makeCard('a', '缓存策略', '旧版内容 v1');
    await index.sync([cardV1], []);

    const second = await index.sync([cardV1], []);
    expect(second.upserted).toBe(0);
    expect(second.removed).toBe(0);

    const cardV2 = { ...cardV1, body: '新版内容包含织女星关键词' };
    const third = await index.sync([cardV2], []);
    expect(third.upserted).toBe(1);
    expect(index.search('织女星')[0]?.card.meta.title).toBe('缓存策略');

    const fourth = await index.sync([], []);
    expect(fourth.removed).toBe(1);
    expect(index.search('织女星')).toHaveLength(0);
  });

  it('资料文件文本入索引, mtime 变化触发重抽', async () => {
    const file = path.join(tmpDir, '规范.txt');
    fs.writeFileSync(file, 'API key 必须存放在加密的凭据文件中。');
    await index.sync([], [makeDoc('d1', file)]);
    const hits = index.search('凭据 加密');
    expect(hits).toHaveLength(1);
    expect(hits[0].card.meta.title).toBe('规范.txt');
    expect(hits[0].snippet).toContain('凭据文件');

    /* 内容更新 + mtime 变化 → 重抽后新词可搜 */
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(file, '新增条款: 轮换周期为九十天。');
    const changed = await index.sync([], [makeDoc('d1', file)]);
    expect(changed.upserted).toBe(1);
    expect(index.search('轮换 周期')).toHaveLength(1);
    expect(index.search('凭据')).toHaveLength(0);
  });

  it('重开库不丢索引 (磁盘态)', async () => {
    await index.sync([makeCard('a', '持久化验证', '磁盘索引重开仍在')], []);
    index.close();
    index = new KnowledgeFtsIndex(ftsIndexPathFor(tmpDir));
    expect(index.search('磁盘 索引')[0]?.card.meta.title).toBe('持久化验证');
  });
});
