/**
 * edit_plan — 增量修改一个 kind='plan' surface 的 markdown 内容
 *
 * 注: 工具名是 edit_plan, 不是 update_plan, 避免跟 Codex 风格的 update_plan(管理 steps 列表的)冲突.
 *
 * Plan 是长任务作战图(几百-几千字 markdown), 频繁动. 5 种 op 让 agent 用最少 token 推进:
 *   - content        全量替换(初始化或大改)
 *   - append         末尾追加(写进展 / 加新章节)
 *   - replace_section  替换某节(标题精确匹配)
 *   - set_section_status  打章节状态徽章(pending/in_progress/done)
 *   - add_note       追加到"## 笔记"区(没有就自动建)
 *
 * agent 用例:
 *   1) 开 plan: open_surface({kind:'plan', source:{type:'inline', content:'# 重构 X\n...'}})
 *   2) 推进一茬: edit_plan({surface_id, set_section_status:{heading:'阶段1', status:'done'}})
 *   3) 留笔记: edit_plan({surface_id, add_note:'阶段1 完成,发现 Y 需后续跟进'})
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  SURFACE_MARKER,
  type PlanOp,
  type PlanSectionStatus,
  type SurfaceMarkerPayload,
} from './surfaceTypes.js';

interface UpdatePlanArgs {
  surface_id: string;
  content?: string;
  append?: string;
  replace_section?: { heading: string; content: string };
  set_section_status?: { heading: string; status: PlanSectionStatus };
  add_note?: string;
}

export const updatePlanTool: Tool = {
  name: 'edit_plan',
  description: `Incrementally edit a kind='plan' surface (the long-form battle plan markdown).

Note: this is NOT the Codex-style 'update_plan' (which manages a step list). This tool edits the markdown body of a plan surface opened via open_surface.

Plan surfaces hold the strategic "war map" of a long task (hundreds-thousands of chars).
Use these incremental ops instead of resending the whole document each time — saves tokens, and lets the UI animate the change.

FILE-BACKED PLANS (for long plans): if the plan is large / long-lived (a target battle plan, a REQUIREMENTS doc), keep the canonical copy in a real markdown FILE and open a file-source plan surface (open_surface({kind:'plan', source:{type:'file', path:'REQUIREMENTS.md'}})). Then edit it with native edit/write_file and read it back with readfile each turn — the file stays out of your context and the surface auto-refreshes. edit_plan's inline ops below are best for SHORT plans held inline; for a big file-backed plan, edit the file directly.

Ops (pass exactly one per call — combining ops is allowed but unusual):
- \`content: "<full md>"\` — replace entire plan (init or major rewrite)
- \`append: "<md fragment>"\` — append to end (good for adding a phase or section)
- \`replace_section: { heading: "阶段 1", content: "<new section md>" }\` — replace one section by heading (matches \`## 阶段 1\` or any heading level)
- \`set_section_status: { heading: "阶段 1", status: "done" }\` — toggle the status badge on a heading. Renderer parses \`<!-- status: ... -->\` after the heading.
- \`add_note: "<text>"\` — append a bullet to the "## 笔记" section (creates the section if missing). Use for progress notes / discoveries during execution.

Pair with \`update_todos\` — plan is the long-lived strategy, todos are the short-lived "current batch" the agent is actually grinding through right now.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['plan_edit', 'editPlan', 'surface_plan_edit'],

  parameters: {
    type: 'object',
    properties: {
      surface_id: {
        type: 'string',
        description: 'The surface_id of the plan (returned by open_surface with kind="plan").',
      },
      content: {
        type: 'string',
        description: 'Full replacement markdown. Use only for init or major rewrites.',
      },
      append: {
        type: 'string',
        description: 'Markdown fragment to append at the end.',
      },
      replace_section: {
        type: 'object',
        description: 'Replace one section by heading. { heading: "阶段 1", content: "<new section md including the heading line>" }',
      },
      set_section_status: {
        type: 'object',
        description: 'Toggle a section status badge. { heading: "阶段 1", status: "pending"|"in_progress"|"done" }',
      },
      add_note: {
        type: 'string',
        description: 'Append a bullet to the "## 笔记" section. Section is created if missing.',
      },
    },
    required: ['surface_id'],
  },

  async function(args: UpdatePlanArgs): Promise<string> {
    if (!args?.surface_id) {
      return JSON.stringify({ error: 'surface_id is required' });
    }

    const op = pickOp(args);
    if (!op) {
      return JSON.stringify({ error: 'must provide one of: content / append / replace_section / set_section_status / add_note' });
    }

    const payload: SurfaceMarkerPayload = {
      [SURFACE_MARKER]: true,
      action: 'plan_op',
      surfaceId: args.surface_id,
      planOp: op,
    };
    return JSON.stringify(payload);
  },
};

function pickOp(args: UpdatePlanArgs): PlanOp | null {
  if (typeof args.content === 'string') {
    return { kind: 'content', content: args.content };
  }
  if (typeof args.append === 'string') {
    return { kind: 'append', text: args.append };
  }
  if (args.replace_section && typeof args.replace_section.heading === 'string' && typeof args.replace_section.content === 'string') {
    return { kind: 'replace_section', heading: args.replace_section.heading, content: args.replace_section.content };
  }
  if (args.set_section_status && typeof args.set_section_status.heading === 'string' && typeof args.set_section_status.status === 'string') {
    return { kind: 'set_section_status', heading: args.set_section_status.heading, status: args.set_section_status.status };
  }
  if (typeof args.add_note === 'string') {
    return { kind: 'add_note', text: args.add_note };
  }
  return null;
}
