/**
 * FileExplorer - Project View 文件资源管理器组件
 *
 * 架构 (IDEA-style):
 *   - 单一动作注册表 fileActions   ← src/ui/renderer/modules/explorer/actions/fileActions.ts
 *   - 通用右键菜单 ContextMenu     ← src/ui/renderer/components/ContextMenu.tsx
 *   - 文件操作服务 fileSystemService ← src/ui/renderer/services/fileSystemService.ts
 *   - 剪贴板单例 fileClipboard     ← src/ui/renderer/modules/explorer/state/fileClipboard.ts
 *   - 全局 Keymap (with context)   ← src/ui/renderer/hooks/useKeymap.ts
 *
 * 交互行为:
 *   - 单击      → 默认 (openOnSingleClick=true, VSCode 风格): 文件立即打开 / 目录立即展开折叠。
 *                 视图选项可切回 IDEA 老行为 (单击只选中, 双击才打开)。
 *                 ⌘/⇧ 单击永远只做多选, 不打开。
 *   - 双击      → 打开文件 / 展开目录 (两种模式下都兼容)
 *   - 右键      → 弹 ContextMenu
 *   - F2        → 进入行内 rename 模式
 *   - Delete    → 移到回收站(弹确认框)
 *   - Enter     → 打开文件 / 展开目录
 *   - ↑↓        → 选中上一项 / 下一项 (只选中, 不打开)
 *   - → / ←     → 展开目录/进入第一个子项 / 折叠目录/跳到父目录
 *   - Home/End  → 跳到第一个 / 最后一个可见节点
 *   - ⌘C/⌘V/⌘X → 复制 / 粘贴 / 剪切 文件 (focus 在树时才生效)
 *   - ⌘D        → 复制副本
 *   - ⌘⇧C       → 复制绝对路径
 */

import React, { useState, useEffect, useCallback, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import Icons from '../../../components/Icons';
import {
  IconFolder as IconFolderStroke,
  IconFile, IconFolderPlus, IconCopy, IconPencil, IconTrash,
  IconUndo, IconTerminal, IconAt, IconLink, IconScissors, IconClipboard, IconLayers,
} from '../../shell/shellIcons';
import * as FT from '../../../components/FileTypeIcons';
import { filePathKey } from '../../../utils/pathUtils';
import { ContextMenu, type ContextMenuItem } from '../../../components/ContextMenu';
import { NewItemDialog, ConfirmDeleteDialog } from '../../../components/FileDialogs';
import { confirmAsync } from '../../../components/confirmEvents';
import { useI18n } from '../../../hooks/useI18n';
import { useTopicSubscription, useCommandShortcut, useFocusScope } from '../../../platform';
import { FILES_TOPIC } from '../../../../../ide';
import { fileSystemService } from '../../../services/fileSystemService';
import { fileClipboard } from '../state/fileClipboard';

function gitStatusTitle(status: string, isZh: boolean): string {
  const zh: Record<string, string> = {
    M: '已修改', A: '新增（已暂存）', D: '已删除', U: '未跟踪（不在 git 里）',
    R: '已重命名', C: '已复制', '?': '未跟踪（不在 git 里）', '!': '被 .gitignore 忽略',
  };
  const en: Record<string, string> = {
    M: 'Modified', A: 'Added (staged)', D: 'Deleted', U: 'Untracked (not in git)',
    R: 'Renamed', C: 'Copied', '?': 'Untracked (not in git)', '!': 'Ignored by .gitignore',
  };
  const table = isZh ? zh : en;
  /* 认不出的状态字符退回原样, 不硬编一句可能是错的解释 */
  return table[status] ?? `git: ${status}`;
}
import {
  fileActions,
  buildContextMenuItems,
  executeFileAction,
  type FileActionContext,
} from '../actions/fileActions';
import { explorerSettings, useExplorerSettings, type SortBy } from '../state/explorerSettings';
import { retainGitRepo } from '../../../state/gitStateStore';
import { useGitFileBadge } from '../../../hooks/useGitState';

const MENU_ICON: Record<string, React.ReactNode> = {
  'file.newFile': <IconFile size={15} />,
  'file.newFolder': <IconFolderPlus size={15} />,
  'file.cut': <IconScissors size={15} />,
  'file.copy': <IconCopy size={15} />,
  'file.paste': <IconClipboard size={15} />,
  'file.copyPath': <IconLink size={15} />,
  'file.copyRelativePath': <IconLink size={15} />,
  'file.duplicate': <IconLayers size={15} />,
  'file.rename': <IconPencil size={15} />,
  'file.revert': <IconUndo size={15} />,
  'file.delete': <IconTrash size={15} />,
  'file.revealInFinder': <IconFolderStroke size={15} />,
  'file.attachToComposer': <IconAt size={15} />,
  'file.openInTerminal': <IconTerminal size={15} />,
};

function withMenuIcons(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.map((it) => (it.separator ? it : { ...it, icon: it.icon ?? MENU_ICON[it.id as string] }));
}

export type ViewScope = 'project' | 'openFiles' | 'changedFiles';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  /** 修改时间 (ms),由 IPC 提供。可选 */
  mtime?: number;
}

/**
 * 排序入口 - 跟 IDEA Project View 设置对齐
 */
function applySorting(
  files: FileEntry[],
  sortBy: SortBy,
  foldersFirst: boolean
): FileEntry[] {
  const sorted = [...files];
  // 先做主排序
  switch (sortBy) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'type': {
      // 按扩展名分组
      const ext = (n: string) => {
        const idx = n.lastIndexOf('.');
        return idx >= 0 ? n.slice(idx + 1).toLowerCase() : '';
      };
      sorted.sort((a, b) => {
        const ae = ext(a.name);
        const be = ext(b.name);
        if (ae !== be) return ae.localeCompare(be);
        return a.name.localeCompare(b.name);
      });
      break;
    }
    case 'time-asc':
      sorted.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
      break;
    case 'time-desc':
      sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      break;
  }
  // foldersFirst 后处理
  if (foldersFirst) {
    sorted.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return 0;
    });
  }
  return sorted;
}

