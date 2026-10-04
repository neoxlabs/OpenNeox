import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createEditFileTool } from '../files/editFileTool.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-edit-file-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildTool(workspaceDir: string) {
  return createEditFileTool({
    resolveWorkspacePath: (requestedPath?: string) => path.resolve(workspaceDir, requestedPath || ''),
    formatDisplayPath: (absPath: string) => path.relative(workspaceDir, absPath),  });
}

/* edit_file uses content-addressed replacement. The optional start_line hint
 * disambiguates a nearby match; it does not define a line-range edit API. */


describe('edit_file 行内子串 (replace_all 的语义必须为真)', () => {
  const CONFIG = [
    '  SLOT-01-RED',
    '  filler line a',
    '  SLOT-02-RED',
    '  filler line b',
    '  SLOT-03-RED',
    '',
  ].join('\n');

  it('replace_all + 行内子串 → 全部替换 (这是原来直接失败的用例)', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'config.txt');
      await fs.writeFile(filePath, CONFIG, 'utf-8');
      const tool = buildTool(dir);
      const raw = await tool.function({
        file_path: 'config.txt',
        old_string: '-RED',
        new_string: '-GREEN',
        replace_all: true,
      });
      const result = JSON.parse(raw);
      expect(result.status).not.toBe('error');
      const after = await fs.readFile(filePath, 'utf-8');
      expect(after).toContain('SLOT-01-GREEN');
      expect(after).toContain('SLOT-02-GREEN');
      expect(after).toContain('SLOT-03-GREEN');
      expect(after).not.toContain('-RED');
      /* filler 一行都不能动 */
      expect((after.match(/filler line/g) || []).length).toBe(2);
    });
  });

  it('行内子串唯一命中 → 不需要 replace_all', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'a.ts');
      await fs.writeFile(filePath, 'const NAME = "old-value";\nother();\n', 'utf-8');
      const tool = buildTool(dir);
      const raw = await tool.function({
        file_path: 'a.ts',
        old_string: 'old-value',
        new_string: 'new-value',
      });
      expect(JSON.parse(raw).status).not.toBe('error');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('const NAME = "new-value";\nother();\n');
    });
  });

  it('多处命中且没传 replace_all → 必须报歧义, 不许乱改', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'config.txt');
      await fs.writeFile(filePath, CONFIG, 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'config.txt', old_string: '-RED', new_string: '-GREEN',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toBe('ambiguous_match');
      /* 文件必须原样 */
      expect(await fs.readFile(filePath, 'utf-8')).toBe(CONFIG);
    });
  });

  it('同一行内多次出现, replace_all 要全换', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'b.txt');
      await fs.writeFile(filePath, 'x=RED, y=RED, z=RED\n', 'utf-8');
      const tool = buildTool(dir);
      await tool.function({ file_path: 'b.txt', old_string: 'RED', new_string: 'GREEN', replace_all: true });
      expect(await fs.readFile(filePath, 'utf-8')).toBe('x=GREEN, y=GREEN, z=GREEN\n');
    });
  });

  it('new_string 含换行 → 一行拆成多行, 后续行号不能错位', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'c.txt');
      await fs.writeFile(filePath, 'head\nA=1 B=2\ntail\n', 'utf-8');
      const tool = buildTool(dir);
      await tool.function({ file_path: 'c.txt', old_string: ' B=2', new_string: '\nB=2' });
      expect(await fs.readFile(filePath, 'utf-8')).toBe('head\nA=1\nB=2\ntail\n');
    });
  });

  it('old_string 含正则元字符 → 按字面替换, 不许当正则', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'd.txt');
      await fs.writeFile(filePath, 'cost = a.b(1) + a.b(2)\n', 'utf-8');
      const tool = buildTool(dir);
      await tool.function({ file_path: 'd.txt', old_string: 'a.b(', new_string: 'a_b(', replace_all: true });
      expect(await fs.readFile(filePath, 'utf-8')).toBe('cost = a_b(1) + a_b(2)\n');
    });
  });

  it('纯空白 old_string 不走子串通道 (否则整个文件会被糟蹋)', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'e.txt');
      const orig = 'a b\nc d\n';
      await fs.writeFile(filePath, orig, 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'e.txt', old_string: ' ', new_string: '_', replace_all: true,
      }));
      expect(result.status).toBe('error');
      expect(await fs.readFile(filePath, 'utf-8')).toBe(orig);
    });
  });
});

describe('edit_file trailing newline 对齐 (gpt-5.5 editfile 回归)', () => {
  it('old_string/new_string 尾部 \\n 不制造额外空行, 精确命中不掉 fuzzy', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, '.neox-editfile-test.txt');
      /* 跟 write_file 落盘一致: 两行正文 + 文件尾换行 */
      await fs.writeFile(filePath, 'editfile test\nstatus: before\n', 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: '.neox-editfile-test.txt',
        /* 模型从自己的 write_file 参数原样带回的尾 \\n */
        old_string: 'editfile test\nstatus: before\n',
        new_string: 'editfile test\nstatus: after\n',
      }));
      expect(result.status).toBe('success');
      expect(result.metadata?.fuzzy_recovered).toBeUndefined();
      expect(result.metadata?.old_lines).toBe(2);
      expect(result.metadata?.new_lines).toBe(2);
      expect(await fs.readFile(filePath, 'utf-8')).toBe('editfile test\nstatus: after\n');
    });
  });
});

