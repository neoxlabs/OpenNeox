/**
 * SkillInstallManager — K4-MVP 单测.
 *
 *   覆盖:
 *     - install: 下载 + 写 SKILL.md + 写 .neox-skill.json, 默认 trustLevel='limited'
 *     - install: 重复装同 skillId → already_exists
 *     - update:  version 不变 → up_to_date; version 变 → updated, trustLevel 保留
 *     - uninstall: rm -rf, listInstalled 不再列
 *     - trust / untrust: 切换 trustLevel + trustedAt
 *     - listInstalled: 扫所有 .neox-skill.json
 *
 *   fetch mock: 用 vi.stubGlobal 替换 global.fetch, 不发真网络.
 *   fs mock: 用 tempDir + 重定向 ~/.neox/skills/ 到 tempDir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillInstallManager } from '../installManager.js';
/* 路径别再写死 —— 跟着 kernel 那个唯一真相源走, 换发行版不用改测试 */
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/* 把 ~/.neox/skills/ 重定向到临时 tempDir, 跑完干掉. */
let tempHomeBackup: string | undefined;
let tempDir: string;

function mockFetchOnce(content: string, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : `HTTP ${status}`,
    text: async () => content,
  })));
}

const VALID_SKILL_MD_V1 = `---
name: my-test
description: A test skill
version: 1.0.0
author: tester
neox:
  category: custom
  allowedTools:
    - readfile
---

# Test Skill

This is a test skill body.
`;

const VALID_SKILL_MD_V2 = `---
name: my-test
description: A test skill
version: 1.1.0
author: tester
neox:
  category: custom
  allowedTools:
    - readfile
    - execute_shell
---

# Test Skill v2

Updated body.
`;

beforeEach(() => {
  /* 改 $HOME 让 os.homedir() 指 tempDir; 跑完恢复. */
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-skill-test-'));
  tempHomeBackup = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.HOME = tempHomeBackup;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SkillInstallManager.install', () => {
  it('成功下载 + 写 SKILL.md + 写 .neox-skill.json, trustLevel 默认 limited', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    const r = await mgr.install('https://example.com/test.md');
    expect(r.success).toBe(true);
    expect(r.status).toBe('installed');
    expect(r.skillId).toBe('my-test');
    expect(r.meta?.trustLevel).toBe('limited');
    expect(r.meta?.installedVersion).toBe('1.0.0');
    expect(r.meta?.author).toBe('tester');
    expect(r.meta?.source.type).toBe('url');
    expect(r.meta?.source.url).toBe('https://example.com/test.md');

    /* 检查盘上文件 */
    const skillDir = path.join(tempDir, NEOX_HOME_DIRNAME, 'skills', 'my-test');
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, '.neox-skill.json'))).toBe(true);
  });

  it('显式传 trustLevel: trusted → 写 meta 的 trustLevel = trusted + trustedAt', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    const r = await mgr.install('https://example.com/test.md', { trustLevel: 'trusted' });
    expect(r.meta?.trustLevel).toBe('trusted');
    expect(r.meta?.trustedAt).toBeTruthy();
  });

  it('重复装同 skillId → already_exists, 不覆盖文件', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');
    mockFetchOnce(VALID_SKILL_MD_V1);
    const r2 = await mgr.install('https://example.com/test.md');
    expect(r2.success).toBe(false);
    expect(r2.status).toBe('already_exists');
    expect(r2.skillId).toBe('my-test');
  });

  it('HTTP 404 → success:false', async () => {
    mockFetchOnce('not found', false, 404);
    const mgr = new SkillInstallManager();
    const r = await mgr.install('https://example.com/missing.md');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/404/);
  });

  it('SKILL.md 缺 name 字段 → 拒绝写盘', async () => {
    mockFetchOnce(`---\ndescription: no name\n---\nbody`);
    const mgr = new SkillInstallManager();
    const r = await mgr.install('https://example.com/bad.md');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/missing name/);
  });
});

describe('SkillInstallManager.update', () => {
  it('版本一致 → up_to_date, 不写盘', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');

    mockFetchOnce(VALID_SKILL_MD_V1);  /* 同版本 */
    const r = await mgr.update('my-test');
    expect(r.success).toBe(true);
    expect(r.status).toBe('up_to_date');
    expect(r.previousVersion).toBe('1.0.0');
    expect(r.newVersion).toBe('1.0.0');
  });

  it('远程版本变 → updated, trustLevel 保留 (不被回退)', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');
    await mgr.trust('my-test');  /* 升级到 trusted */

    mockFetchOnce(VALID_SKILL_MD_V2);  /* 远程更新到 v1.1.0 */
    const r = await mgr.update('my-test');
    expect(r.success).toBe(true);
    expect(r.status).toBe('updated');
    expect(r.previousVersion).toBe('1.0.0');
    expect(r.newVersion).toBe('1.1.0');

    /* trustLevel 必须保留 trusted (用户已经 trust 过, update 不该把它回退) */
    const meta = mgr.getMeta('my-test');
    expect(meta?.trustLevel).toBe('trusted');
  });

  it('未安装的 skill → 拒绝', async () => {
    const mgr = new SkillInstallManager();
    const r = await mgr.update('nonexistent');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not installed/);
  });
});

