import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export type CommandPreset =
  | 'npm' | 'pnpm' | 'yarn' | 'bun'
  | 'pytest' | 'go' | 'cargo' | 'make'
  | 'maven' | 'gradle' | 'flutter';

export const COMMAND_PRESETS: readonly CommandPreset[] = [
  'npm', 'pnpm', 'yarn', 'bun', 'pytest', 'go', 'cargo', 'make', 'maven', 'gradle', 'flutter',
];

/** 模型会按语言/工具随手写的别名 —— 都指向同一个 preset, 不该被当成"不认识"。 */
const PRESET_ALIASES: Record<string, CommandPreset> = {
  python: 'pytest', python3: 'pytest', py: 'pytest', ruff: 'pytest', black: 'pytest', uv: 'pytest', poetry: 'pytest',
  node: 'npm', nodejs: 'npm', npx: 'npm',
  mvn: 'maven', mvnw: 'maven',
  gradlew: 'gradle',
  dart: 'flutter',
  rust: 'cargo', golang: 'go',
};

/**
 * 把模型传来的 preset 收敛成合法值; 认不出返回 null, 由调用方给出可照做的提示。
 *
 *    自测: `run_format(preset="python")` 跑出了 `npm run format` ——
 *   'python' 不在联合类型里, buildCommandForPreset 的 default 分支静默兜到 npm。
 *   一个"不认识"被翻译成了"另一种确定的东西", 比报错更糟。
 */
export function normalizeCommandPreset(raw: unknown): CommandPreset | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if ((COMMAND_PRESETS as readonly string[]).includes(key)) return key as CommandPreset;
  return PRESET_ALIASES[key] ?? null;
}

export async function detectCommandPreset(cwd: string): Promise<CommandPreset | null> {
  const has = (name: string) => fs.stat(path.join(cwd, name)).then(() => true).catch(() => false);

  const hasPackage = has('package.json');
  const hasPnpmLock = has('pnpm-lock.yaml');
  const hasYarnLock = has('yarn.lock');
  const hasBunLock = has('bun.lockb');
  const hasPyProject = has('pyproject.toml');
  const hasPyTestIni = has('pytest.ini');
  const hasGo = has('go.mod');
  const hasCargo = has('Cargo.toml');
  const hasMake = has('Makefile');
  const hasPom = has('pom.xml');
  const hasPubspec = has('pubspec.yaml');
  const hasGradleKts = has('build.gradle.kts');
  const hasGradle = has('build.gradle');
  const hasSettingsGradle = has('settings.gradle');
  const hasSettingsKts = has('settings.gradle.kts');

  return Promise.all([
    hasPackage, hasPnpmLock, hasYarnLock, hasBunLock, hasPyProject, hasPyTestIni,
    hasGo, hasCargo, hasMake, hasPom, hasPubspec,
    hasGradleKts, hasGradle, hasSettingsGradle, hasSettingsKts,
  ]).then(([pkg, pnpm, yarn, bun, py, pytestIni, go, cargo, make, pom, pubspec, gradleKts, gradle, settings, settingsKts]) => {
    /* Java / Flutter 的标识文件比 package.json 更专 —— 一个带 leftover package.json
     * 的 Maven/Flutter 根目录不该被当成 npm, 否则 run_tests 会去跑不存在的 npm test。 */
    if (pom) return 'maven';
    if (pubspec) return 'flutter';
    if (gradleKts || gradle || settings || settingsKts) return 'gradle';
    if (pkg) {
      if (pnpm) return 'pnpm';
      if (yarn) return 'yarn';
      if (bun) return 'bun';
      return 'npm';
    }
    if (py || pytestIni) return 'pytest';
    if (go) return 'go';
    if (cargo) return 'cargo';
    if (make) return 'make';
    return null;
  });
}

function wrapperOr(cwd: string | undefined, wrappers: string[], fallback: string): string {
  if (!cwd) return fallback;
  for (const name of wrappers) {
    const abs = path.join(cwd, name);
    if (fsSync.existsSync(abs)) return abs;
  }
  return fallback;
}

export function buildCommandForPreset(
  preset: CommandPreset,
  kind: 'test' | 'lint' | 'format',
  extraArgs: string[],
  cwd?: string,
): { command: string; args: string[] } {
  switch (preset) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const script = kind === 'test' ? 'test' : kind === 'lint' ? 'lint' : 'format';
      return { command: preset, args: ['run', script, ...extraArgs] };
    }
    case 'pytest':
      /* Python 工程三件事三个工具: pytest 只会跑测试, 拿它去 lint/format 就是跑一遍测试
       * 然后谎报"格式化成功"。lint/format 走 ruff (没装就是 spawn ENOENT → 前置条件提示)。 */
      if (kind === 'test') return { command: 'pytest', args: extraArgs };
      if (kind === 'lint') return { command: 'ruff', args: ['check', '.', ...extraArgs] };
      return { command: 'ruff', args: ['format', '.', ...extraArgs] };
    case 'go':
      if (kind === 'test') return { command: 'go', args: ['test', './...', ...extraArgs] };
      if (kind === 'lint') return { command: 'golangci-lint', args: ['run', ...extraArgs] };
      return { command: 'gofmt', args: ['-w', ...extraArgs] };
    case 'cargo':
      if (kind === 'test') return { command: 'cargo', args: ['test', ...extraArgs] };
      if (kind === 'lint') return { command: 'cargo', args: ['clippy', '--', ...extraArgs] };
      return { command: 'cargo', args: ['fmt', ...extraArgs] };
    case 'make':
      return { command: 'make', args: [kind, ...extraArgs] };
    case 'maven': {
      const command = wrapperOr(cwd, process.platform === 'win32' ? ['mvnw.cmd', 'mvnw.bat'] : ['mvnw'], 'mvn');
      if (kind === 'test') return { command, args: ['test', ...extraArgs] };
      if (kind === 'lint') return { command, args: ['-DskipTests', 'compile', ...extraArgs] };
      return { command, args: ['-DskipTests', 'process-sources', ...extraArgs] };
    }
    case 'gradle': {
      const command = wrapperOr(cwd, process.platform === 'win32' ? ['gradlew.bat', 'gradlew.cmd'] : ['gradlew'], 'gradle');
      if (kind === 'test') return { command, args: ['test', ...extraArgs] };
      if (kind === 'lint') return { command, args: ['check', ...extraArgs] };
      return { command, args: ['spotlessApply', ...extraArgs] };
    }
    case 'flutter':
      if (kind === 'test') return { command: 'flutter', args: ['test', ...extraArgs] };
      if (kind === 'lint') return { command: 'flutter', args: ['analyze', ...extraArgs] };
      return { command: 'dart', args: ['format', '.', ...extraArgs] };
    default: {
      /* 不认识的 preset 在 normalizeCommandPreset 就该被拦下; 这里绝不静默兜到 npm。 */
      const unreachable: never = preset;
      throw new Error(`Unknown command preset: ${String(unreachable)}`);
    }
  }
}
