import type { Scenario } from '../../../types.js';
import { cart, flow, phase, slug } from '../../gen/helpers.js';

/**
 * Large CLI flow matrix — parameterized journeys for regression volume.
 * Each case remains a multi-step flow with mustNot + UI contracts.
 */

const TOOL_TASKS = [
  {
    key: 'read',
    prompt: '用工具读指定源码文件，引用关键 20 行并总结风险',
    toolExpect: 'read/工具卡出现且可读路径',
  },
  {
    key: 'grep',
    prompt: '用搜索工具在仓库里找关键词 TODO，列出 5 处',
    toolExpect: 'search/grep 卡有命中或明确无命中',
  },
  {
    key: 'shell-ok',
    prompt: '执行 shell: echo CLI_MX_OK && pwd',
    toolExpect: 'shell 卡成功，输出含 CLI_MX_OK',
  },
  {
    key: 'shell-fail',
    prompt: '执行 shell: exit 7，并解释退出码',
    toolExpect: 'shell 卡失败态，退出码可见',
  },
  {
    key: 'write-min',
    prompt: '最小改动：只在某文件加一行注释，说明改了哪',
    toolExpect: 'edit/write 卡 + 可读 diff 摘要',
  },
  {
    key: 'multi-tool',
    prompt: '先读文件再 grep 同关键词，最后中文三点总结',
    toolExpect: '≥2 张工具卡，顺序正确',
  },
] as const;

const INTERRUPTS = [
  { key: 'none', when: '跑完', action: null as string | null },
  { key: 'esc-mid', when: '工具或流式中途', action: 'Esc 中断' },
  { key: 'enter-mid', when: '运行中', action: '输入「停」并 Enter（应中断非排队）' },
] as const;

const AFTERMATH = [
  { key: 'short-ask', prompt: '只回复 PONG' },
  { key: 'continue-topic', prompt: '用一句话接上刚才在做什么' },
  { key: 'compact-then-ask', prompt: null as string | null, slash: '/compact' },
] as const;

function toolInterruptAftermath(): Scenario[] {
  const out: Scenario[] = [];
  for (const [task, interrupt, after] of cart(TOOL_TASKS as unknown as (typeof TOOL_TASKS)[number][], INTERRUPTS as unknown as (typeof INTERRUPTS)[number][], AFTERMATH as unknown as (typeof AFTERMATH)[number][])) {
    // Skip senseless combos: shell-fail + compact-only noise ok; write + esc is valuable
    const id = `cli.mx.task-${task.key}__irq-${interrupt.key}__after-${after.key}`;
    const steps = [
      phase('S0 · baseline', '新会话，记 StatusLine model/ctx/idle', 'idle；模型正确；ctx 基线', {
        assertUi: [{ type: 'state', target: 'StatusLine', state: 'idle' }],
      }),
      phase('S1 · task', `发：「${task.prompt}」`, task.toolExpect, {
        assertUi: [
          { type: 'order', sequence: ['user', 'tool/assistant activity'] },
          { type: 'geometry', rule: '工具卡不遮挡输入区；StatusLine 单行' },
        ],
      }),
    ];
    if (interrupt.action) {
      steps.push(
        phase(
          'S2 · interrupt',
          `${interrupt.when}：${interrupt.action}`,
          '立即停；N agents→0（若有）；StatusLine 回 idle；无永久 busy',
          {
            assertUi: [
              { type: 'state', target: 'StatusLine', state: 'idle' },
              { type: 'not_visible', target: 'Enter to interrupt residual' },
            ],
          },
        ),
      );
    } else {
      steps.push(
        phase('S2 · settle', '等待 turn 自然结束', 'StatusLine idle；工具卡终态正确', {
          severity: 'major',
        }),
      );
    }
    if (after.slash) {
      steps.push(
        phase('S3 · compact', '执行 /compact', '有进度或无需压缩反馈；无双前缀；busy 不残留', {
          assertUi: [
            { type: 'not_visible', target: 'Compact Compact' },
            { type: 'state', target: 'StatusLine', state: 'idle after compact terminal msg' },
          ],
        }),
        phase('S4 · ask', '发：「压缩后还记得任务类型吗？一句话」', '能答或诚实说摘要后未知；可继续输入', {
          severity: 'major',
        }),
      );
    } else {
      steps.push(
        phase('S3 · aftermath', `发：「${after.prompt}」`, '新 turn 干净；无上一轮残片污染', {
          assertUi: [{ type: 'order', sequence: ['previous turn', 'new user', 'new assistant'] }],
        }),
      );
    }
    out.push(
      flow({
        id,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `CLI 矩阵：${task.key} × ${interrupt.key} × ${after.key}`,
        why: '任务类型×中断×收尾组合是真实用户路径，任一类严重 bug 都不能漏',
        combo: ['matrix', 'dialogue', 'tools', task.key, interrupt.key, after.key],
        mustNot: [
          '卡死 busy / 幽灵 running 卡',
          '中断后 sticky agents',
          'Enter 只排队不中断',
          '下一轮混入残片',
          '失败 shell 显示成功',
        ],
        estimateMin: interrupt.key === 'none' ? 8 : 10,
        steps,
        priority: interrupt.key !== 'none' || task.key === 'multi-tool' ? 'P0' : 'P1',
      }),
    );
  }
  return out;
}

