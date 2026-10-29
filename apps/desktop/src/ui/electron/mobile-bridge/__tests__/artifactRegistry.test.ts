/**
 * artifactRegistry.test.ts — 手机端下载产物的两条安全底线 + 检出精度.
 *
 * 这个功能的存在理由是用户那句"我让他做个 PPT, 做完了结果不能下载"。
 * 但它同时开了一条"手机能读电脑上的文件"的路, 所以下面两条必须锁死:
 *   1. 只有 agent 报出来的产物能被登记, 且必须落在 workspace / 临时目录内 ——
 *      符号链接指出去也不行 (realpath 之后再比);
 *   2. 手机只能按 id 取, 没有任何接口收路径。
 * 第三组测检出精度: 宁可漏, 不可把满屏 grep 结果当成产物推给用户。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerArtifact,
  lookupArtifact,
  looksLikeArtifact,
  _resetArtifactRegistry,
} from '../artifactRegistry.js';
import { scanArtifactPaths } from '../artifactScan.js';

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  _resetArtifactRegistry();
  root = mkdtempSync(join(tmpdir(), 'neox-artifact-'));
  workspace = join(root, 'ws');
  outside = join(root, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  _resetArtifactRegistry();
  rmSync(root, { recursive: true, force: true });
});

function makeFile(dir: string, name: string, bytes = 32): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

describe('登记边界', () => {
  it('workspace 内的产物可以登记, 拿得到 id 和元信息', () => {
    const p = makeFile(workspace, '汇报.pptx', 1234);
    const pub = registerArtifact('s1', p, workspace);
    expect(pub).not.toBeNull();
    expect(pub!.name).toBe('汇报.pptx');
    expect(pub!.size_bytes).toBe(1234);
    expect(pub!.mime).toContain('presentationml');
    expect(pub!.id.startsWith('art-')).toBe(true);
  });

  it('workspace 外的文件不登记', () => {
    const p = makeFile(outside, '别人的.pptx');
    expect(registerArtifact('s1', p, workspace)).toBeNull();
  });

  it('workspace 里指向外面的符号链接不登记 (realpath 之后再比)', () => {
    const real = makeFile(outside, 'secret.pdf');
    const link = join(workspace, 'looks-inside.pdf');
    try {
      symlinkSync(real, link);
    } catch (e: any) {
      if (e?.code === 'EPERM' && process.platform === 'win32') return;
      throw e;
    }
    expect(registerArtifact('s1', link, workspace)).toBeNull();
  });

  it('目录不登记', () => {
    expect(registerArtifact('s1', workspace, workspace)).toBeNull();
  });

  it('空文件不登记', () => {
    const p = makeFile(workspace, 'empty.pdf', 0);
    expect(registerArtifact('s1', p, workspace)).toBeNull();
  });

  it('同一文件重复登记复用同一个 id (导出两次不刷两张卡)', () => {
    const p = makeFile(workspace, 'a.pdf');
    const first = registerArtifact('s1', p, workspace);
    const second = registerArtifact('s1', p, workspace);
    expect(first!.id).toBe(second!.id);
  });
});

describe('按 id 取用', () => {
  it('登记过的 id 能查到真实路径', () => {
    const p = makeFile(workspace, 'b.png');
    const pub = registerArtifact('s1', p, workspace)!;
    expect(lookupArtifact(pub.id)!.absPath).toBe(p);
  });

  it('没登记过的 id 一律查不到 — 猜 id 无效', () => {
    expect(lookupArtifact('art-00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(lookupArtifact('')).toBeNull();
    /* 路径当 id 传也没用: registry 只认自己发出去的 uuid */
    expect(lookupArtifact('/etc/passwd')).toBeNull();
    expect(lookupArtifact('../../../../etc/passwd')).toBeNull();
  });
});

describe('产物扩展名白名单', () => {
  it('认办公文档 / 图片 / 打包文件', () => {
    for (const n of ['a.pptx', 'a.docx', 'a.xlsx', 'a.pdf', 'a.png', 'a.zip', 'a.mp4']) {
      expect(looksLikeArtifact(n)).toBe(true);
    }
  });

  it('不认源码 / 日志 / 中间文件 — 否则手机 timeline 会被刷屏', () => {
    for (const n of ['a.ts', 'a.js', 'a.log', 'a.lock', 'a.map', 'a.tmp', 'Makefile']) {
      expect(looksLikeArtifact(n)).toBe(false);
    }
  });
});

describe('从 tool_result 里抠路径', () => {
  it('抠得出 deck_export 那种结构化产出 (真实 payload)', () => {
    const output = JSON.stringify({
      ok: true,
      path: '/Users/x/proj/2026-08-10-汇报/汇报.pptx',
      previewPath: '/Users/x/proj/2026-08-10-汇报/preview.html',
      styleId: 'corporate-chevron',
      slideCount: 9,
    });
    const paths = scanArtifactPaths(output);
    expect(paths).toContain('/Users/x/proj/2026-08-10-汇报/汇报.pptx');
    expect(paths).toContain('/Users/x/proj/2026-08-10-汇报/preview.html');
  });

  it('不碰自由文本 — execute_shell 的 ls 输出不该冒出产物', () => {
    const lsOutput = 'total 184\n-rw-r--r--  1 u  staff  21369 Aug 10 07:13 汇报.pptx\n';
    expect(scanArtifactPaths(lsOutput)).toEqual([]);
  });

  it('输入类字段不算产物 (用户自己给的图不该被推回去)', () => {
    const output = JSON.stringify({
      sourcePath: '/Users/x/in.png',
      inputPath: '/Users/x/in2.png',
      cwd: '/Users/x/proj',
    });
    expect(scanArtifactPaths(output)).toEqual([]);
  });

  it('相对路径不算 — 无法确定根, 宁可漏', () => {
    expect(scanArtifactPaths(JSON.stringify({ path: 'out/a.pptx' }))).toEqual([]);
  });

  it('坏 JSON 不抛异常', () => {
    expect(scanArtifactPaths('{not json')).toEqual([]);
    expect(scanArtifactPaths('')).toEqual([]);
    expect(scanArtifactPaths(undefined)).toEqual([]);
  });
});
