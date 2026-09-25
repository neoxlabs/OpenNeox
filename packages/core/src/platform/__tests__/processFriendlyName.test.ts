import { describe, it, expect } from 'vitest';
import { deriveFriendlyName } from '@neoxlabs/platform/platform/processFriendlyName.js';

const fn = (command: string, extra: Partial<Parameters<typeof deriveFriendlyName>[0]> = {}) =>
  deriveFriendlyName({ command, ...extra });

describe('deriveFriendlyName', () => {
  it('configName 优先级最高', () => {
    expect(fn('whatever long command', { configName: 'Gateway' })).toBe('Gateway');
  });

  describe('Spring Boot / Maven', () => {
    it('mvn spring-boot:run → Spring Boot', () => {
      expect(fn('mvn spring-boot:run')).toBe('Spring Boot');
      expect(fn('mvn spring-boot:run -P dev')).toBe('Spring Boot');
      expect(fn('mvn -DskipTests spring-boot:run -P dev')).toBe('Spring Boot');
    });

    it('mvn 嵌在 cd 后面也能识别', () => {
      expect(fn('cd /Users/me/Code/backend && mvn spring-boot:run -P dev')).toBe('Spring Boot');
    });

    it('mvn <goal> → Maven: <goal>', () => {
      expect(fn('mvn clean')).toBe('Maven: clean');
      expect(fn('mvn package')).toBe('Maven: package');
      expect(fn('mvn -o test')).toBe('Maven: test');
    });
  });

  describe('Gradle', () => {
    it('./gradlew bootRun → Spring Boot', () => {
      expect(fn('./gradlew bootRun')).toBe('Spring Boot');
      expect(fn('./gradlew -Penv=dev bootRun')).toBe('Spring Boot');
    });

    it('./gradlew <task> → Gradle: <task>', () => {
      expect(fn('./gradlew build')).toBe('Gradle: build');
      expect(fn('gradle test')).toBe('Gradle: test');
    });
  });

  describe('npm / yarn / pnpm', () => {
    it('npm run <script> → npm: <script>', () => {
      expect(fn('npm run dev')).toBe('npm: dev');
      expect(fn('npm run build')).toBe('npm: build');
    });

    it('npm start/test/install → npm: <verb>', () => {
      expect(fn('npm start')).toBe('npm: start');
      expect(fn('npm test')).toBe('npm: test');
      expect(fn('npm install')).toBe('npm: install');
    });

    it('yarn / pnpm <script>', () => {
      expect(fn('yarn dev')).toBe('yarn: dev');
      expect(fn('pnpm build')).toBe('pnpm: build');
    });
  });

  describe('Node / Vite / Next', () => {
    it('vite → Vite', () => {
      expect(fn('vite')).toBe('Vite');
      expect(fn('npx vite')).toBe('Vite');
    });

    it('next dev → Next.js Dev', () => {
      expect(fn('next dev')).toBe('Next.js Dev');
      expect(fn('npx next start')).toBe('Next.js');
    });

    it('node script.js → Node: script', () => {
      expect(fn('node server.js')).toBe('Node: server');
      expect(fn('node ./src/index.ts')).toBe('Node: index');
    });

    it('node <known-tool> → 工具语义名, 跳过 "Node:" 前缀', () => {
      // pnpm/npm scripts 实际 exec 出的 `node .../vite.js` 这类, 不要显示成 "Node: vite",
      // 直接映射到 "Vite" — 跟用户对该服务的心智 (我跑的是 Vite) 对齐.
      expect(fn('node /Users/foo/proj/node_modules/.bin/vite')).toBe('Vite');
      expect(fn('node node_modules/.bin/next dev')).toBe('Next.js');
      expect(fn('node ./node_modules/webpack/bin/webpack.js')).toBe('Webpack');
      expect(fn('node /usr/local/bin/turbo')).toBe('Turbo');
      // 不在白名单的脚本仍走 Node: <name> 兜底
      expect(fn('node my-custom-cli.js')).toBe('Node: my-custom-cli');
    });

    it('nodemon → Nodemon: <target>', () => {
      expect(fn('nodemon server.js')).toBe('Nodemon: server.js');
      expect(fn('nodemon --inspect app.js')).toBe('Nodemon: app.js');
    });
  });

  describe('Python', () => {
    it('python -m http.server 8888 → HTTP Server :8888', () => {
      expect(fn('python3 -m http.server 8888')).toBe('HTTP Server :8888');
      expect(fn('python -m http.server')).toBe('HTTP Server');
    });

    it('python -m flask / uvicorn / gunicorn', () => {
      expect(fn('python3 -m flask')).toBe('Flask');
      expect(fn('python -m uvicorn')).toBe('Uvicorn');
      expect(fn('python3 -m gunicorn')).toBe('Gunicorn');
    });

    it('python xxx.py → Python: xxx', () => {
      expect(fn('python3 app.py')).toBe('Python: app');
      expect(fn('python ./src/main.py')).toBe('Python: main');
    });

    it('flask run / django runserver', () => {
      expect(fn('flask run')).toBe('Flask');
      expect(fn('django-admin runserver')).toBe('Django');
    });
  });

  describe('Docker / Containers', () => {
    it('docker compose up → Docker Compose', () => {
      expect(fn('docker compose up')).toBe('Docker Compose');
      expect(fn('docker compose up -d db')).toBe('Docker Compose');
      expect(fn('docker-compose up')).toBe('Docker Compose');
    });

    it('docker run <image> → Docker: <image>', () => {
      expect(fn('docker run -d -p 5432:5432 postgres')).toBe('Docker: postgres');
    });
  });

  describe('Rust / Go / Ruby', () => {
    it('cargo run / go run / rails s', () => {
      expect(fn('cargo run')).toBe('Cargo Run');
      expect(fn('cargo build')).toBe('Cargo: build');
      expect(fn('go run main.go')).toBe('Go Run');
      expect(fn('rails server')).toBe('Rails Server');
      expect(fn('rails s')).toBe('Rails Server');
    });
  });

  describe('Misc', () => {
    it('tail -f / exec shell / java -jar', () => {
      expect(fn('tail -f /var/log/app.log')).toBe('Tail: app.log');
      expect(fn('exec /bin/zsh -i')).toBe('Shell');
      expect(fn('java -Xms256m -jar build/libs/app.jar')).toBe('Java: app');
    });
  });

  describe('Fallback', () => {
    it('未识别命令取首个 word', () => {
      expect(fn('weird-binary --flag')).toBe('weird-binary');
      expect(fn('/usr/local/bin/custom-tool')).toBe('custom-tool');
    });

    it('空命令安全 fallback', () => {
      expect(fn('')).toBe('Process');
    });
  });

  describe('cd 前缀', () => {
    it('Windows `cd /d <path> &&` 也要剥掉', () => {
      expect(fn('cd /d e:\\code\\neox-internal && node .tmp-shot.mjs')).toBe('Node: .tmp-shot');
    });

    it('带引号的路径', () => {
      expect(fn('cd "/Users/me/My Project" && npm run dev')).toContain('dev');
    });

    it('多层 cd 链', () => {
      expect(fn('cd /a && cd /b && node server.js')).toBe('Node: server');
    });

    it('对照: 普通单 token cd 照旧', () => {
      expect(fn('cd /srv/app && node index.js')).toBe('Node: index');
    });
  });
});
