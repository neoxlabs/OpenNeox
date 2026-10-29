/** Single source of truth for project files recognized by scanWorkspace and
 * summarized in the UI.
 *
 *   scanWorkspace.ts uses node:fs and node:path, so the renderer consumes this data-only module.
 *   The UI consumes the same list instead of maintaining a second supported-file list.
 *
 *   RunConfigCandidate['source'] is derived from this const so the type checker keeps the UI list aligned.
 */

export const SCAN_SOURCES = [
  'package.json',
  'pom.xml',
  'build.gradle',
  'docker-compose.yml',
  'Procfile',
  'go.mod',
  'Cargo.toml',
  'Makefile',
  'pyproject.toml',
  'manage.py',
  'main.py',
  'app.py',
  'csproj',
  'deno.json',
  'bunfig.toml',
  'pubspec.yaml',
] as const;

export type ScanSource = (typeof SCAN_SOURCES)[number];

/** UI 用: "package.json / pom.xml / build.gradle / go.mod / Cargo.toml 等 16 种工程文件" */
export function scanSourcesSummary(isZh: boolean, head = 5): string {
  const shown = SCAN_SOURCES.slice(0, head).join(' / ');
  return isZh
    ? `${shown} 等 ${SCAN_SOURCES.length} 种工程文件`
    : `${shown} and ${SCAN_SOURCES.length - head} more project files`;
}