const EXPLORE_N = [1, 2, 3] as const;
const EXPLORE_STOP = ['esc', 'enter', 'natural'] as const;

function exploreMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [n, stop] of cart([...EXPLORE_N], [...EXPLORE_STOP])) {
    out.push(
      flow({
        id: `cli.mx.explore-n${n}__stop-${stop}`,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `并行 Explore×${n} → 停止方式 ${stop}`,
        why: 'Explore 数量与停止方式组合易出 sticky agents / 建卡失败',
        combo: ['matrix', 'explore', 'interrupt', `n${n}`, stop],
        mustNot: ['Esc/中断后 N agents>0', 'Explore 永久 running', '再开 Explore 失败'],
        estimateMin: 10,
        priority: n >= 2 ? 'P0' : 'P1',
        steps: [
          phase(
            'E1',
            `发：「并行开 ${n} 个 Explore 查不同子主题，先别汇总」`,
            `底部 agents≈${n}；卡可见有标题`,
            {
              assertUi: [
                { type: 'visible', target: `N agents ≈ ${n}` },
                { type: 'state', target: 'Explore cards', state: 'running' },
              ],
            },
          ),
          phase('E2', '观察 5s', '主 StatusLine busy；卡不空白；不挡输入', {
            severity: 'major',
            assertUi: [{ type: 'geometry', rule: 'Explore UI 与输入区间距稳定' }],
          }),
          phase(
            'E3',
            stop === 'esc'
              ? 'Esc'
              : stop === 'enter'
                ? '输入「全部停下」Enter'
                : '等 Explore 自然结束或主 agent 收束',
            'agents→0 或明确终态；可输入',
            {
              assertUi: [{ type: 'state', target: 'StatusLine', state: 'idle or clean complete' }],
            },
          ),
          phase('E4', '再开 1 个 Explore 短任务', '能建卡跑完；无 suspended 死锁', {
            severity: 'blocker',
          }),
        ],
      }),
    );
  }
  return out;
}

const CTX_LEVELS = [
  { key: 'low', how: '2–3 轮短问答', compactExpect: '多半无需压缩或秒级反馈' },
  { key: 'mid', how: '多轮+中等工具输出，ctx 明显上升', compactExpect: '可能摘要或未获收益，但有过程' },
  { key: 'high', how: '反复读大文件/长输出，尽量抬高 ctx', compactExpect: '应出现生成摘要进度，耗时>1s' },
] as const;

const LANGS = [
  { key: 'zh', note: '中文界面' },
  { key: 'en', note: '英文界面（若可切）' },
] as const;

function compactMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [lvl, lang] of cart([...CTX_LEVELS], [...LANGS])) {
    out.push(
      flow({
        id: `cli.mx.compact-${lvl.key}__lang-${lang.key}`,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `压缩：ctx=${lvl.key} × UI=${lang.key}`,
        why: '不同 ctx 水位与语言下压缩文案/表盘最易回归',
        combo: ['matrix', 'compact', 'tokens', lvl.key, lang.key],
        preconditions: [lang.note, lvl.how],
        mustNot: [
          '双前缀 Compact/压缩',
          '卡片已降但 StatusLine ctx 不降',
          '无需压缩后仍 busy',
        ],
        priority: lvl.key === 'high' ? 'P0' : 'P1',
        estimateMin: lvl.key === 'high' ? 15 : 8,
        steps: [
          phase('C0', `按「${lvl.how}」准备会话`, 'ctx 符合水位预期', { severity: 'major' }),
          phase('C1', '/compact', lvl.compactExpect, {
            assertUi: [
              { type: 'not_visible', target: 'double Compact/压缩 prefix' },
              { type: 'geometry', rule: 'StatusLine 压缩进度单行' },
            ],
          }),
          phase('C2', '读 StatusLine ctx/c-r', '与卡片 final 一致或合理；idle', {
            assertUi: [{ type: 'state', target: 'StatusLine', state: 'idle' }],
          }),
          phase('C3', '短续问「还在吗只回 YES」', 'YES；ctx 从新基线涨', { severity: 'blocker' }),
        ],
      }),
    );
  }
  return out;
}

