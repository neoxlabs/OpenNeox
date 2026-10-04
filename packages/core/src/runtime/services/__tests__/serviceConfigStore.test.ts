/**
 * findByCommandCwd 测试 — 重点是 fuzzy match: agent 凭语言模型现凑的命令要能识别成
 * 已有 RunConfig, 不被错判成 ad-hoc.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ServiceConfigStore,
  extractCommandSignature,
  signatureSuperset,
} from '../serviceConfigStore.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-cfg-store-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('extractCommandSignature', () => {
  it('maven: goals + springProfiles + maven profiles', () => {
    const sig = extractCommandSignature(
      'mvn -DskipTests -Dspring-boot.run.profiles=dev,test spring-boot:run -P backend',
    );
    expect(sig.tool).toBe('maven');
    if (sig.tool !== 'maven') throw new Error('wrong tool');
    expect([...sig.goals]).toEqual(['spring-boot:run']);
    expect([...sig.profiles]).toEqual(['backend']);
    expect([...sig.springProfiles].sort()).toEqual(['dev', 'test']);
  });

  it('maven 含 jvmArguments / logging.file.name 仍被忽略 (非身份标识)', () => {
    const sig = extractCommandSignature(
      'mvn spring-boot:run -Dspring-boot.run.profiles=dev -Dspring-boot.run.jvmArguments="-Xms256m -Xmx512m" -Dlogging.file.name=/x/y.log -Dspring.cloud.nacos.discovery.fail-fast=false',
    );
    if (sig.tool !== 'maven') throw new Error('wrong tool');
    expect([...sig.goals]).toEqual(['spring-boot:run']);
    expect([...sig.springProfiles]).toEqual(['dev']);
    /* maven profile -P 没出现 → 空 set */
    expect(sig.profiles.size).toBe(0);
  });

  it('mvnw / ./mvnw 也算 maven 工具', () => {
    expect(extractCommandSignature('./mvnw clean install').tool).toBe('maven');
    expect(extractCommandSignature('mvnw spring-boot:run').tool).toBe('maven');
  });

  it('gradle / gradlew tasks', () => {
    const sig = extractCommandSignature('./gradlew clean bootRun');
    if (sig.tool !== 'gradle') throw new Error('wrong tool');
    expect([...sig.tasks].sort()).toEqual(['bootRun', 'clean']);
  });

  it('npm run / yarn / pnpm', () => {
    expect(extractCommandSignature('npm run dev')).toMatchObject({ tool: 'npm', script: 'dev' });
    expect(extractCommandSignature('yarn dev')).toMatchObject({ tool: 'yarn', script: 'dev' });
    expect(extractCommandSignature('pnpm dev')).toMatchObject({ tool: 'pnpm', script: 'dev' });
    /* npm <builtin> 也算同 script */
    expect(extractCommandSignature('npm start')).toMatchObject({ tool: 'npm', script: 'start' });
  });

  it('docker compose up 后的 service 列表', () => {
    const sig = extractCommandSignature('docker compose -f deploy/docker-compose.yml up -d db redis');
    if (sig.tool !== 'docker-compose') throw new Error('wrong tool');
    expect([...sig.services].sort()).toEqual(['db', 'redis']);
  });

  it('cd /xxx && cmd 自动剥前缀', () => {
    const sig = extractCommandSignature('cd /Users/foo/proj && mvn spring-boot:run -Dspring-boot.run.profiles=dev');
    if (sig.tool !== 'maven') throw new Error('wrong tool');
    expect([...sig.goals]).toEqual(['spring-boot:run']);
    expect([...sig.springProfiles]).toEqual(['dev']);
  });

  it('env prefix (KEY=val ...) 自动剥', () => {
    const sig = extractCommandSignature('PORT=3000 NODE_ENV=dev npm run dev');
    expect(sig).toMatchObject({ tool: 'npm', script: 'dev' });
  });

  it('未知工具返 unknown', () => {
    expect(extractCommandSignature('./bin/server --port 8080').tool).toBe('unknown');
    expect(extractCommandSignature('python3 -m flask run').tool).toBe('unknown');
  });
});

describe('signatureSuperset', () => {
  it('maven: 进程 spring profiles ⊇ config spring profiles → 匹配', () => {
    const proc = extractCommandSignature('mvn spring-boot:run -Dspring-boot.run.profiles=dev,test');
    const cfg = extractCommandSignature('mvn -DskipTests -Dspring-boot.run.profiles=dev spring-boot:run');
    expect(signatureSuperset(proc, cfg)).toBe(true);
  });

  it('maven: 进程缺少 config 的 springProfile → 不匹配', () => {
    const proc = extractCommandSignature('mvn spring-boot:run');
    const cfg = extractCommandSignature('mvn -Dspring-boot.run.profiles=dev spring-boot:run');
    expect(signatureSuperset(proc, cfg)).toBe(false);
  });

  it('npm 不同 script → 不匹配 (避免 npm install 误绑 npm run dev)', () => {
    const proc = extractCommandSignature('npm install');
    const cfg = extractCommandSignature('npm run dev');
    expect(signatureSuperset(proc, cfg)).toBe(false);
  });

  it('npm 跨包管理器 (yarn vs npm) → 不匹配', () => {
    expect(
      signatureSuperset(
        extractCommandSignature('yarn dev'),
        extractCommandSignature('npm run dev'),
      ),
    ).toBe(false);
  });
});

