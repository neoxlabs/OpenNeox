import type { Scenario } from '../../../types.js';
import { cart, flow, phase } from '../../gen/helpers.js';

/**
 * CLI auth · session · artifact capability journeys.
 */

const LOGIN_MODES = [
  { key: 'browser', cmd: 'neox login --browser 或 REPL /login 选浏览器', expect: '浏览器打开授权；回调后 banner 显示账号' },
  { key: 'device-code', cmd: 'neox login --device-code 或邮箱验证码流', expect: '提示码/邮箱流程完成；token 写入' },
  { key: 'email-flag', cmd: 'neox login --device-code --email=<test>', expect: '跳过 email prompt；完成登录' },
] as const;

const POST_LOGIN = [
  { key: 'chat', ask: '只回复 LOGGED_IN', expect: '正常助手回复（订阅或 BYOK 路由清晰）' },
  { key: 'model-ls', ask: '/model 或 model ls', expect: '能列出可用模型含订阅 sentinel（若有）' },
  { key: 'logout-relogin', ask: null as string | null, special: 'logout' as const },
] as const;

function authFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [mode, post] of cart([...LOGIN_MODES], [...POST_LOGIN])) {
    const steps = [
      phase('A0', '确保可测账号；记录当前是否已登录', '前置清晰', { severity: 'major' }),
      phase('A1', `执行：${mode.cmd}`, mode.expect, {
        assertUi: [
          { type: 'visible', target: 'Account / banner email or logged-in mark' },
          { type: 'state', target: 'StatusLine/banner', state: 'not gray 未登录' },
        ],
      }),
    ];
    if (post.special === 'logout') {
      steps.push(
        phase('A2', '/logout 或 neox logout', '变为未登录；订阅模型不可用或提示登录', {
          severity: 'blocker',
        }),
        phase('A3', `再次 ${mode.cmd}`, '能重新登录成功', { severity: 'blocker' }),
      );
    } else {
      steps.push(
        phase('A2', `登录后：${post.ask}`, post.expect!, {
          severity: 'blocker',
          assertUi: [{ type: 'state', target: 'REPL', state: 'responsive' }],
        }),
      );
    }
    out.push(
      flow({
        id: `cli.cap.auth-${mode.key}__${post.key}`,
        module: 'cli.auth',
        surface: 'cli',
        title: `登录 ${mode.key} → ${post.key}`,
        why: '登录/登出后 providerStore 与 banner 不同步是已知高危回归',
        combo: ['auth', 'login', mode.key, post.key],
        codeHint: 'commands/login.ts · main setAccount reconcile',
        mustNot: [
          '登录成功但 banner 仍未登录',
          '/login 后 /model 拿不到订阅模型（旧 providerStore）',
          '登出后仍能静默用订阅额度',
          '登录死循环（membership 401 ↔ 已登录 no-op）',
        ],
        priority: 'P0',
        estimateMin: 10,
        tier: mode.key === 'browser' ? 'nightly' : 'core',
        steps,
      }),
    );
  }

  out.push(
    flow({
      id: 'cli.cap.auth-expired-token-prompt',
      module: 'cli.auth',
      surface: 'cli',
      title: 'token 过期/刷新失败 → 明确提示重新 /login',
      why: '首条 chat 才发现过期会浪费用户时间',
      combo: ['auth', 'token', 'error'],
      mustNot: ['静默挂起', '无提示的 401 死循环'],
      priority: 'P0',
      steps: [
        phase('E1', '模拟/等待 refresh 失败（或过期 token）', '启动或发送时提示登录过期', {
          assertUi: [{ type: 'visible', target: '过期 / 重新登录提示' }],
        }),
        phase('E2', '/login 恢复', '可再对话', { severity: 'blocker' }),
      ],
    }),
    flow({
      id: 'cli.cap.auth-register-then-login',
      module: 'cli.auth',
      surface: 'cli',
      title: '新用户注册（若产品支持）→ 登录 → 首聊',
      why: '注册漏环节会直接丢转化',
      combo: ['auth', 'register', 'login'],
      preconditions: ['有测试邮箱或注册入口'],
      mustNot: ['注册成功但无法登录', '注册后无引导首聊'],
      priority: 'P0',
      tier: 'nightly',
      estimateMin: 15,
      steps: [
        phase('R1', '走注册流程（Web/CLI 指引）', '账号创建成功', { severity: 'blocker' }),
        phase('R2', 'neox login 用新账号', 'banner 显示新账号', { severity: 'blocker' }),
        phase('R3', '发「只回复 HELLO_NEW」', '正常回复', { severity: 'blocker' }),
      ],
    }),
  );
  return out;
}

