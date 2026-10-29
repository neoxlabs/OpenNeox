import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readRaw = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8');
/* 判"代码里有没有" 必须先剥注释 —— 这些文件的注释里**引用了老写法的原文**
 * (那是有用的记录, 不该为了让闸变绿而删掉), 不剥就会把注释当成代码判红。 */
const read = (rel: string): string => readRaw(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const worker = read('../../workers/indexDbWorker.ts');
const cpuWorker = read('../../workers/indexingCpuWorker.ts');
const embeddingBridge = read('../embeddingBridge.ts');
const semanticBridge = read('../semanticBridge.ts');
const ignoreList = readRaw('../indexIgnore.ts');

describe('代码索引不许挡主线程', () => {
  it('bm25_terms(chunk_id) 建了索引 —— 级联删除和搜索都靠它', () => {
    expect(worker).toMatch(/CREATE INDEX IF NOT EXISTS idx_bm25_terms_chunk ON bm25_terms\(chunk_id\)/);
  });

  it('索引库的 SQLite 只在 worker 里 —— 主线程的 bridge 不许自己开库', () => {
    /* bridge 里不该再出现 better-sqlite3 的痕迹 (prepare/transaction/pragma) */
    expect(embeddingBridge).not.toMatch(/this\.db\.(prepare|transaction|pragma|exec)\(/);
    expect(embeddingBridge).not.toMatch(/_require\('better-sqlite3'\)/);
    /* 而 worker 里必须有 */
    expect(worker).toMatch(/_require\('better-sqlite3'\)/);
  });

  it('搜索不许"每个候选打一次 term 查询" —— 那是 O(候选数) 次全表扫', () => {
    expect(worker).not.toMatch(/FROM bm25_terms WHERE chunk_id = \?/);
    expect(worker).toMatch(/AND term IN \(/);
  });

  it('IN (...) 一律分片 —— SQLite 参数上限 32766, 候选一多直接抛', () => {
    expect(worker).toMatch(/const CHUNK_PARAMS = \d+/);
    expect(worker).toMatch(/const CANDIDATE_LIMIT = \d+/);
  });

  it('avgDocLen 有缓存 —— 每次搜索全表扫一遍 content 是纯浪费', () => {
    expect(worker).toMatch(/AVG_DOC_LEN_KEY/);
    expect(worker).toMatch(/invalidateAvgDocLen/);
  });

  it('两个 bridge 共用同一份忽略清单', () => {
    expect(semanticBridge).toMatch(/SHARED_INDEX_IGNORE/);
    expect(embeddingBridge).toMatch(/SHARED_INDEX_IGNORE/);
    /* 各自再写一份字面量清单 = 又回到抛硬币 */
    expect(semanticBridge).not.toMatch(/'\*\*\/node_modules\/\*\*'/);
    expect(embeddingBridge).not.toMatch(/'\*\*\/node_modules\/\*\*'/);
  });

  it('发布产物和系统垃圾在忽略清单里 —— 它们是"一 build 就重扫上千文件"的来源', () => {
    for (const pattern of ['**/release/**', '**/*.dmg', '**/*.blockmap', '**/.DS_Store']) {
      expect(ignoreList).toContain(`'${pattern}'`);
    }
  });

  it('walk 不许给已经是 glob 的模式再包一层壳', () => {
    // 老写法无条件套一层壳, 把 .DS_Store 这种文件模式拧成目录模式, 一条都匹配不上
    expect(semanticBridge).toMatch(/g\.includes\('\/'\) \|\| g\.includes\('\*'\)/);
  });

  it('分词只有一份 —— 两个 worker 都从 indexTokenize 引, 谁都不许自己写', () => {
    expect(worker).toMatch(/import \{ tokenize \} from '\.\.\/services\/indexTokenize\.js'/);
    expect(cpuWorker).toMatch(/import \{ tokenize \} from '\.\.\/services\/indexTokenize\.js'/);
    expect(worker).not.toMatch(/function tokenize\(/);
    expect(cpuWorker).not.toMatch(/function tokenize\(/);
  });
});
