import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { tokenize, KnowledgeSearchEngine } = await import('../searchEngine.js');
const { KnowledgeFtsIndex } = await import('../ftsIndex.js');

const card = (id: string, title: string, body: string) => ({
  id, filePath: `/k/${id}.md`, displayPath: `${id}.md`, origin: 'workspace' as const,
  meta: { title, description: title }, body,
});

describe('tokenize', () => {
  it('原有规则不变: ASCII 按词, 汉字 bigram', () => {
    expect(tokenize('Univer API')).toEqual(['univer', 'api']);
    expect(tokenize('知识库')).toEqual(['知识', '识库']);
    expect(tokenize('库')).toEqual(['库']);
  });

  it('西里尔 / 韩文 / 希腊文按词', () => {
    expect(tokenize('Политика возврата')).toEqual(['политика', 'возврата']);
    expect(tokenize('환불 정책')).toEqual(['환불', '정책']);
    expect(tokenize('Αθήνα')).toEqual(['αθηνα']);
  });

  it('日文假名跟汉字一样 bigram (无空格分词)', () => {
    expect(tokenize('カタカナ')).toEqual(['カタ', 'タカ', 'カナ']);
    expect(tokenize('返品ポリシー')).toContain('ポリ');
  });

  it('附加符号 / 全角折叠: café = cafe, ＡＢＣ = abc', () => {
    expect(tokenize('café')).toEqual(['cafe']);
    expect(tokenize('Crème brûlée')).toEqual(['creme', 'brulee']);
    expect(tokenize('ＡＢＣ１２３')).toEqual(['abc123']);
  });
});

describe('检索命中', () => {
  it('in-memory BM25: 俄文卡片按俄文词命中', () => {
    const engine = new KnowledgeSearchEngine();
    engine.build([card('ru', 'Возврат', 'Политика возврата: 30 дней'), card('en', 'Refund', 'refund policy')]);
    const hits = engine.search('политика');
    expect(hits.map((h) => h.card.id)).toEqual(['ru']);
  });

  it('FTS: 韩文卡片按韩文词命中; 旧分词版本的索引会被整库重建', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-fts-uni-'));
    const dbPath = path.join(dir, 'fts.db');
    try {
      /* 造一个"旧版本"索引: 条目签名已存在 → 增量 sync 不会重建它 */
      let index = new KnowledgeFtsIndex(dbPath);
      const ko = card('ko', '환불 정책', '환불은 30일 이내에 가능합니다');
      await index.sync([ko], []);
      (index as any).db.exec("UPDATE fts SET body_toks = '', title_toks = ''");
      (index as any).db.pragma('user_version = 1');
      index.close();

      index = new KnowledgeFtsIndex(dbPath);
      await index.sync([ko], []);
      expect(index.search('환불').map((h) => h.card.id)).toEqual(['card:ko']);
      index.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
