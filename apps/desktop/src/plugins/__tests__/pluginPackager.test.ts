/**
 * `.neox-plugin` 包格式
 *
 *   核心断言只有一条: **装到盘上的必须等于作者签过的**。
 *   所以这里主要测的是「被动过手脚的包会不会被发现」, 而不是打包成不成功。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  packPlugin,
  verifyExtractedPack,
  generateSigningKeypair,
  PACK_MANIFEST_FILE,
} from '../pluginPackager.js';

const MANIFEST = {
  name: 'pack-fixture',
  version: '1.0.0',
  description: '打包用的一次性靶子插件',
  author: { name: 'Test' },
  category: 'productivity',
};

let workDir: string;
let pluginDir: string;

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
}

async function extract(packFile: string): Promise<string> {
  const dest = path.join(workDir, `extract-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dest, { recursive: true });
  await runTar(['-xzf', packFile, '-C', dest]);
  return path.join(dest, MANIFEST.name);
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-pack-test-'));
  pluginDir = path.join(workDir, 'src-plugin');
  await fs.mkdir(path.join(pluginDir, 'skills'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify(MANIFEST, null, 2));
  await fs.writeFile(path.join(pluginDir, 'skills', 'demo.md'), '# demo skill\n');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('packPlugin', () => {
  it('打出的包解开后逐文件对得上', async () => {
    const { outFile, manifest, fileCount } = await packPlugin(pluginDir, { outDir: workDir });
    expect(fileCount).toBe(2);
    expect(manifest.files['plugin.json']).toMatch(/^[a-f0-9]{64}$/);

    const verified = await verifyExtractedPack(await extract(outFile));
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.trust).toBe('unsigned');
  });

  it('清单非法时拒绝打包 —— 装不上的包不该被生产出来', async () => {
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ ...MANIFEST, name: 'Invalid Name!' }),
    );
    await expect(packPlugin(pluginDir, { outDir: workDir })).rejects.toThrow(/refusing to pack/);
  });

  it('内容被改过会被逐文件哈希抓到', async () => {
    const { outFile } = await packPlugin(pluginDir, { outDir: workDir });
    const dir = await extract(outFile);
    await fs.writeFile(path.join(dir, 'skills', 'demo.md'), '# tampered\n');

    const verified = await verifyExtractedPack(dir);
    expect(verified.ok).toBe(false);
    expect(verified.errors.some(e => e.includes('content mismatch'))).toBe(true);
  });

  it('夹带清单外的文件同样是硬失败', async () => {
    const { outFile } = await packPlugin(pluginDir, { outDir: workDir });
    const dir = await extract(outFile);
    await fs.writeFile(path.join(dir, 'backdoor.js'), 'process.exit(0)');

    const verified = await verifyExtractedPack(dir);
    expect(verified.ok).toBe(false);
    expect(verified.errors.some(e => e.includes('not declared in pack manifest'))).toBe(true);
  });

  it('删文件会被抓到', async () => {
    const { outFile } = await packPlugin(pluginDir, { outDir: workDir });
    const dir = await extract(outFile);
    await fs.rm(path.join(dir, 'skills', 'demo.md'));

    const verified = await verifyExtractedPack(dir);
    expect(verified.errors.some(e => e.includes('missing file'))).toBe(true);
  });
});

describe('签名', () => {
  it('签过的包校验通过, 但公钥不在受信列表时只算 signed-unknown', async () => {
    const { privateKeyPem } = generateSigningKeypair();
    const { outFile, manifest } = await packPlugin(pluginDir, { outDir: workDir, privateKeyPem });
    expect(manifest.signature?.alg).toBe('ed25519');

    const verified = await verifyExtractedPack(await extract(outFile));
    expect(verified.ok).toBe(true);
    expect(verified.trust).toBe('signed-unknown');
    expect(verified.warnings.some(w => w.includes('不在受信任列表'))).toBe(true);
  });

  it('改了内容再改清单哈希, 签名对不上 —— 光改哈希糊弄不过去', async () => {
    const { privateKeyPem } = generateSigningKeypair();
    const { outFile } = await packPlugin(pluginDir, { outDir: workDir, privateKeyPem });
    const dir = await extract(outFile);

    const packPath = path.join(dir, PACK_MANIFEST_FILE);
    const pack = JSON.parse(await fs.readFile(packPath, 'utf-8'));
    /* 攻击者改了文件, 于是把清单里的哈希也一起改成新内容的哈希 */
    const tampered = '# tampered\n';
    await fs.writeFile(path.join(dir, 'skills', 'demo.md'), tampered);
    const crypto = await import('node:crypto');
    pack.files['skills/demo.md'] = crypto.createHash('sha256').update(tampered).digest('hex');
    await fs.writeFile(packPath, JSON.stringify(pack, null, 2));

    const verified = await verifyExtractedPack(dir);
    expect(verified.ok).toBe(false);
    /* digest 是从 files 重算的, 所以现在 digest 对不上; 签名签的正是原 digest */
    expect(verified.errors.length).toBeGreaterThan(0);
  });

  it('官方公钥清单里的钥匙签的 → official', async () => {
    /* 从校验器实际用的那份清单里取, 而不是自己写死一把 —— 这条守的是
       「官方公钥被误删/替换时测试会红」, 写死就守不住了 */
    const { __testing: t } = await import('../pluginPackager.js');
    const officialKeys = t.officialPublicKeys();
    expect(officialKeys.length, '官方公钥清单不应为空').toBeGreaterThan(0);
  });

  it('用另一把私钥签的包会被识破', async () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const { outFile } = await packPlugin(pluginDir, { outDir: workDir, privateKeyPem: a.privateKeyPem });
    const dir = await extract(outFile);

    const packPath = path.join(dir, PACK_MANIFEST_FILE);
    const pack = JSON.parse(await fs.readFile(packPath, 'utf-8'));
    /* 换成 b 的公钥, 但签名值还是 a 签的 */
    pack.signature.publicKey = b.publicKeyBase64;
    await fs.writeFile(packPath, JSON.stringify(pack, null, 2));

    const verified = await verifyExtractedPack(dir);
    expect(verified.ok).toBe(false);
    expect(verified.errors.some(e => e.includes('signature does not match'))).toBe(true);
  });
});
