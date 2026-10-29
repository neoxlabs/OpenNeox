/**
 * 找 java 可执行文件 + jvm-debugger.jar 的位置.
 *
 * dev 模式: jar 在 <repo>/jvm-debugger/build/libs/neox-jvm-debugger.jar
 * 打包模式: 后面 M0 之外再处理 (asar.unpacked + jlink JRE)
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface JvmDebuggerLocation {
  javaExe: string;
  jarPath: string;
  /** 给 spawn 用的完整 args (含 --add-modules + -jar) */
  args: string[];
}

const JAR_REL = ['jvm-debugger', 'build', 'libs', 'neox-jvm-debugger.jar'];

export function locateJvmDebugger(opts: { repoRoot?: string; javaHomeEnv?: string } = {}): JvmDebuggerLocation {
  const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd()) ?? process.cwd();
  const jarPath = join(repoRoot, ...JAR_REL);
  if (!existsSync(jarPath)) {
    throw new Error(
      `neox-jvm-debugger.jar not found at ${jarPath}.\n` +
        `请先在 jvm-debugger/ 跑 \`gradle shadowJar\``,
    );
  }
  const javaExe = resolveJava(opts.javaHomeEnv ?? process.env.JAVA_HOME);
  return {
    javaExe,
    jarPath,
    args: ['--add-modules', 'jdk.jdi', '-jar', jarPath],
  };
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'jvm-debugger'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolveJava(javaHome: string | undefined): string {
  if (javaHome) {
    const candidate = join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (existsSync(candidate)) return candidate;
  }
  // PATH 兜底
  return process.platform === 'win32' ? 'java.exe' : 'java';
}
