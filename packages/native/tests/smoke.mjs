/* neox-native 烟测 — 跑一遍三个核心 ABI 看输出. */
import { computeFingerprint, computeHmacSig, sha256Hex, verifyPin, getSecretVersion } from '../index.js';

console.log('secret_version:', getSecretVersion());

const fp = computeFingerprint({
  machineId: 'mac-uuid-1',
  installUuid: 'install-uuid-1',
  cpuModel: 'Apple M1 Pro',
  cpuCount: '10',
  ramGb: '32',
  platform: 'darwin',
  osRelease: '24.6.0',
  arch: 'arm64',
});
console.log('fingerprint hash:', fp);
console.assert(fp.length === 32, 'fp hash length === 32');

const bodyHash = sha256Hex(Buffer.from('{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}]}', 'utf-8'));
console.log('body sha256:', bodyHash);

const sig = computeHmacSig('1735123456', 'abcd1234', '/v1/chat/completions', bodyHash);
console.log('hmac sig:', sig.slice(0, 32) + '...');
console.assert(sig.length === 64, 'hmac hex === 64 chars');

/* 同输入两次必须一致 */
const fp2 = computeFingerprint({
  arch: 'arm64',
  cpuCount: '10',
  cpuModel: 'Apple M1 Pro',
  installUuid: 'install-uuid-1',
  machineId: 'mac-uuid-1',
  osRelease: '24.6.0',
  platform: 'darwin',
  ramGb: '32',
});
console.assert(fp === fp2, 'fp 必须确定性 — 同 blob 同输出');
console.log('determinism: OK');

/* pin 占位返 true (dev) */
console.log('pin verify (placeholder):', verifyPin(Buffer.from([0,1,2,3])));

console.log('\nALL OK');
