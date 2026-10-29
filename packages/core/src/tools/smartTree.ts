/**
 * Smart Tree - 智能目录扫描工具
 *
 * 针对各类编程工程优化，自动识别并跳过不需要扫描的目录，
 * 支持两阶段扫描模式，让 LLM 先看顶层结构再按需深入。
 */

import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { safeFs } from './files/safeFs.js';

// ==================== 智能排除规则配置 ====================

/**
 * 通用排除目录 - 所有项目类型都应该跳过
 */
const UNIVERSAL_SKIP_DIRS = new Set([
  // 版本控制
  '.git',
  '.svn',
  '.hg',

  // IDE/编辑器
  '.idea',
  '.vscode',
  '.vs',
  '.fleet',

  // 系统文件
  '.DS_Store',
  '__MACOSX',
  'Thumbs.db',
]);

/**
 * 依赖/构建产物目录 - 按项目类型分类
 */
const PROJECT_TYPE_RULES: Record<string, {
  /** 检测文件 - 存在这些文件说明是该类型项目 */
  detectFiles: string[];
  /** 需要跳过的目录 */
  skipDirs: string[];
  /** 需要跳过的文件模式 */
  skipPatterns?: RegExp[];
  /** 值得深入探索的目录 */
  interestingDirs: string[];
  /** 项目描述 */
  description: string;
}> = {
  // ==================== JavaScript/TypeScript 生态 ====================
  nodejs: {
    detectFiles: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    skipDirs: [
      'node_modules',
      'dist',
      'build',
      'out',
      '.next',
      '.nuxt',
      '.output',
      '.cache',
      '.parcel-cache',
      '.turbo',
      'coverage',
      '.nyc_output',
      'storybook-static',
    ],
    skipPatterns: [/\.min\.js$/, /\.bundle\.js$/, /\.chunk\.js$/],
    interestingDirs: ['src', 'lib', 'app', 'pages', 'components', 'hooks', 'utils', 'services', 'api', 'types', 'styles', 'public', 'assets', 'test', 'tests', '__tests__', 'spec'],
    description: 'Node.js/JavaScript/TypeScript project',
  },

  // ==================== Python 生态 ====================
  python: {
    detectFiles: ['setup.py', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock'],
    skipDirs: [
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.tox',
      '.nox',
      'venv',
      '.venv',
      'env',
      '.env',
      'virtualenv',
      '.eggs',
      '*.egg-info',
      'dist',
      'build',
      '.ipynb_checkpoints',
      'htmlcov',
    ],
    skipPatterns: [/\.pyc$/, /\.pyo$/],
    interestingDirs: ['src', 'lib', 'app', 'apps', 'core', 'api', 'models', 'views', 'services', 'utils', 'tests', 'test', 'scripts', 'notebooks', 'docs'],
    description: 'Python project',
  },

  // ==================== Java/Kotlin 生态 ====================
  java: {
    detectFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    skipDirs: [
      'target',
      'build',
      'out',
      '.gradle',
      'bin',
      '.mvn',
      'gradle',
    ],
    skipPatterns: [/\.class$/],
    interestingDirs: ['src', 'main', 'java', 'kotlin', 'resources', 'test', 'webapp', 'templates'],
    description: 'Java/Kotlin/Gradle/Maven project',
  },

  // ==================== Go 生态 ====================
  golang: {
    detectFiles: ['go.mod', 'go.sum'],
    skipDirs: [
      'vendor',
      'bin',
    ],
    interestingDirs: ['cmd', 'pkg', 'internal', 'api', 'web', 'configs', 'scripts', 'test', 'tests', 'docs'],
    description: 'Go project',
  },

  // ==================== Rust 生态 ====================
  rust: {
    detectFiles: ['Cargo.toml', 'Cargo.lock'],
    skipDirs: [
      'target',
    ],
    interestingDirs: ['src', 'benches', 'examples', 'tests'],
    description: 'Rust project',
  },

  // ==================== C/C++ 生态 ====================
  cpp: {
    detectFiles: ['CMakeLists.txt', 'Makefile', 'meson.build', 'configure.ac'],
    skipDirs: [
      'build',
      'cmake-build-debug',
      'cmake-build-release',
      'bin',
      'obj',
      'out',
      '.ccache',
    ],
    skipPatterns: [/\.o$/, /\.obj$/, /\.a$/, /\.so$/, /\.dll$/, /\.exe$/],
    interestingDirs: ['src', 'include', 'lib', 'tests', 'test', 'examples', 'docs'],
    description: 'C/C++ project',
  },

  // ==================== Ruby 生态 ====================
  ruby: {
    detectFiles: ['Gemfile', 'Gemfile.lock', 'Rakefile', '.ruby-version'],
    skipDirs: [
      'vendor/bundle',
      '.bundle',
      'tmp',
      'log',
      'coverage',
      'node_modules', // Rails 项目可能有
    ],
    interestingDirs: ['app', 'lib', 'config', 'db', 'spec', 'test', 'public', 'views'],
    description: 'Ruby/Rails project',
  },

  // ==================== PHP 生态 ====================
  php: {
    detectFiles: ['composer.json', 'composer.lock', 'artisan'],
    skipDirs: [
      'vendor',
      'node_modules',
      'storage/framework',
      'bootstrap/cache',
    ],
    interestingDirs: ['app', 'src', 'config', 'database', 'resources', 'routes', 'tests', 'public'],
    description: 'PHP/Laravel/Composer project',
  },

  // ==================== .NET 生态 ====================
  dotnet: {
    detectFiles: ['*.csproj', '*.fsproj', '*.sln', 'packages.config'],
    skipDirs: [
      'bin',
      'obj',
      'packages',
      '.nuget',
      'TestResults',
    ],
    skipPatterns: [/\.dll$/, /\.exe$/, /\.pdb$/],
    interestingDirs: ['src', 'lib', 'tests', 'Controllers', 'Models', 'Views', 'Services', 'Data'],
    description: '.NET/C#/F# project',
  },

  // ==================== Swift/iOS 生态 ====================
  swift: {
    detectFiles: ['Package.swift', '*.xcodeproj', '*.xcworkspace', 'Podfile'],
    skipDirs: [
      'Pods',
      'DerivedData',
      'build',
      '.build',
      'Carthage',
      'xcuserdata',
    ],
    interestingDirs: ['Sources', 'Tests', 'Resources', 'Assets'],
    description: 'Swift/iOS/macOS project',
  },

  // ==================== Flutter/Dart 生态 ====================
  flutter: {
    detectFiles: ['pubspec.yaml', 'pubspec.lock'],
    skipDirs: [
      '.dart_tool',
      'build',
      '.pub-cache',
      'ephemeral',
      '.plugin_symlinks',
      'android/build',
      'ios/Pods',
      'web/build',
    ],
    interestingDirs: ['lib', 'test', 'assets', 'android', 'ios', 'web', 'macos', 'linux', 'windows'],
    description: 'Flutter/Dart project',
  },

  // ==================== Elixir 生态 ====================
  elixir: {
    detectFiles: ['mix.exs', 'mix.lock'],
    skipDirs: [
      '_build',
      'deps',
      '.elixir_ls',
      'cover',
    ],
    interestingDirs: ['lib', 'test', 'config', 'priv', 'assets'],
    description: 'Elixir/Phoenix project',
  },
};

/**
 * 通用的值得探索目录（跨语言）
 */
const UNIVERSAL_INTERESTING_DIRS = new Set([
  'src',
  'lib',
  'app',
  'core',
  'api',
  'test',
  'tests',
  'docs',
  'doc',
  'examples',
  'scripts',
  'config',
  'configs',
]);

// ==================== 工具函数 ====================

interface ProjectInfo {
  types: string[];
  skipDirs: Set<string>;
  skipPatterns: RegExp[];
  interestingDirs: Set<string>;
  descriptions: string[];
}

/**
 * 检测项目类型
 */
async function detectProjectTypes(dirPath: string): Promise<ProjectInfo> {
  const result: ProjectInfo = {
    types: [],
    skipDirs: new Set(UNIVERSAL_SKIP_DIRS),
    skipPatterns: [],
    interestingDirs: new Set(UNIVERSAL_INTERESTING_DIRS),
    descriptions: [],
  };

  try {
    const items = await safeFs.readdir(dirPath);
    const itemSet = new Set(items);

    for (const [projectType, rules] of Object.entries(PROJECT_TYPE_RULES)) {
      // 检查是否存在检测文件
      const hasDetectFile = rules.detectFiles.some(detectFile => {
        if (detectFile.includes('*')) {
          // 支持通配符匹配（简单版本）
          const pattern = detectFile.replace('*', '');
          return items.some(item => item.endsWith(pattern) || item.startsWith(pattern.replace('.', '')));
        }
        return itemSet.has(detectFile);
      });

      if (hasDetectFile) {
        result.types.push(projectType);
        result.descriptions.push(rules.description);

        // 添加该类型的跳过目录
        rules.skipDirs.forEach(dir => result.skipDirs.add(dir));

        // 添加跳过模式
        if (rules.skipPatterns) {
          result.skipPatterns.push(...rules.skipPatterns);
        }

        // 添加有趣目录
        rules.interestingDirs.forEach(dir => result.interestingDirs.add(dir));
      }
    }
  } catch (error) {
    // 忽略读取错误
  }

  return result;
}

/**
 * 判断是否应该跳过目录
 */
function shouldSkipDir(name: string, projectInfo: ProjectInfo): boolean {
  // 检查精确匹配
  if (projectInfo.skipDirs.has(name)) return true;

  // 检查通配符模式 (如 *.egg-info)
  for (const skipDir of projectInfo.skipDirs) {
    if (skipDir.includes('*')) {
      const pattern = skipDir.replace('*', '');
      if (name.endsWith(pattern) || name.startsWith(pattern.replace('.', ''))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 判断目录是否值得深入探索
 */
function isInterestingDir(name: string, projectInfo: ProjectInfo): boolean {
  return projectInfo.interestingDirs.has(name);
}

// ==================== 目录树节点类型 ====================

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: TreeNode[];
  skipped?: boolean;
  skipReason?: string;
  isInteresting?: boolean;
  itemCount?: number; // 子项数量（用于跳过的目录）
}

// ==================== 核心扫描函数 ====================

/**
 * 扫描目录（智能模式）
 */
async function scanDirectory(
  dirPath: string,
  projectInfo: ProjectInfo,
  options: {
    maxDepth: number;
    currentDepth: number;
    shallow: boolean;
    expandInteresting: boolean;
  }
): Promise<TreeNode[]> {
  const { maxDepth, currentDepth, shallow, expandInteresting } = options;

  if (currentDepth > maxDepth) return [];

  try {
    const items = await safeFs.readdir(dirPath, { withFileTypes: true });
    const nodes: TreeNode[] = [];

    // 分离目录和文件，目录优先
    const dirs = items.filter(item => item.isDirectory() && !item.name.startsWith('.'));
    const files = items.filter(item => item.isFile() && !item.name.startsWith('.'));

    // 处理目录
    for (const item of dirs) {
      const itemPath = path.join(dirPath, item.name);

      if (shouldSkipDir(item.name, projectInfo)) {
        // 跳过的目录 - 但显示摘要信息
        let itemCount = 0;
        try {
          const subItems = await safeFs.readdir(itemPath);
          itemCount = subItems.length;
        } catch {
          // 忽略
        }

        nodes.push({
          name: item.name,
          path: itemPath,
          isDirectory: true,
          skipped: true,
          skipReason: getSkipReason(item.name, projectInfo),
          itemCount,
        });
      } else {
        // 判断是否值得展开
        const interesting = isInterestingDir(item.name, projectInfo);
        const shouldExpand = shallow
          ? false
          : (expandInteresting && interesting) || currentDepth < maxDepth;

        const children = shouldExpand
          ? await scanDirectory(itemPath, projectInfo, {
              maxDepth,
              currentDepth: currentDepth + 1,
              shallow,
              expandInteresting,
            })
          : undefined;

        nodes.push({
          name: item.name,
          path: itemPath,
          isDirectory: true,
          isInteresting: interesting,
          children,
        });
      }
    }

    // 处理文件（只在浅层或第一层显示）
    if (!shallow || currentDepth === 0) {
      for (const item of files) {
        const itemPath = path.join(dirPath, item.name);

        // 检查是否应该跳过的文件
        let shouldSkip = false;
        for (const pattern of projectInfo.skipPatterns) {
          if (pattern.test(item.name)) {
            shouldSkip = true;
            break;
          }
        }

        if (!shouldSkip) {
          try {
            const stats = await safeFs.stat(itemPath);
            nodes.push({
              name: item.name,
              path: itemPath,
              isDirectory: false,
              size: stats.size,
            });
          } catch {
            nodes.push({
              name: item.name,
              path: itemPath,
              isDirectory: false,
            });
          }
        }
      }
    }

    return nodes;
  } catch (error) {
    return [];
  }
}

/**
 * 获取跳过原因描述
 */
function getSkipReason(dirName: string, projectInfo: ProjectInfo): string {
  // 依赖目录
  if (['node_modules', 'vendor', 'Pods', 'deps', '.dart_tool', 'packages'].includes(dirName)) {
    return 'dependencies';
  }

  // 构建产物
  if (['dist', 'build', 'out', 'target', '.next', '.nuxt', 'bin', 'obj'].includes(dirName)) {
    return 'build output';
  }

  // 缓存
  if (dirName.includes('cache') || dirName.startsWith('.') && dirName.includes('_')) {
    return 'cache';
  }

  // 测试覆盖率
  if (['coverage', 'htmlcov', '.nyc_output'].includes(dirName)) {
    return 'coverage';
  }

  // 虚拟环境
  if (['venv', '.venv', 'env', 'virtualenv'].includes(dirName)) {
    return 'virtual env';
  }

  return 'auto-skipped';
}

// ==================== 格式化输出 ====================

/**
 * 格式化文件大小
 */
function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 格式化树形结构输出
 */
function formatTree(nodes: TreeNode[], prefix = ''): string[] {
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (node.isDirectory) {
      if (node.skipped) {
        // 跳过的目录 - 显示灰色/删除线效果
        const countInfo = node.itemCount !== undefined ? ` (${node.itemCount} items)` : '';
        lines.push(`${prefix}${connector}[~] ${node.name}/ [>>] ${node.skipReason}${countInfo}`);
      } else if (node.isInteresting) {
        // 值得探索的目录 - 高亮显示
        lines.push(`${prefix}${connector}[+] ${node.name}/ [*]`);
        if (node.children && node.children.length > 0) {
          lines.push(...formatTree(node.children, prefix + childPrefix));
        }
      } else {
        lines.push(`${prefix}${connector}[~] ${node.name}/`);
        if (node.children && node.children.length > 0) {
          lines.push(...formatTree(node.children, prefix + childPrefix));
        }
      }
    } else {
      const sizeInfo = node.size !== undefined ? ` (${formatSize(node.size)})` : '';
      lines.push(`${prefix}${connector}[] ${node.name}${sizeInfo}`);
    }
  }

  return lines;
}

// ==================== Layer 1: Structure 输出构建 ====================

/**
 * 构建 Structure 模式输出 - 极简 JSON 结构
 * 让 Agent 快速了解项目布局，输出极小 (~50-100 tokens)
 */
async function buildStructureOutput(
  absPath: string,
  displayPath: string,
  projectInfo: ProjectInfo
): Promise<string> {
  try {
    const items = await safeFs.readdir(absPath, { withFileTypes: true });

    // 收集根目录（排除跳过的）
    const rootDirs: string[] = [];
    const rootFiles: string[] = [];

    for (const item of items) {
      if (item.name.startsWith('.')) continue;

      if (item.isDirectory()) {
        if (!shouldSkipDir(item.name, projectInfo)) {
          rootDirs.push(item.name);
        }
      } else {
        // 只收集重要的配置文件
        if (isImportantFile(item.name)) {
          rootFiles.push(item.name);
        }
      }
    }

    // 收集模块信息（从 src/ 或其他源码目录）
    const modules: string[] = [];
    const sourceDir = rootDirs.find(d => ['src', 'lib', 'app', 'core', 'packages'].includes(d));

    if (sourceDir) {
      const sourcePath = path.join(absPath, sourceDir);
      try {
        const sourceItems = await safeFs.readdir(sourcePath, { withFileTypes: true });
        for (const item of sourceItems) {
          if (item.isDirectory() && !item.name.startsWith('.') && !shouldSkipDir(item.name, projectInfo)) {
            modules.push(item.name);
          }
        }
      } catch {
        // 忽略读取错误
      }
    }

    // 构建输出 - 使用横向紧凑格式，更易阅读
    const lines: string[] = [];

    lines.push(`📁 Path: ${displayPath}`);
    lines.push('');

    if (projectInfo.descriptions.length > 0) {
      lines.push(`📦 Project Type: ${projectInfo.descriptions.join(', ')}`);
    }

    if (rootDirs.length > 0) {
      lines.push(`📂 Root Directories: ${rootDirs.sort().join(', ')}`);
    }

    if (modules.length > 0) {
      lines.push(`🔧 Modules: ${modules.sort().join(', ')}`);
    }

    if (rootFiles.length > 0) {
      lines.push(`⚙️  Config Files: ${rootFiles.slice(0, 5).join(', ')}`);
    }

    lines.push('');
    lines.push(`💡 Tip: Use search(pattern="keyword", path="src/", recursive=true) to locate code`);

    return lines.join('\n');
  } catch (error: any) {
    return JSON.stringify({ error: error.message });
  }
}

/**
 * 判断是否是重要的配置文件
 */
function isImportantFile(name: string): boolean {
  const importantFiles = new Set([
    'package.json',
    'tsconfig.json',
    'pom.xml',
    'build.gradle',
    'Cargo.toml',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
    'Makefile',
    'Dockerfile',
    'docker-compose.yml',
    '.env.example',
    'README.md',
  ]);
  return importantFiles.has(name);
}

// ==================== 输出限制配置 ====================

/**
 * SmartTree 输出限制
 * 防止大型项目的目录树输出过大，导致 context 爆炸
 */
const OUTPUT_LIMITS = {
  /** 最大输出行数 */
  maxLines: 500,
  /** 最大输出字符数 */
  maxChars: 15000,
  /** 截断提示 */
  truncationMessage: '\n... [输出已截断，使用更具体的 directory 参数查看子目录]',
};

/**
 * 截断输出
 */
function truncateOutput(lines: string[]): string[] {
  let totalChars = 0;
  const result: string[] = [];

  for (let i = 0; i < lines.length && i < OUTPUT_LIMITS.maxLines; i++) {
    const line = lines[i];
    if (totalChars + line.length > OUTPUT_LIMITS.maxChars) {
      result.push(OUTPUT_LIMITS.truncationMessage);
      break;
    }
    result.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  if (lines.length > OUTPUT_LIMITS.maxLines && !result.includes(OUTPUT_LIMITS.truncationMessage)) {
    result.push(OUTPUT_LIMITS.truncationMessage);
  }

  return result;
}

// ==================== 导出工具定义 ====================

const WORKSPACE_ENV_KEY = 'NEOX_WORKDIR';

function getWorkspaceRoot(): string {
  const contextRoot = getWorkspaceRootFromContext();
  if (contextRoot) {
    return path.resolve(contextRoot);
  }

  const envPath = process.env[WORKSPACE_ENV_KEY];
  if (envPath && envPath.trim()) {
    return path.resolve(envPath);
  }
  return process.cwd();
}

function resolveWorkspacePath(requestedPath?: string): string {
  const workspaceRoot = getWorkspaceRoot();
  if (!requestedPath || requestedPath.trim() === '' || requestedPath.trim() === '.') {
    return workspaceRoot;
  }

  if (path.isAbsolute(requestedPath)) {
    return path.resolve(requestedPath);
  }

  return path.resolve(workspaceRoot, requestedPath);
}

function formatDisplayPath(absPath: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const relative = path.relative(workspaceRoot, absPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return absPath;
}

/**
 * 智能目录树工具
 *
 * Layer 1: 结构感知 - 让 Agent 快速了解项目结构
 * - structure 模式: 返回精简的 JSON 结构，适合 Agent 理解项目布局
 * - 其他模式: 返回可读的树形结构，适合用户查看
 */
export const smartTree: Tool = {
  name: 'smart_tree',
  description: `Smart directory scanner — detects the project type and tailors the output.

[Layered search strategy]
This is Layer 1: structural awareness. It works best paired with search (Layer 2: semantic location).

Recommended workflow:
1. smart_tree(mode="structure") → get a project structure overview (tiny output, ~50 tokens)
2. search(pattern="keyword", path="src/", recursive=true) → locate the code (with module info)
3. readfile(path, start_line, num_lines) → read only the parts that matter

Scan modes:
- structure: recommended. Returns a compact JSON structure (root_dirs + modules), ideal for getting oriented fast
- shallow: first level only, for a quick look
- normal: expands source directories intelligently, skipping dependencies and build output
- deep: expands every directory

Example:
{"mode": "structure"} → {"root_dirs": ["src","config","test"], "modules": ["auth","health","order"]}`,
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Directory path (default: current working directory). Alias: path',
      },
      path: {
        type: 'string',
        description: 'Alias for directory',
      },
      mode: {
        type: 'string',
        enum: ['structure', 'shallow', 'normal', 'deep'],
        description: 'Scan mode: structure (structural JSON), shallow, normal, deep. Default: structure',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum depth (fixed at 1-2 for structure/shallow; defaults to 3 for other modes)',
      },
    },
  },
  async function(args: any) {
    /* 模型经常发 path 而非 directory — 兼容. */
    const directory: string = args?.directory || args?.path || '.';
    const mode: string = args?.mode || 'structure';
    const max_depth: number | undefined = args?.max_depth;
    try {
      const absPath = resolveWorkspacePath(directory);
      const displayPath = formatDisplayPath(absPath);

      // 检查目录是否存在
      const stats = await safeFs.stat(absPath);
      if (!stats.isDirectory()) {
        /* 路径存在但不是目录 — 真错误, 给清晰提示 */
        return `[x] 不是目录, 是文件: ${displayPath}\n💡 用 readfile 读单文件, smart_tree 只接目录`;
      }

      // 检测项目类型
      const projectInfo = await detectProjectTypes(absPath);

      // ==================== Layer 1: Structure 模式 ====================
      // 返回极简 JSON 结构，让 Agent 快速了解项目布局
      if (mode === 'structure') {
        return await buildStructureOutput(absPath, displayPath, projectInfo);
      }

      // 根据模式设置参数
      const shallow = mode === 'shallow';
      const maxDepth = max_depth ?? (shallow ? 1 : mode === 'deep' ? 5 : 3);
      const expandInteresting = mode !== 'shallow';

      // 扫描目录
      const nodes = await scanDirectory(absPath, projectInfo, {
        maxDepth,
        currentDepth: 0,
        shallow,
        expandInteresting,
      });

      // 构建输出
      const output: string[] = [];

      // 头部信息
      output.push(`[~] ${displayPath}/`);
      output.push('');

      // 项目类型信息
      if (projectInfo.types.length > 0) {
        output.push(`[?] 检测到项目类型: ${projectInfo.descriptions.join(', ')}`);
      } else {
        output.push(`[?] 未检测到特定项目类型`);
      }

      output.push(`📊 扫描模式: ${mode} | 最大深度: ${maxDepth}`);
      output.push('');

      // 图例
      output.push('图例: [+][*] 重点目录 | [~][>>] 已跳过 | [~] 普通目录');
      output.push('─'.repeat(50));
      output.push('');

      // 树形结构
      if (nodes.length === 0) {
        output.push('(空目录)');
      } else {
        output.push(...formatTree(nodes));
      }

      // 统计信息
      const skipCount = countSkipped(nodes);
      const interestingCount = countInteresting(nodes);

      output.push('');
      output.push('─'.repeat(50));
      output.push(`统计: ${interestingCount} 个重点目录 | ${skipCount} 个已跳过目录`);

      if (shallow) {
        output.push('');
        output.push('💡 提示: 使用 mode="normal" 深入探索感兴趣的目录');
      }

      // 应用输出截断，防止 context 爆炸
      const truncatedOutput = truncateOutput(output);
      return truncatedOutput.join('\n');
    } catch (error: any) {
      /* 给具体的诊断信息, 让模型知道是路径错还是别的. 不再 [x] 简短前缀. */
      if (error.code === 'ENOENT') {
        return `Directory does not exist: ${directory}\n💡 Use list_directory or smart_tree with a different path. Workspace root is the default if you pass nothing.`;
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return `Permission denied scanning: ${directory}\n💡 The path exists but Neox app process can't read it. Check macOS system file access permissions in System Settings → Privacy.`;
      }
      return `smart_tree scan failed: ${error.message} (code=${error.code || 'unknown'}). Path: ${directory}`;
    }
  },
};

/**
 * 统计跳过的目录数量
 */
function countSkipped(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.skipped) count++;
    if (node.children) count += countSkipped(node.children);
  }
  return count;
}

/**
 * 统计有趣目录数量
 */
function countInteresting(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.isInteresting) count++;
    if (node.children) count += countInteresting(node.children);
  }
  return count;
}

export default smartTree;
