import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
import {
  canonicalJson,
  signingPayload,
  verifyTarballDigest,
  decideUpdate,
  currentPlatformArch,
  type SignedLatest,
} from '../security/releaseVerify.js';

/* 用一对真 ed25519 密钥端到端验证签名/验签逻辑, 并把公钥注入到被测模块
 * (真实 RELEASE_PUBLIC_KEY_PEM 是占位, 生产填入后行为等价)。 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const TEST_PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signLatest(version: string, digests: Record<string, string>): string {
  const payload = Buffer.from(signingPayload({ version, digests }), 'utf-8');
  return edSign(null, payload, privateKey).toString('base64');
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const ARCH = currentPlatformArch();

describe('releaseVerify · canonicalJson', () => {
  it('key 顺序无关, 输出稳定', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it('嵌套递归排序', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 }, a: [3, 2] })).toBe('{"a":[3,2],"x":{"c":2,"d":1}}');
  });
});

describe('releaseVerify · sha256 摘要', () => {
  it('匹配 ok / 不匹配 mismatch / 缺失 skip', () => {
    const buf = Buffer.from('hello neox');
    expect(verifyTarballDigest(buf, sha256hex(buf))).toBe('ok');
    expect(verifyTarballDigest(buf, sha256hex(buf).toUpperCase())).toBe('ok'); // 大小写归一
    expect(verifyTarballDigest(buf, 'deadbeef')).toBe('mismatch');
    expect(verifyTarballDigest(buf, undefined)).toBe('skip');
  });
});

describe('releaseVerify · decideUpdate (公钥占位=未配置时)', () => {
  it('摘要匹配 → 放行, 签名 skip (公钥未配)', () => {
    const buf = Buffer.from('x'.repeat(2048));
    const latest: SignedLatest = { version: '9.9.9', digests: { [ARCH]: sha256hex(buf) } };
    const d = decideUpdate(latest, buf);
    expect(d.allow).toBe(true);
    expect(d.reason).toContain('sha256');
  });

  it('摘要不匹配 → 拒 (即便无签名)', () => {
    const buf = Buffer.from('x'.repeat(2048));
    const latest: SignedLatest = { version: '9.9.9', digests: { [ARCH]: 'deadbeef' } };
    expect(decideUpdate(latest, buf).allow).toBe(false);
  });

  it('无 digests 无 signature → 过渡期放行', () => {
    const buf = Buffer.from('x'.repeat(2048));
    expect(decideUpdate({ version: '9.9.9' }, buf).allow).toBe(true);
  });

  it('requireSignature 且无签名 → 拒', () => {
    const buf = Buffer.from('x'.repeat(2048));
    const latest: SignedLatest = { version: '9.9.9', digests: { [ARCH]: sha256hex(buf) } };
    expect(decideUpdate(latest, buf, { requireSignature: true }).allow).toBe(false);
  });
});

describe('releaseVerify · ed25519 验签 (注入测试公钥)', () => {
  it('合法签名 + 摘要匹配 → 放行, 校验含 signature', () => {
    const buf = Buffer.from('y'.repeat(4096));
    const digests = { [ARCH]: sha256hex(buf) };
    const latest: SignedLatest = { version: '9.9.9', digests, signature: signLatest('9.9.9', digests) };
    const d = decideUpdate(latest, buf, { requireSignature: true, publicKeyPem: TEST_PUB_PEM });
    expect(d.allow).toBe(true);
    expect(d.reason).toContain('signature');
  });

  it('被篡改的 digests (攻击者改摘要但没私钥) → 签名 bad → 拒', () => {
    const buf = Buffer.from('y'.repeat(4096));
    const goodDigests = { [ARCH]: sha256hex(buf) };
    const sig = signLatest('9.9.9', goodDigests);
    // 攻击者把 digests 换成恶意 tarball 的摘要, 但签名还是旧的 → 对不上
    const evil = Buffer.from('EVIL'.repeat(1024));
    const latest: SignedLatest = { version: '9.9.9', digests: { [ARCH]: sha256hex(evil) }, signature: sig };
    expect(decideUpdate(latest, evil, { publicKeyPem: TEST_PUB_PEM }).allow).toBe(false);
  });

  it('伪造签名 (乱填) → bad → 拒', () => {
    const buf = Buffer.from('y'.repeat(4096));
    const digests = { [ARCH]: sha256hex(buf) };
    const latest: SignedLatest = { version: '9.9.9', digests, signature: Buffer.from('nope').toString('base64') };
    expect(decideUpdate(latest, buf, { publicKeyPem: TEST_PUB_PEM }).allow).toBe(false);
  });

  it('合法签名但 tarball 被换 (摘要不符) → 拒', () => {
    const buf = Buffer.from('y'.repeat(4096));
    const digests = { [ARCH]: sha256hex(buf) };
    const sig = signLatest('9.9.9', digests);
    const evil = Buffer.from('z'.repeat(4096));
    const latest: SignedLatest = { version: '9.9.9', digests, signature: sig };
    // 清单合法但下载到的是别的包 → sha256 mismatch → 拒
    expect(decideUpdate(latest, evil, { publicKeyPem: TEST_PUB_PEM }).allow).toBe(false);
  });
});