describe('findByCommandCwd (fuzzy)', () => {
  it('严格匹配优先', () => {
    const store = new ServiceConfigStore(tmpDir);
    store.upsert({
      id: 'a',
      name: 'A',
      command: 'mvn spring-boot:run',
      cwd: '.',
      createdBy: 'user',
    });
    const m = store.findByCommandCwd('mvn spring-boot:run', tmpDir);
    expect(m?.id).toBe('a');
  });

  it('fuzzy: agent 凑出比 config 多 -D 的命令 → 同 cwd 仍匹配 (本次 bug 主线场景)', () => {
    const store = new ServiceConfigStore(tmpDir);
    store.upsert({
      id: 'gateway-dev',
      name: 'kyx-service-gateway (dev)',
      spec: {
        kind: 'maven',
        goals: ['spring-boot:run'],
        skipTests: true,
        springProfiles: ['dev'],
      },
      cwd: 'backend/kyx-service-gateway',
      createdBy: 'user',
    });
    /* mkdir for cwd resolution */
    fs.mkdirSync(path.join(tmpDir, 'backend/kyx-service-gateway'), { recursive: true });

    /* agent 实际跑的命令 — 比 config 多了 jvmArguments / logging / nacos */
    const agentCmd =
      'mvn spring-boot:run -Dspring-boot.run.profiles=dev -Dspring-boot.run.jvmArguments="-Xms256m -Xmx512m -Dlogging.file.name=/x/gateway.log" -Dspring.cloud.nacos.discovery.fail-fast=false';
    const cwdAbs = path.join(tmpDir, 'backend/kyx-service-gateway');
    const m = store.findByCommandCwd(agentCmd, cwdAbs);
    expect(m?.id).toBe('gateway-dev');
  });

  it('fuzzy: 同 cwd 但 spring profile 不一致 → 不匹配 (dev config 不能被 prod 进程认领)', () => {
    const store = new ServiceConfigStore(tmpDir);
    store.upsert({
      id: 'gateway-dev',
      name: 'gateway dev',
      spec: { kind: 'maven', goals: ['spring-boot:run'], springProfiles: ['dev'] },
      cwd: '.',
      createdBy: 'user',
    });
    const m = store.findByCommandCwd(
      'mvn spring-boot:run -Dspring-boot.run.profiles=prod',
      tmpDir,
    );
    expect(m).toBeUndefined();
  });

  it('fuzzy: cwd 不同 → 不匹配', () => {
    const store = new ServiceConfigStore(tmpDir);
    store.upsert({
      id: 'a',
      name: 'A',
      spec: { kind: 'maven', goals: ['spring-boot:run'] },
      cwd: 'backend',
      createdBy: 'user',
    });
    fs.mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'frontend'), { recursive: true });
    const m = store.findByCommandCwd(
      'mvn spring-boot:run',
      path.join(tmpDir, 'frontend'),
    );
    expect(m).toBeUndefined();
  });

  it('fuzzy: npm — 同 script 匹配, 不同 script 不匹配', () => {
    const store = new ServiceConfigStore(tmpDir);
    store.upsert({
      id: 'fe-dev',
      name: 'frontend dev',
      spec: { kind: 'npm', script: 'dev' },
      cwd: '.',
      createdBy: 'user',
    });
    expect(store.findByCommandCwd('PORT=3000 npm run dev', tmpDir)?.id).toBe('fe-dev');
    expect(store.findByCommandCwd('npm run build', tmpDir)).toBeUndefined();
  });

  it('严格匹配: spawnCwd 是 config.cwd 子目录 (serviceLauncher 走的路径)', () => {
    /* 复现 serviceLauncher 调 runBackgroundShellCommand 的真实场景:
     *   · store 根 = workspaceRoot
     *   · 启动时 spawnCwd = path.resolve(workspaceRoot, config.cwd) (绝对路径)
     *   · 调 store.findByCommandCwd(command, spawnCwd) 必须命中那个 config
     *
     *   之前 bug: serviceLauncher 把 spawnCwd 同时传成 store 根, store 在子目录找
     *   .neox/run-configs.json 找不到 → list 空 → 永不匹配 → 进程留 ad-hoc. */
    const store = new ServiceConfigStore(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'backend/gateway'), { recursive: true });
    store.upsert({
      id: 'gw-dev',
      name: 'gateway dev',
      spec: { kind: 'maven', goals: ['spring-boot:run'], skipTests: true, springProfiles: ['dev'] },
      cwd: 'backend/gateway',
      createdBy: 'user',
    });
    /* serviceLauncher 拼出来的 fullCommand 跟 store 里 config.command 完全一致 (没 env prefix) */
    const cfg = store.get('gw-dev')!;
    const spawnCwd = path.resolve(tmpDir, cfg.cwd);
    const matched = store.findByCommandCwd(cfg.command, spawnCwd);
    expect(matched?.id).toBe('gw-dev');
  });
});
