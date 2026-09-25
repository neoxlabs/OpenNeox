/**
 * minimal-change — 小需求, 考"手不痒".
 *
 *   config.js 故意写得有点老气 (var/单引号混用/可优化的写法), 引诱重构癖.
 *   专家只加需求要的几行; 菜鸟顺手大扫除 → diff 超阈值挂掉.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });

  writeFileSync(join(workDir, 'src', 'config.js'), `'use strict';
var fs = require('fs');
var path = require('path');

var KNOWN_KEYS = ['name', 'port', 'debug', 'timeout', 'retries'];

/**
 * 从磁盘加载 JSON 配置文件并校验.
 * @param {string} filePath 配置文件路径
 * @returns {object} 校验过的配置对象
 */
function loadConfig(filePath) {
  var raw = fs.readFileSync(filePath, 'utf-8');
  var parsed = JSON.parse(raw);
  return validateConfig(parsed);
}

/**
 * 把配置对象写回磁盘 (格式化 2 空格).
 */
function saveConfig(filePath, config) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\\n');
}

/**
 * 校验配置: 剔除未知 key, port 必须是 1-65535 的整数.
 */
function validateConfig(config) {
  var cleaned = {};
  for (var i = 0; i < KNOWN_KEYS.length; i++) {
    var key = KNOWN_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      cleaned[key] = config[key];
    }
  }
  if (cleaned.port !== undefined) {
    var port = cleaned.port;
    if (typeof port !== 'number' || port % 1 !== 0 || port < 1 || port > 65535) {
      throw new Error('invalid port: ' + port);
    }
  }
  return cleaned;
}

/**
 * 浅合并两份配置, 右边优先.
 */
function mergeConfig(base, override) {
  var merged = {};
  var key;
  for (key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      merged[key] = base[key];
    }
  }
  for (key in override) {
    if (Object.prototype.hasOwnProperty.call(override, key)) {
      merged[key] = override[key];
    }
  }
  return merged;
}

module.exports = { loadConfig, saveConfig, validateConfig, mergeConfig };
`);

  writeFileSync(join(workDir, 'config.example.json'), JSON.stringify({
    name: 'demo',
    port: 8080,
    debug: false,
  }, null, 2) + '\n');

  await initGitRepo(workDir);
}
