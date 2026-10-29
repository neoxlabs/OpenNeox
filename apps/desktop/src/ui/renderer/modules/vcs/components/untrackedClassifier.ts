/* ============================================================
 * untrackedClassifier — 按常见 .gitignore 模式归类 untracked 文件
 *
 *   目标: 19 个 untracked 不要平铺一长串. 按用户"建议加 .gitignore 的程度"分:
 *     1. deps    — 依赖目录 (node_modules / vendor / __pycache__ / target / .venv...)
 *     2. build   — 构建产物 (dist / build / out / .next / coverage...)
 *     3. tmp     — 临时/日志 (*.log / *.tmp / *.swp / .DS_Store...)
 *     4. ide     — IDE 元数据 (.vscode / .idea / *.iml / .DS_Store)
 *     5. byDir   — 其它按目录分组 (3+ 同目录文件)
 *     6. loose   — 散文件 (顶层 / 唯一目录里的孤儿)
 *
 *   每个 bucket 带 suggestedPattern[] — 一键加到 .gitignore 用.
 *   pattern 用 glob 形态 (node_modules/, *.log, .DS_Store), 直接 append 到 .gitignore.
 *
 *   "智能" = 不硬编码到代码里的 magic; 模式来自社区 gitignore 模板 + 现项目 .gitignore
 *   常见前缀. 如果用户已经在 .gitignore 里写了某模式, 这里检测后跳过分组 (因为
 *   按理 git 不会再 untrack). 但为防御性, 还是先分组, 再让 UI 显"已在 .gitignore".
 * ============================================================ */

export interface ClassifiableFile {
  /** 仓库相对路径 (跟 git status --porcelain 返回的一致) */
  path: string;
  /** 透传字段 — 调用方可附加任何 metadata, classifier 不解读 */
  [key: string]: any;
}

export type BucketKey = 'deps' | 'build' | 'tmp' | 'ide' | 'byDir' | 'loose';

export interface Bucket<T extends ClassifiableFile = ClassifiableFile> {
  key: BucketKey;
  /** 中文 label, 供 UI group header */
  label: string;
  /** 描述 — 副标题用 */
  description: string;
  /** 默认是否折叠 (deps/build/tmp/ide 默认折叠避免占空间) */
  defaultCollapsed: boolean;
  /** 该 bucket 的所有文件 */
  files: T[];
  /** 建议追加到 .gitignore 的 pattern 列表 — 已 dedupe */
  suggestedPatterns: string[];
}

/* ────────────── 规则定义 ────────────── */

interface Rule {
  bucket: Exclude<BucketKey, 'byDir' | 'loose'>;
  /** path 命中此正则就归到此 bucket */
  test: RegExp;
  /** 命中时, 建议追加到 .gitignore 的 pattern; 用函数允许根据 path 动态推荐 */
  pattern: (path: string) => string | null;
}

