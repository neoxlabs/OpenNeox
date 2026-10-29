/**
 * FilePathChip — timeline 卡片内文件路径的统一交互入口.
 *
 *   单击  →  在右侧 Surface 打开 (走 openSurfaceFromPath, 跟 agent open_surface 同条路);
 *            目录 / 不可预览的文件退化为 Finder 显示 (点了必有物理反馈, 不再静默复制)
 *   双击  →  在右侧 Surface 编辑源码 (preferCode；产品主路径, 不再开 IDE)
 *   右键  →  统一上下文菜单 (useTimelineFileActions): 在右侧编辑源码 /
 *            Finder 显示 / 复制路径 / 复制相对路径 — 双语, 复用 components/ContextMenu
 *
 * stopPropagation 全打开 — 避免触发外层 timeline 卡片的展开/收起.
 * 动作层 (存在检查 + 双语 toast + 菜单) 全部下沉到 useTimelineFileActions,
 * 这里只管 click/dblclick/键盘 手势与展示.
 */

import * as React from 'react';
import {
  useTimelineFileActions,
  type TimelineChangedLine,
  type TimelineEditHunk,
} from './useTimelineFileActions';
import { pathTooltip } from '../../utils/pathUtils';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { fileManagerShortName } from '../../utils/fileManagerLabels';

export interface FilePathChipProps {
  path: string;
  /** 路径展示文本 (可缩短为 …/foo.ts), 不传就用 path */
  display?: string;
  /** 额外 CSS class — 用在不同卡片里覆盖默认样式 */
  className?: string;
  /** 单击行为模式: 'surface' (默认, 右侧打开) | 'editor' (兼容旧调用, 现亦走右侧源码) | 'none' (无单击行为, 仅右键菜单) */
  primaryAction?: 'surface' | 'editor' | 'none';
  /** title attr 自定义 — 不传时默认为完整 path + 操作提示 */
  title?: string;
  /** Diff/edit 卡片可选传入: 单击 surface 打开时让 Monaco 高亮这些改动行区间 */
  changedLines?: TimelineChangedLine[];
  /** Edit 卡片可选传入: 单击 surface 打开时切到 Monaco DiffEditor 模式渲染老/新 diff */
  editHunks?: TimelineEditHunk[];
  /** 新建/写入文件预览兜底: 文件尚未落盘或历史 workspace 不匹配时仍可打开内容。 */
  fallbackContent?: string;
  /** 目录 — Surface/编辑器不可用, 单击与"打开"退化为 Finder 显示 */
  isDirectory?: boolean;
  /** 已删除文件 (turn summary delete 行) — 打开动作全禁, 右键仅复制路径可用 */
  deleted?: boolean;
  forceDiffView?: boolean;
}

/** click vs double-click 区分窗口 (ms) — 单击延迟此时间, 期间收到第二次 click 改成 dblclick. */
const DOUBLE_CLICK_DELAY = 240;

export const FilePathChip: React.FC<FilePathChipProps> = ({
  path,
  display,
  className = '',
  primaryAction = 'surface',
  title,
  changedLines,
  editHunks,
  fallbackContent,
  isDirectory = false,
  deleted = false,
  forceDiffView = false,
}) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const workspacePath = runtime?.workspacePath;
  const clickTimerRef = React.useRef<number | null>(null);

  const actions = useTimelineFileActions({
    path,
    isDirectory,
    deleted,
    changedLines,
    editHunks,
    fallbackContent,
    forceDiffView,
  });

  /* 单击语义:
   *   surface / editor 模式 → 右侧 Surface (editor 兼容名也走 Surface 源码, 不再开 IDE)
   *   目录/不可预览文件 → Finder 显示 (必有反馈)
   *   none / deleted → 无单击行为 (右键菜单仍可用) */
  const primaryClick = React.useMemo(() => {
    if (deleted || primaryAction === 'none') return null;
    if (primaryAction === 'editor') return () => actions.openSurface({ preferCode: true });
    if (actions.previewable) return () => actions.openSurface();
    return actions.reveal;
  }, [deleted, primaryAction, actions.previewable, actions.openSurface, actions.reveal]);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (!primaryClick) return;
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      void primaryClick();
    }, DOUBLE_CLICK_DELAY);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (deleted) return;
    void (isDirectory ? actions.reveal() : actions.openSurface({ preferCode: true }));
  };

  React.useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  const tooltipText = title ?? (() => {
    const base = pathTooltip(path, workspacePath);
    if (deleted) return isZh ? `${base}\n已删除 · 右键可复制路径` : `${base}\nDeleted — right-click to copy path`;
    if (isDirectory) {
      const fm = fileManagerShortName(isZh);
      return isZh ? `${base}\n单击在${fm}中显示 · 右键更多` : `${base}\nClick to reveal in ${fm} · right-click for more`;
    }
    if (primaryAction === 'none') return isZh ? `${base}\n右键更多操作` : `${base}\nRight-click for actions`;
    return actions.previewable
      ? (isZh ? `${base}\n单击在右侧打开 · 双击编辑源码 · 右键更多` : `${base}\nClick to open on the right · double-click to edit source · right-click for more`)
      : (() => {
          const fm = fileManagerShortName(isZh);
          return isZh ? `${base}\n单击在${fm}中显示 · 右键更多` : `${base}\nClick to reveal in ${fm} · right-click for more`;
        })();
  })();

  return (
    <>
      <span
        className={`atl-pathchip${primaryClick ? '' : ' atl-pathchip--menu-only'} ${className}`.trim()}
        title={tooltipText}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={actions.handleContextMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (primaryClick) void primaryClick();
          }
        }}
      >
        {display ?? path}
      </span>
      {actions.contextMenu}
    </>
  );
};
