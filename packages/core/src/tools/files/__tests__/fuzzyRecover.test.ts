/**
 * edit 定位与失败分诊 — 行为锁
 *
 * 核心理论: **edit 不是搜索问题, 是缓存一致性问题**。模型上下文是文件的一份缓存副本,
 * old_string 不是"查询词"而是"这份副本仍然有效"的凭据。所以它对不上时, 该问的不是
 * "怎么近似地找到它", 而是"模型手里那份副本还对得上磁盘吗" —— 这件事可以**直接查**
 * (读账本 + 一次 stat), 不需要用内容去猜。
 *
 * 于是分工是:
 *   recoverMatch      只处理**语义无歧义**的书写习惯 (空行被吞 / `// ...` 省略中段)
 *   checkCoherence    处理一致性 (unread / stale / fresh), 由 editFileTool 分诊
 *
 * 这里锁住的是安全边界: 分不清改哪一处时必须拒, 任何放宽都要先看这些用例。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recoverMatch, lineSimilarity, isElisionLine } from '../fuzzyMatcher.js';

const FILE = [
  'function greet(name) {',
  '  // say hello to the user',
  '  const msg = "hello, " + name;',
  '',
  '  console.log(msg);',
  '  return msg;',
  '}',
  '',
  'function farewell(name) {',
  '  // say goodbye',
  '  const msg = "bye, " + name;',
  '  return msg;',
  '}',
];

describe('recoverMatch — 能救的要救', () => {
  it('空行被吞: 跨过文件里的空行仍能定位', () => {
    const r = recoverMatch(FILE, ['  const msg = "hello, " + name;', '  console.log(msg);']);
    expect(r.match?.kind).toBe('blank_insensitive');
    expect(r.match?.line).toBe(3);
    // 必须把文件里真实覆盖的那几行(含空行)交出来, 否则替换会吃掉空行
    expect(r.match?.actualLines).toEqual(['  const msg = "hello, " + name;', '', '  console.log(msg);']);
  });

  it('省略号: head 唯一即可, tail 取 head 之后第一处 (不要求全局唯一)', () => {
    // `  return msg;\n}` 在 greet 和 farewell 各出现一次 — 要求全局唯一会误拒
    const r = recoverMatch(FILE, ['function greet(name) {', '  // ...', '  return msg;', '}']);
    expect(r.match?.kind).toBe('elided');
    expect(r.match?.line).toBe(1);
    expect(r.match?.actualLines).toHaveLength(7); // 整个 greet 函数
  });
});

describe('内容漂移不再靠猜 — 交给一致性诊断 (2026-07-24 设计变更)', () => {
  /* 曾经这里有两条断言, 要求 similar 档把"注释漂移"和"const→let"救回来。
   * 那是**用内容去猜一个可以直接查到的事实**: old_string 对不上只有三种可能
   * (没读过 / 读过但文件变了 / 读过且没变但抄错了), 而这三种可以由 readLedger
   * 的版本戳精确区分, 各自有完全不同的正确动作。
   *
   * similar 档的代价也是实打实的: 合法改写(const→let 单行 0.889)与臆造字面量
   * ("xxx"→"bye" 0.846)只差 0.043, 只能靠校准出来的窄阈值去赌, 赌输就是改错文件。
   *
   * 现在: recoverMatch 只保留**语义无歧义**的两档 (空行 / 省略号), 内容层漂移一律
   * 交给 editFileTool 的一致性诊断处理 —— fresh 时把文件里真实那段摊给模型让它重发,
   * stale/unread 时让它重读。见 editFileTool.locateAndApply 里的大段注释。 */
  it('注释漂移: 不再自作主张恢复, 但要给出 nearest 供报错', () => {
    const r = recoverMatch(FILE, ['  // say hello to the user (updated)', '  const msg = "hello, " + name;']);
    expect(r.match).toBeUndefined();
    expect(r.nearest).toBeDefined();
    expect(r.nearest!.line).toBe(2);          // 位置照样指得准, 只是不动手
  });

  it('一行改写 (const→let): 同上, 诊断而非猜测', () => {
    const r = recoverMatch(FILE, ['  // say hello to the user', '  let msg = "hello, " + name;']);
    expect(r.match).toBeUndefined();
    expect(r.nearest?.line).toBe(2);
  });
});

