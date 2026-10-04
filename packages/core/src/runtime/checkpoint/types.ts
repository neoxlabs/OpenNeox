/**
 * Shadow Git Checkpoint 类型定义
 */

/** 文件变更类型 */
export type ChangeType =
  | 'create'   // 创建文件
  | 'modify'   // 修改文件
  | 'delete'   // 删除文件
  | 'mkdir'    // 创建目录
  | 'rmdir'    // 删除目录
  | 'rename';  // 重命名/移动

/** 单个文件变更记录 */
export interface FileChange {
  type: ChangeType;
  path: string;           // 相对于 workspace 的路径
  timestamp: number;
  /** 删除/修改前的内容 (用于恢复) */
  previousContent?: string;
  /** 重命名时的原路径 */
  previousPath?: string;
  /** 新内容 (用于显示 diff) */
  newContent?: string;
  /** 文件大小 (bytes) */
  size?: number;
  /** 是否为二进制文件 */
  isBinary?: boolean;
  /** 是否为大文件 (跳过内容存储) */
  isLargeFile?: boolean;
}

/** 变更统计 */
export interface ChangeStats {
  created: number;    // 新建文件数
  modified: number;   // 修改文件数
  deleted: number;    // 删除文件数
  directories: number; // 目录变更数
  total: number;      // 总变更数
}

/** Checkpoint 元数据 */
export interface CheckpointMeta {
  id: string;              // Git commit hash
  label: string;           // 用户可读标签
  timestamp: number;
  sessionId: string;
  messageIndex: number;    // 对应的消息索引
  changes: FileChange[];   // 变更列表
  stats: ChangeStats;      // 变更统计
}

/** Checkpoint 列表项 (不含完整变更列表) */
export interface CheckpointListItem {
  id: string;
  label: string;
  timestamp: number;
  sessionId: string;
  messageIndex: number;
  stats: ChangeStats;
}

/** Shadow Git 配置 */
export interface ShadowGitConfig {
  /** 忽略的路径模式 */
  ignoredPatterns: string[];
  /** 最大保留的 checkpoint 数量 */
  maxCheckpoints: number;
  /** checkpoint 过期时间 (毫秒) */
  checkpointTTL: number;
  /** 是否启用 */
  enabled: boolean;
  /** 大文件阈值 (bytes)，超过此大小的文件不存储内容 */
  largeFileThreshold: number;
  /** 非常大的文件阈值 (bytes)，超过此大小的文件跳过同步到 shadow */
  veryLargeFileThreshold: number;
  /** 二进制文件扩展名列表 */
  binaryExtensions: string[];
}

/** 常见二进制文件扩展名 */
export const BINARY_EXTENSIONS = [
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif',
  // 音视频
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.wav', '.ogg', '.webm',
  // 压缩文件
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  // 可执行文件
  '.exe', '.dll', '.so', '.dylib', '.bin', '.app',
  // 文档
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // 数据库
  '.db', '.sqlite', '.sqlite3',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 其他
  '.jar', '.war', '.class', '.pyc', '.pyo', '.o', '.a', '.lib',
  '.node', '.wasm', '.asar',
];

/** 默认配置 */
export const DEFAULT_SHADOW_GIT_CONFIG: ShadowGitConfig = {
  ignoredPatterns: [
    // ==================== Git & 版本控制 ====================
    '**/.git/**',
    '**/.cdundo/**',
    '**/.svn/**',
    '**/.hg/**',

    // ==================== 系统文件 ====================
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/desktop.ini',
    '**/*.log',
    '**/*.tmp',
    '**/*.temp',
    '**/*.swp',
    '**/*.swo',
    '**/*~',

    // ==================== Node.js / 前端 ====================
    '**/node_modules/**',
    '**/bower_components/**',
    '**/.npm/**',
    '**/.yarn/**',
    '**/.pnpm-store/**',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',

    // ==================== 打包产物 / 构建输出 ====================
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/output/**',
    '**/.output/**',
    '**/target/**',
    '**/bin/**',
    '**/obj/**',
    '**/*.bundle.js',
    '**/*.bundle.css',
    '**/*.min.js',
    '**/*.min.css',

    // ==================== 框架特定 ====================
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.astro/**',
    '**/.vercel/**',
    '**/.netlify/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.webpack/**',
    '**/.vite/**',

    // ==================== 测试 & 覆盖率 ====================
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/jest_cache/**',
    '**/.jest/**',

    // ==================== Python ====================
    '**/__pycache__/**',
    '**/*.pyc',
    '**/*.pyo',
    '**/*.pyd',
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',
    '**/.env/**',
    '**/virtualenv/**',
    '**/.Python',
    '**/pip-wheel-metadata/**',
    '**/*.egg-info/**',
    '**/.eggs/**',
    '**/site-packages/**',

    // ==================== Java / Kotlin / Scala ====================
    '**/target/**',
    '**/.gradle/**',
    '**/gradle/**',
    '**/.m2/**',
    '**/*.class',
    '**/*.jar',
    '**/*.war',
    '**/*.ear',

    // ==================== Rust ====================
    '**/target/**',
    '**/*.rlib',
    '**/Cargo.lock',

    // ==================== Go ====================
    '**/vendor/**',
    '**/go.sum',

    // ==================== .NET / C# ====================
    '**/bin/**',
    '**/obj/**',
    '**/packages/**',
    '**/.nuget/**',
    '**/*.dll',
    '**/*.exe',
    '**/*.pdb',

    // ==================== Ruby ====================
    '**/vendor/bundle/**',
    '**/.bundle/**',
    '**/Gemfile.lock',

    // ==================== PHP ====================
    '**/vendor/**',
    '**/composer.lock',

    // ==================== IDE & 编辑器 ====================
    '**/.idea/**',
    '**/.vscode/**',
    '**/*.sublime-*',
    '**/.project',
    '**/.classpath',
    '**/.settings/**',
    '**/*.iml',

    // ==================== 环境配置 ====================
    '**/.env.local',
    '**/.env.*.local',
    '**/.env.development',
    '**/.env.production',

    // ==================== 其他大文件 / 临时文件 ====================
    '**/*.sqlite',
    '**/*.sqlite3',
    '**/*.db',
    '**/npm-debug.log*',
    '**/yarn-debug.log*',
    '**/yarn-error.log*',
    '**/.pnpm-debug.log*',
  ],
  maxCheckpoints: 50,
  checkpointTTL: 24 * 60 * 60 * 1000, // 24 小时
  enabled: false,
  largeFileThreshold: 1024 * 1024,        // 1 MB - 不读取内容到内存
  veryLargeFileThreshold: 10 * 1024 * 1024, // 10 MB - 跳过同步到 shadow
  binaryExtensions: BINARY_EXTENSIONS,
};

/** Diff 行信息 */
export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/** 文件 Diff 信息 */
export interface FileDiff {
  path: string;
  status: 'A' | 'M' | 'D' | 'R'; // Added, Modified, Deleted, Renamed
  oldPath?: string;              // 重命名时的原路径
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Checkpoint 详细 Diff */
export interface CheckpointDiff {
  checkpointId: string;
  files: FileDiff[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}