interface FileTreeNodeProps {
  entry: FileEntry;
  level: number;
  expandedDirs: Set<string>;
  selectedFile: string | null;
  /** 当前 inline rename 中的 path,匹配则 file-name 替换为 input */
  renamingPath: string | null;
  onToggleDir: (path: string) => void;
  /** 选中回调。isDirectory 让消费方能拒绝把目录当文件打开/预览 (目录 read 会报 EISDIR)。 */
  onSelectFile: (path: string, isDirectory?: boolean) => void;
  /** 双击文件 → 在编辑器打开 */
  onOpenFile: (path: string) => void;
  /** 选中(单击) → 不打开,只 set selectedFile。modifier 区分多选语义 */
  onSelect: (path: string, isDirectory: boolean, modifier?: 'cmd' | 'shift') => void;
  /** 多选集合 — 用于判断 isMultiSelected */
  selectedPaths: Set<string>;
  /** 右键 → 弹 ContextMenu */
  onContextMenu: (e: React.MouseEvent, path: string, isDirectory: boolean) => void;
  /** 提交 inline rename */
  onCommitRename: (oldPath: string, newName: string) => void;
  /** 取消 inline rename */
  onCancelRename: () => void;
  /** 拖拽: 全局当前 hover 的目录 path,用于高亮 */
  dragOverPath: string | null;
  /** 拖拽: 开始 */
  onDragStartNode: (e: React.DragEvent, path: string, isDirectory?: boolean, name?: string) => void;
  /** 拖拽: 进入节点 */
  onDragOverNode: (e: React.DragEvent, path: string, isDirectory: boolean) => void;
  /** 拖拽: 离开节点 */
  onDragLeaveNode: (path: string) => void;
  /** 拖拽: 在节点上释放 */
  onDropNode: (e: React.DragEvent, path: string, isDirectory: boolean) => void;
  loadChildren: (path: string) => Promise<FileEntry[]>;
  /** 最近被 VFS 标记为改过的路径集合，应用 .recently-changed 样式 */
  recentlyChangedPaths: Set<string>;
  /** git 仓库 (工作区路径): 行按自己的路径订阅角标 (M/A/D/U/C/R) */
  gitCwd: string;
  /** 目录重载 token map — entry.path 对应 token 变化时本节点强制 re-fetch children.
   *  FILES_TOPIC 事件触发 FileExplorer.refreshDir(parent) → bumpDirReloadToken(parent). */
  dirReloadTokens: Map<string, number>;
  /** 单击即打开/展开 (VSCode 风格)。false = 单击只选中 (IDEA 老行为) */
  openOnSingleClick: boolean;
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  entry,
  level,
  expandedDirs,
  selectedFile,
  selectedPaths,
  renamingPath,
  dragOverPath,
  onToggleDir,
  onSelectFile,
  onOpenFile,
  onSelect,
  onContextMenu,
  onCommitRename,
  onCancelRename,
  onDragStartNode,
  onDragOverNode,
  onDragLeaveNode,
  onDropNode,
  loadChildren,
  recentlyChangedPaths,
  dirReloadTokens,
  gitCwd,
  openOnSingleClick,
}) => {
  const { isZh } = useI18n();
  const [children, setChildren] = useState<FileEntry[]>([]);
  const isExpanded = expandedDirs.has(entry.path);
  const gitStatus = useGitFileBadge(gitCwd, entry.path);
  // lead = 当前主选中(光标位置) / multi = 在多选集合里
  /* Win 树节点 path 多为 `\`, Surface tab.url 经 normalize 后是 `/` —— 必须用 filePathKey 判等,
   * 否则选中高亮全灭, 看起来像「点了没反应」。 */
  const isLead = !!selectedFile && filePathKey(selectedFile) === filePathKey(entry.path);
  const isMultiSelected = selectedPaths.has(entry.path)
    || (!!selectedFile && [...selectedPaths].some((p) => filePathKey(p) === filePathKey(entry.path)));
  const isSelected = isLead || isMultiSelected;
  const isRenaming = renamingPath === entry.path;
  // step 6B: VFS 高亮 —— 路径在 recentlyChangedPaths 集合里时应用 CSS 类
  const isRecentlyChanged = recentlyChangedPaths.has(entry.path);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // 订阅 clipboard 变化以更新 cut 状态(半透明)
  const [isCutMarked, setIsCutMarked] = useState(() => fileClipboard.isCut(entry.path));
  useEffect(() => {
    return fileClipboard.subscribe(() => setIsCutMarked(fileClipboard.isCut(entry.path)));
  }, [entry.path]);

  // 进入 rename 模式时,初始化 input 内容并 autofocus
  useEffect(() => {
    if (isRenaming) {
      const baseName = entry.name;
      setRenameValue(baseName);
      requestAnimationFrame(() => {
        const input = renameInputRef.current;
        if (input) {
          input.focus();
          // 选中 basename(不含扩展名),跟 IDEA 行为一致
          const dotIdx = baseName.lastIndexOf('.');
          if (dotIdx > 0 && !entry.isDirectory) {
            input.setSelectionRange(0, dotIdx);
          } else {
            input.select();
          }
        }
      });
    }
  }, [isRenaming, entry.name, entry.isDirectory]);

  const myReloadToken = dirReloadTokens.get(entry.path) ?? 0;
  useEffect(() => {
    if (entry.isDirectory && isExpanded) {
      loadChildren(entry.path).then((files) => {
        setChildren(files);
      });
    }
  }, [isExpanded, entry.path, entry.isDirectory, loadChildren, myReloadToken]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const isCmd = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;
    const modifier: 'cmd' | 'shift' | undefined = isShift ? 'shift' : isCmd ? 'cmd' : undefined;
    onSelect(entry.path, entry.isDirectory, modifier);
    if (openOnSingleClick && !modifier) {
      if (entry.isDirectory) {
        onToggleDir(entry.path);
      } else {
        onOpenFile(entry.path);
      }
    }
  };

  // 双击文件 → 打开 / 双击目录 → 展开折叠 (两种单击模式下都保留, 肌肉记忆兼容)
  // openOnSingleClick 时目录的第二次 click 已经 toggle 过一次, 双击不再重复 toggle,
  // 否则"双击展开"净效果 = 开→关, 视觉上像没反应。
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.isDirectory) {
      if (!openOnSingleClick) onToggleDir(entry.path);
    } else {
      onOpenFile(entry.path);
    }
  };

  // 右键 → 选中并弹 ContextMenu
  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 如果右键的不是当前选中行,先切换选中
    if (selectedFile !== entry.path) {
      onSelect(entry.path, entry.isDirectory);
    }
    onContextMenu(e, entry.path, entry.isDirectory);
  };

  // 点 chevron → 只 toggle 展开/折叠,不改选中。
  // Why: onSelect → onSelectFile(dir) 会调 editor.openFile(dirPath),触发
  // 编辑器 tab 状态更新 + agent pane effect,引起"闪一下"的视觉抖动。
  // IDEA 的 chevron 也只展开,不改选中。
  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.isDirectory) {
      onToggleDir(entry.path);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = renameValue.trim();
      if (trimmed && trimmed !== entry.name) {
        onCommitRename(entry.path, trimmed);
      } else {
        onCancelRename();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelRename();
    }
  };

  const getFileIcon = (name: string, isDir: boolean) => {
    if (isDir) {
      // 目录图标跟随主题色, 且全 app 只有这一颗文件夹形状。
      return <IconFolderStroke size={16} />;
    }
    const lower = name.toLowerCase();
    // 特殊文件名: package.json / package-lock.json 都用 {} JSON 图标
    // (跟 IDEA 一致 - lock 文件也是 JSON,IDEA 用 JSON 图标 + tiny lock 角标,这里简化只用 JSON)
    if (lower === 'package.json' || lower === 'package-lock.json') {
      return <FT.JsonIcon />;
    }
    // pnpm-lock.yaml / yarn.lock — 这些不是 JSON,用 lock 图标
    if (lower === 'pnpm-lock.yaml' || lower === 'yarn.lock') {
      return <FT.LockFileIcon />;
    }
    // .gitignore / .dockerignore / .npmignore / .eslintignore 等 — 一律用 IDEA ⊘ ignored
    if (/^\.[a-z]+ignore$/i.test(lower)) {
      return <FT.IgnoreFileIcon />;
    }
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'docker-compose.yml' || lower === 'docker-compose.yaml') {
      return <FT.DockerIcon />;
    }
    if (lower === 'pom.xml') {
      return <FT.MavenPomIcon />;
    }
    // Spring Boot application*.yml/yaml/properties → 绿叶 / 橙叶（区分主配置与环境配置）
    const springYamlMatch = lower.match(/^application(?:-(.+))?\.(ya?ml|properties)$/);
    if (springYamlMatch) {
      const env = springYamlMatch[1];
      return env ? <FT.SpringYamlAltIcon /> : <FT.SpringYamlIcon />;
    }
    if (/^bootstrap(?:-.+)?\.(ya?ml|properties)$/.test(lower)) {
      return <FT.SpringYamlIcon />;
    }
    const ext = lower.split('.').pop() || '';
    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'mts':
      case 'cts':
        return <FT.TypeScriptIcon />;
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
        return <FT.JavaScriptIcon />;
      case 'json':
      case 'jsonc':
        return <FT.JsonIcon />;
      case 'css':
      case 'scss':
      case 'less':
      case 'sass':
        return <FT.CssIcon />;
      case 'html':
      case 'htm':
        return <FT.HtmlIcon />;
      case 'md':
      case 'mdx':
      case 'markdown':
        return <FT.MarkdownIcon />;
      case 'py':
      case 'pyi':
        return <FT.PythonIcon />;
      case 'java':
      case 'class':
        return <FT.JavaIcon />;
      case 'go':
      case 'mod':
        return <FT.GoIcon />;
      case 'rs':
        return <FT.RustIcon />;
      case 'yml':
      case 'yaml':
        return <FT.YamlIcon />;
      case 'xml':
        return <FT.XmlIcon />;
      case 'properties':
      case 'ini':
      case 'cfg':
      case 'conf':
        return <FT.PropertiesIcon />;
      case 'sql':
        return <FT.SqlIcon />;
      case 'sh':
      case 'bash':
      case 'zsh':
      case 'fish':
        return <FT.ShellIcon />;
      case 'svg':
        return <FT.SvgFileIcon />;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'webp':
      case 'bmp':
      case 'ico':
        return <FT.ImageFileIcon />;
      case 'lock':
        return <FT.LockFileIcon />;
      case 'toml':
        return <FT.TomlIcon />;
      case 'iml':
        return <FT.ImlFileIcon />;
      case 'txt':
      case 'log':
        return <FT.TextFileIcon />;
      default:
        return <FT.GenericFileIcon />;
    }
  };

  // 复制文件引用到剪贴板
  const handleCopyRef = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!entry.isDirectory) {
      const fileRef = `@file:${entry.path}`;
      void navigator.clipboard.writeText(fileRef).then(() => {
        void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `已复制 ${fileRef}` : `Copied ${fileRef}`, 'success'));
      }).catch(() => {
        void import('../../../components/notifyEvents').then(m => m.dispatchOpFailed({
          op: isZh ? '复制文件引用' : 'Copy file reference',
          message: isZh ? '剪贴板写入失败' : 'Failed to write to clipboard',
        }));
      });
    }
  };

  // JB 风格：识别 excluded / library / build artifact 文件夹
  const folderTag = (() => {
    if (!entry.isDirectory) return null;
    const n = entry.name;
    if (n === 'node_modules') return { kind: 'excluded', label: 'library root' };
    if (n === 'dist' || n === 'build' || n === 'out' || n === 'target' || n === '.next' || n === '.nuxt') {
      return { kind: 'excluded', label: null };
    }
    if (n === 'release' || n === 'releases') return { kind: 'excluded', label: null };
    return null;
  })();

  // 识别忽略类文件 (.gitignore / .dockerignore / .npmignore 等)
  const isIgnoreFile = !entry.isDirectory && /^\.[a-z]*ignore$/i.test(entry.name);

  // 顶层模块（level 1 + 模块化命名）需要加粗
  const isTopLevelModule =
    entry.isDirectory &&
    level === 1 &&
    /^[a-z0-9]+-[a-z0-9-]+$/i.test(entry.name) &&
    !entry.name.startsWith('.');

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${isSelected ? 'selected editor-active' : ''} ${entry.isDirectory ? 'directory' : 'file'} ${folderTag ? 'excluded' : ''} ${isIgnoreFile ? 'ignored' : ''} ${isTopLevelModule ? 'module-bold' : ''}${isCutMarked ? ' cut-marked' : ''}${dragOverPath === entry.path && entry.isDirectory ? ' drag-over' : ''}${isRecentlyChanged ? ' recently-changed' : ''}`}
        style={{ paddingLeft: `calc(${level * 22}px + var(--fx-indent-base, 6px))` }}
        data-path={entry.path}
        draggable={!isRenaming}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleRightClick}
        onDragStart={(e) => onDragStartNode(e, entry.path, entry.isDirectory, entry.name)}
        onDragOver={(e) => onDragOverNode(e, entry.path, entry.isDirectory)}
        onDragLeave={() => onDragLeaveNode(entry.path)}
        onDrop={(e) => onDropNode(e, entry.path, entry.isDirectory)}
        title={entry.isDirectory ? entry.name : entry.name}
      >
        <span
          className="file-icon"
          onClick={entry.isDirectory ? handleChevronClick : undefined}
        >
          {entry.isDirectory ? <IconFolderStroke size={16} /> : getFileIcon(entry.name, false)}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="file-rename-input"
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => {
              const trimmed = renameValue.trim();
              if (trimmed && trimmed !== entry.name) {
                onCommitRename(entry.path, trimmed);
              } else {
                onCancelRename();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <span className={`file-name${gitStatus ? ' has-git-status' : ''}`} data-git-status={gitStatus || undefined}>{entry.name}</span>
        )}
        {gitStatus && !isRenaming && (
          <span className="file-git-badge" data-git-status={gitStatus} title={gitStatusTitle(gitStatus, isZh)}>{gitStatus}</span>
        )}
        {folderTag?.label && !isRenaming && <span className="file-tag">{folderTag.label}</span>}
        {!entry.isDirectory && !isRenaming && (
          <button
            className="file-copy-btn"
            onClick={handleCopyRef}
            title="Copy @file reference"
          >
            <Icons.Copy />
          </button>
        )}
      </div>
      {entry.isDirectory && (
        <div className={`file-tree-children-wrap${isExpanded ? ' is-open' : ''}`}>
          <div className="file-tree-children">
            {isExpanded && children.map((child) => (
              <FileTreeNode
                key={child.path}
                entry={child}
                level={level + 1}
                expandedDirs={expandedDirs}
                selectedFile={selectedFile}
                selectedPaths={selectedPaths}
                renamingPath={renamingPath}
                dragOverPath={dragOverPath}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
              onDragStartNode={onDragStartNode}
              onDragOverNode={onDragOverNode}
              onDragLeaveNode={onDragLeaveNode}
              onDropNode={onDropNode}
              loadChildren={loadChildren}
              gitCwd={gitCwd}
              recentlyChangedPaths={recentlyChangedPaths}
              dirReloadTokens={dirReloadTokens}
              openOnSingleClick={openOnSingleClick}
            />
          ))}
          </div>
        </div>
      )}
    </div>
  );
};

export interface FileExplorerProps {
  workspacePath: string;
  selectedFile: string | null;
  /** 单击/箭头 → 仅选中,不打开。isDirectory 让消费方能区分目录(不能当文件读)。 */
  onSelectFile: (path: string, isDirectory?: boolean) => void;
  /** 双击 / Enter → 在编辑器中打开 */
  onOpenFile?: (path: string) => void;
  /** 用于 toast 通知 (如不传则 console.log) */
  onToast?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** 工具栏「隐藏面板」按钮的回调 — 由 WorkspacePage 提供,关闭整个 sidebar */
  onHidePanel?: () => void;
  className?: string;
  /** 多根工作区: 隐藏自带 header (工作区级 header 由外层 MultiRoot 容器统一渲染一次)。 */
  hideHeader?: boolean;
  /** 多根工作区: 提供则该根可从工作区移除 (root 节点 hover 出 ✕ + 右键菜单项)。primary root 不传。 */
  onRemoveFromWorkspace?: () => void;
  /** 多根工作区: 是否响应 IdeFileSidebar 头部派的全局 'neox:explorer:*' 工具栏事件。
   *  多根时只有 primary 实例响应 (=true), 否则 N 个实例同时弹 N 个新建对话框。默认 true。 */
  respondsToGlobalActions?: boolean;
  /** 覆盖"单击即打开"这条全局设置, 只作用于这一个实例。
   *
   *  文件管理器 Surface 需要 false: 那里单击是**就地预览** (右侧换内容, 不开 tab),
   *  双击才真的开成 tab。而全局设置默认 true (VSCode 风格, 单击直接打开) —— 侧栏那份
   *  该保持原样, 所以不能去改设置本身, 只能按实例覆盖。不传就跟随全局设置。 */
  singleClickOpens?: boolean;
}

/** Surface 工具栏等外部调用新建/刷新时用 */
export interface FileExplorerHandle {
  newFile: () => void;
  newFolder: () => void;
  refresh: () => void;
  collapseAll: () => void;
  locate: () => void;
}

const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(function FileExplorer({
  workspacePath,
  selectedFile,
  onSelectFile,
  onOpenFile,
  onToast,
  onHidePanel,
  className = '',
  hideHeader = false,
  onRemoveFromWorkspace,
  respondsToGlobalActions = true,
  singleClickOpens,
}, ref) {
  const { t, isZh } = useI18n();
  const settings = useExplorerSettings();
  /* 实例级覆盖优先于全局设置 (见 singleClickOpens 的说明) */
  const openOnSingleClick = singleClickOpens ?? settings.openOnSingleClick;
  const [rootFiles, setRootFiles] = useState<FileEntry[]>([]);
  const expandedStorageKey = `neox-explorer-expanded:${workspacePath}`;
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(expandedStorageKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const set = new Set<string>(arr);
          set.add(workspacePath); // 根目录始终展开
          return set;
        }
      }
    } catch { /* ignore */ }
    return new Set([workspacePath]);
  });
  // 持久化展开状态
  useEffect(() => {
    try {
      window.localStorage.setItem(
        expandedStorageKey,
        JSON.stringify(Array.from(expandedDirs)),
      );
    } catch { /* ignore quota errors */ }
  }, [expandedDirs, expandedStorageKey]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirReloadTokens, setDirReloadTokens] = useState<Map<string, number>>(() => new Map());
  const bumpDirReloadToken = useCallback((dirPath: string) => {
    setDirReloadTokens((prev) => {
      const next = new Map(prev);
      next.set(dirPath, (prev.get(dirPath) ?? 0) + 1);
      return next;
    });
  }, []);
  // step 6B: VFS 事件高亮 —— 最近被改动过的文件路径集合
  // 由 FILES_TOPIC 订阅触发，3 秒后自动消失。CSS 走脉动闪烁动画。
  const [recentlyChangedPaths, setRecentlyChangedPaths] = useState<Set<string>>(new Set());
  const recentChangeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 是否选中的是目录(用于 fileActions context)
  const [selectedIsDirectory, setSelectedIsDirectory] = useState(false);
  // 多选: paths 集合 + lead(主选中,作为 shift-click 锚点 + 键盘光标)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // 路径 → isDirectory 缓存(批量选择时需要知道每个的类型)
  const pathTypeMapRef = useRef<Map<string, boolean>>(new Map());
  // ContextMenu 状态
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    items: ContextMenuItem[];
  } | null>(null);
  // 行内 rename 状态
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // NewItem dialog 状态(promise-based)
  const [newItemDialog, setNewItemDialog] = useState<{
    visible: boolean;
    isDirectory: boolean;
    parentDir: string;
    resolve: ((name: string) => void) | null;
    reject: ((err?: any) => void) | null;
  }>({
    visible: false,
    isDirectory: false,
    parentDir: workspacePath,
    resolve: null,
    reject: null,
  });
  // Delete confirm dialog 状态
  const [deleteDialog, setDeleteDialog] = useState<{
    visible: boolean;
    paths: string[];
    resolve: ((confirmed: boolean) => void) | null;
  }>({ visible: false, paths: [], resolve: null });
  // 文件树是否拥有焦点(scoped shortcut 用)
  const explorerRootRef = useRef<HTMLDivElement>(null);
  const [hasFocus, setHasFocus] = useState(false);
  // Type-to-search 状态(IDEA Speed Search)
  const [typeBuffer, setTypeBuffer] = useState('');
  const typeBufferTimerRef = useRef<number | null>(null);
  // 拖拽: 当前 hover 的目标目录路径
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // 拖拽: 当前正在拖的源 paths(组件内引用,跨节点共享)
  const dragSourcePathsRef = useRef<string[]>([]);

  // ─── 视图作用域 (项目下拉) ───
  const [viewScope, setViewScope] = useState<ViewScope>('project');

  useEffect(() => (workspacePath ? retainGitRepo(workspacePath) : undefined), [workspacePath]);

  const loadFiles = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    const needMtime = settings.sortBy === 'time-asc' || settings.sortBy === 'time-desc';
    const result = await window.neox?.listFiles?.(dirPath, undefined, {
      showHidden: settings.showHiddenFiles,
      withMtime: needMtime,
    });
    if (result?.success) {
      let files: FileEntry[] = result.files;
      // 应用 sort + foldersFirst (Hidden 已经在 IPC 层过滤)
      files = applySorting(files, settings.sortBy, settings.foldersFirst);
      return files;
    }
    return [];
  }, [settings.showHiddenFiles, settings.sortBy, settings.foldersFirst]);

  useEffect(() => {
    setError(null);
    // Stale-while-revalidate: 不立即 setLoading(true), 而是开一个 200ms 延迟的 timer.
    // 如果 200ms 内加载完成 → 直接 swap 数据, 不显示 "Loading...", 无闪屏.
    // 如果 200ms 后还没完成 → 才显示 loading 状态, 让用户知道在加载.
    // 这是 IDEA 项目切换的标准做法, 快项目用户感知不到任何 loading.
    const slowTimer = setTimeout(() => setLoading(true), 200);
    let cancelled = false;
    loadFiles(workspacePath)
      .then((files) => {
        if (cancelled) return;
        clearTimeout(slowTimer);
        setRootFiles(files);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        clearTimeout(slowTimer);
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
    // 当 settings 变化时也重新加载(showHidden / sort 切换)
    // step 7A: 移除 refreshKey 依赖 —— FILES_TOPIC 订阅替代
  }, [workspacePath, loadFiles, settings.showHiddenFiles, settings.sortBy, settings.foldersFirst]);


  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 当选中的文件改变时，自动展开到该文件的路径
  useEffect(() => {
    if (selectedFile && selectedFile.startsWith(workspacePath)) {
      // 获取文件的所有父目录
      const relativePath = selectedFile.slice(workspacePath.length);
      const parts = relativePath.split('/').filter(Boolean);
      
      // 构建所有需要展开的目录路径
      const dirsToExpand: string[] = [workspacePath];
      let currentPath = workspacePath;
      for (let i = 0; i < parts.length - 1; i++) { // -1 因为最后一个是文件名
        currentPath = `${currentPath}/${parts[i]}`;
        dirsToExpand.push(currentPath);
      }
      
      // 展开所有父目录
      setExpandedDirs(prev => {
        const next = new Set(prev);
        dirsToExpand.forEach(dir => next.add(dir));
        return next;
      });
    }
  }, [selectedFile, workspacePath]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    /* P0-4: 必须 catch — 之前 IPC 失败 (网络抖 / handler 异常) 时 setLoading(false) 永远
     *  不跑, spinner 转一辈子, 用户只能重启. 跟 line 633 那个初次加载 effect 同款防御. */
    loadFiles(workspacePath)
      .then((files) => {
        setRootFiles(files);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `刷新失败: ${msg}` : `Refresh failed: ${msg}`, 'warning'));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [workspacePath, loadFiles, isZh]);

  const workspaceName = useMemo(() => {
    const norm = workspacePath.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    return parts[parts.length - 1] || workspacePath;
  }, [workspacePath]);

  // 父目录名 — 用作 [bracket] tag (类似 IDEA 显示 "ordersys [order]")
  const workspaceBracket = useMemo(() => {
    const parts = workspacePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const parent = parts[parts.length - 2];
    if (!parent || parent === 'Users' || parent === 'home' || /^[A-Za-z]:$/.test(parent)) return null;
    return parent;
  }, [workspacePath]);

  // 获取简短路径显示（如 ~/AI/OpenNeox）；Win 不重复刷整条绝对路径
  const shortPath = useMemo(() => {
    const norm = workspacePath.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    if (parts[0] === 'Users' && parts.length > 2) {
      return '~/' + parts.slice(2).join('/');
    }
    if (parts[0] === 'home' && parts.length > 2) {
      return '~/' + parts.slice(2).join('/');
    }
    /* Windows: e:/code/foo → 只显示父级相对线索, 避免根行又亮一整条盘符路径 */
    if (/^[A-Za-z]:$/.test(parts[0] ?? '') && parts.length > 1) {
      if (parts.length <= 2) return '';
      return parts.slice(0, -1).join('\\') + '\\';
    }
    if (parts.length <= 1) return '';
    return workspacePath;
  }, [workspacePath]);

  // ─── scope 过滤 ───
  /* 当前 3 个 scope (project/openFiles/changedFiles):
   *   · project       —— 全列 (默认)
   *   · openFiles     —— 父层传入打开 tab 列表后才能真正过滤, 暂回退到全列
   *   · changedFiles  —— 接 window.neox.gitStatus 后才能真正过滤, 暂回退到全列
   * 后续把这两个数据源接进来时, 在此处真正过滤. */
  const scopedRootFiles = useMemo((): FileEntry[] => rootFiles, [rootFiles]);
  void viewScope;

  const isRootExpanded = expandedDirs.has(workspacePath);

  const handleToggleRoot = useCallback(() => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(workspacePath)) {
        next.delete(workspacePath);
      } else {
        next.add(workspacePath);
      }
      return next;
    });
  }, [workspacePath]);

  // 单击 root → 选中; openOnSingleClick 时同时展开/折叠 (跟子目录单击一致)
  const handleRootClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setHasFocus(true);
    onSelectFile(workspacePath, true);
    setSelectedIsDirectory(true);
    setSelectedPaths(new Set([workspacePath]));
    if (openOnSingleClick && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      handleToggleRoot();
    }
  }, [workspacePath, onSelectFile, openOnSingleClick, handleToggleRoot]);

  // 双击 root → 展开/折叠 (单击模式下 click 已 toggle 过, 不重复)
  const handleRootDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!openOnSingleClick) handleToggleRoot();
  }, [handleToggleRoot, openOnSingleClick]);

  // 点 root chevron → 只 toggle 展开/折叠(跟子目录 chevron 一致,避免走 editor.openFile)
  const handleRootChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleToggleRoot();
  }, [handleToggleRoot]);


  // 折叠所有
  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set([workspacePath]));
  }, [workspacePath]);

  // ─── 选中 / 双击 / 右键 处理 ───

  /**
   * 处理选中,支持 IDEA 多选语义:
   *   普通点击  → 替换选中为 [path]
   *   ⌘+click  → 切换 path 在选中集合内的存在
   *   ⇧+click  → 从 lead 到 path 的范围选中
   */
  const handleSelect = useCallback((path: string, isDirectory: boolean, modifier?: 'cmd' | 'shift') => {
    pathTypeMapRef.current.set(path, isDirectory);
    setHasFocus(true);

    if (modifier === 'cmd') {
      // toggle
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      // lead 跟着新点的走
      onSelectFile(path, isDirectory);
      setSelectedIsDirectory(isDirectory);
      return;
    }

    if (modifier === 'shift' && selectedFile) {
      // 范围选: 从 selectedFile (lead) 到 path 的所有可见节点
      const visibleNodes = explorerRootRef.current?.querySelectorAll<HTMLDivElement>('.file-tree-item:not(.root-node)');
      if (visibleNodes) {
        const paths = Array.from(visibleNodes).map(el => el.getAttribute('data-path')).filter(Boolean) as string[];
        const startIdx = paths.indexOf(selectedFile);
        const endIdx = paths.indexOf(path);
        if (startIdx >= 0 && endIdx >= 0) {
          const [a, b] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          setSelectedPaths(new Set(paths.slice(a, b + 1)));
          onSelectFile(path, isDirectory);
          setSelectedIsDirectory(isDirectory);
          return;
        }
      }
    }

    // 默认: 替换为单选
    setSelectedPaths(new Set([path]));
    onSelectFile(path, isDirectory);
    setSelectedIsDirectory(isDirectory);
  }, [onSelectFile, selectedFile]);

  // 全选(⌘A): 选中所有可见节点
  const handleSelectAll = useCallback(() => {
    const visibleNodes = explorerRootRef.current?.querySelectorAll<HTMLDivElement>('.file-tree-item:not(.root-node)');
    if (!visibleNodes) return;
    const all = new Set<string>();
    for (const node of Array.from(visibleNodes)) {
      const p = node.getAttribute('data-path');
      if (p) all.add(p);
    }
    setSelectedPaths(all);
  }, []);

  const handleOpenFile = useCallback((path: string) => {
    if (onOpenFile) {
      onOpenFile(path);
    } else {
      onSelectFile(path); // 兼容旧调用方
    }
  }, [onOpenFile, onSelectFile]);

  // 同步刷新一个目录(用于 action 触发后重新加载)
  const refreshDir = useCallback((dirPath?: string) => {
    const onError = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `刷新目录失败: ${msg}` : `Failed to refresh directory: ${msg}`, 'warning'));
    };
    if (!dirPath || dirPath === workspacePath) {
      // 刷新根
      loadFiles(workspacePath).then(setRootFiles).catch(onError);
      bumpDirReloadToken(workspacePath);
    } else {
      // 根列表也重拉 (因为新增的可能是根直接子项之一的孙级)
      loadFiles(workspacePath).then(setRootFiles).catch(onError);
      /* 给目标 dirPath bump token — FileTreeNode 监听到自身 path 的 token 变会
       * re-fetch children. 兼容已展开 / 未展开 (未展开下次展开自然拉新数据). */
      bumpDirReloadToken(dirPath);
    }
  }, [workspacePath, loadFiles, bumpDirReloadToken, isZh]);

  // step 6B: 把一个路径标记为"刚被改过"，3 秒后自动从集合中移除。
  // 触发 CSS 脉动高亮，让用户能看到 agent 改的是哪个文件。
  const markRecentlyChanged = useCallback((path: string) => {
    // 清掉旧 timer，避免短时间内多次 onChanged 时高亮提前消失
    const existing = recentChangeTimersRef.current.get(path);
    if (existing !== undefined) clearTimeout(existing);

    setRecentlyChangedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });

    const timer = setTimeout(() => {
      setRecentlyChangedPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      recentChangeTimersRef.current.delete(path);
    }, 3000);
    recentChangeTimersRef.current.set(path, timer);
  }, []);

  // 卸载时清掉所有 pending timer，避免在 unmount 后 setState
  useEffect(() => {
    return () => {
      for (const timer of recentChangeTimersRef.current.values()) {
        clearTimeout(timer);
      }
      recentChangeTimersRef.current.clear();
    };
  }, []);

  // step 6B: 订阅 VFS 文件变更事件 —— 任何来源（agent / 手动 save / 未来的
  // 外部 watcher）写文件后，自动刷新对应目录 + 标记最近改动用于高亮。
  //
  // 强制整树刷新；现在改成订阅 FILES_TOPIC，更精确（只刷父目录）、更解耦
  // （文件树不需要知道事件源是谁），未来还能按 source 标签做不同高亮。
  //
  // step 7A: refreshKey prop 已彻底删除，唯一的刷新通道就是 FILES_TOPIC。
  //
  // refreshDir(重拉根 + setState) 会连环触发几十次全树 re-render + git status。
  // 改为: 事件只把 parent 收进 pendingRefreshParentsRef, 150ms 窗口合并 flush 一次
  // (根列表拉一次 + 每个 parent bump 一次 token + git status 拉一次)。
  const pendingRefreshParentsRef = useRef<Set<string>>(new Set());
  const refreshFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback((parentDir?: string) => {
    pendingRefreshParentsRef.current.add(parentDir || workspacePath);
    if (refreshFlushTimerRef.current != null) return;
    refreshFlushTimerRef.current = setTimeout(() => {
      refreshFlushTimerRef.current = null;
      const parents = pendingRefreshParentsRef.current;
      pendingRefreshParentsRef.current = new Set();
      /* 根列表统一只拉一次 */
      loadFiles(workspacePath).then(setRootFiles).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `刷新目录失败: ${msg}` : `Failed to refresh directory: ${msg}`, 'warning'));
      });
      for (const p of parents) bumpDirReloadToken(p);
      /* git 角标不在这里拉: 主进程收到同一批 fs 事件后会重算, 变了会推 (见上方订阅) */
    }, 150);
  }, [workspacePath, loadFiles, bumpDirReloadToken, isZh]);
  useEffect(() => () => {
    if (refreshFlushTimerRef.current != null) clearTimeout(refreshFlushTimerRef.current);
  }, []);

  useTopicSubscription(FILES_TOPIC, {
    onChanged: (event) => {
      // 取父目录后合并刷新；如果改的是根下的文件，parentDir 为空 → 刷整个根
      const parent = event.path.slice(0, event.path.lastIndexOf('/'));
      scheduleRefresh(parent || undefined);
      markRecentlyChanged(event.path);
    },
    onCreated: (event) => {
      const parent = event.path.slice(0, event.path.lastIndexOf('/'));
      scheduleRefresh(parent || undefined);
      markRecentlyChanged(event.path);
    },
    onDeleted: (event) => {
      const parent = event.path.slice(0, event.path.lastIndexOf('/'));
      scheduleRefresh(parent || undefined);
    },
  });

  // ─── Inline rename 提交 / 取消 ───
  const handleCommitRename = useCallback(async (oldPath: string, newName: string) => {
    try {
      await fileSystemService.rename(oldPath, newName);
      const parent = oldPath.slice(0, oldPath.lastIndexOf('/'));
      refreshDir(parent);
      onToast?.(t.explorer.successRenamed, 'success');
    } catch (e: any) {
      onToast?.(`${t.explorer.errorRename}: ${e?.message || e}`, 'error');
    } finally {
      setRenamingPath(null);
    }
  }, [refreshDir, onToast, t]);

  const handleCancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── 动作上下文 (供 fileActions / ContextMenu / Keymap 共用) ───
  const buildActionContext = useCallback((): FileActionContext => {
    // 构建批量: 如果 selectedPaths 非空就用它,否则退化到只含 lead 的单元素
    const batch = selectedPaths.size > 0
      ? Array.from(selectedPaths)
      : (selectedFile ? [selectedFile] : []);
    return {
      selectedPaths: batch,
      leadPath: selectedFile,
      leadIsDirectory: selectedIsDirectory,
      // 兼容字段
      selectedPath: selectedFile,
      selectedIsDirectory,
      workspacePath,
      t,
      ui: {
        toast: (msg, type = 'info') => onToast?.(msg, type),
        promptNewItem: (parentDir, isDirectory) => {
          return new Promise<string>((resolve, reject) => {
            setNewItemDialog({
              visible: true,
              isDirectory,
              parentDir,
              resolve,
              reject,
            });
          });
        },
        confirmDelete: (paths) => {
          return new Promise<boolean>((resolve) => {
            setDeleteDialog({ visible: true, paths, resolve });
          });
        },
        startInlineRename: (path) => {
          setRenamingPath(path);
        },
      },
      refresh: refreshDir,
    };
  }, [selectedFile, selectedIsDirectory, selectedPaths, workspacePath, t, onToast, refreshDir]);

  // 右键 → 弹 ContextMenu
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    const pos = { x: e.clientX, y: e.clientY };
    const base = buildActionContext();
    const ctx: FileActionContext = {
      ...base,
      selectedPaths: base.selectedPaths.includes(path) ? base.selectedPaths : [path],
      leadPath: path,
      leadIsDirectory: isDirectory,
      selectedPath: path,
      selectedIsDirectory: isDirectory,
    };
    setContextMenu({ position: pos, items: withMenuIcons(buildContextMenuItems(ctx)) });
  }, [buildActionContext]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (selectedFile !== workspacePath) {
      onSelectFile(workspacePath, true);
      setSelectedIsDirectory(true);
      setSelectedPaths(new Set([workspacePath]));
    }
    handleNodeContextMenu(e, workspacePath, true);
  }, [selectedFile, workspacePath, onSelectFile, handleNodeContextMenu]);

  // ─── Drag & Drop 处理 (IDEA Project View 风格) ───

  /**
   * 开始拖拽: 收集源 paths(选中集合或单个),写入 dataTransfer
   */
  const handleDragStartNode = useCallback((e: React.DragEvent, path: string, isDirectory?: boolean, name?: string) => {
    e.stopPropagation();
    // 如果拖的不是当前选中,先选中它
    let sources: string[];
    if (selectedPaths.has(path) && selectedPaths.size > 0) {
      sources = Array.from(selectedPaths);
    } else {
      sources = [path];
    }
    dragSourcePathsRef.current = sources;
    e.dataTransfer.effectAllowed = 'copyMove';
    // 写入 paths(用 \n 分隔以允许跨进程粘贴)
    e.dataTransfer.setData('application/x-neox-files', sources.join('\n'));
    e.dataTransfer.setData('text/plain', sources.join('\n'));
    /* 目录标记 —— 接收方 (输入框) 要区分"挂成附件"还是"当路径提示插进 prompt"。
     * 单独一个 type, 老的两条不动, 不影响树内部的移动/复制。 */
    if (sources.length === 1) {
      try {
        e.dataTransfer.setData('application/x-neox-file-meta',
          JSON.stringify([{ path, dir: !!isDirectory, name: name ?? path.split(/[\\/]/).pop() }]));
      } catch { /* 某些平台 setData 会抛, 不影响主路径 */ }
    }

    try {
      const label = sources.length > 1
        ? `${sources.length} 项`
        : (name ?? path.split(/[\\/]/).pop() ?? path);
      const ghost = document.createElement('div');
      ghost.textContent = label;
      ghost.setAttribute('style', [
        'position:fixed', 'top:-1000px', 'left:-1000px',
        'padding:3px 9px', 'border-radius:6px',
        'font-size:12px', 'font-family:inherit', 'white-space:nowrap',
        'background:var(--neox-primary-500,#6366f1)', 'color:#fff',
        'box-shadow:0 2px 8px rgba(0,0,0,.18)',
      ].join(';'));
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      /* 影像在 dragstart 这一帧被浏览器截走, 之后就可以拆了 */
      setTimeout(() => { ghost.remove(); }, 0);
    } catch { /* 拖拽影像是锦上添花, 失败不影响拖拽本身 */ }
  }, [selectedPaths]);

  const handleDragOverNode = useCallback((e: React.DragEvent, path: string, isDirectory: boolean) => {
    /* 命中 file → 升级到父目录; 命中 directory → 就地 */
    const targetDir = isDirectory ? path : path.slice(0, path.lastIndexOf('/'));
    if (!targetDir) return;   // 极端: 无斜杠 (不应发生)
    const isExternal = Array.from(e.dataTransfer?.types || []).includes('Files');
    if (!isExternal) {
      // 不能拖到自己 / 自己的子目录 (仅内部拖需校验源)
      const sources = dragSourcePathsRef.current;
      for (const src of sources) {
        if (targetDir === src || targetDir.startsWith(src + '/')) return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isExternal ? 'copy' : (e.altKey ? 'copy' : 'move');
    setDragOverPath(targetDir);   // 高亮父目录, 不高亮文件本身
  }, []);

  const handleDragLeaveNode = useCallback((path: string) => {
    /* 命中 file 时高亮的是父目录, 所以 leave 时同时匹配 self 或 parent 才清 */
    const parent = path.slice(0, path.lastIndexOf('/'));
    setDragOverPath(prev => (prev === path || prev === parent ? null : prev));
  }, []);

  /**
   * 从 DataTransfer.items 里逐项抽 webkitGetAsEntry().isDirectory, 与 dataTransfer.files 顺序对应.
   * items 拿不到 (旧浏览器 / 没 items 权限) 或 entry 抽不到就回落 File.size===0 && type===''.
   * 用于判断从 Finder 拖入的每一项是文件还是文件夹, 决定要不要问"打开?"
   */
  const collectIsDirsFromItems = useCallback((dt: DataTransfer | null): boolean[] => {
    if (!dt) return [];
    const items = dt.items;
    const files = dt.files;
    const n = Math.max(items?.length ?? 0, files?.length ?? 0);
    const out: boolean[] = [];
    for (let i = 0; i < n; i++) {
      let isDir = false;
      const item = items?.[i];
      if (item && typeof (item as any).webkitGetAsEntry === 'function') {
        try {
          const entry = (item as any).webkitGetAsEntry();
          if (entry && entry.isDirectory) isDir = true;
        } catch { /* ignore */ }
      }
      /* 回落: File.type 空 + size 0 大概率是目录 (macOS 拖文件夹时如此) */
      if (!isDir) {
        const f = files?.[i];
        if (f && f.type === '' && f.size === 0) isDir = true;
      }
      out.push(isDir);
    }
    return out;
  }, []);

  /**
   * 展开路径祖先 + 滚动到指定 path 的节点, 可选自动选中. 用于新建/复制/移动后自动定位.
   * 树刷新是异步的 (bumpDirReloadToken → FileTreeNode 重新 load children), DOM 不一定立刻有节点,
   * 所以 tick 逐帧重试, 最多 ~1.5s (15 * 100ms).
   */
  const revealPath = useCallback((targetPath: string, select: boolean = true) => {
    if (!targetPath.startsWith(workspacePath)) return;
    /* 展开祖先目录 */
    const relative = targetPath.slice(workspacePath.length);
    const parts = relative.split('/').filter(Boolean);
    const dirsToExpand: string[] = [workspacePath];
    let cur = workspacePath;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}/${parts[i]}`;
      dirsToExpand.push(cur);
    }
    setExpandedDirs(prev => {
      const next = new Set(prev);
      dirsToExpand.forEach(d => next.add(d));
      return next;
    });
    /* 逐帧轮询节点入 DOM (等 refreshDir → loadChildren 落) */
    let tries = 0;
    const tick = () => {
      const node = explorerRootRef.current?.querySelector<HTMLDivElement>(
        `.file-tree-item[data-path="${CSS.escape(targetPath)}"]`
      );
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (select) onSelectFile(targetPath);
      } else if (tries < 15) {
        tries++;
        setTimeout(tick, 100);
      }
    };
    requestAnimationFrame(tick);
  }, [workspacePath, onSelectFile]);

  /**
   * 从外部 (Finder/Explorer) 拖进来的文件/目录抽路径 + 逐个 copy 到 destDir.
   * 独立成函数供容器/根/directory-row 三处 drop handler 共用.
   */
  const performExternalDrop = useCallback(async (
    files: File[],
    destDir: string,
    /* isDirs 与 files 平行 — 从 dataTransfer.items[i].webkitGetAsEntry().isDirectory 抽的.
     * 用于 drop 后决定要不要提示"打开?" (文件夹不问, 只 reveal). */
    isDirs: boolean[] = [],
  ): Promise<void> => {
    if (!files || files.length === 0) {
      onToast?.(isZh ? '拖入为空: 未检测到文件' : 'Nothing to drop', 'warning');
      return;
    }
    const bridge = window.neox as { getPathForFile?: (f: File) => string | null };
    if (typeof bridge.getPathForFile !== 'function') {
      onToast?.(isZh ? 'preload 未暴露 getPathForFile, 请重启桌面' : 'Preload getPathForFile missing — restart desktop', 'error');
      return;
    }
    const externalPaths: string[] = [];
    for (const f of files) {
      let abs: string | null = null;
      try { abs = bridge.getPathForFile!(f); } catch { abs = null; }
      if (abs) externalPaths.push(abs);
    }
    if (externalPaths.length === 0) {
      onToast?.(isZh ? '无法从系统读取拖入文件的路径' : 'Cannot read dropped file paths from OS', 'error');
      return;
    }
    const total = externalPaths.length;
    if (total > 1) {
      onToast?.(isZh ? `复制中… 0/${total}` : `Copying… 0/${total}`, 'info');
    } else {
      onToast?.(isZh ? `复制 ${externalPaths[0].split('/').pop()} …` : `Copying ${externalPaths[0].split('/').pop()} …`, 'info');
    }
    let done = 0;
    const failed: string[] = [];
    /* 收集"新路径 + 是否目录" — 复制完后要 reveal 第一项, 且文件才问打开 */
    const arrivals: Array<{ newPath: string; isDirectory: boolean }> = [];
    for (let i = 0; i < externalPaths.length; i++) {
      const src = externalPaths[i];
      const isDirGuess = isDirs[i] ?? false;
      try {
        /* external:true 关键 — src 在 workspace 外, main 沙箱默认拒绝 "Path traversal",
         * 该 flag 明确"这是用户从 Finder 拖入", 免 src 沙箱校验 (dest 仍严格校验). */
        const newPath = await fileSystemService.copyTo(src, destDir, { external: true });
        arrivals.push({ newPath, isDirectory: isDirGuess });
        done++;
        if (total > 1 && done < total) {
          onToast?.(isZh ? `复制中… ${done}/${total}` : `Copying… ${done}/${total}`, 'info');
        }
      } catch (err: any) {
        failed.push(`${src.split('/').pop()}: ${err?.message || err}`);
      }
    }
    refreshDir(destDir);
    if (failed.length === 0) {
      onToast?.(
        isZh ? `已复制 ${done} 项到 ${destDir.split('/').pop()}` : `Copied ${done} item(s) to ${destDir.split('/').pop()}`,
        'success',
      );
    } else {
      onToast?.(
        isZh ? `${done} 成功, ${failed.length} 失败: ${failed[0]}` : `${done} ok, ${failed.length} failed: ${failed[0]}`,
        'error',
      );
    }

    if (arrivals.length > 0) {
      const first = arrivals[0];
      revealPath(first.newPath, true);
      if (arrivals.length === 1 && !first.isDirectory) {
        const ok = await confirmAsync({
          title: isZh ? '打开这个文件?' : 'Open this file?',
          message: isZh
            ? `${first.newPath.split('/').pop()} 已复制进来, 现在打开吗?`
            : `${first.newPath.split('/').pop()} was copied in — open it now?`,
          confirmLabel: isZh ? '打开' : 'Open',
          cancelLabel: isZh ? '暂不' : 'Not now',
        });
        if (ok) {
          /* 走已有 openFile 通道 (编辑器打开; 打开后编辑器会 focus, 树里 selectedFile
           * 保持不变即可, revealPath 已经选中并滚过了). */
          if (onOpenFile) onOpenFile(first.newPath);
          else onSelectFile(first.newPath);
          /* 打开后再 reveal 一次 — 用户可能已经用了别的 UI 反滚出去, 保证还能回来看 */
          setTimeout(() => revealPath(first.newPath, false), 200);
        }
      }
    }
  }, [refreshDir, onToast, isZh, revealPath, onOpenFile, onSelectFile]);

  const handleDropNode = useCallback(async (e: React.DragEvent, destPath: string, destIsDirectory: boolean) => {
    const destDir = destIsDirectory ? destPath : destPath.slice(0, destPath.lastIndexOf('/'));
    if (!destDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    /* 外部拖识别: 优先 types (更早, 拖入时就有), 兜底 files.length (drop 时才准) */
    const hasFilesType = Array.from(e.dataTransfer?.types || []).includes('Files');
    const hasFilesList = (e.dataTransfer?.files?.length ?? 0) > 0;
    const isExternal = hasFilesType || hasFilesList;

    if (isExternal) {
      const files = Array.from(e.dataTransfer.files || []);
      const isDirs = collectIsDirsFromItems(e.dataTransfer);
      await performExternalDrop(files, destDir, isDirs);
      return;
    }

    /* ── 内部拖: 源来自 dragSourcePathsRef, Alt = copy 否则 move ── */
    const sources = dragSourcePathsRef.current;
    if (sources.length === 0) return;
    const isCopy = e.altKey;
    try {
      const affectedParents = new Set<string>();
      affectedParents.add(destDir);
      const total = sources.length;
      if (total > 3) {
        onToast?.(isZh ? `${isCopy ? '复制' : '移动'}中… 0/${total}` : `${isCopy ? 'Copying' : 'Moving'}… 0/${total}`, 'info');
      }
      let done = 0;
      for (const src of sources) {
        if (src === destDir || destDir.startsWith(src + '/')) continue;
        if (isCopy) {
          await fileSystemService.copyTo(src, destDir);
        } else {
          await fileSystemService.moveTo(src, destDir);
          affectedParents.add(src.slice(0, src.lastIndexOf('/')));
        }
        done++;
        if (total > 3 && done < total) {
          onToast?.(isZh ? `${isCopy ? '复制' : '移动'}中… ${done}/${total}` : `${isCopy ? 'Copying' : 'Moving'}… ${done}/${total}`, 'info');
        }
      }
      for (const parent of affectedParents) refreshDir(parent);
      onToast?.(t.explorer.successPasted, 'success');
      dragSourcePathsRef.current = [];
    } catch (err: any) {
      onToast?.(`${err?.message || err}`, 'error');
    }
  }, [refreshDir, onToast, t, isZh, performExternalDrop]);

  const containerDragLoggedRef = useRef(false);
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    if (!containerDragLoggedRef.current) {
      containerDragLoggedRef.current = true;
      if (import.meta.env.DEV) {
        console.log('[FileExplorer] container dragOver types=', types, 'files=', e.dataTransfer?.files?.length);
      }
      setTimeout(() => { containerDragLoggedRef.current = false; }, 3000);
    }
    const hasFilesType = types.includes('Files');
    if (!hasFilesType) return;                     // 内部拖 (path 在 ref 里) 走各行 handler
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleContainerDrop = useCallback(async (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    const fileCount = e.dataTransfer?.files?.length ?? 0;
    if (import.meta.env.DEV) {
      console.log('[FileExplorer] container drop types=', types, 'files=', fileCount);
    }
    const hasFilesType = types.includes('Files');
    const hasFilesList = fileCount > 0;
    if (!hasFilesType && !hasFilesList) return;    // 非外部拖不接管
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    onToast?.(isZh ? `收到 ${fileCount} 项拖入, 开始处理…` : `Received ${fileCount} drop, processing…`, 'info');
    const files = Array.from(e.dataTransfer.files || []);
    const isDirs = collectIsDirsFromItems(e.dataTransfer);
    await performExternalDrop(files, workspacePath, isDirs);
  }, [performExternalDrop, workspacePath, onToast, isZh]);

  // 点 explorer-tree 空白区域 → 取消选中(IDEA 行为)
  const handleEmptyAreaClick = useCallback((e: React.MouseEvent) => {
    // 只在点的是 .explorer-tree 本身(不是子节点)时触发
    if (e.target === e.currentTarget) {
      onSelectFile('');
      setSelectedIsDirectory(false);
    }
  }, [onSelectFile]);

  // ─── Toolbar 按钮回调 ───

  /** 工具栏「新建文件」 — 直接调 fileActions */
  const handleToolbarNewFile = useCallback(() => {
    executeFileAction('file.newFile', buildActionContext());
  }, [buildActionContext]);

  /** 工具栏「新建文件夹」 — 复用 file.newFolder action 链路 (走 NewItemDialog) */
  const handleToolbarNewFolder = useCallback(() => {
    executeFileAction('file.newFolder', buildActionContext());
  }, [buildActionContext]);

  /** 工具栏「定位当前文件」 — 滚动到 selectedFile 对应的树节点 */
  const handleToolbarLocate = useCallback(() => {
    if (!selectedFile) {
      onToast?.(t.explorer.locateInProjectView, 'info');
      return;
    }
    // 先确保从 root 到 selectedFile 的所有父目录都展开
    if (selectedFile.startsWith(workspacePath)) {
      const relativePath = selectedFile.slice(workspacePath.length);
      const parts = relativePath.split('/').filter(Boolean);
      const dirsToExpand: string[] = [workspacePath];
      let currentPath = workspacePath;
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = `${currentPath}/${parts[i]}`;
        dirsToExpand.push(currentPath);
      }
      setExpandedDirs(prev => {
        const next = new Set(prev);
        dirsToExpand.forEach(dir => next.add(dir));
        return next;
      });
    }
    // 等下一帧渲染完成后滚动
    requestAnimationFrame(() => {
      const node = explorerRootRef.current?.querySelector<HTMLDivElement>(
        `.file-tree-item[data-path="${CSS.escape(selectedFile)}"]`
      );
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }, [selectedFile, workspacePath, onToast, t]);

  useImperativeHandle(ref, () => ({
    newFile: handleToolbarNewFile,
    newFolder: handleToolbarNewFolder,
    refresh: () => refreshDir(workspacePath),
    collapseAll,
    locate: handleToolbarLocate,
  }), [handleToolbarNewFile, handleToolbarNewFolder, refreshDir, workspacePath, collapseAll, handleToolbarLocate]);

  /* IDE 模式 sidebar 头部按钮 → 复用 FileExplorer 内部 handler.
   *   走 window event 总线避免把 ref/imperative handle 一路传到 IdeFileSidebar.
   *   IdeFileSidebar 派 'neox:explorer:*' 事件, 这里接住调对应 handler. */
  useEffect(() => {
    if (!respondsToGlobalActions) return; // 多根: 非 primary 实例不响应全局工具栏事件
    const onNewFile = () => handleToolbarNewFile();
    const onNewFolder = () => handleToolbarNewFolder();
    const onLocate = () => handleToolbarLocate();
    const onCollapseAll = () => collapseAll();
    window.addEventListener('neox:explorer:new-file', onNewFile);
    window.addEventListener('neox:explorer:new-folder', onNewFolder);
    window.addEventListener('neox:explorer:locate', onLocate);
    window.addEventListener('neox:explorer:collapse-all', onCollapseAll);
    return () => {
      window.removeEventListener('neox:explorer:new-file', onNewFile);
      window.removeEventListener('neox:explorer:new-folder', onNewFolder);
      window.removeEventListener('neox:explorer:locate', onLocate);
      window.removeEventListener('neox:explorer:collapse-all', onCollapseAll);
    };
  }, [handleToolbarNewFile, handleToolbarNewFolder, handleToolbarLocate, collapseAll, respondsToGlobalActions]);

  // ─── 视图选项菜单 (⋮ More 按钮) ───
  const handleOpenViewOptions = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const button = e.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        id: 'showHidden',
        label: t.explorer.showHiddenFiles,
        icon: settings.showHiddenFiles ? '✓' : ' ',
        onClick: () => explorerSettings.toggle('showHiddenFiles'),
      },
      {
        id: 'openOnSingleClick',
        label: isZh ? '单击打开文件/展开文件夹' : 'Open on single click',
        icon: settings.openOnSingleClick ? '✓' : ' ',
        onClick: () => explorerSettings.toggle('openOnSingleClick'),
      },
      /* "显示已排除文件" 已移除: settings.showExcludedFiles 写得进去但 loadFiles 只传 showHidden,
         没有任何渲染/IPC 读它 → 切了树不变, 是假开关。接通 listFiles 的 excluded 选项前不放。 */
      { separator: true },
      {
        id: 'sortByName',
        label: t.explorer.sortByName,
        icon: settings.sortBy === 'name' ? '●' : '○',
        onClick: () => explorerSettings.set('sortBy', 'name'),
      },
      {
        id: 'sortByType',
        label: t.explorer.sortByType,
        icon: settings.sortBy === 'type' ? '●' : '○',
        onClick: () => explorerSettings.set('sortBy', 'type'),
      },
      {
        id: 'sortByTimeAsc',
        label: t.explorer.sortByTimeAsc,
        icon: settings.sortBy === 'time-asc' ? '●' : '○',
        onClick: () => explorerSettings.set('sortBy', 'time-asc'),
      },
      {
        id: 'sortByTimeDesc',
        label: t.explorer.sortByTimeDesc,
        icon: settings.sortBy === 'time-desc' ? '●' : '○',
        onClick: () => explorerSettings.set('sortBy', 'time-desc'),
      },
      { separator: true },
      {
        id: 'foldersFirst',
        label: t.explorer.foldersFirst,
        icon: settings.foldersFirst ? '✓' : ' ',
        onClick: () => explorerSettings.toggle('foldersFirst'),
      },
      /* "折叠空中间目录" 已移除: settings.compactMiddleDirs 无任何渲染消费方 → 切了无效, 假开关。
         实现树的 a/b/c→a.b.c 折叠逻辑前不放。 */
    ];
    setContextMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items,
    });
  }, [t, settings, isZh]);

  // ─── 项目 title 下拉 ───
  const handleTitleDropdown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    /* "打开的文件"/"改动的文件" 两个 scope 已移除: scopedRootFiles 无条件返回全列 (line ~816 自承
       "暂回退到全列"), 选了不过滤 → 假选项。接通 open-files/git-status 过滤前只留 project。 */
    const scopes: Array<{ id: ViewScope; label: string }> = [
      { id: 'project',       label: t.explorer.scopeProject },
    ];
    setContextMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items: scopes.map((s) => ({
        id: s.id,
        label: s.label,
        icon: viewScope === s.id ? '●' : ' ',
        onClick: () => setViewScope(s.id),
      })),
    });
  }, [t, viewScope]);

  // 当前 scope 的显示标签
  const viewScopeLabel = useMemo(() => {
    const map: Record<ViewScope, string> = {
      project:       t.explorer.scopeProject,
      openFiles:     t.explorer.scopeOpenFiles,
      changedFiles:  t.explorer.scopeChangedFiles,
    };
    return map[viewScope];
  }, [viewScope, t]);

  // 空白区域右键 → 弹简化菜单(只有 New File / New Folder / Paste)
  const handleEmptyAreaContextMenu = useCallback((e: React.MouseEvent) => {
    // 只在空白处生效(不要拦截子节点的右键)
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    // 空白菜单的 ctx → selectedPath = null,新建会落到 workspace 根
    requestAnimationFrame(() => {
      const ctx: FileActionContext = {
        selectedPath: null,
        selectedPaths: [],
        leadPath: null,
        selectedIsDirectory: false,
        leadIsDirectory: false,
        workspacePath,
        t,
        ui: {
          toast: (msg, type) => onToast?.(msg, type),
          promptNewItem: (parentDir, isDirectory) => new Promise<string>((resolve, reject) => {
            setNewItemDialog({ visible: true, isDirectory, parentDir, resolve, reject });
          }),
          confirmDelete: () => Promise.resolve(false),
          startInlineRename: () => {},
        },
        refresh: refreshDir,
      };
      const items = withMenuIcons(buildContextMenuItems(ctx));
      setContextMenu({ position: { x: e.clientX, y: e.clientY }, items });
    });
  }, [workspacePath, t, onToast, refreshDir]);

  // ─── step 7B: 焦点 scope + 命令系统 ───
  // 把 file tree 的逻辑焦点 push 到 FocusService。useCommandShortcut 用
  // scope='fileTree' 时只在 FocusService.isActive('fileTree') 才响应。
  // 当 hasFocus 变化时自动 push / clear。
  useFocusScope('fileTree', hasFocus);

  // 13 个 file.* 命令注册到 CommandRegistry，同时绑定到 keymap 默认快捷键。
  // 跟之前 useScopedShortcut 的行为完全一致，但好处是：
  //   - commandId='file.rename' 等同时被暴露给 agent / 命令面板 / 菜单
  //   - keydown listener 用 capture: true 抢在编辑器之前判断 scope，
  //     解决 ⌘C/⌘V 冲突（跟之前 useScopedShortcut 的 capture 机制一致）
  //   - preventDefault 由 useCommandShortcut 自动调用，不需要每个 handler 写
  /* 多根: 只有 primary 实例 (respondsToGlobalActions) 注册 file.* 命令, 否则 N 个实例
   *   重复 register('file.rename') → CommandRegistry 抛 "already registered" 崩溃。
   *   非 primary 的 file 操作走右键菜单 (executeFileAction 直调, 不经命令系统)。 */
  const fileTreeOpts = { scope: 'fileTree' as const, enabled: respondsToGlobalActions };

  useCommandShortcut('file.rename', () => {
    if (selectedFile) executeFileAction('file.rename', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.delete', () => {
    if (selectedFile) executeFileAction('file.delete', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.duplicate', () => {
    if (selectedFile) executeFileAction('file.duplicate', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.cut', () => {
    if (selectedFile) executeFileAction('file.cut', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.copy', () => {
    if (selectedFile) executeFileAction('file.copy', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.paste', () => {
    executeFileAction('file.paste', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.copyPath', () => {
    if (selectedFile) executeFileAction('file.copyPath', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.copyRelativePath', () => {
    if (selectedFile) executeFileAction('file.copyRelativePath', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.newFile', () => {
    executeFileAction('file.newFile', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.newFolder', () => {
    executeFileAction('file.newFolder', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.revealInFinder', () => {
    if (selectedFile) executeFileAction('file.revealInFinder', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.openInTerminal', () => {
    if (selectedFile) executeFileAction('file.openInTerminal', buildActionContext());
  }, fileTreeOpts);
  useCommandShortcut('file.selectAll', () => {
    handleSelectAll();
  }, fileTreeOpts);

  // 键盘 ↑↓→← Enter Home End 导航(组件内 onKeyDown,只在 hasFocus 时生效)
  //
  // 直接打开文件, 方向键路过一个文件开一个 tab。现在直接走 handleSelect (纯选中),
  // 打开仍只由 Enter / 鼠标点击触发, 跟 VSCode 一致。顺带补齐:
  //   → 已展开目录 = 进入第一个子项 (之前 no-op)
  //   ← 文件/已折叠目录 = 跳到父目录 (之前 no-op)
  //   Home/End = 第一个/最后一个可见节点
  useEffect(() => {
    if (!hasFocus) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // 如果当前焦点在 input(rename 或 dialog 内),交给 input 自己处理
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;

      // 收集所有可见树节点,有序 (DOM 顺序 = 视觉顺序)
      const visibleNodes = explorerRootRef.current?.querySelectorAll<HTMLDivElement>('.file-tree-item:not(.root-node)');
      if (!visibleNodes || visibleNodes.length === 0) return;
      const nodes = Array.from(visibleNodes);
      const paths = nodes.map((el) => el.getAttribute('data-path')).filter(Boolean) as string[];
      const currentIdx = selectedFile ? paths.indexOf(selectedFile) : -1;

      /** 选中第 idx 个可见节点 (不打开), 并滚到可视区 */
      const selectAt = (idx: number) => {
        const clamped = Math.max(0, Math.min(paths.length - 1, idx));
        const el = nodes[clamped];
        const p = paths[clamped];
        if (!el || !p) return;
        const isDir = el.classList.contains('directory');
        handleSelect(p, isDir);
        el.scrollIntoView({ block: 'nearest' });
      };

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectAt(currentIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectAt(currentIdx <= 0 ? 0 : currentIdx - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!selectedFile) return;
        if (selectedIsDirectory) {
          if (!expandedDirs.has(selectedFile)) {
            handleToggleDir(selectedFile);
          } else {
            // 已展开 → 进入第一个子项 (可见列表里紧跟其后且以 selectedFile/ 开头)
            const next = currentIdx + 1;
            if (next < paths.length && paths[next].startsWith(selectedFile + '/')) {
              selectAt(next);
            }
          }
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!selectedFile) return;
        if (selectedIsDirectory && expandedDirs.has(selectedFile)) {
          handleToggleDir(selectedFile);
        } else {
          // 文件 / 已折叠目录 → 跳到父目录
          const parent = selectedFile.slice(0, selectedFile.lastIndexOf('/'));
          const parentIdx = paths.indexOf(parent);
          if (parentIdx >= 0) selectAt(parentIdx);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectAt(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        selectAt(paths.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedFile) {
          if (selectedIsDirectory) {
            handleToggleDir(selectedFile);
          } else {
            handleOpenFile(selectedFile);
          }
        }
      }
    };
    const root = explorerRootRef.current;
    root?.addEventListener('keydown', onKeyDown);
    return () => root?.removeEventListener('keydown', onKeyDown);
  }, [hasFocus, selectedFile, selectedIsDirectory, expandedDirs, handleToggleDir, handleOpenFile, handleSelect]);

  // ─── Type-to-search (IDEA Speed Search) ───
  // 在文件树聚焦时,敲字母 → 跳到第一个匹配 prefix 的可见节点
  useEffect(() => {
    if (!hasFocus) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // 跳过 input / textarea 内的输入
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      // 跳过带修饰键的(那些是快捷键)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 只接受可打印字符(字母 / 数字 / 部分符号)
      if (e.key.length !== 1) return;
      // 跳过空格(IDEA 用空格做选中切换,这里先不实现)
      if (e.key === ' ') return;

      e.preventDefault();
      const newBuffer = typeBuffer + e.key.toLowerCase();
      setTypeBuffer(newBuffer);

      // 重置 1 秒倒计时
      if (typeBufferTimerRef.current != null) {
        window.clearTimeout(typeBufferTimerRef.current);
      }
      typeBufferTimerRef.current = window.setTimeout(() => {
        setTypeBuffer('');
        typeBufferTimerRef.current = null;
      }, 1200);

      // 找匹配的可见节点: prefix 优先, 找不到回退 substring (跟 IDEA Speed Search 一致)
      // 打开文件, 敲字母定位就误开一堆 tab。改走 handleSelect 纯选中。
      const visibleNodes = explorerRootRef.current?.querySelectorAll<HTMLDivElement>('.file-tree-item:not(.root-node)');
      if (!visibleNodes) return;
      const nodes = Array.from(visibleNodes);
      const nameOf = (node: HTMLDivElement) =>
        (node.querySelector<HTMLSpanElement>('.file-name')?.textContent || '').toLowerCase();
      let hit = nodes.find((n) => nameOf(n).startsWith(newBuffer));
      if (!hit) hit = nodes.find((n) => nameOf(n).includes(newBuffer));
      if (hit) {
        const p = hit.getAttribute('data-path');
        if (p) handleSelect(p, hit.classList.contains('directory'));
        hit.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasFocus, typeBuffer, handleSelect]);

  // 焦点进入 file-explorer 时打开 hasFocus,失焦时关闭
  useEffect(() => {
    const root = explorerRootRef.current;
    if (!root) return;
    const onFocusIn = () => setHasFocus(true);
    const onFocusOut = (e: FocusEvent) => {
      // 如果新焦点还在 explorer 内,不算失焦
      if (!root.contains(e.relatedTarget as Node)) {
        setHasFocus(false);
      }
    };
    // 用 mouseenter 把焦点 attach 上去(因为 div 没默认 focusable)
    const onMouseDown = () => setHasFocus(true);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('mousedown', onMouseDown);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  return (
    <div
      className={`file-explorer ${className}`}
      ref={explorerRootRef}
      tabIndex={-1}
      onMouseDown={() => explorerRootRef.current?.focus({ preventScroll: true })}>
      {/* 头部 — JB 风格：左侧标题下拉 + 右侧工具按钮 (多根工作区下由外层统一渲染, hideHeader) */}
      {!hideHeader && (
      <div className="sidebar-header explorer-header">
        <button
          className="explorer-title-btn"
          type="button"
          title={t.explorer.viewOptions}
          onClick={handleTitleDropdown}
        >
          <span>{viewScopeLabel}</span>
          <Icons.ChevronDown />
        </button>
        {/* IDEA New UI 工具窗口 header 标准 6 按钮: [+ ⊙ ↕ ✕ ⋮ −] */}
        <div className="explorer-actions">
          <button
            className="explorer-action-btn"
            type="button"
            title={t.explorer.newFile}
            onClick={handleToolbarNewFile}
          >
            <Icons.JBAddFile />
          </button>
          <button
            className="explorer-action-btn"
            type="button"
            title={t.explorer.locateInProjectView}
            onClick={handleToolbarLocate}
          >
            <Icons.JBLocate />
          </button>
          <button
            className="explorer-action-btn"
            type="button"
            onClick={collapseAll}
            title={`${t.common.close} ${t.explorer.projectTitle}`}
          >
            <Icons.JBCollapseAll />
          </button>
          <button
            className="explorer-action-btn"
            type="button"
            title={t.explorer.viewOptions}
            onClick={handleOpenViewOptions}
          >
            <Icons.JBMoreVertical />
          </button>
          <button
            className="explorer-action-btn"
            type="button"
            title={t.common.close}
            onClick={() => onHidePanel?.()}
          >
            <Icons.JBHide />
          </button>
        </div>
      </div>
      )}

      {/* Type-to-search overlay (IDEA Speed Search) */}
      {typeBuffer && (
        <div className="explorer-speed-search">
          <span className="speed-search-icon">🔎</span>
          <span className="speed-search-buffer">{typeBuffer}</span>
        </div>
      )}

      {/* 文件树 */}
      <div
        className="explorer-tree"
        onClick={handleEmptyAreaClick}
        onContextMenu={handleEmptyAreaContextMenu}
        onDragOver={handleContainerDragOver}
        onDrop={handleContainerDrop}
      >
        {/* 根节点 — 单击只选中,双击才展开,跟子目录行为一致; 右键弹 IDEA 风格菜单 */}
        <div
          className={`file-tree-item root-node ${isRootExpanded ? 'expanded' : ''}${selectedFile && filePathKey(selectedFile) === filePathKey(workspacePath) ? ' selected' : ''}`}
          data-path={workspacePath}
          onClick={handleRootClick}
          onDoubleClick={handleRootDoubleClick}
          onContextMenu={handleRootContextMenu}
          title={workspacePath}
        >
          <span className="file-icon" onClick={handleRootChevronClick}>
            <IconFolderStroke size={16} />
          </span>
          <span className="root-name">{workspaceName}</span>
          {workspaceBracket && (
            <span className="root-bracket">[{workspaceBracket}]</span>
          )}
          {shortPath ? <span className="root-path">{shortPath}</span> : null}
          {onRemoveFromWorkspace && (
            <button
              type="button"
              className="root-remove-btn"
              title="从工作区移除此文件夹"
              aria-label="从工作区移除此文件夹"
              onClick={(e) => { e.stopPropagation(); onRemoveFromWorkspace(); }}
            >
              <Icons.JBHide />
            </button>
          )}
        </div>

        {/* 子节点 */}
        <div className={`file-tree-children-wrap${isRootExpanded ? ' is-open' : ''}`}>
          <div className="file-tree-children">
            {(isRootExpanded || scopedRootFiles.length > 0) && (loading ? (
              <div className="tree-loading" style={{ paddingLeft: '22px' }}>
                <span className="tree-loading-spinner"><Icons.Loader /></span>
                <span className="neox-text-shimmer">加载中…</span>
              </div>
            ) : error ? (
              <div className="tree-error" style={{ paddingLeft: '22px' }}>{error}</div>
            ) : (
              scopedRootFiles.map((entry) => (
                <FileTreeNode
                  key={entry.path}
                  entry={entry}
                  level={1}
                  expandedDirs={expandedDirs}
                  selectedFile={selectedFile}
                  selectedPaths={selectedPaths}
                  renamingPath={renamingPath}
                  dragOverPath={dragOverPath}
                  onToggleDir={handleToggleDir}
                  onSelectFile={onSelectFile}
                  onOpenFile={handleOpenFile}
                  onSelect={handleSelect}
                  onContextMenu={handleNodeContextMenu}
                  onCommitRename={handleCommitRename}
                  onCancelRename={handleCancelRename}
                  onDragStartNode={handleDragStartNode}
                  onDragOverNode={handleDragOverNode}
                  onDragLeaveNode={handleDragLeaveNode}
                  onDropNode={handleDropNode}
                  loadChildren={loadFiles}
                  gitCwd={workspacePath}
                  recentlyChangedPaths={recentlyChangedPaths}
                  dirReloadTokens={dirReloadTokens}
                  openOnSingleClick={openOnSingleClick}
                />
              ))
            ))}
          </div>
        </div>
      </div>

      {/* ──── ContextMenu (右键) ──── */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* ──── NewItemDialog (新建文件 / 文件夹) ──── */}
      <NewItemDialog
        visible={newItemDialog.visible}
        isDirectory={newItemDialog.isDirectory}
        parentDir={newItemDialog.parentDir}
        onSubmit={(name) => {
          newItemDialog.resolve?.(name);
        }}
        onClose={() => {
          newItemDialog.reject?.(new Error('cancelled'));
          setNewItemDialog({ visible: false, isDirectory: false, parentDir: workspacePath, resolve: null, reject: null });
        }}
      />

      {/* ──── ConfirmDeleteDialog ──── */}
      <ConfirmDeleteDialog
        visible={deleteDialog.visible}
        paths={deleteDialog.paths}
        onConfirm={() => {
          deleteDialog.resolve?.(true);
        }}
        onClose={() => {
          deleteDialog.resolve?.(false);
          setDeleteDialog({ visible: false, paths: [], resolve: null });
        }}
      />
    </div>
  );
});

FileExplorer.displayName = 'FileExplorer';

export default FileExplorer;