const RULES: Rule[] = [
  /* ───── deps: 依赖目录 ───── */
  { bucket: 'deps', test: /^node_modules\//,      pattern: () => 'node_modules/' },
  { bucket: 'deps', test: /\/node_modules\//,     pattern: () => 'node_modules/' },
  { bucket: 'deps', test: /^vendor\//,            pattern: () => 'vendor/' },
  { bucket: 'deps', test: /__pycache__\//,        pattern: () => '**/__pycache__/' },
  { bucket: 'deps', test: /\.pyc$/,               pattern: () => '*.pyc' },
  { bucket: 'deps', test: /^\.venv\//,            pattern: () => '.venv/' },
  { bucket: 'deps', test: /^venv\//,              pattern: () => 'venv/' },
  { bucket: 'deps', test: /^target\//,            pattern: () => 'target/' },
  { bucket: 'deps', test: /^Pods\//,              pattern: () => 'Pods/' },
  { bucket: 'deps', test: /\.(lock)$/,            pattern: (p) => p.endsWith('package-lock.json') ? null : '*.lock' },
  /* ───── build: 构建产物 ───── */
  { bucket: 'build', test: /^dist\//,             pattern: () => 'dist/' },
  { bucket: 'build', test: /^build\//,            pattern: () => 'build/' },
  { bucket: 'build', test: /^out\//,              pattern: () => 'out/' },
  { bucket: 'build', test: /^\.next\//,           pattern: () => '.next/' },
  { bucket: 'build', test: /^\.nuxt\//,           pattern: () => '.nuxt/' },
  { bucket: 'build', test: /^\.output\//,         pattern: () => '.output/' },
  { bucket: 'build', test: /^\.turbo\//,          pattern: () => '.turbo/' },
  { bucket: 'build', test: /^\.parcel-cache\//,   pattern: () => '.parcel-cache/' },
  { bucket: 'build', test: /^\.cache\//,          pattern: () => '.cache/' },
  { bucket: 'build', test: /^coverage\//,         pattern: () => 'coverage/' },
  { bucket: 'build', test: /\.map$/,              pattern: () => '*.map' },
  { bucket: 'build', test: /\.tsbuildinfo$/,      pattern: () => '*.tsbuildinfo' },
  /* ───── tmp: 临时/日志 ───── */
  { bucket: 'tmp', test: /\.log$/,                pattern: () => '*.log' },
  { bucket: 'tmp', test: /\.tmp$/,                pattern: () => '*.tmp' },
  { bucket: 'tmp', test: /\.bak$/,                pattern: () => '*.bak' },
  { bucket: 'tmp', test: /\.swp$/,                pattern: () => '*.swp' },
  { bucket: 'tmp', test: /\.swo$/,                pattern: () => '*.swo' },
  { bucket: 'tmp', test: /~$/,                    pattern: () => '*~' },
  { bucket: 'tmp', test: /^logs\//,               pattern: () => 'logs/' },
  /* ───── ide / os ───── */
  { bucket: 'ide', test: /^\.vscode\//,           pattern: () => '.vscode/' },
  { bucket: 'ide', test: /^\.idea\//,             pattern: () => '.idea/' },
  { bucket: 'ide', test: /\.iml$/,                pattern: () => '*.iml' },
  { bucket: 'ide', test: /\.DS_Store$/,           pattern: () => '.DS_Store' },
  { bucket: 'ide', test: /^Thumbs\.db$/,          pattern: () => 'Thumbs.db' },
];

const BUCKET_META: Record<BucketKey, { label: string; description: string; defaultCollapsed: boolean }> = {
  deps:  { label: '依赖文件',     description: '建议加入 .gitignore', defaultCollapsed: true  },
  build: { label: '构建产物',     description: '建议加入 .gitignore', defaultCollapsed: true  },
  tmp:   { label: '临时与日志',   description: '建议加入 .gitignore', defaultCollapsed: true  },
  ide:   { label: 'IDE / 系统',   description: '建议加入 .gitignore', defaultCollapsed: true  },
  byDir: { label: '其它',         description: '按目录归类',          defaultCollapsed: false },
  loose: { label: '散文件',       description: '顶层 / 单文件',       defaultCollapsed: false },
};

/* ────────────── 主分类函数 ────────────── */

export function classifyUntracked<T extends ClassifiableFile>(files: T[]): Bucket<T>[] {
  if (files.length === 0) return [];

  const byBucket = new Map<Exclude<BucketKey, 'byDir' | 'loose'>, { files: T[]; patterns: Set<string> }>();
  const unmatched: T[] = [];

  for (const f of files) {
    let matched = false;
    for (const rule of RULES) {
      if (rule.test.test(f.path)) {
        const pattern = rule.pattern(f.path);
        let entry = byBucket.get(rule.bucket);
        if (!entry) {
          entry = { files: [], patterns: new Set() };
          byBucket.set(rule.bucket, entry);
        }
        entry.files.push(f);
        if (pattern) entry.patterns.add(pattern);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(f);
  }

  /* ───── 剩下的按目录分组: 3+ 同目录 → byDir 组, 否则 loose ───── */
  const dirMap = new Map<string, T[]>();
  for (const f of unmatched) {
    const dir = dirOf(f.path);
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(f);
  }

  const byDirFiles: T[] = [];
  const looseFiles: T[] = [];
  for (const [dir, list] of dirMap) {
    if (dir && list.length >= 3) {
      byDirFiles.push(...list);
    } else {
      looseFiles.push(...list);
    }
  }

  /* ───── 组装 buckets, 按固定顺序输出 ───── */
  const order: BucketKey[] = ['loose', 'byDir', 'tmp', 'ide', 'build', 'deps'];
  const out: Bucket<T>[] = [];
  for (const key of order) {
    if (key === 'byDir') {
      if (byDirFiles.length === 0) continue;
      out.push({
        key,
        ...BUCKET_META.byDir,
        files: byDirFiles,
        suggestedPatterns: [],
      });
      continue;
    }
    if (key === 'loose') {
      if (looseFiles.length === 0) continue;
      out.push({
        key,
        ...BUCKET_META.loose,
        files: looseFiles,
        suggestedPatterns: [],
      });
      continue;
    }
    const entry = byBucket.get(key);
    if (!entry || entry.files.length === 0) continue;
    out.push({
      key,
      ...BUCKET_META[key],
      files: entry.files,
      suggestedPatterns: [...entry.patterns].sort(),
    });
  }
  return out;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}