/* Missing new_string is invalid and leaves the file untouched. An explicit
 * empty string remains the supported deletion operation. */
describe('edit_file new_string 缺失 ≠ 删除 (2026-08-28 静默删代码事故)', () => {
  it('没有 new_string 字段: 报错, 且文件一个字节都不能变', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'stock.js');
      const original = 'export function reserveStock(req) {\n  return req;\n}\n';
      await fs.writeFile(filePath, original, 'utf-8');
      const tool = buildTool(dir);

      const result = JSON.parse(await tool.function({
        file_path: 'stock.js',
        old_string: 'export function reserveStock(req) {\n  return req;\n}',
        replace_all: true,
        /* new_string 故意不传 —— 复现事故里模型发的那个调用 */
      }));

      expect(result.status).toBe('error');
      expect(result.metadata?.error ?? result.error).toBe('missing_new_string');
      /* 最关键的一条: 不能落盘 */
      expect(await fs.readFile(filePath, 'utf-8')).toBe(original);
    });
  });

  it('显式传 new_string: "" 时, 删除照常生效', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'stock.js');
      await fs.writeFile(filePath, 'keep me\nDELETE THIS LINE\nkeep me too\n', 'utf-8');
      const tool = buildTool(dir);

      const result = JSON.parse(await tool.function({
        file_path: 'stock.js',
        old_string: 'DELETE THIS LINE\n',
        new_string: '',
      }));

      expect(result.status).toBe('success');
      const after = await fs.readFile(filePath, 'utf-8');
      /* 这一条只守"显式空串能正常删除, 不被当成缺字段拦下"。
       * 落盘结果是 'keep me\n\nkeep me too\n' —— old_string 带了尾 \n, 行内替换后
       * 留下一个空行。那是这个工具既有的行为, 跟本次修复无关, 所以不在这里断言死。 */
      expect(after).not.toContain('DELETE THIS LINE');
      expect(after).toContain('keep me');
      expect(after).toContain('keep me too');
    });
  });
});

/* A replacement that makes no edits reports a structured failure so callers
 * can distinguish an unchanged file from a successful write. */
describe('edit_file 零编辑失败', () => {
  const TS = [
    'export class Bus {',
    '  sub(topic: string) {',
    '    if (this.disposed) {',
    '      throw new Error(`ScopedEventBus: app topic "${topic}" requires parent bus`);',
    '    }',
    '  }',
    '  pub(topic: string) {',
    '    if (this.disposed) {',
    '      throw new Error(`ScopedEventBus: app topic "${topic}" requires parent bus`);',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('长 old_string 在文件里两处完全相同 → 全部应用, 回执点名两处行号', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'bus.ts');
      await fs.writeFile(filePath, TS, 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'bus.ts',
        old_string: '      throw new Error(`ScopedEventBus: app topic "${topic}" requires parent bus`);',
        new_string: '      throw new IdeError(\'BUS\', `ScopedEventBus: app topic "${topic}" requires parent bus`);',
      }));
      expect(result.status).toBe('success');
      expect(result.summary).toMatch(/出现 2 次且完全相同 \(第 4, 9 行\)/);
      const after = await fs.readFile(filePath, 'utf-8');
      expect(after.match(/IdeError/g)?.length).toBe(2);
      expect(after).not.toContain('new Error(');
    });
  });

  it('old_string 已不在而 new_string 已在原位 → already_done, 不算失败 (realtest 实拍: 上一发全改后再发第二处)', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'bus.ts');
      const done = TS.replace(/throw new Error\(`ScopedEventBus: app topic "\$\{topic\}" requires parent bus`\);/g,
        'throw new IdeError(\'BUS\', `ScopedEventBus: app topic "${topic}" requires parent bus`);');
      await fs.writeFile(filePath, done, 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'bus.ts',
        old_string: '      throw new Error(`ScopedEventBus: app topic "${topic}" requires parent bus`);',
        new_string: '      throw new IdeError(\'BUS\', `ScopedEventBus: app topic "${topic}" requires parent bus`);',
      }));
      expect(result.status).toBe('already_done');
      expect(await fs.readFile(filePath, 'utf-8')).toBe(done);
    });
  });

  it('短 old_string 多处命中仍报歧义, 但错误里摊出每一处的行号和原文', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'bus.ts');
      await fs.writeFile(filePath, TS, 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'bus.ts', old_string: '    if (this.disposed) {', new_string: '    if (this.dead) {',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toBe('ambiguous_match');
      /* 给了下一步、模型自己改 —— 标 guidance, 界面不弹红卡 */
      expect(result.guidance).toBe(true);
      expect(result.verify_hint).toContain('第 3, 8 行');
      expect(result.verify_hint).toContain('3 │ "    if (this.disposed) {"');
      expect(result.metadata.match_lines).toEqual([3, 8]);
      expect(await fs.readFile(filePath, 'utf-8')).toBe(TS);
    });
  });

  it('没读过的文件, old_string 只差一个空行 → 空白级恢复照样应用', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'a.ts');
      await fs.writeFile(filePath, 'const a = 1;\n\nconst b = 2;\nconst c = 3;\n', 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 10;\nconst b = 20;',
      }));
      expect(result.status).toBe('success');
      expect(result.summary).toContain('blank_insensitive');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('const a = 10;\nconst b = 20;\nconst c = 3;\n');
    });
  });

  it('没读过的文件, old_string 是编的 → 错误里给锚点行 (JSON 原样, 带行号), 不必再 readfile', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'container.ts');
      await fs.writeFile(filePath, [
        'import { foo } from "./foo.js";',
        'import { IdeError } from "../IdeError.js";',
        '',
        'export class ServiceContainer {',
        '  register(token: string) { return token; }',
        '}',
        '',
      ].join('\n'), 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'container.ts',
        old_string: 'import { createServiceToken } from "../IdeError.js";',
        /* Keep the replacement absent so this case exercises the genuine
         * no-op path instead of the already-applied result. */
        new_string: 'import { IdeError, createServiceToken } from "../IdeError.js";',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toBe('file_not_read');
      /* 需求：「这种报错没必要显示吧, 都不影响」—— 标 guidance, 界面不弹红卡 */
      expect(result.guidance).toBe(true);
      /* 编的那行跟真 import 行相似度 70% → 走"最接近的一段" (JSON 原样); 更不像时才铺锚点行 */
      expect(result.verify_hint).toContain('2 │ "import { IdeError } from \\"../IdeError.js\\";"');
      expect(result.verify_hint).toContain('照下面摊出来的真实原文写 old_string');
      expect(await fs.readFile(filePath, 'utf-8')).toContain('import { IdeError }');
    });
  });
});

