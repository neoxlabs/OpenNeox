import React from 'react';
import { FilePathChip } from '../FilePathChip';
import { useI18n } from '../../../hooks/useI18n';

/* ---------- filelist ----------
 * 每行接 FilePathChip 统一原语: 文件单击 → 右侧 Surface 预览 (旧行为是 Finder 显示),
 * 目录单击 → Finder 显示; 右键 → 统一菜单 (右侧编辑源码/Finder/复制路径). */
export const FileListView: React.FC<{
  root?: string;
  entries: Array<{ path: string; isDir: boolean; depth?: number; size?: number }>;
  total?: number;
}> = ({ root, entries, total }) => {
  const { isZh } = useI18n();
  return (
    <div className="atl-filelist">
      {root && <div className="atl-filelist__root">{root}</div>}
      <ul className="atl-filelist__list">
        {entries.map((e) => {
          const abs = root ? `${root}/${e.path}` : e.path;
          return (
            <li
              key={e.path}
              className={`atl-filelist__item ${e.isDir ? 'is-dir' : 'is-file'}`}
              style={{ paddingLeft: `${(e.depth ?? 0) * 12}px` }}
            >
              <span className="atl-filelist__glyph" aria-hidden="true">
                {e.isDir ? '▸' : '·'}
              </span>
              <FilePathChip
                path={abs}
                display={e.path}
                isDirectory={e.isDir}
                className="atl-filelist__path"
              />
              {typeof e.size === 'number' && e.size > 0 && (
                <span className="atl-filelist__size">{formatSizeBytes(e.size)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {total && total > entries.length && (
        <div className="atl-filelist__more">{isZh ? `+${total - entries.length} 更多` : `+${total - entries.length} more`}</div>
      )}
    </div>
  );
};

function formatSizeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
