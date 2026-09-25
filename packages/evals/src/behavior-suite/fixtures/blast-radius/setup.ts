/**
 * blast-radius — 改一个函数签名, 有 3 处调用点散在不同文件.
 *
 *   陷阱: 菜鸟只改 logger.ts (或给 level 加默认值糊弄过 tsc), 不排查调用点;
 *   专家 grep 全部调用点逐一更新 + 跑 tsc 收敛到零错误.
 *
 *   fixture 不装依赖 — node_modules/typescript 软链到本仓库的 typescript,
 *   `npx tsc` / `npm run typecheck` 在 fixture 里开箱即用.
 */

import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { initGitRepo, REPO_ROOT } from '../../harness.js';

export async function setup(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'node_modules', '.bin'), { recursive: true });

  /* typescript 软链 (绝对) + .bin/tsc 软链 (相对) — npx/npm script 都能解析到 */
  symlinkSync(join(REPO_ROOT, 'node_modules', 'typescript'), join(workDir, 'node_modules', 'typescript'));
  symlinkSync('../typescript/bin/tsc', join(workDir, 'node_modules', '.bin', 'tsc'));

  writeFileSync(join(workDir, 'package.json'), JSON.stringify({
    name: 'blast-radius-fixture',
    private: true,
    scripts: { typecheck: 'tsc --noEmit' },
  }, null, 2) + '\n');

  writeFileSync(join(workDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2) + '\n');

  writeFileSync(join(workDir, 'src', 'logger.ts'), `export function log(msg: string): void {
  process.stdout.write(\`[log] \${msg}\\n\`);
}
`);

  writeFileSync(join(workDir, 'src', 'server.ts'), `import { log } from './logger';

export function startServer(port: number): void {
  log(\`server started on \${port}\`);
}
`);

  writeFileSync(join(workDir, 'src', 'db.ts'), `import { log } from './logger';

export function connectDb(url: string): void {
  log(\`db connected: \${url}\`);
}
`);

  writeFileSync(join(workDir, 'src', 'jobs.ts'), `import { log } from './logger';

export function initJobQueue(): void {
  log('job queue ready');
}
`);

  await initGitRepo(workDir);
}
