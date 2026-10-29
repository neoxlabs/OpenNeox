import { describe, it, expect } from 'vitest';
import { isLikelyLongRunningCommand } from '@neoxlabs/platform/platform/portProbe.js';
import { isService } from '../../runtime/services/serviceSnapshot.js';

describe('isLikelyLongRunningCommand — build/install blacklist', () => {
  it.each([
    'vite build',
    'next build',
    'npm run build',
    'pnpm run typecheck',
    'yarn run lint',
    'npm install -g @openai/codex@latest',
    'pnpm add lodash',
    'mvn clean package -DskipTests',
    'mvn compile',
    './gradlew build',
    'gradle assemble test',
    'tsc -p tsconfig.json',
    'webpack --mode production',
    'docker build -t app .',
    'docker compose build',
    'go build ./...',
    'cargo build --release',
    'pip install requests',
    'brew install jq',
  ])('one-shot: %s → false', (cmd) => {
    expect(isLikelyLongRunningCommand(cmd)).toBe(false);
  });

  it.each([
    'npm run dev',
    'pnpm dev',
    'vite',
    'vite --port 3000',
    'next dev',
    'mvn spring-boot:run',
    /* 混合命令: 先编译再起服务 — 显式服务标记让黑名单让位 */
    'mvn clean package spring-boot:run',
    './gradlew bootRun',
    'tsc --watch',
    'webpack serve',
    'docker compose up',
    'python -m http.server 8000',
    'node server.js',
    'nodemon app.js',
  ])('service: %s → true', (cmd) => {
    expect(isLikelyLongRunningCommand(cmd)).toBe(true);
  });

  const fact = (over: Partial<Parameters<typeof isService>[0]>) => ({
    pid: 1, id: '1', command: 'x', friendly_name: 'x', name: 'x',
    cwd: '/w', workspaceRoot: '/w',
    origin: 'spawned' as const, kind: 'background-task' as const,
    startTime: 1_000_000, status: 'running' as const, background: true, ...over,
  });
  const NOW = 1_000_000;

  it('isService: 没配置没转正 → 不算服务', () => {
    expect(isService(fact({}))).toBe(false);
  });

  it('isService: 只是占了端口 → **不算**常驻服务 (改由 UI 提示用户转正)', () => {
    expect(isService(fact({ port: 8080 }))).toBe(false);
  });

  it('isService: 用户显式转正 → 算服务', () => {
    expect(isService(fact({ persistent: true }))).toBe(true);
  });

  it('isService: 绑了 RunConfig 立刻算服务', () => {
    expect(isService(fact({ config_id: 'cfg-1' }))).toBe(true);
  });

  it('isService: 活得再久也不算 —— 这正是构建被焊成服务的老路', () => {
    const nodeEval = fact({ command: `node -e "import('./src/server.js')"`, endTime: NOW + 3_600_000 });
    expect(isService(nodeEval)).toBe(false);
  });

  it('isService: 派给外部 agent 的一次性委派不是服务 (跑十几分钟很正常)', () => {
    expect(isService(fact({ kind: 'agent-task', persistent: true }))).toBe(false);
  });

  it('isService: free-shell 永远不是服务', () => {
    expect(isService(fact({ kind: 'free-shell', port: 8080, persistent: true }))).toBe(false);
  });
});
