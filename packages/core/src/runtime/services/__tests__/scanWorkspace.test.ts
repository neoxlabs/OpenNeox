import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanWorkspace } from '../scanWorkspace.js';

let tmpDir: string;

function write(rel: string, content: string) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-workspace-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('scanWorkspace', () => {
  it('empty workspace returns no candidates', () => {
    expect(scanWorkspace(tmpDir)).toEqual([]);
  });

  it('只生成 launch 类 npm scripts (dev/start/serve), 排除 test/build/lint', () => {
    write('package.json', JSON.stringify({
      name: 'demo',
      scripts: { dev: 'vite', test: 'jest', build: 'tsc', lint: 'eslint', start: 'node server.js' },
    }));
    const out = scanWorkspace(tmpDir);
    /* 启动类: 进列表 */
    expect(out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'dev')).toBeDefined();
    expect(out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'start')).toBeDefined();
    /* 临时类: 不进列表 (build/test/lint 走"+新建"手动加) */
    expect(out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'test')).toBeUndefined();
    expect(out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'build')).toBeUndefined();
    expect(out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'lint')).toBeUndefined();
  });

  it('detects pnpm package manager via pnpm-lock.yaml', () => {
    write('package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    write('pnpm-lock.yaml', '# lockfile');
    const out = scanWorkspace(tmpDir);
    const dev = out.find(c => c.spec.kind === 'npm' && (c.spec as any).script === 'dev');
    expect(dev).toBeDefined();
    expect((dev!.spec as any).packageManager).toBe('pnpm');
  });

  it('npm 启动类全部标 long-lived (临时类已经被排除, 不在列表里)', () => {
    write('package.json', JSON.stringify({
      scripts: { dev: 'vite', start: 'node server.js', test: 'jest', build: 'tsc' },
    }));
    const out = scanWorkspace(tmpDir);
    const dev = out.find(c => (c.spec as any).script === 'dev');
    const start = out.find(c => (c.spec as any).script === 'start');
    expect(dev?.longLived).toBe(true);
    expect(start?.longLived).toBe(true);
  });

  it('npm: 同 package.json 多 script 共享 moduleKey, suggestedName 是工程名, profile=script', () => {
    write('frontend/package.json', JSON.stringify({
      name: 'frontend',
      scripts: {
        dev: 'vite',
        'dev:antd': 'vite --mode antd',
        'dev:docs': 'vite --mode docs',
        preview: 'vite preview',
        build: 'vite build',
        'build:analyze': 'vite build --mode analyze',
        test: 'jest',
        lint: 'eslint .',
      },
    }));
    const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'npm');
    /* dev/dev:antd/dev:docs/preview 4 个 launch 类进列表; build/build:analyze/test/lint 全排除 */
    expect(out.map(c => (c.spec as any).script).sort()).toEqual(
      ['dev', 'dev:antd', 'dev:docs', 'preview']
    );
    /* 全部共享同一 moduleKey, UI 按它聚合成一行 */
    const keys = new Set(out.map(c => c.moduleKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('npm:frontend');
    /* suggestedName 是工程目录名, 不含 script 后缀 — 跟 maven 一样 */
    expect(out.every(c => c.suggestedName === 'frontend')).toBe(true);
    /* profile 字段 = script 名 (UI chip 渲染用, 复用 maven 的 profile chip) */
    expect(out.map(c => c.profile).sort()).toEqual(['dev', 'dev:antd', 'dev:docs', 'preview']);
  });

  it('npm: build 类 name 永远不进列表, 即使 body 含 vite 关键词', () => {
    /* 关键 regression: `"build": "vite build"` 之前被 vite\s 误匹配 → 出现在列表里.
     * 现在 NPM_NEVER_LAUNCH_NAMES 黑名单优先, body 再像启动也无效. */
    write('package.json', JSON.stringify({
      scripts: {
        build: 'vite build',
        'build:analyze': 'vite build --mode analyze',
        typecheck: 'tsc --noEmit',
        clean: 'rm -rf dist',
        deploy: 'npm run build && rsync ...',
      },
    }));
    const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'npm');
    expect(out).toEqual([]);
  });

  it('npm: 多个 package.json 各自一个 moduleKey, 不互相串', () => {
    write('frontend/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    write('backend/package.json', JSON.stringify({ scripts: { dev: 'nodemon' } }));
    const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'npm');
    const keys = new Set(out.map(c => c.moduleKey));
    expect(keys.size).toBe(2);
    expect(keys.has('npm:frontend')).toBe(true);
    expect(keys.has('npm:backend')).toBe(true);
  });


  it('Maven Spring Boot: pom 激活 plugin + 有 @SpringBootApplication → 生成启动候选', () => {
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>my-service</artifactId>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`);
    write('src/main/java/com/example/Application.java', `
package com.example;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
  public static void main(String[] args) {
    SpringApplication.run(Application.class, args);
  }
}
`);
    const out = scanWorkspace(tmpDir);
    const cand = out.find(c => c.spec.kind === 'maven');
    expect(cand).toBeDefined();
    expect(cand!.suggestedName).toBe('my-service');
    expect(cand!.longLived).toBe(true);
  });

  it('Maven: 激活了 plugin 但没 @SpringBootApplication → 不算启动类 (lib 模块)', () => {
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <artifactId>shared-lib</artifactId>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`);
    /* 只有普通 lib 类, 没 main class */
    write('src/main/java/com/example/SomeService.java', `
package com.example;
public class SomeService { }
`);
    const out = scanWorkspace(tmpDir);
    expect(out.filter(c => c.spec.kind === 'maven')).toHaveLength(0);
  });

  it('Maven: spring-boot-maven-plugin 仅在 pluginManagement 里声明 → 不算启动 (没真激活)', () => {
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <artifactId>module-with-plugin-management</artifactId>
  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-maven-plugin</artifactId>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>
</project>`);
    write('src/main/java/com/example/Application.java', `
@SpringBootApplication
public class Application { }
`);
    const out = scanWorkspace(tmpDir);
    expect(out.filter(c => c.spec.kind === 'maven')).toHaveLength(0);
  });

  it('Spring Boot 模块: 扫到 application-dev/prod/test → 同 moduleKey 多 profile candidate', () => {
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <artifactId>gateway-service</artifactId>
  <build><plugins><plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
  </plugin></plugins></build>
</project>`);
    write('src/main/java/com/example/Application.java', '@SpringBootApplication\npublic class Application { }');
    write('src/main/resources/application.yml', 'spring:');
    write('src/main/resources/application-dev.yml', 'env: dev');
    write('src/main/resources/application-prod.yml', 'env: prod');
    write('src/main/resources/application-test.properties', 'env=test');

    const out = scanWorkspace(tmpDir);
    const mvnCands = out.filter(c => c.spec.kind === 'maven');
    expect(mvnCands).toHaveLength(3);
    /* 关键: 所有 candidate 共享同一 moduleKey, UI 据此聚合一行 */
    const keys = new Set(mvnCands.map(c => c.moduleKey));
    expect(keys.size).toBe(1);
    /* suggestedName 不再带 profile 后缀, profile 是独立字段 (UI 渲染 chip 用) */
    expect(mvnCands.every(c => c.suggestedName === 'gateway-service')).toBe(true);
    /* dev 优先排序 */
    expect(mvnCands[0].profile).toBe('dev');
    expect((mvnCands[0].spec as any).springProfiles).toEqual(['dev']);
    /* 其它 profile 都齐 */
    expect(mvnCands.map(c => c.profile).sort()).toEqual(['dev', 'prod', 'test']);
  });

  it('Spring Boot 模块: 没 application-*.yml 时回退到无 profile 单候选', () => {
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <artifactId>solo-app</artifactId>
  <build><plugins><plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
  </plugin></plugins></build>
</project>`);
    write('src/main/java/com/example/Application.java', '@SpringBootApplication\npublic class Application { }');
    write('src/main/resources/application.yml', 'spring:');

    const out = scanWorkspace(tmpDir);
    const mvnCands = out.filter(c => c.spec.kind === 'maven');
    expect(mvnCands).toHaveLength(1);
    expect(mvnCands[0].suggestedName).toBe('solo-app');
    expect((mvnCands[0].spec as any).springProfiles).toBeUndefined();
  });

  it('Maven multi-module: 只有真启动模块入列表, 没 main class 的子模块全部跳过', () => {
    /* 真实场景: parent + 一堆 lib 子模块 + 1-2 个 starter 应用. 之前 33 个 pom 都被识别成
     * "Spring Boot: kyx-foundation" 是因为 (a) parent.artifactId 误抓 (b) plugin 字符串
     * 匹配不严. 新判定下只有有 @SpringBootApplication 的子模块进列表. */
    write('pom.xml', `<?xml version="1.0"?>
<project>
  <artifactId>kyx-foundation</artifactId>
  <packaging>pom</packaging>
  <modules>
    <module>backend/kyx-service-gateway</module>
    <module>backend/kyx-service-common</module>
  </modules>
  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-maven-plugin</artifactId>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>
</project>`);
    /* gateway: 启动模块 — 激活 plugin + 有 main class */
    write('backend/kyx-service-gateway/pom.xml', `<?xml version="1.0"?>
<project>
  <parent>
    <artifactId>kyx-foundation</artifactId>
  </parent>
  <artifactId>kyx-service-gateway</artifactId>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`);
    write('backend/kyx-service-gateway/src/main/java/com/kyx/GatewayApplication.java', `
@SpringBootApplication
public class GatewayApplication { }
`);
    /* common: lib 模块 — 仅继承 pluginManagement, 没激活, 没 main class */
    write('backend/kyx-service-common/pom.xml', `<?xml version="1.0"?>
<project>
  <parent>
    <artifactId>kyx-foundation</artifactId>
  </parent>
  <artifactId>kyx-service-common</artifactId>
</project>`);
    write('backend/kyx-service-common/src/main/java/com/kyx/Util.java', `
public class Util { }
`);

    const out = scanWorkspace(tmpDir);
    const mvnCands = out.filter(c => c.spec.kind === 'maven');

    /* parent / common 都不应出现, 只剩 gateway */
    expect(mvnCands).toHaveLength(1);
    expect(mvnCands[0].suggestedName).toBe('kyx-service-gateway');
  });

  it('finds docker-compose.yml', () => {
    write('docker-compose.yml', 'version: "3"\nservices:\n  db:\n    image: postgres');
    const out = scanWorkspace(tmpDir);
    const cand = out.find(c => c.spec.kind === 'docker-compose');
    expect(cand).toBeDefined();
    expect(cand!.longLived).toBe(true);
  });

  it('parses Procfile lines', () => {
    write('Procfile', `
web: npm start
worker: node worker.js
# comment line
release: rake db:migrate
`);
    const out = scanWorkspace(tmpDir);
    const web = out.find(c => c.suggestedName === 'Procfile: web');
    const worker = out.find(c => c.suggestedName === 'Procfile: worker');
    const release = out.find(c => c.suggestedName === 'Procfile: release');
    expect(web).toBeDefined();
    expect(web!.longLived).toBe(true);  // 'web' name pattern
    expect(worker).toBeDefined();
    expect(worker!.longLived).toBe(true); // 'worker' name pattern
    expect(release).toBeDefined();
    expect(release!.longLived).toBe(false);
  });

  it('scans sub-directories up to depth 3 but skips node_modules / target', () => {
    write('backend/api/package.json', JSON.stringify({ scripts: { dev: 'nodemon' } }));
    write('frontend/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    /* 这两个应该被找到 */
    write('node_modules/some-dep/package.json', JSON.stringify({ scripts: { foo: 'bar' } }));
    write('target/build/package.json', JSON.stringify({ scripts: { foo: 'bar' } }));
    /* 这两个在 skip 目录里, 不应该被找到 */
    const out = scanWorkspace(tmpDir);
    const allScripts = out.filter(c => c.spec.kind === 'npm').map(c => c.sourceFile);
    expect(allScripts).toContain('backend/api/package.json');
    expect(allScripts).toContain('frontend/package.json');
    expect(allScripts.find(p => p.includes('node_modules'))).toBeUndefined();
    expect(allScripts.find(p => p.includes('target'))).toBeUndefined();
  });

  /* ================================================================
   * Go (go.mod) scanner
   * ================================================================ */
  describe('Go scanner', () => {
    it('cmd/<name>/main.go 多 binary → 每个 binary 一个 candidate', () => {
      write('go.mod', 'module github.com/acme/myapp\n\ngo 1.21\n');
      write('cmd/server/main.go', 'package main\nfunc main() {}\n');
      write('cmd/worker/main.go', 'package main\nfunc main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'go');
      expect(out).toHaveLength(2);
      expect(out.map(c => c.profile).sort()).toEqual(['server', 'worker']);
      /* 同 go.mod → 共享 moduleKey */
      const keys = new Set(out.map(c => c.moduleKey));
      expect(keys.size).toBe(1);
      /* suggestedName = go.mod 里 module 最后一段 */
      expect(out.every(c => c.suggestedName === 'myapp')).toBe(true);
      /* target = ./cmd/<name> */
      expect((out.find(c => c.profile === 'server')!.spec as any).target).toBe('./cmd/server');
    });

    it('单 binary 项目: 根 main.go → cargo run .', () => {
      write('go.mod', 'module github.com/acme/cli\n');
      write('main.go', 'package main\nfunc main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'go');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).target).toBe('.');
    });

    it('有 cmd/<name>/main.go 时不再追加根 main.go (避免重复)', () => {
      write('go.mod', 'module github.com/acme/app\n');
      write('main.go', 'package main\nfunc main() {}\n');
      write('cmd/server/main.go', 'package main\nfunc main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'go');
      expect(out).toHaveLength(1);
      expect(out[0].profile).toBe('server');
    });

    it('library only (无 main.go) → 不生成 candidate', () => {
      write('go.mod', 'module github.com/acme/lib\n');
      write('lib.go', 'package lib\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'go');
      expect(out).toHaveLength(0);
    });
  });

  /* ================================================================
   * Python scanner
   * ================================================================ */
  describe('Python scanner', () => {
    it('Django: manage.py → python3 manage.py runserver', () => {
      write('manage.py', '#!/usr/bin/env python\n# django management script\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).script).toBe('manage.py');
      expect((out[0].spec as any).args).toContain('runserver');
    });

    it('FastAPI: main.py 含 FastAPI() → uvicorn main:app', () => {
      write('main.py', `
from fastapi import FastAPI
app = FastAPI()
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).module).toBe('uvicorn');
      expect((out[0].spec as any).args).toContain('main:app');
      expect(out[0].profile).toContain('uvicorn');
    });

    it('Flask: app.py 含 Flask() → flask CLI', () => {
      write('app.py', `
from flask import Flask
app = Flask(__name__)
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).module).toBe('flask');
      expect(out[0].profile).toContain('flask');
    });

    it('裸 main.py → python3 main.py (无框架检测)', () => {
      write('main.py', 'print("hello")\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).script).toBe('main.py');
    });

    it('manage.py 已占位 → 同 dir 的 main.py 不再生成 (避免重复)', () => {
      write('manage.py', '# django\n');
      write('main.py', 'print("noise")\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      expect(out).toHaveLength(1);
      expect(out[0].profile).toBe('runserver');
    });

    it('pyproject.toml [tool.poetry.scripts] → 每条 script 一个候选, 同 moduleKey', () => {
      write('pyproject.toml', `
[tool.poetry]
name = "myapp"

[tool.poetry.scripts]
serve = "myapp.cli:serve"
worker = "myapp.cli:worker"
lint = "myapp.cli:lint"
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'python');
      const profiles = out.map(c => c.profile).sort();
      expect(profiles).toEqual(['lint', 'serve', 'worker']);
      /* serve / worker / lint 全部共享 moduleKey */
      const keys = new Set(out.map(c => c.moduleKey));
      expect(keys.size).toBe(1);
      /* long-lived 仅 launch 类 name 才标 true */
      expect(out.find(c => c.profile === 'serve')!.longLived).toBe(true);
      expect(out.find(c => c.profile === 'worker')!.longLived).toBe(false);
    });
  });

  /* ================================================================
   * Rust (Cargo.toml) scanner
   * ================================================================ */
  describe('Rust scanner', () => {
    it('单 binary: 仅 src/main.rs → cargo run', () => {
      write('Cargo.toml', `
[package]
name = "mycli"
version = "0.1.0"
`);
      write('src/main.rs', 'fn main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'cargo');
      expect(out).toHaveLength(1);
      expect(out[0].suggestedName).toBe('mycli');
      expect((out[0].spec as any).bin).toBeUndefined();
    });

    it('[[bin]] 多 binary → 每个 bin 一个 candidate, profile=bin', () => {
      write('Cargo.toml', `
[package]
name = "myapp"

[[bin]]
name = "server"
path = "src/bin/server.rs"

[[bin]]
name = "worker"
path = "src/bin/worker.rs"
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'cargo');
      expect(out.map(c => c.profile).sort()).toEqual(['server', 'worker']);
      const keys = new Set(out.map(c => c.moduleKey));
      expect(keys.size).toBe(1);
      expect((out.find(c => c.profile === 'server')!.spec as any).bin).toBe('server');
    });

    it('workspace 根 (仅 [workspace], 无 [package]) → 跳过', () => {
      write('Cargo.toml', `
[workspace]
members = ["crates/foo"]
`);
      write('crates/foo/Cargo.toml', `
[package]
name = "foo"
`);
      write('crates/foo/src/main.rs', 'fn main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'cargo');
      expect(out).toHaveLength(1);
      expect(out[0].suggestedName).toBe('foo');
    });

    it('lib crate (无 main.rs, 无 [[bin]]) → 不生成', () => {
      write('Cargo.toml', `
[package]
name = "mylib"
`);
      write('src/lib.rs', '');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'cargo');
      expect(out).toHaveLength(0);
    });

    it('显式 [[bin]] 时不再 fallback 到 src/main.rs', () => {
      write('Cargo.toml', `
[package]
name = "myapp"

[[bin]]
name = "server"
`);
      write('src/main.rs', 'fn main() {}\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'cargo');
      expect(out).toHaveLength(1);
      expect(out[0].profile).toBe('server');
    });
  });

  /* ================================================================
   * Makefile scanner
   * ================================================================ */
  describe('Makefile scanner', () => {
    it('launch 类 target (dev/run/serve) → long-lived 候选', () => {
      write('Makefile', `
.PHONY: dev build test clean

dev:
\tnpm run dev

build:
\ttsc

test:
\tjest

run:
\tnode server.js
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'make');
      const profiles = out.map(c => c.profile).sort();
      expect(profiles).toEqual(['dev', 'run']);
      /* build / test / clean 全部排除 */
      expect(out.find(c => c.profile === 'build')).toBeUndefined();
      expect(out.find(c => c.profile === 'test')).toBeUndefined();
    });

    it('target-suffix (dev-frontend) 也算 launch', () => {
      write('Makefile', `
dev-frontend:
\tnpm run dev

dev-backend:
\tgo run .
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'make');
      expect(out.map(c => c.profile).sort()).toEqual(['dev-backend', 'dev-frontend']);
    });

    it('变量赋值行不当作 target', () => {
      write('Makefile', `
CC = clang
DEBUG := 1
PREFIX ?= /usr/local

dev:
\tnpm run dev
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'make');
      expect(out).toHaveLength(1);
      expect(out[0].profile).toBe('dev');
    });
  });

  /* ================================================================
   * .NET scanner
   * ================================================================ */
  describe('.NET scanner', () => {
    it('Web Sdk → dotnet run candidate', () => {
      write('src/Api/Api.csproj', `<?xml version="1.0"?>
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'dotnet');
      expect(out).toHaveLength(1);
      expect(out[0].suggestedName).toBe('Api');
      expect((out[0].spec as any).project).toBe('Api.csproj');
    });

    it('Console (OutputType=Exe) → run candidate', () => {
      write('Cli.csproj', `<?xml version="1.0"?>
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'dotnet');
      expect(out).toHaveLength(1);
      expect(out[0].suggestedName).toBe('Cli');
    });

    it('Library (默认 OutputType) → 跳过', () => {
      write('Shared.csproj', `<?xml version="1.0"?>
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'dotnet');
      expect(out).toHaveLength(0);
    });
  });

  /* ================================================================
   * Deno scanner
   * ================================================================ */
  describe('Deno scanner', () => {
    it('deno.json tasks → 每个 launch 类 task 一个候选', () => {
      write('deno.json', JSON.stringify({
        tasks: {
          dev: 'deno run --allow-net --watch main.ts',
          test: 'deno test',
          lint: 'deno lint',
        },
      }));
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'deno');
      expect(out.map(c => c.profile)).toEqual(['dev']);
      expect((out[0].spec as any).task).toBe('dev');
    });

    it('deno.jsonc 支持注释', () => {
      write('deno.jsonc', `{
  // dev task only
  "tasks": {
    "dev": "deno run --watch main.ts"
  }
}`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'deno');
      expect(out).toHaveLength(1);
    });
  });

  /* ================================================================
   * Bun scanner
   * ================================================================ */
  describe('Bun scanner', () => {
    it('bunfig.toml + index.ts (无 package.json) → bun run index.ts', () => {
      write('bunfig.toml', '# bun config\n');
      write('index.ts', 'console.log("hi")\n');
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'bun');
      expect(out).toHaveLength(1);
      expect((out[0].spec as any).entry).toBe('index.ts');
    });

    it('bunfig.toml + package.json → 由 npm scanner 接管, bun scanner 不重复', () => {
      write('bunfig.toml', '# bun\n');
      write('package.json', JSON.stringify({ scripts: { dev: 'bun run server.ts' } }));
      write('server.ts', '');
      const bunOut = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'bun');
      const npmOut = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'npm');
      expect(bunOut).toHaveLength(0);
      expect(npmOut).toHaveLength(1);
    });
  });

  /* ================================================================
   * Flutter scanner
   * ================================================================ */
  describe('Flutter scanner', () => {
    it('pubspec.yaml 含 flutter: 块 → flutter run', () => {
      write('pubspec.yaml', `
name: my_flutter_app
description: A new Flutter project.

flutter:
  uses-material-design: true
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'flutter');
      expect(out).toHaveLength(1);
      expect(out[0].suggestedName).toBe('my_flutter_app');
      expect((out[0].spec as any).command).toBe('run');
    });

    it('纯 Dart package (无 flutter:) → 不生成', () => {
      write('pubspec.yaml', `
name: pure_dart_pkg
dependencies:
  http: ^1.0.0
`);
      const out = scanWorkspace(tmpDir).filter(c => c.spec.kind === 'flutter');
      expect(out).toHaveLength(0);
    });
  });

  it('sorts long-lived first', () => {
    write('package.json', JSON.stringify({
      scripts: { dev: 'vite', test: 'jest', build: 'tsc' },
    }));
    const out = scanWorkspace(tmpDir);
    const firstNonLong = out.findIndex(c => !c.longLived);
    const lastLong = out.map(c => c.longLived).lastIndexOf(true);
    /* 所有 long-lived 都在所有非-long-lived 之前 */
    if (firstNonLong >= 0 && lastLong >= 0) {
      expect(lastLong).toBeLessThan(firstNonLong);
    }
  });
});

