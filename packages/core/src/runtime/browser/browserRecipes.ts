/**
 * 录一遍, 以后 0 token 复跑 —— 浏览器脚本的录制 / 回放 / 自愈。
 *
 * ─── 为什么值得做 ──────────────────────────────────────────────────────────
 * 同一件事 (每天登后台导一张报表 / 每周去某个页面抓状态) 现在每次都要重新烧一遍
 * 模型: 看页面 → 想选择器 → 写脚本, 一轮几万 token。而这件事第二次做的时候,
 * 步骤跟第一次一模一样 —— 需要模型的只有"第一次"。
 *
 * ─── 存成 SKILL.md, 不是私有格式 ────────────────────────────────────────────
 * 落在 `~/.neox/skills/<name>/SKILL.md`, 就是本仓库已有的技能格式。三个好处:
 *   · 用户能直接改 —— 改一个选择器、删一步、加一句说明, 不用求助模型
 *   · 技能系统自己会加载它, 模型能看见"我会做这件事"
 *   · 人读的部分和机器读的部分在同一个文件里, 不会一个改了另一个没改
 *
 * 机器读的是文件末尾那个 ```json 块 (```neox-browser-recipe 标记)。上面的中文步骤
 * 清单是**给人看的**, 回放时不解析它 —— 两份真相里必须有一份说了算, 否则用户改了
 * 文字以为改了行为。这一点在文件里写明白, 见 renderSkillMd。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 一条备用定位方式。主定位失效时按顺序试。 */
export interface RecipeAnchor {
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface RecipeStep {
  action: string;
  args?: Record<string, unknown>;
  expectChange?: unknown;
  optional?: boolean;
  label?: string;
  /** 录制时一起存下的备用定位方式 —— 自愈就靠它 */
  anchors?: RecipeAnchor[];
}

export interface Recipe {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  steps: RecipeStep[];
  /** 自愈改写过几次 —— 用户能看出这份录制"漂"得厉害不厉害 */
  healCount?: number;
}

const FENCE = 'neox-browser-recipe';

/** 技能目录。放用户级而不是工作区级: 录的是"某个网站怎么操作", 跟哪个仓库无关。 */
export function recipesRoot(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'skills');
}

/**
 * 名字 → 目录名。只留字母数字和连字符 —— 它要当目录名, 也要当技能名。
 * 中文名会被整段替换成连字符, 所以空结果时回落一个固定前缀 + 时间戳, 而不是建一个叫 "" 的目录。
 */
