/**
 * 写路径一致性 — 行为锁
 *
 * 核心不变量: **任何会改工作区的路径, 都必须让相应的缓存失效**, 否则工具会撒谎。
 *
 * 两套缓存的失效机制不同, 暴露面也不同:
 *   读账本 —— 有 per-file (mtime + size) 版本戳 ⇒ 外部改动自动被判 stale, 无需通知
 *   搜索缓存 —— **只有会话级 epoch** 一个判据 ⇒ 没人 bump 就永远"新鲜", 必须显式失效
 *
 * 于是 shell 成了破口: bumpWorkspaceEpoch() 原先只有 edit/write_file 调, shell 从不调。
 *   search "foo" → 缓存 → shell `sed -i s/foo/bar/` → 再 search "foo" → 命中旧缓存
 *   → 告诉模型 foo 还在。这里锁住修复后的行为。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isReadOnlyShellCommand } from '../../shell/executeShellTool.js';
import {
  recordSearch,
  findFreshSearch,
  bumpWorkspaceEpoch,
  recordOpaqueDocRead,
  checkCoherence,
  dropSessionLedger,
} from '../readLedger.js';

beforeEach(() => dropSessionLedger('__default__'));

describe('isReadOnlyShellCommand — 保守白名单 (不在名单里就当会写)', () => {
  it('公认只读的命令放行并发', () => {
    for (const c of ['ls -la', 'cat foo.ts', 'git status', 'git log --oneline', 'rg pattern', 'wc -l x']) {
      expect(isReadOnlyShellCommand(c), c).toBe(true);
    }
  });

  it('写类命令一律判为会写', () => {
    for (const c of ['rm -rf x', 'npm install', 'git commit -m x', 'mv a b', 'touch f', 'sed -i s/a/b/ f']) {
      expect(isReadOnlyShellCommand(c), c).toBe(false);
    }
  });

  it('重定向 / tee 必须算写 —— 否则 `echo x > f` 会被当只读', () => {
    for (const c of ['echo hi > f.txt', 'cat a >> b', 'ls | tee out.txt', 'echo x >f']) {
      expect(isReadOnlyShellCommand(c), c).toBe(false);
    }
  });

  it('组合命令不敢判只读 (只对单命令判定)', () => {
    expect(isReadOnlyShellCommand('ls && rm -rf x')).toBe(false);
    expect(isReadOnlyShellCommand('cat a; rm b')).toBe(false);
  });

  it('cd 前缀不影响判定', () => {
    expect(isReadOnlyShellCommand('cd src && ls')).toBe(true);
  });

  it('空命令保守判为会写', () => {
    expect(isReadOnlyShellCommand('')).toBe(false);
  });
});

describe('搜索缓存: 纪元一变必须失效', () => {
  it('未 bump → 命中缓存 (这是想要的省一次 ripgrep)', () => {
    recordSearch('q1', 3, ['a.ts']);
    expect(findFreshSearch('q1')).toBeDefined();
  });

  it('bump 之后 → 缓存作废 (shell 改过文件的场景)', () => {
    recordSearch('q1', 3, ['a.ts']);
    bumpWorkspaceEpoch();
    expect(findFreshSearch('q1')).toBeUndefined();
  });
});

describe('不透明文档 (.docx): 只靠版本戳判一致性', () => {
  const P = '/tmp/doc/a.docx';

  it('读过且版本戳一致 → fresh (按索引写可放行)', () => {
    recordOpaqueDocRead(P, 111, 2048);
    expect(checkCoherence(P, 111, 2048).state).toBe('fresh');
  });

  it('文件被外部改过 → stale (按索引写必须拦: index 5 会指向别的段落)', () => {
    recordOpaqueDocRead(P, 111, 2048);
    expect(checkCoherence(P, 222, 3000).state).toBe('stale');
  });

  it('没读过 → unread (索引来源不明)', () => {
    expect(checkCoherence(P, 111, 2048).state).toBe('unread');
  });

  it('不存文本内容 —— .docx 的文本对 edit 没用, 存了只会误导', () => {
    recordOpaqueDocRead(P, 111, 2048);
    expect(checkCoherence(P, 111, 2048).entry?.content).toBe('');
  });
});

/* Positional-write safety depends on read evidence being registered by a read path;
 * loading a document as part of a write must not create fresh evidence for that write. */
describe('证据登记不能由写方自己触发', () => {
  const P = '/tmp/doc/guard.docx';
  beforeEach(() => dropSessionLedger('__default__'));

  it('没有任何读证据时必须是 unread —— 写方不许自己补上', () => {
    // 模拟"写工具 load 了文件但显式不登记证据"的效果
    expect(checkCoherence(P, 500, 1000).state).toBe('unread');
  });

  it('只有读方登记过, 才可能是 fresh', () => {
    recordOpaqueDocRead(P, 500, 1000);
    expect(checkCoherence(P, 500, 1000).state).toBe('fresh');
  });
});
