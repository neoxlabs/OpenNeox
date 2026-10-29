/**
 * @neox/ide/editor — 编辑器平台层
 *
 * 把编辑器标签页 / 文档状态从 React Hook 中抽离出来，沉到 IDE 平台层。
 * 这是 Neox 客户端架构重构 step 2 的产物。
 *
 * 行为对齐
 * --------
 * EditorService 严格保留 useEditorTabs 的全部行为（包括边界 case），
 * 后续 React 接入时不会引入任何行为漂移。
 *
 * 用法（最小例子）
 * --------------
 * ```ts
 * import { EditorService, EDITOR_SERVICE, EDITOR_TOPIC } from '@neox/ide/editor'
 *
 * const fs: FileSystemPort = {
 *   readFile: (path) => window.neox.readFile(path),
 *   writeFile: (path, content) => window.neox.writeFile(path, content),
 * }
 * const editor = new EditorService({ fs, bus })
 * container.register(EDITOR_SERVICE, () => editor)
 *
 * await editor.openFile('/foo.ts')
 * editor.updateContent(editor.getActiveTab()!.id, 'new content')
 * await editor.save(editor.getActiveTab()!.id)
 * ```
 */

export { EditorService } from './EditorService.js';
export type { EditorServiceOptions } from './EditorService.js';
export {
  EDITOR_TOPIC,
  EDITOR_SERVICE,
} from './types.js';
export type {
  EditorTab,
  EditorState,
  EditorEvents,
} from './types.js';