const BYOK_FAULTS = [
  { key: 'bad-key', setup: 'API key 改为明显错误', err: 'auth/401 类可读错误' },
  { key: 'dead-url', setup: 'baseURL 指到 127.0.0.1:1', err: '连接/超时类错误' },
  { key: 'empty-key', setup: '清空 key', err: '引导配置或明确缺 key' },
  { key: 'wrong-model', setup: '选不存在的 model id（若可）', err: '模型不存在/不可用错误' },
] as const;

const BYOK_RECOVER = [
  { key: 'fix-inplace', how: '改回正确配置后同会话再发' },
  { key: 'switch-model', how: '换到另一个可用模型再发' },
  { key: 'new-session', how: '新会话再发（旧会话错误历史应仍在）' },
] as const;

function byokMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [fault, recover] of cart([...BYOK_FAULTS], [...BYOK_RECOVER])) {
    out.push(
      flow({
        id: `cli.mx.byok-${fault.key}__${recover.key}`,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `BYOK 故障 ${fault.key} → 恢复 ${recover.key}`,
        why: '配置失败组合是阻断级体验',
        combo: ['matrix', 'byok', 'error', fault.key, recover.key],
        mustNot: ['无限 Thinking', '错误后无法再输入', '恢复后必须强杀进程'],
        priority: fault.key === 'bad-key' ? 'P0' : 'P1',
        steps: [
          phase('B1', fault.setup, '配置已破坏', { severity: 'major' }),
          phase('B2', '发「你好」', fault.err + '；StatusLine idle', {
            assertUi: [
              { type: 'visible', target: 'error card' },
              { type: 'state', target: 'StatusLine', state: 'idle' },
            ],
          }),
          phase('B3', recover.how, '能发出下一轮并得到正常助手回复或明确仍失败原因', {
            severity: 'blocker',
          }),
        ],
      }),
    );
  }
  return out;
}

const STREAM_PROMPTS = [
  { key: 'poem', text: '写一首很长的诗至少 60 行' },
  { key: 'essay', text: '用中文写 800 字解释什么是 agent loop' },
  { key: 'code', text: '输出一段较长 TypeScript 示例（带注释）' },
  { key: 'list', text: '列出 40 条工程实践建议，逐条输出' },
] as const;

const STREAM_CUT = [
  { key: 'esc-early', cut: '刚出前几行就 Esc' },
  { key: 'esc-mid', cut: '大约一半时 Esc' },
  { key: 'full', cut: '跑完' },
] as const;

function streamMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const [p, cut] of cart([...STREAM_PROMPTS], [...STREAM_CUT])) {
    out.push(
      flow({
        id: `cli.mx.stream-${p.key}__${cut.key}`,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `流式 ${p.key} × ${cut.key}`,
        why: '流式中断/完整结束的渲染残留是严重 bug',
        combo: ['matrix', 'streaming', 'interrupt', p.key, cut.key],
        mustNot: ['下一轮残片污染', '永久 Writing', '气泡与输入区重叠'],
        priority: cut.key !== 'full' ? 'P0' : 'P1',
        steps: [
          phase('T1', `发：「${p.text}」`, '开始流式；StatusLine Writing/Thinking', {
            severity: 'major',
          }),
          phase('T2', cut.cut, cut.key === 'full' ? '完整结束 idle' : '立即停；截断气泡可接受', {
            assertUi: [{ type: 'state', target: 'StatusLine', state: 'idle' }],
          }),
          phase('T3', '发「只回复 CLEAN」', '仅 CLEAN；无旧流残片', { severity: 'blocker' }),
        ],
      }),
    );
  }
  return out;
}

const SLASH_SEQS = [
  { key: 'help-compact', seq: ['/help', '/compact'] },
  { key: 'compact-help', seq: ['/compact', '/help'] },
  { key: 'help-unknown-help', seq: ['/help', '/compacx', '/help'] },
  { key: 'status-compact', seq: ['/status', '/compact'] },
  { key: 'model-help', seq: ['/model', '/help'] },
  { key: 'clear-help', seq: ['/clear', '/help'] },
] as const;

