/**
 * update_todos — 全量替换 kind='todo' surface 的清单项
 *
 * Todo 是"当下一茬"(3-10 条 actionable), 跟 plan 互补:
 *   - plan = 战略地图(长 markdown, 改动少)
 *   - todo = 战术清单(短结构化, 改动频繁)
 *
 * 全量替换语义 — 跟 Claude Code 的 TodoWrite 同范式. items 短(< 10), 全量传输成本可忽略,
 * 简单可靠不会出现"漏掉某项"的 bug.
 *
 * 典型流程:
 *   1) 一茬开始: update_todos({items:[{id:'t1',text:'读文件A',status:'in_progress'},{id:'t2',text:'改函数B',status:'pending'}]})
 *   2) 推进:     update_todos({items:[{id:'t1',...,status:'done'},{id:'t2',...,status:'in_progress'}]})
 *   3) 全做完后开新一茬, 直接传新 items 数组
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  SURFACE_MARKER,
  type SurfaceMarkerPayload,
  type TodoItem,
  type TodoStatus,
} from './surfaceTypes.js';

interface UpdateTodosArgs {
  surface_id?: string;
  items: TodoItem[];
}

/** 没传 surface_id 时用的固定 id —— 一个会话只该有一份"当下清单", 复用同一个 surface
 *  就不会每次调用都长出一个新 tab。renderer 认不到就按这个 id 建。 */
const DEFAULT_TODO_SURFACE_ID = 'todo:current';

const VALID_STATUS: TodoStatus[] = ['pending', 'in_progress', 'done', 'skipped'];

export const updateTodosTool: Tool = {
  name: 'update_todos',
  description: `Replace the items of a kind='todo' surface (the "current batch" checklist).

Todo is the short tactical list of what you're grinding through right now (3-10 items).
Pair with \`update_plan\` — plan holds the long strategic map, todos are the immediate batch you crank on.

Items shape: \`[{ id: 'unique-id', text: '人话描述', status: 'pending'|'in_progress'|'done'|'skipped' }]\`

Semantics: **full replacement** — pass the entire updated array each call. The renderer animates state transitions by matching items by \`id\`, so keep ids stable across updates.

Best practices:
- Have at most one item in 'in_progress' at any time (the user wants to see what you're doing NOW)
- Use 'skipped' when you decide not to do a planned item — don't silently drop it
- When a batch is fully done, replace with the next batch's items rather than appending (keeps the list focused)`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['todos_update', 'updateTodos', 'todo_write', 'TodoWrite'],

  parameters: {
    type: 'object',
    properties: {
      surface_id: {
        type: 'string',
        description:
          'Optional. Omit it — the checklist surface is created on first call and reused afterwards. '
          + 'Only pass one if you deliberately keep several separate checklists.',
      },
      items: {
        type: 'array',
        description: 'Full replacement array of TodoItem { id, text, status }.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable unique id (keep across updates so renderer can match).' },
            text: { type: 'string', description: 'Human-readable description.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done', 'skipped'],
            },
          },
          required: ['id', 'text', 'status'],
        },
      },
    },
    required: ['items'],
  },

  async function(args: UpdateTodosArgs): Promise<string> {
    if (!Array.isArray(args?.items)) {
      return JSON.stringify({ error: 'items must be an array' });
    }

    const normalized: TodoItem[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const raw = args.items[i];
      if (!raw || typeof raw !== 'object') {
        return JSON.stringify({ error: `items[${i}] must be an object` });
      }
      if (typeof raw.id !== 'string' || raw.id.length === 0) {
        return JSON.stringify({ error: `items[${i}].id must be a non-empty string` });
      }
      if (typeof raw.text !== 'string') {
        return JSON.stringify({ error: `items[${i}].text must be a string` });
      }
      if (!VALID_STATUS.includes(raw.status)) {
        return JSON.stringify({ error: `items[${i}].status must be one of: ${VALID_STATUS.join(', ')}` });
      }
      normalized.push({ id: raw.id, text: raw.text, status: raw.status });
    }

    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'todo_replace',
      surfaceId: args.surface_id?.trim() || DEFAULT_TODO_SURFACE_ID,
      todoItems: normalized,
      ensureSurface: { kind: 'todo', title: '待办清单' },
    };
    return JSON.stringify(payload);
  },
};
