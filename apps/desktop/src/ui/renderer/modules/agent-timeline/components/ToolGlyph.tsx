import React from 'react';
import type { StepIconKind } from '../types';

const P: Record<string, React.ReactNode> = {
  think: <><path d="M8 2.5a4 4 0 0 0-2.4 7.2c.5.4.9 1 .9 1.6V12h3v-.7c0-.6.4-1.2.9-1.6A4 4 0 0 0 8 2.5Z" /><path d="M6.5 14h3" /></>,
  read: <><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M6.5 8h3M6.5 10.5h3" /></>,
  grep: <><path d="M2.5 4h6M2.5 7h4M2.5 10h3" /><circle cx="11" cy="10" r="2.6" /><path d="m13 12 1.5 1.5" /></>,
  list: <path d="M2.5 4.5h3l1 1.2h7v6.8h-11z" />,
  edit: <path d="m10.5 3 2.5 2.5L6 12.5H3.5V10z" />,
  add: <><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M8 7.5v4M6 9.5h4" /></>,
  run: <path d="m3.5 5 3 3-3 3M8.5 11.5h4" />,
  bg: <><path d="m3.5 5 3 3-3 3" /><circle cx="11.5" cy="11" r="2" /></>,
  web: <><circle cx="7" cy="7" r="3.8" /><path d="m10 10 3 3" /></>,
  browse: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></>,
  todo: <path d="M3 4.5l1.2 1.2L6.5 3.5M3 10.5l1.2 1.2 2.3-2.2M8.5 5h5M8.5 11h5" />,
  plan: <path d="M3 3.5h10M3 8h10M3 12.5h6" />,
  agent: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6" /></>,
  image: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" /></>,
  tools: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><path d="M11.25 9v4.5M9 11.25h4.5" /></>,
  desktop: <><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M6 13.5h4M8 11v2.5" /></>,
  memory: <path d="M8 2.5c-3 0-5 1.8-5 4.3 0 1.6.9 2.8 2 3.5V13l2.2-1.5c.3 0 .5.1.8.1 3 0 5-1.8 5-4.3S11 2.5 8 2.5Z" />,
  git: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="6.5" r="1.5" /><path d="M5 5.5v5M11 8c0 2-2 2.5-4.5 3" /></>,
  test: <><path d="M6 2.5h4M6.5 2.5v4L3.5 12a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9.5 6.5v-4" /><path d="M5 10h6" /></>,
  sheet: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.2h11M2.5 9.8h11M6.5 2.5v11" /></>,
  doc: <><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z" /><path d="M6.5 7h3M6.5 9h3M6.5 11h2" /></>,
  slides: <><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M8 11v2.5M5.5 13.5h5M5 6h4M5 8h2.5" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  plug: <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2" />,
  group: <><path d="M3 4h10M3 8h10M3 12h10" /><circle cx="3" cy="4" r=".4" /></>,
  dot: <circle cx="8" cy="8" r="2" />,
  ask: <><path d="M2.5 4.5h11v6h-6l-3 2.5v-2.5h-2z" /><path d="M7 6.3a1.2 1.2 0 1 1 1.6 1.1c-.4.2-.6.5-.6.9M8 9.6v.1" /></>,
};

const BY_VERB: Array<[RegExp, string]> = [
  [/^思考|^Thought|^Thinking/, 'think'],
  [/^询问|^问你|^Ask/, 'ask'],
  /* 表格 / 文档 / 演示稿的动词先认 —— 「写入单元格」「新建工作簿」别落到通用的「写入 / 新建」 */
  [/单元格|工作簿|表格/, 'sheet'],
  [/段落|替换文本|文档|PDF/, 'doc'],
  [/演示稿|幻灯片/, 'slides'],
  [/^后台|^Background/, 'bg'],
  [/^运行|^Run/, 'run'],
  [/^读取|^Read|^读文档|^看表格/, 'read'],
  [/^搜索|^搜代码|^Search|^Grep/, 'grep'],
  [/^列目录|^文件树|^List|^File tree/, 'list'],
  [/^编辑|^修改|^Edit/, 'edit'],
  [/^新建|^写入|^Write|^Create/, 'add'],
  [/^联网搜索|^网络搜索|^Web search/, 'web'],
  [/^打开网页|^操作|^浏览|^Open page/, 'browse'],
  [/^待办|^Todo/, 'todo'],
  [/^更新计划|^计划|^方案|^plan/i, 'plan'],
  [/Agent$|^子 Agent|^团队/, 'agent'],
  [/^出图|^改图|^Generate image/, 'image'],
  [/^找工具|^Tool search|^用技能|^Use skill/, 'tools'],
  [/^操作电脑|^Computer/, 'desktop'],
  [/^记住|^想起|^记忆|^Memory/, 'memory'],
  [/^Git|^提交|^切分支/, 'git'],
  [/^跑测试|^Run tests|^Lint|^查问题/, 'test'],
  [/表格/, 'sheet'],
  [/文档/, 'doc'],
  [/演示稿/, 'slides'],
  [/^定时|^提醒|^过会儿/, 'clock'],
];

const BY_KIND: Partial<Record<StepIconKind, string>> = {
  thinking: 'think', read: 'read', folder: 'list', file: 'read', terminal: 'run', web: 'web',
  edit: 'edit', diff: 'edit', generate: 'image', search: 'grep', test: 'test', skill: 'tools',
  computer: 'desktop', plugin: 'plug', task: 'todo', project: 'list', database: 'sheet',
};

export function toolGlyphName(verb: string, kind?: StepIconKind): string {
  for (const [re, name] of BY_VERB) if (re.test(verb)) return name;
  return (kind && BY_KIND[kind]) || 'dot';
}

export const ToolGlyph: React.FC<{ name: string; size?: number }> = ({ name, size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {P[name] ?? P.dot}
  </svg>
);