describe('recoverMatch — 分不清就必须拒 (安全边界, 不许放宽)', () => {
  it('臆造的字面量: 两处都像时拒绝下手', () => {
    // "xxx, " 文件里不存在; 对 "bye, " 0.846 / 对 "hello, " 0.815 — 近乎平手
    const r = recoverMatch(FILE, ['  const msg = "xxx, " + name;', '  return msg;']);
    expect(r.match).toBeUndefined();
    expect(r.nearest).toBeDefined();      // 但要给出最接近处供模型自查
  });

  it('完全不相干的内容: 拒绝', () => {
    const r = recoverMatch(FILE, ['  const totallyUnrelated = 42;']);
    expect(r.match).toBeUndefined();
  });

  it('代码行相似度低于闸门: 拒绝 (注释豁免不适用于代码行)', () => {
    const r = recoverMatch(FILE, ['  const value = computeSomethingElse(a, b, c);']);
    expect(r.match).toBeUndefined();
  });

  it('多处空行无关匹配时判歧义而非乱选', () => {
    const dup = ['a();', '', 'b();', 'x();', 'a();', '', 'b();'];
    const r = recoverMatch(dup, ['a();', 'b();']);
    expect(r.match).toBeUndefined();
    expect(r.reason).toBe('ambiguous');
  });
});

describe('辅助判定', () => {
  it('isElisionLine 认得常见省略写法', () => {
    for (const l of ['...', '  ...', '// ...', '  // ....', '# ...', '/* ... */', '  * ...']) {
      expect(isElisionLine(l), l).toBe(true);
    }
    for (const l of ['const a = 1;', '// hello', '', 'a.b.c']) {
      expect(isElisionLine(l), l).toBe(false);
    }
  });

  it('lineSimilarity: 完全相同=1, 空白/引号归一后相同也=1', () => {
    expect(lineSimilarity('  a = 1;', 'a = 1;')).toBe(1);
    expect(lineSimilarity('x = "s";', 'x = “s”;')).toBe(1);
    expect(lineSimilarity('abc', 'xyz')).toBeLessThan(0.3);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 一致性诊断 (readLedger.checkCoherence) — edit 失败分诊的依据
 *
 * 这是"edit 是缓存一致性问题而不是搜索问题"这个结论的落点: old_string 找不到时,
 * 该问的不是"怎么近似找到它", 而是"模型手里那份副本还对得上磁盘吗" —— 直接查, 不猜。
 * ══════════════════════════════════════════════════════════════════════════ */
import { recordRead, checkCoherence, dropSessionLedger } from '../../smart-read/readLedger.js';

describe('checkCoherence — 三态分诊', () => {
  const P = '/tmp/coh/x.ts';
  beforeEach(() => dropSessionLedger('__default__'));

  const put = (mtimeMs: number, sizeBytes: number) => recordRead(P, {
    rangeKey: 'FULL', content: 'a\nb\n', startLine: 1, lineCount: 2,
    mtimeMs, sizeBytes, readAtTurn: 1,
  });

  it('没读过 → unread', () => {
    expect(checkCoherence(P, 100, 10).state).toBe('unread');
  });

  it('读过且版本戳一致 → fresh', () => {
    put(100, 10);
    expect(checkCoherence(P, 100, 10).state).toBe('fresh');
  });

  it('mtime 变了 → stale', () => {
    put(100, 10);
    expect(checkCoherence(P, 200, 10).state).toBe('stale');
  });

  it('size 变了 (mtime 分辨率不够时的兜底) → stale', () => {
    put(100, 10);
    expect(checkCoherence(P, 100, 11).state).toBe('stale');
  });

  it('stale 时仍带回最近那条记录, 供报错说明"你当时看到的是什么"', () => {
    put(100, 10);
    const r = checkCoherence(P, 999, 99);
    expect(r.state).toBe('stale');
    expect(r.entry?.lineCount).toBe(2);
  });
});
