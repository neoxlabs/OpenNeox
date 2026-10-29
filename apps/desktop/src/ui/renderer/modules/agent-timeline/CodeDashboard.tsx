
import React, { useMemo } from 'react';

type CodeIconKey = 'rocket' | 'bug' | 'refactor' | 'test' | 'review' | 'explain' | 'git' | 'perf';

interface CodeScenario {
  icon: CodeIconKey;
  title: string;
  prompt: string;
}

/* SVG 内容 20x20 viewBox, stroke:currentColor, stroke-width:1.4 — 与 .atl-scenario__glyph 同风 */
const CODE_ICON_SHAPES: Record<CodeIconKey, React.ReactNode> = {
  /* 火箭 — 实现新功能 */
  rocket:   (<><path d="M12 3s-3 2-5 6c-1.5 3 0 5 0 5s2 1.5 5 0c4-2 6-5 6-5s-1-4-6-6z"/><circle cx="13" cy="8" r="1.2"/><path d="M8 12l-3 2m10-4l2-3"/></>),
  bug:      (<><ellipse cx="10" cy="12" rx="4.5" ry="5"/><path d="M10 7v10M5.5 10H4.5M15.5 10h1M6 15l-2 2M14 15l2 2M6 8L4 6M14 8l2-2"/></>),
  /* 循环箭头 — 重构 */
  refactor: (<><path d="M4 10a6 6 0 0 1 10-4"/><path d="M14 3v3.5h-3.5"/><path d="M16 10a6 6 0 0 1-10 4"/><path d="M6 17v-3.5h3.5"/></>),
  /* 打勾 — 写测试 */
  test:     (<><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M6.5 10.5l2.5 2.5 4.5-5"/></>),
  /* 眼睛 + 分支 — PR 审查 */
  review:   (<><path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5S2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2"/></>),
  /* 灯泡 — 解释代码 */
  explain:  (<><path d="M6 8a4 4 0 1 1 6.5 3.1c-.6.5-1 1.2-1.2 2.1V14h-2.6v-.8c-.2-.9-.6-1.6-1.2-2.1A4 4 0 0 1 6 8z"/><path d="M9 16.5h2M9 18h2"/></>),
  /* 分叉 — Git */
  git:      (<><circle cx="5" cy="5" r="1.8"/><circle cx="5" cy="15" r="1.8"/><circle cx="15" cy="7" r="1.8"/><path d="M5 6.8v6.4"/><path d="M6.5 5.5c3 0 4.5 1 7 1.5"/><path d="M15 8.8v1c0 3-4 3-8 4"/></>),
  /* 闪电 — 性能 */
  perf:     (<><path d="M11 2 4 12h5l-1 6 7-10h-5l1-6z"/></>),
};

function getCodeScenarios(zh: boolean): CodeScenario[] {
  return zh ? [
    { icon: 'rocket',   title: '实现新功能', prompt: '帮我实现一个新功能: (描述目标 / 输入 / 输出 / 边界情况)。请先列 3-5 步计划, 再动手改 / 补测试。' },
    { icon: 'bug',      title: '定位并修 bug', prompt: '有个 bug 需要你帮我定位和修复: (描述症状 / 复现步骤 / 期望行为)。请先查代码找出根因, 再最小改动修复, 最后补一个回归测试.' },
    { icon: 'refactor', title: '重构', prompt: '帮我重构一段代码, 目标是: (更清晰 / 拆职责 / 抽公共 / 去重复)。先给出重构计划, 保持行为等价, 逐步改并跑测试.' },
    { icon: 'test',     title: '写测试', prompt: '帮我给这段代码补测试: (指定文件 / 函数)。覆盖 happy path + 边界 + 异常; 用项目已有的测试框架和风格.' },
    { icon: 'review',   title: '审查这个 PR', prompt: '帮我审这份改动 (贴 diff 或说 PR 号): 1) 正确性 2) 边界/回归风险 3) 命名/结构 4) 有没有更简洁的写法。给可动的评论, 不要空话.' },
    { icon: 'explain',  title: '解释代码', prompt: '帮我读懂这段代码: (贴代码或指路径)。请说明 1) 它做什么 2) 关键设计选择的 why 3) 有没有可疑/易踩的坑.' },
    { icon: 'git',      title: 'Git 操作', prompt: '帮我处理一下 git: (描述场景, 比如"合并冲突"/"回滚到某 commit 但保留 xxx"/"cherry-pick 一批"). 先解释再执行, 破坏性操作先确认.' },
    { icon: 'perf',     title: '性能优化', prompt: '这段代码/接口跑得慢, 帮我优化: (贴代码或指路径, 说明 profile 数据或体感)。先测量再改, 保留可读性, 给 before/after 数据.' },
  ] : [
    { icon: 'rocket',   title: 'Implement feature', prompt: 'Implement a new feature: (goal / inputs / outputs / edge cases). List a 3-5 step plan first, then code + tests.' },
    { icon: 'bug',      title: 'Find & fix bug',    prompt: "There's a bug to track down and fix: (symptoms / repro / expected). Locate the root cause first, then minimal fix + regression test." },
    { icon: 'refactor', title: 'Refactor',          prompt: 'Refactor this code toward: (clarity / separation / dedup). Give a plan first, keep behavior equivalent, apply step by step with tests passing.' },
    { icon: 'test',     title: 'Write tests',       prompt: 'Add tests for: (file / function). Cover happy path + edges + errors, follow the project\'s existing test style.' },
    { icon: 'review',   title: 'Review this PR',    prompt: 'Review this change (paste diff or PR#): 1) correctness 2) edges/regression risk 3) naming/structure 4) simpler alternatives. Actionable comments, no fluff.' },
    { icon: 'explain',  title: 'Explain code',      prompt: 'Explain this code: (paste or point to path). Cover 1) what it does 2) why the key design choices 3) suspicious spots to watch.' },
    { icon: 'git',      title: 'Git ops',           prompt: 'Help me with a git operation: (describe — "merge conflict" / "revert to X but keep Y" / "cherry-pick a batch"). Explain first, confirm before anything destructive.' },
    { icon: 'perf',     title: 'Perf tuning',       prompt: 'This runs slow; help me tune: (paste code or path, share profile data or feel). Measure first, keep readable, report before/after numbers.' },
  ];
}

const CodeScenarioIcon: React.FC<{ icon: CodeIconKey }> = ({ icon }) => (
  <span className="atl-scenario__glyph" aria-hidden>
    <svg viewBox="0 0 20 20" width="18" height="18">{CODE_ICON_SHAPES[icon]}</svg>
  </span>
);

const CodeDashboard: React.FC<{
  isZh: boolean;
  onDispatch: (text: string) => void;
}> = ({ isZh, onDispatch }) => {
  const scenarios = useMemo(() => getCodeScenarios(isZh), [isZh]);
  return (
    <section className="atl-code-dash">
      <div className="atl-code-dash__section-h">
        {isZh ? '快速开始' : 'Quick start'}
      </div>
      <div className="atl-code-scenarios">
        {scenarios.map((s, i) => (
          <button
            key={i}
            type="button"
            className="atl-code-scenario"
            onClick={() => onDispatch(s.prompt)}
            title={s.prompt}
          >
            <CodeScenarioIcon icon={s.icon} />
            <span className="atl-code-scenario__title">{s.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
};

export default CodeDashboard;
