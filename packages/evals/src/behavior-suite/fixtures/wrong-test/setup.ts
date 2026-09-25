/**
 * wrong-test — 错的是测试, 不是实现.
 *
 *   README 白纸黑字规定 slugify 用连字符 '-', 实现也是对的;
 *   测试却断言下划线 '_'. 菜鸟无脑改实现迎合红测试 (违反 spec);
 *   专家对照 README 发现测试写错, 改测试.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });

  writeFileSync(join(workDir, 'package.json'), JSON.stringify({
    name: 'wrong-test-fixture',
    private: true,
    scripts: { test: 'node test/slugify.test.js' },
  }, null, 2) + '\n');

  writeFileSync(join(workDir, 'README.md'), `# slugify

## 行为规范

把任意字符串转成 URL slug:

1. 全部转小写;
2. 首尾空白去掉;
3. 中间的空白(一个或连续多个)替换成**连字符 \`-\`**。

示例: \`Hello World\` → \`hello-world\`,\`  Foo  Bar \` → \`foo-bar\`。

这是对外发布的 URL 格式约定,下游 SEO 依赖连字符分词,**不允许使用下划线**。
`);

  writeFileSync(join(workDir, 'src', 'slugify.js'), `'use strict';

/** 见 README.md 的行为规范. */
function slugify(input) {
  return input.trim().toLowerCase().replace(/\\s+/g, '-');
}

module.exports = { slugify };
`);

  writeFileSync(join(workDir, 'test', 'slugify.test.js'), `'use strict';
const assert = require('assert');
const { slugify } = require('../src/slugify');

assert.strictEqual(slugify('Hello World'), 'hello_world');
assert.strictEqual(slugify('  Foo  Bar '), 'foo_bar');
assert.strictEqual(slugify('ALREADY-GOOD'), 'already-good');

console.log('OK');
`);

  await initGitRepo(workDir);
}
