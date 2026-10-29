/**
 * update_profile — Work 模式的结构化个人档案.
 *
 * 落 ~/.neox/user_profile_work.md — 这个文件本来就每回合注入 prompt
 * (prompts/sections 的 user-mode-profile 段), 所以 agent 写进去的事实
 * 下一轮起自动"认识"用户, 不需要新的注入链路。
 *
 * 与 memory 工具的分工:
 *   update_profile = 关于用户本人的长期事实 (称呼/岗位/公司/偏好/城市/作息), 每回合全文注入;
 *   memory         = 项目/任务层面的知识沉淀, 按需检索注入。
 *
 * 格式: markdown 二级标题分节 + 无序列表条目, 用户可直接手改同一文件
 * (onboarding 勾选的场景 chips 也落在这里, 井水不犯河水地共存)。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getUserProfilePath } from '../runtime/modeHome.js';

/** 建议的分节 — 非强制, agent 传别的节名也接受 (放宽比拒绝稳) */
const SUGGESTED_SECTIONS = ['基本', '家人与关系', '重要日期', '饮食偏好', '健康', '兴趣', '其他'];

interface UpdateProfileArgs {
  action: 'add' | 'remove' | 'get';
  section?: string;
  entry?: string;
  /** Batch add: 多条同 section 一次调用, 避免模型分 N 次调 tool. entries 存在时忽略 entry. */
  entries?: string[];
  match?: string;
}

function readProfile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** 在 section 下追加条目; section 不存在则新建到文件末尾 */
function addEntry(content: string, section: string, entry: string): string {
  const lines = content.length ? content.split('\n') : [];
  const header = `## ${section}`;
  const bullet = `- ${entry}`;
  const idx = lines.findIndex(l => l.trim() === header);
  if (idx === -1) {
    const tail = lines.length && lines[lines.length - 1].trim() !== '' ? [''] : [];
    return [...lines, ...tail, header, bullet, ''].join('\n');
  }
  /* 找 section 末尾 (下一个 ## 或文件尾), 在其前插入 */
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  /* 去重: 完全相同的条目不重复加 */
  for (let i = idx + 1; i < end; i++) {
    if (lines[i].trim() === bullet) return lines.join('\n');
  }
  /* 跳过 section 尾部空行, 紧跟最后一条内容插入 */
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

/** 删除所有包含 match 子串的条目行 (只删 "- " 开头的条目, 不动标题) */
function removeEntries(content: string, match: string, section?: string): { next: string; removed: number } {
  const lines = content.split('\n');
  const header = section ? `## ${section}` : null;
  let inSection = header === null;
  let removed = 0;
  const kept = lines.filter(l => {
    if (l.startsWith('## ')) {
      inSection = header === null || l.trim() === header;
      return true;
    }
    if (inSection && l.trim().startsWith('- ') && l.includes(match)) {
      removed++;
      return false;
    }
    return true;
  });
  return { next: kept.join('\n'), removed };
}

export const updateProfileTool: Tool = {
  name: 'update_profile',
  description:
    'Maintain the user\'s durable personal profile (name/nickname, family members, birthdays & ' +
    'anniversaries, food preferences & allergies, health basics, city, habits). The profile is ' +
    'injected into every future conversation, so facts saved here make you permanently "know" the user. ' +
    'Call action="add" when the user reveals a durable personal fact ("我妈生日是3月8号", "我不吃香菜", ' +
    '"我住在杭州"); action="remove" with a match string when a fact changes or the user asks to forget; ' +
    'action="get" to view the full profile. Do NOT store transient task state here.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'get'], description: 'add a fact / remove matching facts / read the profile.' },
      section: {
        type: 'string',
        description: `Section to file the fact under. Suggested: ${SUGGESTED_SECTIONS.join(' / ')}. Free-form section names are accepted. Required for add.`,
      },
      entry: {
        type: 'string',
        description: 'The fact as one short line, third-person, no emoji. e.g. "妈妈生日: 3月8日" / "不吃香菜" / "常住杭州, 周末常去西湖跑步". Required for add if `entries` not given.',
      },
      entries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Batch: add multiple facts in one call (up to 8). Prefer over calling update_profile N times. e.g. ["对花生过敏", "接触猫毛会打喷嚏"]. All entries share the same `section`. Optional; if given, `entry` is ignored.',
      },
      match: {
        type: 'string',
        description: 'Substring to match entries for removal (all "- " lines containing it are deleted; scoped to `section` if given). Required for remove.',
      },
    },
    required: ['action'],
  },

  async function(args: UpdateProfileArgs): Promise<string> {
    const path = getUserProfilePath('work');
    try {
      if (args.action === 'get') {
        const content = readProfile(path).trim();
        return JSON.stringify({ profile: content || '(empty — no facts saved yet)', path });
      }
      if (args.action === 'add') {
        const section = args.section?.trim();
        /* Batch 分支: entries[] 传入时一次调用写多条, 避免模型对多个相关事实分 N 次调工具 */
        const batch = Array.isArray(args.entries)
          ? args.entries.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).slice(0, 8)
          : [];
        const single = args.entry?.trim();
        const items = batch.length > 0 ? batch : (single ? [single] : []);
        if (!section || items.length === 0) return JSON.stringify({ error: 'add requires section and either entry or entries[]' });
        const oversized = items.find((e) => e.length > 200);
        if (oversized) return JSON.stringify({ error: 'entry too long — keep facts to one short line (<200 chars)' });
        let current = readProfile(path);
        for (const it of items) current = addEntry(current, section, it);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, current, 'utf8');
        return JSON.stringify({
          ok: true,
          added: items.length,
          message: `Saved ${items.length} to profile [${section}]: ${items.join(' | ')}`,
        });
      }
      if (args.action === 'remove') {
        const match = args.match?.trim();
        if (!match) return JSON.stringify({ error: 'remove requires match' });
        const { next, removed } = removeEntries(readProfile(path), match, args.section?.trim() || undefined);
        if (removed === 0) return JSON.stringify({ ok: false, message: `No profile entries contain "${match}". Use action="get" to see current entries.` });
        writeFileSync(path, next, 'utf8');
        return JSON.stringify({ ok: true, removed, message: `Removed ${removed} entr${removed > 1 ? 'ies' : 'y'} matching "${match}".` });
      }
      return JSON.stringify({ error: `unknown action "${(args as { action?: string }).action}"` });
    } catch (e: unknown) {
      return JSON.stringify({ error: `update_profile failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
};
