
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface InstalledJdk { major: number; home: string; javafx: boolean }

function out(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

/** "1.8.0_441" / "1.8" / "8" / "17.0.16" → 8 / 8 / 8 / 17 */
export function javaMajor(v: string): number | null {
  const m = v.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const a = Number(m[1]);
  return a === 1 && m[2] ? Number(m[2]) : a;
}

/** 从服务目录往上找到 workspace 根, 第一个写了 Java 版本的 pom / gradle 说了算 */
export function declaredJavaMajor(workspaceRoot: string, cwdAbs: string): number | null {
  const top = path.resolve(workspaceRoot);
  let dir = path.resolve(cwdAbs);
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf-8'); } catch { /* 没 pom */ }
    const pomVer = text.match(/<(?:java\.version|maven\.compiler\.release|maven\.compiler\.source)>\s*([\d.]+)\s*</)?.[1];
    if (pomVer) return javaMajor(pomVer);
    for (const g of ['build.gradle', 'build.gradle.kts']) {
      let gradle = '';
      try { gradle = fs.readFileSync(path.join(dir, g), 'utf-8'); } catch { continue; }
      const v = gradle.match(/sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/)?.[1]
        ?? gradle.match(/languageVersion\.set\(JavaLanguageVersion\.of\((\d+)\)\)/)?.[1];
      if (v) return javaMajor(v.replace('_', '.'));
    }
    if (dir === top || !dir.startsWith(top)) return null;
    dir = path.dirname(dir);
  }
}

let cached: InstalledJdk[] | null = null;

export function listInstalledJdks(): InstalledJdk[] {
  if (cached) return cached;
  const homes = new Set<string>();
  if (process.platform === 'darwin') {
    /* java_home -V 退出码 0 但清单写在 stderr; 浏览器插件那份 JRE 不是 JDK, 排掉 */
    for (const line of out('/usr/libexec/java_home', ['-V']).split('\n')) {
      const p = line.match(/\s(\/\S.*)$/)?.[1]?.trim();
      if (p && !p.includes('Internet Plug-Ins')) homes.add(p);
    }
  } else {
    const bases = process.platform === 'win32'
      ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Zulu', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Amazon Corretto']
      : ['/usr/lib/jvm'];
    for (const base of bases) {
      try { for (const d of fs.readdirSync(base)) homes.add(path.join(base, d)); } catch { /* 没装这家 */ }
    }
  }
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const list: InstalledJdk[] = [];
  for (const home of homes) {
    if (!fs.existsSync(path.join(home, 'bin', exe))) continue;
    const ver = out(path.join(home, 'bin', exe), ['-version']).match(/version "([^"]+)"/)?.[1];
    const major = ver ? javaMajor(ver) : null;
    if (!major) continue;
    const javafx = fs.existsSync(path.join(home, 'jre', 'lib', 'ext', 'jfxrt.jar')) || fs.existsSync(path.join(home, 'lib', 'javafx.properties'));
    list.push({ major, home, javafx });
  }
  cached = list;
  return list;
}

/** 当前环境下 `java` 是几 (JAVA_HOME 优先, 跟 mvn 认的一致) */
function defaultJavaMajor(env: NodeJS.ProcessEnv): number | null {
  const exe = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const ver = out(exe, ['-version']).match(/version "([^"]+)"/)?.[1];
  return ver ? javaMajor(ver) : null;
}

/** 需要换 JDK 时给出要叠加的环境变量; 不需要 / 没装对应版本 → null */
export function pickProjectJdkEnv(workspaceRoot: string, cwdAbs: string, env: NodeJS.ProcessEnv): Record<string, string> | null {
  const want = declaredJavaMajor(workspaceRoot, cwdAbs);
  if (!want || defaultJavaMajor(env) === want) return null;
  const match = listInstalledJdks().filter((j) => j.major === want).sort((a, b) => Number(b.javafx) - Number(a.javafx))[0];
  if (!match) return null;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { JAVA_HOME: match.home, [pathKey]: `${path.join(match.home, 'bin')}${path.delimiter}${env[pathKey] ?? ''}` };
}
