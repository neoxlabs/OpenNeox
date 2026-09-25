/**
 * @openneox/pptx-compose/node — Node/agent-shell 专用出口.
 *
 * 跟主入口一样, 只是名字为了让 agent 从 .mjs 里 dynamic import 时更明确"这是 node 分支".
 * 内容 100% 从 index re-export.
 */

export * from './index.js';