const SESSION_OPS = [
  { key: 'new', action: '新建会话/clear 开新对话', expect: 'timeline 空或新 session；ctx 接近基线' },
  { key: 'switch-list', action: '从历史列表切到另一会话', expect: '内容与 badge 属目标会话' },
  { key: 'resume-recent', action: '重启 CLI 后恢复最近会话（若支持）', expect: '历史仍在或明确需重开' },
] as const;

const SESSION_STRESS = [
  { key: 'mid-stream', setup: 'A 会话长流式中' },
  { key: 'after-tools', setup: 'A 刚跑完多工具 turn' },
  { key: 'after-error', setup: 'A 刚出现错误卡' },
] as const;

function sessionFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [op, stress] of cart([...SESSION_OPS], [...SESSION_STRESS])) {
    out.push(
      flow({
        id: `cli.cap.session-${op.key}__${stress.key}`,
        module: 'cli.session',
        surface: 'cli',
        title: `会话 ${op.key}（背景：${stress.key}）`,
        why: '会话切换是高频；串内容/ctx 是严重 bug',
        combo: ['session', op.key, stress.key],
        mustNot: ['串会话消息', 'ctx 串号', '切换后卡死 busy'],
        priority: 'P0',
        steps: [
          phase('S0', `准备：${stress.setup}`, 'A 处于所述状态', { severity: 'major' }),
          phase('S1', op.action, op.expect, {
            assertUi: [{ type: 'state', target: 'timeline', state: 'matches target session' }],
          }),
          phase('S2', '发「只回复 SESSION_OK」', '回复出现在当前会话；不污染另一会话', {
            severity: 'blocker',
          }),
        ],
      }),
    );
  }
  return out;
}

/** Artifact generation capabilities — HTML / Vite / PPT / Word / Sheet */
const ARTIFACTS = [
  {
    key: 'html-landing',
    prompt: '在工作区写一个单文件 index.html 着陆页（内联 CSS），主题「NeoX Demo」',
    fileHint: 'index.html 或指定路径',
    verify: '文件存在；用浏览器/打开可见标题；无致命脚本错',
    surface: 'html',
  },
  {
    key: 'html-interactive',
    prompt: '写一个带按钮计数器的纯 HTML+JS 小页，保存为 demo.html',
    fileHint: 'demo.html',
    verify: '打开后点击按钮数字增加（或说明如何验证）',
    surface: 'html',
  },
  {
    key: 'vite-react',
    prompt: '用 Vite 脚手架在子目录 demo-vite 创建 React+TS 最小项目，npm install && npm run build 要通过',
    fileHint: 'demo-vite/package.json + src',
    verify: 'build 成功；dev 可起（或 build 产物存在）',
    surface: 'code',
  },
  {
    key: 'vite-vanilla',
    prompt: '创建 Vite vanilla-ts 小项目 hello-vite，改 App 文案为 HELLO_VITE，build 通过',
    fileHint: 'hello-vite/',
    verify: 'build ok；产物含 HELLO_VITE',
    surface: 'code',
  },
  {
    key: 'pptx-deck',
    prompt: '生成一份 5 页 pptx：标题/目录/三点卖点/架构图说明/结尾，保存到 out/demo.pptx',
    fileHint: '.pptx',
    verify: '文件可打开；页数合理；自检工具若有则通过',
    surface: 'pptx',
  },
  {
    key: 'pptx-inspect',
    prompt: '生成 pptx 后用项目 pptx inspect/render 脚本自检（若环境有 NEOX_PPTX_*）',
    fileHint: '.pptx',
    verify: 'inspect 无致命错误；或明确跳过原因',
    surface: 'pptx',
  },
  {
    key: 'docx-report',
    prompt: '写一份简短 Word 报告（.docx）：标题+两段正文+一个列表，保存 out/report.docx',
    fileHint: '.docx',
    verify: '文件存在可打开；内容可读',
    surface: 'docx',
  },
  {
    key: 'docx-export-roundtrip',
    prompt: '若有 word 工具：创建 docx 后再导出/检查；否则用可用工具写 md 再说明限制',
    fileHint: '.docx or .md',
    verify: '有产出文件；工具失败时错误可读非挂死',
    surface: 'docx',
  },
  {
    key: 'sheet-xlsx',
    prompt: '生成一份 xlsx：三列 Name/Score/Note，至少 5 行数据，保存 out/scores.xlsx',
    fileHint: '.xlsx',
    verify: '文件可打开；数据正确',
    surface: 'sheet',
  },
  {
    key: 'md-mermaid',
    prompt: '写 README 风格 md，内含 mermaid 流程图描述登录流程',
    fileHint: '.md',
    verify: '文件存在；含 mermaid 代码块',
    surface: 'doc',
  },
] as const;

