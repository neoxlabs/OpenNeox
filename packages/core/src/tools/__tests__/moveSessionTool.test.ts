import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { moveSessionTool, projectRootOf, SESSION_MOVE_MARKER } from '../moveSessionTool.js';

const run = async (args: any) => JSON.parse(await moveSessionTool.function(args) as string);

describe('move_session_to_project', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'neox-move-')));
    mkdirSync(join(base, 'billing', '.git'), { recursive: true });
    mkdirSync(join(base, 'billing', 'src', 'api'), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('子目录 → 往上找到 .git 那一层, 结果带标记和理由', async () => {
    expect(projectRootOf(join(base, 'billing', 'src', 'api'))).toBe(join(base, 'billing'));
    const r = await run({ path: join(base, 'billing', 'src'), reason: 'this is the billing repo' });
    expect(r).toMatchObject({ [SESSION_MOVE_MARKER]: true, ok: true, path: join(base, 'billing'), reason: 'this is the billing repo' });
  });

  it('不存在的目录 / 家目录不挪', async () => {
    expect((await run({ path: join(base, 'nope') })).ok).toBe(false);
    expect((await run({ path: homedir() })).ok).toBe(false);
  });

  it('只在有界面的宿主里有 (gui 标签)', () => {
    expect(moveSessionTool.capabilities).toContain('gui');
  });
});
