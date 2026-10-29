
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { declaredJavaMajor, listInstalledJdks, pickProjectJdkEnv, type InstalledJdk } from './projectJdk.js';

export interface ServiceProjectInfo {
  spring?: { available: string[]; active: string[] };
  java?: { declared: number | null; installed: InstalledJdk[]; autoHome?: string; defaultVersion?: string };
  node?: { version: string; required?: string; depsInstalled: boolean };
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

function springInfo(moduleDir: string): ServiceProjectInfo['spring'] {
  const res = path.join(moduleDir, 'src', 'main', 'resources');
  let files: string[] = [];
  try { files = fs.readdirSync(res); } catch { return undefined; }
  const available = files.map((f) => f.match(/^application-([\w.-]+)\.(ya?ml|properties)$/i)?.[1]).filter((x): x is string => !!x);
  const raw = readText(path.join(res, 'application.yml')).match(/\bprofiles:\s*\n\s+active:\s*([^\n#]+)/)?.[1]
    ?? readText(path.join(res, 'application.yaml')).match(/\bprofiles:\s*\n\s+active:\s*([^\n#]+)/)?.[1]
    ?? readText(path.join(res, 'application.properties')).match(/^spring\.profiles\.active\s*=\s*([^\n#]+)/m)?.[1];
  const value = (raw ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/^\$\{[^:}]*:?([^}]*)\}$/, '$1');
  const active = value && !value.includes('@') ? value.split(',').map((x) => x.trim()).filter(Boolean) : [];
  /* active 里的公共 profile (core) 可能不在本模块 resources 里 (放在框架 jar), 也要能点选 */
  const all = [...new Set([...active, ...available])];
  if (!all.length) return undefined;
  return { available: all, active };
}

export function getServiceProjectInfo(workspaceRoot: string, draft: { cwd: string; module?: string; command?: string }): ServiceProjectInfo {
  const cwdAbs = path.resolve(workspaceRoot, draft.cwd || '.');
  const moduleDir = draft.module ? path.resolve(cwdAbs, draft.module) : cwdAbs;
  const info: ServiceProjectInfo = {};
  const isJava = fs.existsSync(path.join(moduleDir, 'pom.xml')) || fs.existsSync(path.join(moduleDir, 'build.gradle'))
    || fs.existsSync(path.join(moduleDir, 'build.gradle.kts')) || /\b(mvn|gradle|gradlew|java)\b/.test(draft.command ?? '');
  if (isJava) {
    info.spring = springInfo(moduleDir);
    const auto = pickProjectJdkEnv(workspaceRoot, moduleDir, process.env);
    const r = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 4000 });
    info.java = {
      declared: declaredJavaMajor(workspaceRoot, moduleDir),
      installed: listInstalledJdks(),
      autoHome: auto?.JAVA_HOME,
      defaultVersion: `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/version "([^"]+)"/)?.[1],
    };
  }
  const pkgText = readText(path.join(moduleDir, 'package.json'));
  if (pkgText) {
    let required: string | undefined;
    try { required = JSON.parse(pkgText)?.engines?.node; } catch { /* 坏 json */ }
    required = readText(path.join(moduleDir, '.nvmrc')).trim() || required;
    const r = spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 4000 });
    info.node = { version: (r.stdout ?? '').trim(), required, depsInstalled: fs.existsSync(path.join(moduleDir, 'node_modules')) };
  }
  return info;
}
