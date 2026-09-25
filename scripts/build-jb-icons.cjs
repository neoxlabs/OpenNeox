#!/usr/bin/env node
/**
 * 从 src/ui/renderer/assets/jb-icons/{nodes,fileTypes,vcs}/ 读取 IDEA 自带的 expui svg
 * 转成 Iconify collection,生成 src/ui/renderer/components/jbIconRegistry.generated.ts
 *
 * 命名规则:
 *   nodes/folder.svg     →  jb:nodes-folder
 *   nodes/folder_dark.svg → jb:nodes-folder-dark
 *   fileTypes/yaml.svg   →  jb:fileTypes-yaml
 *
 * 用法: node scripts/build-jb-icons.cjs
 */
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '..', 'src/ui/renderer/assets/jb-icons');
const OUT_FILE = path.resolve(
  __dirname,
  '..',
  'src/ui/renderer/components/jbIconRegistry.generated.ts'
);

const SUBDIRS = ['nodes', 'fileTypes', 'vcs', 'toolwindows', 'general', 'actions'];

/** 解析 svg 文件 → { body, width, height } */
function parseSvg(content) {
  // 取 width/height/viewBox
  const widthMatch = content.match(/<svg[^>]*\swidth="([^"]+)"/);
  const heightMatch = content.match(/<svg[^>]*\sheight="([^"]+)"/);
  const viewBoxMatch = content.match(/<svg[^>]*\sviewBox="([^"]+)"/);

  let width = widthMatch ? parseFloat(widthMatch[1]) : 16;
  let height = heightMatch ? parseFloat(heightMatch[1]) : 16;
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/);
    if (parts.length === 4) {
      width = parseFloat(parts[2]);
      height = parseFloat(parts[3]);
    }
  }

  // 取 <svg ...>...</svg> 中间的 body
  const bodyMatch = content.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!bodyMatch) return null;
  let body = bodyMatch[1].trim();

  // 移除 xmlns 属性 (Iconify 不需要)
  body = body.replace(/\s*xmlns="[^"]*"/g, '');

  return { body, width, height };
}

const collection = {
  prefix: 'jb',
  width: 16,
  height: 16,
  icons: {},
};

let total = 0;
let bytes = 0;
let skipped = 0;

for (const sub of SUBDIRS) {
  const dir = path.join(ASSETS_DIR, sub);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'));
  for (const f of files) {
    const full = path.join(dir, f);
    const content = fs.readFileSync(full, 'utf8');
    const parsed = parseSvg(content);
    if (!parsed) {
      skipped++;
      continue;
    }
    const baseName = f.replace(/\.svg$/, '');
    // jb:nodes-folder, jb:nodes-folder-dark
    const iconName = `${sub}-${baseName.replace(/_/g, '-')}`;
    collection.icons[iconName] = {
      body: parsed.body,
      width: parsed.width,
      height: parsed.height,
    };
    total++;
    bytes += parsed.body.length;
  }
}

const lines = [
  '// AUTO-GENERATED — do not edit by hand.',
  '// Regenerate via: node scripts/build-jb-icons.cjs',
  '//',
  '// JetBrains IDEA expUI icons (Apache 2.0) extracted from app-client.jar.',
  `// ${total} icons, ${(bytes / 1024).toFixed(1)} KB svg body total`,
  '//',
  '// Usage:',
  '//   import { jbIcons } from "./jbIconRegistry.generated";',
  '//   addCollection(jbIcons);',
  '',
  '/* eslint-disable */',
  'export const jbIcons = ' + JSON.stringify(collection) + ' as const;',
  '',
];

fs.writeFileSync(OUT_FILE, lines.join('\n'));
console.log(
  `✓ Wrote ${total} JB icons to jbIconRegistry.generated.ts (${(bytes / 1024).toFixed(1)} KB body, ${skipped} skipped)`
);
