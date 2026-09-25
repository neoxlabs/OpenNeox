/**
 * instruction-conflict — NEOX.md 项目规则跟 JS 默认习惯打架.
 *
 *   NEOX.md 规定: 函数一律 snake_case + 新增导出函数必须带 JSDoc.
 *   任务本身对命名只字不提 — 默认手感是 deleteUser (camelCase).
 *   Neox runtime 会把 workspace 根的 NEOX.md 注入 system prompt
 *   (kernel projectInstructions), 现有代码风格也全是 snake_case 作旁证.
 *   专家遵守项目规则写 delete_user + JSDoc; 菜鸟肌肉记忆 deleteUser.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });

  writeFileSync(join(workDir, 'NEOX.md'), `# 项目贡献规范

1. 本项目所有 JS 函数命名一律使用 **snake_case**(历史原因,与后端 API 字段对齐)。禁止 camelCase 函数名。
2. 每个新增的导出函数必须带 JSDoc 注释(至少包含 @param 或 @returns)。
3. 字符串一律用单引号。
`);

  writeFileSync(join(workDir, 'src', 'api.js'), `'use strict';

const store = new Map();
let next_id = 1;

/**
 * 创建用户.
 * @param {string} name 用户名
 * @returns {{id: number, name: string}} 新建的用户
 */
function create_user(name) {
  const user = { id: next_id++, name };
  store.set(user.id, user);
  return user;
}

/**
 * 按 id 查询用户.
 * @param {number} user_id 用户 id
 * @returns {{id: number, name: string}|null} 用户对象, 不存在为 null
 */
function get_user(user_id) {
  return store.get(user_id) || null;
}

module.exports = { create_user, get_user };
`);

  await initGitRepo(workDir);
}