const ARTIFACT_FOLLOW = [
  { key: 'open-hint', ask: '告诉我如何打开刚生成的文件' },
  { key: 'fix-small', ask: '只改一处文案/标题再保存' },
  { key: 'new-session-find', ask: null as string | null, special: 'session' as const },
] as const;

function artifactFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [art, follow] of cart([...ARTIFACTS], [...ARTIFACT_FOLLOW])) {
    const steps = [
      phase('P0', '空或干净工作区子目录；记路径', '可写', { severity: 'major' }),
      phase('P1', `发：「${art.prompt}」`, `开始工具调用；最终有 ${art.fileHint}`, {
        assertUi: [
          { type: 'order', sequence: ['user', 'tools/writes', 'assistant'] },
          { type: 'state', target: 'StatusLine', state: 'idle when done' },
        ],
      }),
      phase('P2 · verify', art.verify, '验证通过或失败原因可读', {
        severity: 'blocker',
        assertUi: [{ type: 'visible', target: `artifact file (${art.surface})` }],
      }),
    ];
    if (follow.special === 'session') {
      steps.push(
        phase('P3', '新会话后问「刚才生成的文件路径是什么」', '能指出或诚实不知；文件仍在磁盘', {
          severity: 'major',
        }),
      );
    } else {
      steps.push(
        phase('P3', `发：「${follow.ask}」`, '回答/修改正确；不毁掉产物', {
          severity: 'blocker',
        }),
      );
    }
    out.push(
      flow({
        id: `cli.cap.artifact-${art.key}__${follow.key}`,
        module: 'cli.artifact',
        surface: 'cli',
        title: `产出 ${art.key} → ${follow.key}`,
        why: 'HTML/Vite/PPT/Word/Sheet 是核心差异化能力，失败即产品事故',
        combo: ['artifact', art.key, art.surface, follow.key],
        codeHint: 'pptxTools/wordTools/sheetTools/write_file/shell',
        mustNot: [
          '声称写完但文件不存在',
          'Vite build 失败却说成功',
          'PPT/Word 空文件或 0 字节',
          '长任务后卡死无法再输入',
        ],
        priority: art.key.startsWith('html') || art.key.startsWith('vite') || art.key.includes('pptx') || art.key.includes('docx')
          ? 'P0'
          : 'P1',
        estimateMin: art.key.includes('vite') ? 20 : 12,
        tier: art.key.includes('vite') ? 'nightly' : 'core',
        steps,
      }),
    );
  }
  return out;
}

export const cliCapabilityFlows: Scenario[] = [
  ...authFlows(),
  ...sessionFlows(),
  ...artifactFlows(),
];