/* ── 最后几类 (第二批): 末行半截 / 锚点插入 ──────────────────────────── */
describe('edit_file 末行半截 + insert_after/insert_before', () => {
  it('old_string 末行只抄了半截 → 按前缀命中, 没抄到的后半行原样接回', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'config.txt');
      await fs.writeFile(filePath, [
        '  filler line 83 of config module — do not touch',
        '  SLOT-06-RED',
        '  filler line 85 of config module — do not touch',
        '',
      ].join('\n'), 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'config.txt',
        old_string: '  SLOT-06-RED\n  filler line 85 of config',
        new_string: '  SLOT-06-GREEN\n  filler line 85 of config',
      }));
      expect(result.status).toBe('success');
      expect(result.summary).toContain('tail_prefix');
      expect(await fs.readFile(filePath, 'utf-8')).toBe([
        '  filler line 83 of config module — do not touch',
        '  SLOT-06-GREEN',
        '  filler line 85 of config module — do not touch',
        '',
      ].join('\n'));
    });
  });

  it('insert_after: 只给锚点行 + 要插的内容, 加 import 不必抄上下文', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'a.ts');
      await fs.writeFile(filePath, 'import { a } from "./a.js";\nimport { b } from "./b.js";\n\nexport const x = 1;\n', 'utf-8');
      const tool = buildTool(dir);
      const result = JSON.parse(await tool.function({
        file_path: 'a.ts', insert_after: 'import { b } from "./b.js";', new_string: 'import { IdeError } from "./IdeError.js";',
      }));
      expect(result.status).toBe('success');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { IdeError } from "./IdeError.js";\n\nexport const x = 1;\n');
      /* 回执里直接带改后区域, 不再让模型 readfile 复核 */
      expect(result.verify_hint).toContain('不必再 readfile');
      expect(result.verify_hint).toContain('3 │ import { IdeError }');
    });
  });

  it('insert_before 在 hunks 里也能用, 且已插过再插一次是 already_done', async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, 'a.ts');
      await fs.writeFile(filePath, 'function f() {\n  return 1;\n}\n', 'utf-8');
      const tool = buildTool(dir);
      const r1 = JSON.parse(await tool.function({
        file_path: 'a.ts', hunks: [{ insert_before: '  return 1;', new_string: '  console.log("f called");' }],
      }));
      expect(r1.status).toBe('success');
      expect(await fs.readFile(filePath, 'utf-8')).toBe('function f() {\n  console.log("f called");\n  return 1;\n}\n');
      const r2 = JSON.parse(await tool.function({
        file_path: 'a.ts', hunks: [{ insert_before: '  return 1;', new_string: '  console.log("f called");' }],
      }));
      expect(r2.status).toBe('already_done');
    });
  });
});