export function slugify(name: string): string {
  const s = String(name ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `recipe-${Date.now()}`;
}

export function recipePath(name: string): string {
  return join(recipesRoot(), slugify(name), 'SKILL.md');
}

/** 人读的一行步骤说明。跟时间线上的说法保持一致 —— 同一件事只该有一种说法。 */
function describeStep(s: RecipeStep): string {
  const a = (s.args ?? {}) as Record<string, unknown>;
  const target = String(a.selector ?? a.text ?? a.name ?? a.url ?? a.key ?? '').slice(0, 60);
  const verb: Record<string, string> = {
    navigate: '打开', click: '点击', type: '输入', fill_form: '填表', press_key: '按键',
    scroll: '滚动', hover: '悬停', select_option: '选择', wait_for: '等待',
    wait_for_navigation: '等页面跳转', expect: '断言', eval: '执行脚本',
    get_text: '读文本', query: '查元素', screenshot: '截图', get_aria_tree: '读页面结构',
    back: '后退', forward: '前进', reload: '刷新',
  };
  const v = verb[s.action] ?? s.action;
  const label = s.label ? ` (${s.label})` : '';
  return target ? `${v} \`${target}\`${label}` : `${v}${label}`;
}

export function renderSkillMd(r: Recipe): string {
  const lines = r.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join('\n');
  return `---
name: ${slugify(r.name)}
description: 复跑一段录好的浏览器操作「${r.description || r.name}」—— 共 ${r.steps.length} 步, 不需要重新看页面写脚本。
user-invocable: false
---

# ${r.description || r.name}

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "${slugify(r.name)}" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

${lines || '(空)'}

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

\`\`\`${FENCE}
${JSON.stringify({
  name: slugify(r.name),
  description: r.description,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  healCount: r.healCount ?? 0,
  steps: r.steps,
}, null, 2)}
\`\`\`
`;
}

/** 从 SKILL.md 里抠出机器读的那块。抠不到返回 null —— 文件在但块没了, 不能当"空脚本"跑。 */
export function parseSkillMd(text: string): Recipe | null {
  const m = new RegExp('```' + FENCE + '\\s*\\n([\\s\\S]*?)\\n```').exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Partial<Recipe>;
    if (!Array.isArray(raw.steps)) return null;
    return {
      name: String(raw.name ?? ''),
      description: String(raw.description ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      updatedAt: String(raw.updatedAt ?? ''),
      healCount: Number(raw.healCount ?? 0),
      steps: raw.steps as RecipeStep[],
    };
  } catch {
    /* JSON 被用户改坏了 —— 明确当"读不出来", 而不是回一份空脚本假装成功 */
    return null;
  }
}

export function saveRecipe(r: Recipe): string {
  const p = recipePath(r.name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, renderSkillMd(r), 'utf8');
  return p;
}

export function loadRecipe(name: string): Recipe | null {
  const p = recipePath(name);
  if (!existsSync(p)) return null;
  try {
    return parseSkillMd(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export interface RecipeSummary { name: string; description: string; steps: number; updatedAt: string }

export function listRecipes(): RecipeSummary[] {
  const root = recipesRoot();
  if (!existsSync(root)) return [];
  const out: RecipeSummary[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    try {
      const r = parseSkillMd(readFileSync(join(root, dir.name, 'SKILL.md'), 'utf8'));
      /* 只有带录制块的才算 —— 用户手写的普通技能不该出现在"能复跑的浏览器脚本"里 */
      if (r) out.push({ name: r.name || dir.name, description: r.description, steps: r.steps.length, updatedAt: r.updatedAt });
    } catch { /* 不是录制技能, 跳过 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `text` 是**内容**而不是定位的动作。
 *
 * browser_click({text:"登录"}) 里的 text 是"点哪个", 而 browser_type({selector,text}) 里的
 * text 是"输入什么"。自愈时把这两个混为一谈的后果很具体: 换定位时顺手删掉 text,
 * 用户名就没了; 拿 anchor 的文字去覆盖 text, 用户名会被填成"用户名"。
 */
const TEXT_IS_CONTENT = new Set(['type', 'fill_form', 'select_option', 'press_key']);

/**
 * 主定位失效时的备选参数序列。
 *
 * 每个备选都是"把 anchor 覆盖到原参数上" —— surfaceId、按键、填的值这些必须留着,
 * 只换定位那几个字段。而且**换定位就要把别的定位字段清掉**: 留着旧 selector 的话,
 * resolveLocator 优先用 selector, 备选等于没换。
 */
export function healingVariants(step: RecipeStep): Record<string, unknown>[] {
  const base = { ...(step.args ?? {}) } as Record<string, unknown>;
  const textIsContent = TEXT_IS_CONTENT.has(step.action);
  const out: Record<string, unknown>[] = [];
  for (const a of step.anchors ?? []) {
    const v = { ...base };
    delete v.selector; delete v.role; delete v.name;
    if (!textIsContent) delete v.text;
    if (a.selector) v.selector = a.selector;
    else if (a.role) { v.role = a.role; if (a.name) v.name = a.name; }
    else if (a.text && !textIsContent) v.text = a.text;
    else continue;   /* 文字锚点对 type 这类动作没用 —— 它没有"按文字找元素"这条路 */
    /* 跟原参数一模一样的备选没有意义 —— 试它只是白等一次超时 */
    if (JSON.stringify(v) === JSON.stringify(base)) continue;
    out.push(v);
  }
  return out;
}