function slashMatrix(): Scenario[] {
  return SLASH_SEQS.map((s) =>
    flow({
      id: `cli.mx.slash-${s.key}`,
      module: 'cli.agent-flow',
      surface: 'cli',
      title: `Slash 序列：${s.seq.join(' → ')}`,
      why: '命令串联不应搞挂 REPL 状态',
      combo: ['matrix', 'slash', ...s.seq.map(slug)],
      mustNot: ['slash 后 CLI 无响应', '未知命令当普通 prompt 乱发且不可恢复'],
      priority: 'P1',
      estimateMin: 5,
      steps: [
        ...s.seq.map((cmd, i) =>
          phase(
            `L${i + 1}`,
            `输入 ${cmd}`,
            cmd.includes('compacx')
              ? '友好未知命令提示'
              : '有输出/反馈且可继续输入',
            { severity: cmd.includes('compacx') ? 'major' : 'blocker' },
          ),
        ),
        phase('Lend', '发「只回复 SLASH_OK」', '正常对话回复', { severity: 'blocker' }),
      ],
    }),
  );
}

const SHELL_BG = [
  { key: 'fg-short', prompt: '前台 echo BG_MX_1' },
  { key: 'fg-fail', prompt: '前台 false' },
  { key: 'bg-sleep', prompt: '后台 sleep 6 && echo BG_MX_DONE（若支持）' },
  { key: 'fg-then-bg', prompt: '先 echo A，再后台 sleep 5 && echo B' },
] as const;

function shellMatrix(): Scenario[] {
  return SHELL_BG.map((s) =>
    flow({
      id: `cli.mx.shell-${s.key}`,
      module: 'cli.agent-flow',
      surface: 'cli',
      title: `Shell 形态：${s.key}`,
      why: '前台/后台/失败卡生命周期',
      combo: ['matrix', 'shell', s.key],
      mustNot: ['重复后台卡', '失败当成功', 'running 幽灵'],
      priority: s.key.includes('bg') ? 'P0' : 'P1',
      steps: [
        phase('H1', `要求：${s.prompt}`, '对应卡片状态正确', {
          assertUi: [{ type: 'not_visible', target: 'duplicate shell cards' }],
        }),
        phase('H2', '再发「总结刚才 shell 结果一句话」', '总结与真实退出码/输出一致', {
          severity: 'blocker',
        }),
      ],
    }),
  );
}

/** Extra dialogue length × verify combos */
function longDialogueMatrix(): Scenario[] {
  const turns = [3, 5, 8] as const;
  const styles = [
    { key: 'qa', ask: (i: number) => `第 ${i} 轮：用一句话解释概念 #${i}` },
    { key: 'tool-every-other', ask: (i: number) => (i % 2 === 0 ? `读一个小文件并引用一行（轮${i}）` : `只文字回答轮${i}`) },
    { key: 'correct-self', ask: (i: number) => `轮${i}：若你上轮说错了请纠正，否则说 OK` },
  ] as const;
  const out: Scenario[] = [];
  for (const [n, style] of cart([...turns], [...styles])) {
    const steps = [
      phase('D0', '新会话', 'idle', { severity: 'major' }),
      ...Array.from({ length: n }, (_, i) =>
        phase(
          `D${i + 1}`,
          `发：「${style.ask(i + 1)}」`,
          '本轮 user/assistant（及工具）顺序正确；无覆盖错位',
          {
            severity: i === n - 1 ? 'blocker' : 'major',
            assertUi:
              i === n - 1
                ? [{ type: 'order', sequence: ['earlier turns', 'latest user', 'latest assistant'] }]
                : undefined,
          },
        ),
      ),
      phase('Dend', '快速上滚再回底（若 TUI 支持）', '历史仍在；输入区可用', {
        severity: 'major',
      }),
    ];
    out.push(
      flow({
        id: `cli.mx.dialogue-t${n}__${style.key}`,
        module: 'cli.agent-flow',
        surface: 'cli',
        title: `多轮对话 ${n}×${style.key}`,
        why: '长会话顺序/状态是基础质量',
        combo: ['matrix', 'dialogue', style.key, `t${n}`],
        mustNot: ['消息错位覆盖', '中途卡死 busy'],
        priority: n >= 5 ? 'P0' : 'P1',
        estimateMin: 4 + n * 2,
        steps,
      }),
    );
  }
  return out;
}

export const cliMatrixFlows: Scenario[] = [
  ...toolInterruptAftermath(),
  ...exploreMatrix(),
  ...compactMatrix(),
  ...byokMatrix(),
  ...streamMatrix(),
  ...slashMatrix(),
  ...shellMatrix(),
  ...longDialogueMatrix(),
];