describe('SkillInstallManager.uninstall', () => {
  it('rm -rf 整个目录, listInstalled 不再列', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');
    expect(mgr.listInstalled()).toHaveLength(1);

    const r = await mgr.uninstall('my-test');
    expect(r.success).toBe(true);
    expect(mgr.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(path.join(tempDir, NEOX_HOME_DIRNAME, 'skills', 'my-test'))).toBe(false);
  });

  it('卸载不存在的 → success:false', async () => {
    const mgr = new SkillInstallManager();
    const r = await mgr.uninstall('nonexistent');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});

describe('SkillInstallManager.trust / untrust', () => {
  it('trust: limited → trusted, 设 trustedAt', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');
    expect(mgr.getMeta('my-test')?.trustLevel).toBe('limited');

    const r = await mgr.trust('my-test');
    expect(r.success).toBe(true);
    const meta = mgr.getMeta('my-test');
    expect(meta?.trustLevel).toBe('trusted');
    expect(meta?.trustedAt).toBeTruthy();
  });

  it('untrust: trusted → limited, 清 trustedAt', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md', { trustLevel: 'trusted' });
    expect(mgr.getMeta('my-test')?.trustLevel).toBe('trusted');

    await mgr.untrust('my-test');
    const meta = mgr.getMeta('my-test');
    expect(meta?.trustLevel).toBe('limited');
    expect(meta?.trustedAt).toBeUndefined();
  });
});

describe('SkillInstallManager.preview (A2)', () => {
  it('远程 URL preview: 不写盘, 返 metadata', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    const p = await mgr.preview('https://example.com/test.md');
    expect(p.success).toBe(true);
    expect(p.skillId).toBe('my-test');
    expect(p.name).toBe('my-test');
    expect(p.version).toBe('1.0.0');
    expect(p.author).toBe('tester');
    expect(p.description).toBe('A test skill');
    expect(p.allowedTools).toEqual(['readfile']);
    expect(p.contentLength).toBeGreaterThan(0);
    expect(p.bodyPreview).toContain('# Test Skill');

    /* 不应该写盘 */
    expect(fs.existsSync(path.join(tempDir, NEOX_HOME_DIRNAME, 'skills', 'my-test'))).toBe(false);
  });

  it('preview fetch 失败 → success:false', async () => {
    mockFetchOnce('', false, 404);
    const mgr = new SkillInstallManager();
    const p = await mgr.preview('https://example.com/missing.md');
    expect(p.success).toBe(false);
    expect(p.error).toMatch(/404/);
  });

  it('previewLocal: 从本地文件读, 解析 metadata', () => {
    /* 写一个临时 SKILL.md */
    const local = path.join(tempDir, 'local.md');
    fs.writeFileSync(local, VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    const p = mgr.previewLocal(local);
    expect(p.success).toBe(true);
    expect(p.skillId).toBe('my-test');
    expect(p.allowedTools).toEqual(['readfile']);
  });
});

describe('SkillInstallManager.install — A3 local path', () => {
  it('install 接受本地绝对路径 → source.type=local', async () => {
    const local = path.join(tempDir, 'mylocal.md');
    fs.writeFileSync(local, VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    const r = await mgr.install(local);
    expect(r.success).toBe(true);
    expect(r.meta?.source.type).toBe('local');
    expect(r.meta?.source.path).toBe(local);
  });

  it('install 接受 file:// URL', async () => {
    const local = path.join(tempDir, 'mylocal2.md');
    /* 注意: install 自己 generate skillId 从 name, 这里 name='my-test' 跟上一个测试 conflict.
     * 用 V2 (name 还是 'my-test' 但版本不同) — 仍 conflict, 改成生成一个新 SKILL.md. */
    fs.writeFileSync(local, VALID_SKILL_MD_V1.replace('name: my-test', 'name: my-local-2'));
    const mgr = new SkillInstallManager();
    const r = await mgr.install(`file://${local}`);
    expect(r.success).toBe(true);
    expect(r.skillId).toBe('my-local-2');
    expect(r.meta?.source.type).toBe('local');
  });

  it('install 本地路径不存在 → success:false', async () => {
    const mgr = new SkillInstallManager();
    const r = await mgr.install('/tmp/__nonexistent_skill__/SKILL.md');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

describe('SkillInstallManager.listInstalled', () => {
  it('扫 ~/.neox/skills/ 下所有 .neox-skill.json', async () => {
    mockFetchOnce(VALID_SKILL_MD_V1);
    const mgr = new SkillInstallManager();
    await mgr.install('https://example.com/test.md');

    const list = mgr.listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0].skillId).toBe('my-test');
    expect(list[0].installedVersion).toBe('1.0.0');
  });

  it('没装任何 → 空数组', () => {
    const mgr = new SkillInstallManager();
    expect(mgr.listInstalled()).toEqual([]);
  });
});
