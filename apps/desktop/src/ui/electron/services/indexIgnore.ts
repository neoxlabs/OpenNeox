
/** 两边共用的基线 —— 任何"永远不该进索引"的东西写在这里 */
export const SHARED_INDEX_IGNORE: readonly string[] = [
  // 依赖 / 版本控制
  '**/node_modules/**', '**/.git/**', '**/.svn/**', '**/.hg/**',
  // 构建产物
  '**/dist/**', '**/build/**', '**/out/**', '**/target/**',
  '**/.next/**', '**/.nuxt/**', '**/.cache/**', '**/.turbo/**',
  '**/coverage/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**',
  // 工具目录
  '**/.neox/**', '**/<third-party-tree>/**', '**/vendor/**', '**/prebuilds/**',
  '**/.idea/**', '**/.gradle/**',
  '**/.dart_tool/**', '**/ephemeral/**', '**/.plugin_symlinks/**', '**/.pub-cache/**',
  // 二进制 / 系统垃圾
  '**/.DS_Store', '**/*.node', '**/*.wasm',
  /* 发布产物: dmg/zip/blockmap 动辄几百 MB, 每次发版全体 mtime 翻新 ——
   * 这是"一 build 就重扫上千个文件"的最大单一来源, 而它们从来不该进代码索引。 */
  '**/release/**', '**/release-*/**',
  '**/*.dmg', '**/*.blockmap', '**/*.asar', '**/*.zip', '**/*.exe', '**/*.pkg',
  '**/*.app/**',
];

/** BM25 索引额外排除的 (纯文本但没有检索价值) */
export const EMBEDDING_EXTRA_IGNORE: readonly string[] = [
  '**/*.min.js', '**/*.map',
];
