/**
 * 发布脚本里"产物名 → 下载地址"的映射规则。
 *
 * 这套规则只有在真发版时才会被执行一次, 错了的后果是用户点更新下到错架构的包,
 * 而那时候已经来不及了 —— 所以在这里把每一种产物名钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestKeyFor, buildManifest } from '../publish-github-release.mjs';

test('按架构和形态认领产物', () => {
  assert.equal(manifestKeyFor('Neox-3.8.6-arm64.dmg'), 'macArm');
  assert.equal(manifestKeyFor('Neox-3.8.6.dmg'), 'macIntel');
  assert.equal(manifestKeyFor('Neox-3.8.6-x64.dmg'), 'macIntel');
  assert.equal(manifestKeyFor('Neox Setup 3.8.6.exe'), 'winX64');
  assert.equal(manifestKeyFor('Neox Setup 3.8.6-arm64.exe'), 'winArm64');
  assert.equal(manifestKeyFor('Neox-3.8.6-portable.exe'), 'winPortable');
});

test('zip 和 feed 不进 latest.json —— 它们给 electron-updater 用, 不是给人点的', () => {
  assert.equal(manifestKeyFor('Neox-3.8.6-arm64-mac.zip'), null);
  assert.equal(manifestKeyFor('latest-mac.yml'), null);
});

test('manifest 里每个平台键只取第一个命中, 且地址都在 latest/download 下', () => {
  const base = 'https://github.com/neoxlabs/OpenNeox/releases/latest/download';
  const m = buildManifest('3.8.6', [
    'Neox-3.8.6-arm64.dmg',
    'Neox-3.8.6-x64.dmg',
    'Neox Setup 3.8.6.exe',
    'latest-mac.yml',
  ], base, 'notes');
  assert.equal(m.version, '3.8.6');
  assert.equal(m.macVersion, '3.8.6');
  assert.equal(m.winVersion, '3.8.6');
  assert.equal(m.macArm, `${base}/Neox-3.8.6-arm64.dmg`);
  assert.equal(m.macIntel, `${base}/Neox-3.8.6-x64.dmg`);
  assert.equal(m.winX64, `${base}/Neox%20Setup%203.8.6.exe`);
  assert.ok(!('winArm64' in m), '没发的产物不该出现在 manifest 里');
  for (const k of ['macArm', 'macIntel', 'winX64']) {
    assert.ok(m[k].startsWith(`${base}/`), `${k} 必须挂在 latest/download 下`);
  }
});