describe('扫描能力清单跟文案对齐', () => {
  it('只有 Dockerfile 不产生候选 —— 所以清单里不许有 Dockerfile', async () => {
    const { SCAN_SOURCES } = await import('../scanSources.js');
    write('Dockerfile', 'FROM node:20\nCMD ["node","server.js"]\n');
    expect(scanWorkspace(tmpDir)).toEqual([]);
    expect(SCAN_SOURCES as readonly string[]).not.toContain('Dockerfile');
  });

  it('docker-compose.yml 才是真认的那个, 且在清单里', async () => {
    const { SCAN_SOURCES } = await import('../scanSources.js');
    write('docker-compose.yml', 'services:\n  web:\n    image: nginx\n');
    expect(scanWorkspace(tmpDir).length).toBeGreaterThan(0);
    expect(SCAN_SOURCES as readonly string[]).toContain('docker-compose.yml');
  });

  it('扫描器吐出的 source 全都在清单里', async () => {
    const { SCAN_SOURCES } = await import('../scanSources.js');
    write('package.json', JSON.stringify({ name: 'a', scripts: { dev: 'vite' } }));
    write('go.mod', 'module demo\n');
    write('main.go', 'package main\nfunc main(){}\n');
    write('Cargo.toml', '[package]\nname = "d"\n');
    for (const c of scanWorkspace(tmpDir)) {
      expect(SCAN_SOURCES as readonly string[]).toContain(c.source);
    }
  });

  it('摘要文案报的种类数跟清单一致 (中英都不许写死)', async () => {
    const { SCAN_SOURCES, scanSourcesSummary } = await import('../scanSources.js');
    expect(scanSourcesSummary(true)).toContain(`${SCAN_SOURCES.length} 种`);
    expect(scanSourcesSummary(false)).toContain(`${SCAN_SOURCES.length - 5} more`);
    expect(scanSourcesSummary(true)).not.toContain('Dockerfile');
  });
});
