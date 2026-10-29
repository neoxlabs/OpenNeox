import { describe, it, expect } from 'vitest';
import { buildCommandLine } from '../buildCommandLine.js';

describe('buildCommandLine', () => {
  describe('shell', () => {
    it('returns raw command verbatim', () => {
      expect(buildCommandLine({ kind: 'shell', command: 'ls -la' })).toBe('ls -la');
    });
  });

  describe('maven', () => {
    it('builds clean install with goals only', () => {
      expect(buildCommandLine({
        kind: 'maven',
        goals: ['clean', 'install'],
      })).toBe('mvn clean install');
    });

    it('adds -P profiles', () => {
      expect(buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        profiles: ['dev', 'local'],
      })).toBe('mvn spring-boot:run -P dev,local');
    });

    it('adds -D properties', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        properties: { 'spring.profiles.active': 'dev' },
      });
      /* 不含特殊字符 → 不 quote (shell-friendly) */
      expect(out).toBe('mvn -Dspring.profiles.active=dev spring-boot:run');
    });

    it('adds skipTests / offline / pomFile', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['test'],
        offline: true,
        skipTests: true,
        pomFile: 'backend/pom.xml',
      });
      expect(out).toContain('-o');
      expect(out).toContain('-f backend/pom.xml');
      expect(out).toContain('-DskipTests');
      expect(out).toContain('test');
    });

    it('wraps jvmArgs into -Dspring-boot.run.jvmArguments', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        jvmArgs: ['-Xms256m', '-Xmx512m'],
      });
      expect(out).toContain("'-Dspring-boot.run.jvmArguments=-Xms256m -Xmx512m'");
    });

    it('springProfiles → -Dspring-boot.run.profiles=...', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        springProfiles: ['dev'],
      });
      expect(out).toBe('mvn -Dspring-boot.run.profiles=dev spring-boot:run');
    });

    it('多个 springProfiles 逗号连接', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        springProfiles: ['dev', 'local'],
      });
      expect(out).toContain('-Dspring-boot.run.profiles=dev,local');
    });
  });

  describe('npm', () => {
    it('npm run <script> for non-builtin', () => {
      expect(buildCommandLine({
        kind: 'npm',
        script: 'dev',
      })).toBe('npm run dev');
    });

    it('npm <builtin> for builtin (start/test/install)', () => {
      expect(buildCommandLine({ kind: 'npm', script: 'start' })).toBe('npm start');
      expect(buildCommandLine({ kind: 'npm', script: 'test' })).toBe('npm test');
    });

    it('args use -- separator for npm', () => {
      expect(buildCommandLine({
        kind: 'npm',
        script: 'dev',
        args: ['--port', '3000'],
      })).toBe('npm run dev -- --port 3000');
    });

    it('yarn / pnpm 不需要 run 前缀', () => {
      expect(buildCommandLine({
        kind: 'npm',
        packageManager: 'yarn',
        script: 'dev',
      })).toBe('yarn dev');
      expect(buildCommandLine({
        kind: 'npm',
        packageManager: 'pnpm',
        script: 'dev',
      })).toBe('pnpm dev');
    });

    it('inspectPort → NODE_OPTIONS=--inspect-brk=<port> 前缀', () => {
      const out = buildCommandLine({
        kind: 'npm',
        script: 'dev',
        inspectPort: 9229,
      });
      /* NODE_OPTIONS=--inspect-brk=9229 npm run dev */
      expect(out).toBe('NODE_OPTIONS=--inspect-brk=9229 npm run dev');
    });

    it('nodeOptions 合并到同一 NODE_OPTIONS', () => {
      const out = buildCommandLine({
        kind: 'npm',
        script: 'start',
        nodeOptions: '--max-old-space-size=4096',
        inspectPort: 9229,
      });
      expect(out).toBe("'NODE_OPTIONS=--inspect-brk=9229 --max-old-space-size=4096' npm start");
    });

    it('inspectPort=0 / 负数 → 不注入 NODE_OPTIONS', () => {
      expect(buildCommandLine({ kind: 'npm', script: 'dev', inspectPort: 0 })).toBe('npm run dev');
      expect(buildCommandLine({ kind: 'npm', script: 'dev', inspectPort: -1 })).toBe('npm run dev');
    });
  });

  describe('gradle', () => {
    it('default to ./gradlew', () => {
      expect(buildCommandLine({
        kind: 'gradle',
        tasks: ['bootRun'],
      })).toBe('./gradlew bootRun');
    });

    it('useWrapper=false → gradle', () => {
      expect(buildCommandLine({
        kind: 'gradle',
        tasks: ['build'],
        useWrapper: false,
      })).toBe('gradle build');
    });

    it('properties + args', () => {
      const out = buildCommandLine({
        kind: 'gradle',
        tasks: ['bootRun'],
        properties: { env: 'dev' },
        args: ['--debug'],
      });
      expect(out).toContain('-Penv=dev');
      expect(out).toContain('--args');
      expect(out).toContain('--debug');
    });
  });

  describe('docker-compose', () => {
    it('basic up', () => {
      expect(buildCommandLine({ kind: 'docker-compose' })).toBe('docker compose up');
    });

    it('-f + service list + detach', () => {
      expect(buildCommandLine({
        kind: 'docker-compose',
        composeFile: 'deploy/docker-compose.yml',
        services: ['db', 'redis'],
        detach: true,
      })).toBe('docker compose -f deploy/docker-compose.yml up -d db redis');
    });
  });

  describe('python', () => {
    it('-m module', () => {
      expect(buildCommandLine({
        kind: 'python',
        module: 'http.server',
        args: ['8888'],
      })).toBe('python3 -m http.server 8888');
    });

    it('script.py', () => {
      expect(buildCommandLine({
        kind: 'python',
        script: 'app.py',
        args: ['--debug'],
      })).toBe('python3 app.py --debug');
    });

    it('custom interpreter', () => {
      /* 路径含 / 和 . 但都在 shQuote 白名单里, 不需要 quote */
      expect(buildCommandLine({
        kind: 'python',
        module: 'flask',
        interpreter: '/usr/local/bin/python3.11',
      })).toBe('/usr/local/bin/python3.11 -m flask');
    });

    it('interpreter with spaces gets quoted', () => {
      expect(buildCommandLine({
        kind: 'python',
        module: 'flask',
        interpreter: '/Applications/Python 3/python3',
      })).toBe("'/Applications/Python 3/python3' -m flask");
    });
  });

  describe('go', () => {
    it('default target = .', () => {
      expect(buildCommandLine({ kind: 'go' })).toBe('go run .');
    });

    it('explicit target + args', () => {
      expect(buildCommandLine({
        kind: 'go',
        target: './cmd/server',
        args: ['--port', '8080'],
      })).toBe('go run ./cmd/server --port 8080');
    });

    it('tags + ldflags', () => {
      const out = buildCommandLine({
        kind: 'go',
        target: './cmd/api',
        tags: ['integration', 'pg'],
        ldflags: '-X main.version=1.0',
      });
      expect(out).toContain('-tags=integration,pg');
      /* ldflags 含 = 和 . 触发 quoting */
      expect(out).toContain("'-ldflags=-X main.version=1.0'");
      expect(out).toContain('./cmd/api');
    });
  });

  describe('cargo', () => {
    it('default cargo run', () => {
      expect(buildCommandLine({ kind: 'cargo' })).toBe('cargo run');
    });

    it('--bin + --release', () => {
      expect(buildCommandLine({
        kind: 'cargo',
        bin: 'server',
        release: true,
      })).toBe('cargo run --release --bin server');
    });

    it('--features comma-joined', () => {
      const out = buildCommandLine({
        kind: 'cargo',
        features: ['tokio', 'tls'],
      });
      expect(out).toContain('--features tokio,tls');
    });

    it('-- args separator', () => {
      const out = buildCommandLine({
        kind: 'cargo',
        bin: 'cli',
        args: ['--config', 'dev.toml'],
      });
      expect(out).toBe('cargo run --bin cli -- --config dev.toml');
    });

    it('bin / example 互斥, bin 优先', () => {
      const out = buildCommandLine({
        kind: 'cargo',
        bin: 'server',
        example: 'hello',
      });
      expect(out).toContain('--bin server');
      expect(out).not.toContain('--example');
    });
  });

  describe('make', () => {
    it('single target', () => {
      expect(buildCommandLine({ kind: 'make', targets: ['dev'] })).toBe('make dev');
    });

    it('-f Makefile.dev + -j + 变量 + 多 target', () => {
      const out = buildCommandLine({
        kind: 'make',
        targets: ['build', 'test'],
        makefile: 'Makefile.dev',
        jobs: 8,
        variables: { CC: 'clang', DEBUG: '1' },
      });
      expect(out).toContain('-f Makefile.dev');
      expect(out).toContain('-j8');
      expect(out).toContain('CC=clang');
      expect(out).toContain('DEBUG=1');
      /* targets 应在变量之后 (GNU make 习惯) */
      expect(out.indexOf('build')).toBeGreaterThan(out.indexOf('CC=clang'));
    });
  });

  describe('dotnet', () => {
    it('default = dotnet run', () => {
      expect(buildCommandLine({ kind: 'dotnet' })).toBe('dotnet run');
    });

    it('--project + -c Release', () => {
      const out = buildCommandLine({
        kind: 'dotnet',
        project: 'src/Api/Api.csproj',
        configuration: 'Release',
      });
      expect(out).toContain('--project src/Api/Api.csproj');
      expect(out).toContain('-c Release');
    });

    it('watch + --launch-profile', () => {
      const out = buildCommandLine({
        kind: 'dotnet',
        command: 'watch',
        launchProfile: 'Development',
      });
      expect(out).toContain('dotnet watch');
      expect(out).toContain('--launch-profile Development');
    });

    it('-- args separator', () => {
      const out = buildCommandLine({
        kind: 'dotnet',
        args: ['--urls', 'http://localhost:5000'],
      });
      expect(out).toContain('-- --urls');
    });
  });

  describe('bun', () => {
    it('bun run <script>', () => {
      expect(buildCommandLine({ kind: 'bun', script: 'dev' })).toBe('bun run dev');
    });

    it('bun run <entry>', () => {
      expect(buildCommandLine({ kind: 'bun', entry: 'src/index.ts' })).toBe('bun run src/index.ts');
    });

    it('script + args', () => {
      expect(buildCommandLine({
        kind: 'bun',
        script: 'serve',
        args: ['--port', '3000'],
      })).toBe('bun run serve --port 3000');
    });

    it('inspectPort → bun --inspect=<port>', () => {
      expect(buildCommandLine({
        kind: 'bun',
        script: 'dev',
        inspectPort: 9229,
      })).toBe('bun --inspect=9229 run dev');
    });
  });

  describe('deno', () => {
    it('deno task <name>', () => {
      expect(buildCommandLine({ kind: 'deno', task: 'dev' })).toBe('deno task dev');
    });

    it('deno run --allow-net --allow-read entry', () => {
      const out = buildCommandLine({
        kind: 'deno',
        entry: 'main.ts',
        permissions: ['net', 'read'],
      });
      expect(out).toBe('deno run --allow-net --allow-read main.ts');
    });

    it('--allow-all 优先于 permissions', () => {
      const out = buildCommandLine({
        kind: 'deno',
        entry: 'main.ts',
        allowAll: true,
        permissions: ['net'],
      });
      expect(out).toContain('--allow-all');
      expect(out).not.toContain('--allow-net');
    });

    it('task 模式不带权限 flag (task 内部已声明)', () => {
      const out = buildCommandLine({
        kind: 'deno',
        task: 'serve',
        permissions: ['net'],
      });
      expect(out).toBe('deno task serve');
    });
  });

  describe('flutter', () => {
    it('default flutter run', () => {
      expect(buildCommandLine({ kind: 'flutter' })).toBe('flutter run');
    });

    it('-d device + --flavor + dart-define', () => {
      const out = buildCommandLine({
        kind: 'flutter',
        device: 'chrome',
        flavor: 'dev',
        dartDefines: { API_URL: 'https://api.dev', DEBUG: 'true' },
      });
      expect(out).toContain('-d chrome');
      /* --flavor=dev: '=' 不触发 quote (在 shQuote 白名单), 用 = 拼一段 */
      expect(out).toContain('--flavor=dev');
      expect(out).toContain('--dart-define=API_URL=https://api.dev');
      expect(out).toContain('--dart-define=DEBUG=true');
    });

    it('--release 模式', () => {
      const out = buildCommandLine({ kind: 'flutter', mode: 'release' });
      expect(out).toBe('flutter run --release');
    });

    it('debug 不显式加 flag', () => {
      const out = buildCommandLine({ kind: 'flutter', mode: 'debug' });
      expect(out).toBe('flutter run');
    });
  });

  describe('shell quoting', () => {
    it('values with spaces get single-quoted', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['spring-boot:run'],
        properties: { 'app.name': 'my service' },
      });
      expect(out).toContain("'-Dapp.name=my service'");
    });

    it('values with single quotes get safely escaped', () => {
      const out = buildCommandLine({
        kind: 'maven',
        goals: ['run'],
        properties: { msg: "it's working" },
      });
      /* 'it\'s working' → 'it'\''s working' */
      expect(out).toContain(`'-Dmsg=it'\\''s working'`);
    });
  });
});
