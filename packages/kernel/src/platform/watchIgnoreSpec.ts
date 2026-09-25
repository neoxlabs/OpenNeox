/**
 * watchIgnoreSpec — 工作区文件监听/扫描的**唯一**忽略清单。
 *
 * 为什么要有这个文件
 * ------------------
 * 同一棵工作区树上有两个消费者:
 *   · agent 侧 —— neox-core `WatchCoordinator` → @parcel/watcher (checkpoint / 索引 / embedding 订阅)
 *   · UI 侧 —— desktop 资源管理器 watcher   → fs.watch recursive (FileExplorer 自动刷新)
 *
 * 两份清单原先各写各的, 已经漂移: core 有 `.zed` / `.vscode-server` / `Pictures…Downloads`,
 * desktop 有 `.parcel-cache` / `.vite` / `.nuxt` / `.expo`。漂移的后果不是"多扫一点" ——
 * 而是**同一棵树两个消费者看到的范围不一致**: 界面里看不见的文件 agent 能改, 反之亦然;
 * 更糟的是判断"哪些目录永不进模型"的地方会出现两套答案。
 *
 * 所以: 忽略目录名只在这里定义一次。新增请只改本文件, 两个消费者自动同步。
 *
 * 加一条的门槛 (别把这里变成万能垃圾桶)
 * ------------------------------------
 *   1. 该目录名在任意层级出现, 都**必然**是缓存/产物/toolchain home, 不会是用户源码;
 *   2. 它要么文件数极大, 要么写入频率极高 (否则不值得为它牺牲一次 readdir 判断)。
 * 拿不准就别加 —— 漏掉一个目录只是多点 CPU, 误加会让用户的真实代码在工具里"消失"。
 *
 * 注意: 这里只放**目录名**与**目录后缀**。扩展名 / 单文件名 (*.log / .DS_Store 这类)
 * 由各消费者自己按 glob 形态维护 —— 它们的匹配语义 (picomatch vs 路径分段) 不同, 合并
 * 反而会引入"看起来一样实际匹配不上"的假统一。
 */

/** 任意层级命中即忽略整个子树的一级目录名。 */
export const WATCH_IGNORE_DIRS: readonly string[] = [
  /* VCS / 包管理器 / 构建产物 */
  'node_modules', '.git', '.neox', 'dist', 'build', 'out', 'reverse',
  'release', 'releases', 'coverage', 'target', '__pycache__',
  /* JS / TS 生态缓存 */
  '.cache', '.turbo', '.parcel-cache', '.next', '.nuxt', '.svelte-kit', '.vite',
  '.expo', '.yarn', '.pnpm-store', '.npm', '.nvm', '.pnpm', '.bun', '.deno',
  /* 各语言 toolchain home */
  '.cargo', '.rustup', '.gem', '.venv', 'venv', '.conda', '.miniconda', '.anaconda',
  '.poetry', '.pyenv', '.rbenv', '.m2', '.ivy2', '.sbt', '.gradle',
  /* Flutter / Dart 的 ephemeral 和 .plugin_symlinks 是工具链生成目录，写入频繁且不属于
   * 用户源码；监听回调必须丢弃这些路径，避免递归 watcher 消耗主线程资源。 */
  '.dart_tool', 'ephemeral', '.plugin_symlinks', '.pub-cache',
  /* IDE 大容量数据 / 系统目录 */
  '.idea', '.cdundo', '.cursor', '.zed', '.vscode-server', '.vscode-insiders',
  'Pods', 'DerivedData', 'Caches', 'Library',
  /* 集装箱 / 沙箱 */
  '.docker', '.terraform', '.local', '.android',
  /* 用户媒体 — 工作区落在 $HOME 时不该感知 */
  'Pictures', 'Movies', 'Music', 'Downloads', 'Trash', '.Trash',
];

/**
 * 目录后缀 — segment 以它结尾且长于它时忽略 (macOS bundle / 归档目录)。
 * `path.extname` 式的 endsWith 判断, 不能退化成"包含"。
 */
export const WATCH_IGNORE_DIR_SUFFIXES: readonly string[] = [
  '.app', '.framework', '.bundle', '.xcassets',
  '.xcodeproj', '.dSYM', '.lproj', '.bak',
];

const IGNORE_DIR_SET: ReadonlySet<string> = new Set(WATCH_IGNORE_DIRS);

/** 单个路径分段是否属于"永不监听/永不索引"的目录。两个消费者共用这一条判断。 */
export function isWatchIgnoredDirSegment(segment: string): boolean {
  if (!segment) return false;
  if (IGNORE_DIR_SET.has(segment)) return true;
  for (const suffix of WATCH_IGNORE_DIR_SUFFIXES) {
    if (segment.length > suffix.length && segment.endsWith(suffix)) return true;
  }
  return false;
}
