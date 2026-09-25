import { defineConfig, configDefaults } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * 让 vitest 在仓内开发时直接走原 .ts 源,不依赖 packages/{core,sdk}/dist 是否构建.
 * 发布到 npm 后消费者拿到的是 dist/ 编译产物,这套 alias 只对 vitest 生效.
 *
 * 顺序敏感:精确匹配 (`@neoxlabs/core` 整体) 必须排在通配前.
 */
const workspaceAliases = [
  {
    find: /^@neoxlabs\/core$/,
    replacement: resolve(repoRoot, 'packages/core/src/sdk/index.ts'),
  },
  {
    find: /^@neoxlabs\/core\/(.*)\.js$/,
    replacement: resolve(repoRoot, 'packages/core/src/$1.ts'),
  },
  {
    find: /^@neoxlabs\/sdk$/,
    replacement: resolve(repoRoot, 'packages/sdk/src/index.ts'),
  },
  {
    find: /^@neoxlabs\/sdk\/(.*)\.js$/,
    replacement: resolve(repoRoot, 'packages/sdk/src/$1.ts'),
  },
  {
    find: /^@neoxlabs\/sandbox$/,
    replacement: resolve(repoRoot, 'packages/sandbox/src/index.ts'),
  },
  {
    find: /^@neoxlabs\/sandbox\/(.*)\.js$/,
    replacement: resolve(repoRoot, 'packages/sandbox/src/$1.ts'),
  },
];

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    /* 宿主收进 apps/ 之后, 测试同样长在 apps/cli 与 apps/desktop 下 —— 只列 packages/*
     * 会让这两个最大的消费者整体不被跑到 (全量绿但少了几百条, 是最容易漏的那种缺口)。 */
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
    ],
    exclude: [
      ...configDefaults.exclude,
      'packages/evals/src/release-suite/cli-tests/**',
    ],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});
