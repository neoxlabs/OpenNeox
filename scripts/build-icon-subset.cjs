#!/usr/bin/env node
/**
 * 从 @iconify-json/* 包里挑选 FileTypeIcons.tsx 实际用到的图标,
 * 生成精简的 src/ui/renderer/components/iconRegistry.generated.ts
 *
 * 为什么需要这一步:
 *   完整 vscode-icons 集 3.5MB, logos 7MB. 直接 import 会让 renderer
 *   bundle 暴涨. 这里只挑出 ~50 个用到的, 总大小 ~90KB.
 *
 * 用法: node scripts/build-icon-subset.cjs
 * 改 FileTypeIcons 里的图标名后, 必须重跑此脚本.
 */
const fs = require('fs');
const path = require('path');

const v = require('@iconify-json/vscode-icons/icons.json');
const m = require('@iconify-json/material-icon-theme/icons.json');
const l = require('@iconify-json/logos/icons.json');

// 必须与 FileTypeIcons.tsx 里实际用到的 icon 名保持一致
const wanted = {
  'vscode-icons': [
    'default-folder', 'default-folder-opened', 'default-file',
    'folder-type-src', 'folder-type-src-opened',
    'folder-type-test', 'folder-type-test-opened',
    'folder-type-dist', 'folder-type-dist-opened',
    'folder-type-node', 'folder-type-node-opened',
    'folder-type-maven', 'folder-type-maven-opened',
    'file-type-typescript', 'file-type-typescriptdef', 'file-type-reactts',
    'file-type-js', 'file-type-reactjs',
    'file-type-json', 'file-type-yaml', 'file-type-xml',
    'file-type-css', 'file-type-scss', 'file-type-html',
    'file-type-markdown', 'file-type-mdx',
    'file-type-python', 'file-type-java', 'file-type-class',
    'file-type-go', 'file-type-rust', 'file-type-sql',
    'file-type-shell', 'file-type-svg', 'file-type-toml',
    'file-type-image', 'file-type-text', 'file-type-log',
    'file-type-ini', 'file-type-docker', 'file-type-config',
    'file-type-maven', 'file-type-npm', 'file-type-yarn',
    'file-type-pdf2', 'file-type-word', 'file-type-excel', 'file-type-powerpoint',
    'file-type-zip', 'file-type-audio', 'file-type-video',
  ],
  'material-icon-theme': [
    'folder-resource', 'folder-resource-open',
    'folder-target', 'folder-target-open',
    'folder-mappings', 'folder-mappings-open',
    'folder-docs', 'folder-docs-open',
    'folder-git', 'folder-git-open',
    'lock',
  ],
  'logos': [
    'spring',
  ],
};

const sets = {
  'vscode-icons': v,
  'material-icon-theme': m,
  'logos': l,
};

const out = {};
let total = 0;
let bytes = 0;
const missing = [];

for (const prefix of Object.keys(wanted)) {
  out[prefix] = { prefix, width: sets[prefix].width, height: sets[prefix].height, icons: {} };
  for (const name of wanted[prefix]) {
    const ic = sets[prefix].icons[name];
    if (!ic) {
      missing.push(`${prefix}:${name}`);
      continue;
    }
    out[prefix].icons[name] = ic;
    total++;
    bytes += JSON.stringify(ic).length;
  }
}

if (missing.length) {
  console.error('Missing icons:');
  missing.forEach((m) => console.error('  -', m));
  process.exit(1);
}

const lines = [
  '// AUTO-GENERATED — do not edit by hand.',
  '// Regenerate via: node scripts/build-icon-subset.cjs',
  '//',
  '// Icon subset extracted from @iconify-json/{vscode-icons,material-icon-theme,logos}',
  '// Total: ' + total + ' icons, ~' + (bytes / 1024).toFixed(1) + ' KB',
  '//',
  '// Usage:',
  '//   import { fallbackIconCollections } from "./iconRegistry.generated";',
  '//   fallbackIconCollections.forEach(c => addCollection(c));',
  '',
  '/* eslint-disable */',
  'export const fallbackIconCollections = [',
];
for (const prefix of Object.keys(out)) {
  lines.push('  ' + JSON.stringify(out[prefix]) + ',');
}
lines.push('] as const;');
lines.push('');

const outFile = path.resolve(__dirname, '..', 'apps/desktop/src/ui/renderer/components/iconRegistry.generated.ts');
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`✓ Wrote ${total} icons to iconRegistry.generated.ts (${(bytes / 1024).toFixed(1)} KB)`);
