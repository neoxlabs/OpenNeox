/**
 * neoxArtifacts — Neox 拥有的可渲染 artifact 目录, 集中管理.
 *
 * 契约:
 *   任何 Neox 内部产的**渲染层需要读的**衍生/缓存文件 (PDF 转换缓存 / rasterize 输出 / 下载 asset /
 *   图像生成产物 / 缩略图 / 索引 …) 都写到 <userData>/neox-artifacts/<category>/ 下.
 *   fileSystemHandlers 的 surface 文件守卫把这个根目录进 allowed bases —
 *   之后任何写到这里的文件都能被 renderer 通过 surfaceReadFile 读, 免于逐案批 "access denied".
 *
 * 分类:
 *   office-cache/   pptx→PDF 等 Office 老格式转换缓存 (mtime-keyed)
 *   raster-cache/   Presentation→PNG 幻灯片图片缓存
 *   image-cache/    图片下载 / 缩略图 / 尺寸变体
 *   download/       agent 触发的下载 asset (Wikimedia 图 / 素材包)
 *   generated/      AI 图像生成产物
 *   thumbnail/      任意文件生成的缩略图
 *   other/          未归类兜底
 *
 * 为什么不用 tmpdir:
 *   tmpdir 会被系统 GC (重启/长闲清理), 缓存丢就要重来. Neox artifact 是"我们的东西",
 *   应该跟 app data 一起持久化到用户重装/清应用数据才清.
 *
 * 为什么不放 userData 根:
 *   userData 里还有 auth.enc / sessions / secrets 敏感数据, 全放会让 renderer 意外能读到.
 *   一个明确的子树 `userData/neox-artifacts/` 语义上告诉守卫 "此路径下渲染可信",
 *   其它 userData 部分照旧受保护.
 */

import { lazyElectron } from '../lazyElectron.js';

const app = lazyElectron<typeof import('electron').app>('app');
import { promises as fs, existsSync, mkdirSync } from 'fs';
import path from 'node:path';

export type ArtifactCategory =
  | 'office-cache'
  | 'raster-cache'
  | 'image-cache'
  | 'download'
  | 'generated'
  | 'thumbnail'
  | 'other';

/** artifact 根目录. fileSystemHandlers 的 surface guard 允许这个树里所有文件. */
export function getNeoxArtifactsRoot(): string {
  return path.join(app.getPath('userData'), 'neox-artifacts');
}

/** 拿分类子目录 (自动 mkdir -p). 所有 Neox 内部产文件的 target dir 都从这里来. */
export function getArtifactDir(category: ArtifactCategory): string {
  const dir = path.join(getNeoxArtifactsRoot(), category);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 生成一个 artifact 文件的完整路径 (不创建, 只拼路径). */
export function artifactPath(category: ArtifactCategory, filename: string): string {
  return path.join(getArtifactDir(category), filename);
}

/** 清某一类缓存 (调试/用户手动清). 返回删除的文件数. */
export async function clearArtifactCategory(category: ArtifactCategory): Promise<{ removed: number }> {
  const dir = getArtifactDir(category);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const e of entries) {
    try {
      await fs.rm(path.join(dir, e), { recursive: true, force: true });
      removed++;
    } catch { /* ignore individual failures */ }
  }
  return { removed };
}

/** 报个 artifact root 目录占的总磁盘 (给设置面板显示 "清缓存 (XX MB)"). */
export async function getArtifactsTotalSize(): Promise<number> {
  const root = getNeoxArtifactsRoot();
  return sumDirSize(root);
}

async function sumDirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        total += await sumDirSize(p);
      } else if (e.isFile()) {
        const stat = await fs.stat(p);
        total += stat.size;
      }
    } catch { /* skip */ }
  }
  return total;
}
