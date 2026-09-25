import type { Scenario } from '../../../types.js';
import { cart, flow, phase } from '../../gen/helpers.js';

/**
 * Desktop: cloud login/register, session switching, artifacts + surface viewers.
 */

const DESK_AUTH = [
  { key: 'cloud-login', action: '打开登录/云账号入口，完成登录', expect: 'UI 显示已登录头像/邮箱' },
  { key: 'cloud-register', action: '注册新账号（测试邮箱）', expect: '注册成功并进入已登录或引导登录' },
  { key: 'logout', action: '登出云账号', expect: '回到未登录；云专属能力收起' },
  { key: 'relogin', action: '登出后再登录同一账号', expect: '会话列表/设置不崩；可对话' },
  { key: 'token-expire', action: '模拟登录过期（或等 refresh 失败）', expect: '明确重新登录，非白屏' },
] as const;

const DESK_AUTH_NEXT = [
  { key: 'open-chat', next: '新建会话发「只回复 CLOUD_OK」', expect: '正常回复' },
  { key: 'open-settings', next: '打开 Settings 再回会话', expect: 'timeline 仍在；无闪白' },
  { key: 'oauth-plugin', next: '打开 OAuth 订阅面板看状态', expect: '面板可渲染；与云登录态不打架' },
] as const;

function desktopAuthFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [auth, next] of cart([...DESK_AUTH], [...DESK_AUTH_NEXT])) {
    // logout × oauth-plugin still useful; token-expire × open-chat critical
    out.push(
      flow({
        id: `desktop.cap.auth-${auth.key}__${next.key}`,
        module: 'desktop.auth',
        surface: 'desktop',
        title: `桌面认证 ${auth.key} → ${next.key}`,
        why: '登录注册是漏斗；登录后 UI 往返最易白屏/丢态',
        combo: ['auth', auth.key, next.key],
        mustNot: [
          '登录成功 UI 仍显示未登录',
          '注册后无法进入产品',
          '登出残留可调用云 API',
          '设置往返闪白/timeline 清空异常',
        ],
        priority: 'P0',
        tier: auth.key.includes('register') || auth.key.includes('expire') ? 'nightly' : 'core',
        estimateMin: 12,
        steps: [
          phase('A1', auth.action, auth.expect, {
            assertUi: [{ type: 'visible', target: 'auth state indicator' }],
          }),
          phase('A2', next.next, next.expect, {
            severity: 'blocker',
            assertUi: [
              { type: 'geometry', rule: '主壳布局完整，无整屏白' },
              { type: 'state', target: 'composer', state: 'usable unless logged out intentionally' },
            ],
          }),
        ],
      }),
    );
  }
  return out;
}

const SESSION_A_STATES = [
  { key: 'streaming', prep: 'A 正在流式长文' },
  { key: 'awaiting-approval', prep: 'A 卡在审批 banner' },
  { key: 'idle-rich', prep: 'A 已有多工具+助手消息' },
  { key: 'error', prep: 'A 刚 BYOK 错误' },
  { key: 'compacting', prep: 'A 刚触发/完成压缩' },
] as const;

const SESSION_ACTIONS = [
  { key: 'to-B-idle', act: '切到空闲会话 B', expect: 'B 独立；A 流不写入 B' },
  { key: 'to-B-send', act: '切到 B 并立刻发「B_ONLY」', expect: '回复只在 B' },
  { key: 'create-C', act: '新建会话 C', expect: 'C 空 composer；侧栏出现' },
  { key: 'rename-A', act: '重命名 A', expect: '标题更新且切走再回来仍在' },
  { key: 'delete-B', act: '删除非当前会话 B（先造 B）', expect: '列表移除；当前不崩' },
  { key: 'back-A-stop', act: '回 A 并 Stop', expect: '无孤儿 running；可再发' },
] as const;

function desktopSessionFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [st, act] of cart([...SESSION_A_STATES], [...SESSION_ACTIONS])) {
    out.push(
      flow({
        id: `desktop.cap.session-${st.key}__${act.key}`,
        module: 'desktop.session',
        surface: 'desktop',
        title: `会话：A=${st.key} × ${act.key}`,
        why: '会话切换×运行态组合最容易串流/串 ctx/卡审批',
        combo: ['session', st.key, act.key],
        mustNot: [
          'B 出现 A 的 delta',
          'badge/ctx 串 session',
          '审批 banner 粘在错误会话',
          '删除后幽灵项',
          '回 A 永久 running',
        ],
        priority: 'P0',
        estimateMin: 10,
        steps: [
          phase('S0', `准备 A：${st.prep}`, 'A 状态成立', { severity: 'major' }),
          phase('S1', act.act, act.expect, {
            assertUi: [
              { type: 'state', target: 'composer ctx badge', state: 'matches active session' },
              { type: 'not_visible', target: 'cross-session stream leak' },
            ],
          }),
          phase('S2', '在当前会话发「只回复 CUR」', 'CUR 只出现在当前 feed', {
            severity: 'blocker',
          }),
        ],
      }),
    );
  }
  return out;
}

const DESK_ARTIFACTS = [
  {
    key: 'html',
    prompt: '生成精美单页 HTML（内联 CSS），保存到 workspace，并用 open_surface/打开预览',
    open: 'HTML surface / iframe 可见内容',
    kind: 'html',
  },
  {
    key: 'html-fix',
    prompt: '已有 html 则改配色再打开；否则先生成再改',
    open: 'surface 刷新或重开后看到新配色',
    kind: 'html',
  },
  {
    key: 'vite-app',
    prompt: '创建 Vite React 项目并 npm run build；总结如何 npm run dev',
    open: '代码 surface 或文件树可见；build 成功',
    kind: 'code',
  },
  {
    key: 'vite-dev-browser',
    prompt: '若可：起 Vite dev 并用浏览器 surface 打开本地 URL（注意清理进程）',
    open: 'web surface 打开 localhost；可见页面',
    kind: 'web',
  },
  {
    key: 'pptx',
    prompt: '生成 4–6 页 pptx 并打开 pptx surface/预览',
    open: 'pptx/pdf surface 可翻页或可见幻灯',
    kind: 'pptx',
  },
  {
    key: 'docx',
    prompt: '生成 docx 报告并打开 docx surface',
    open: 'docx surface 渲染正文（mammoth HTML）',
    kind: 'docx',
  },
  {
    key: 'sheet',
    prompt: '生成 xlsx 并打开 sheet surface',
    open: '表格可见行列',
    kind: 'sheet',
  },
  {
    key: 'md-doc',
    prompt: '写带标题的 markdown 并用 doc surface 打开',
    open: 'markdown 渲染',
    kind: 'doc',
  },
  {
    key: 'mermaid',
    prompt: '生成含 mermaid 的说明并用 diagram/doc surface 打开',
    open: '图或代码可见',
    kind: 'diagram',
  },
  {
    key: 'pdf-if-any',
    prompt: '若流程能导出 pdf 则打开 pdf surface，否则跳过并说明',
    open: 'pdf 可看或明确跳过',
    kind: 'pdf',
  },
] as const;

const DESK_ART_FOLLOW = [
  { key: 'pin-tab', follow: '钉住 surface tab，再开另一文件', expect: '钉住的不轻易被替换' },
  { key: 'close-reopen', follow: '关掉 surface 再让 agent 打开', expect: '能再次打开' },
  { key: 'switch-session', follow: '切到另一会话再切回', expect: 'surface/会话状态合理不串' },
  { key: 'ask-path', follow: '问文件绝对路径', expect: '路径正确可在侧栏定位' },
] as const;

function desktopArtifactFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [art, fol] of cart([...DESK_ARTIFACTS], [...DESK_ART_FOLLOW])) {
    out.push(
      flow({
        id: `desktop.cap.artifact-${art.key}__${fol.key}`,
        module: 'desktop.artifact',
        surface: 'desktop',
        title: `桌面产出 ${art.key} → ${fol.key}`,
        why: '产出物 + 右栏 surface 是桌面核心；白屏/打不开=严重',
        combo: ['artifact', 'surface', art.key, art.kind, fol.key],
        codeHint: 'open_surface · SurfaceKind html/docx/pptx/sheet/web',
        mustNot: [
          'surface 白屏',
          'BrowserView 闪白挡 UI',
          '声称已打开但右栏空白',
          'Vite/构建失败却报成功',
          '切会话后 surface 内容串号',
        ],
        priority: ['html', 'vite-app', 'pptx', 'docx', 'sheet'].includes(art.key) ? 'P0' : 'P1',
        estimateMin: art.key.includes('vite') ? 25 : 14,
        tier: art.key.includes('vite') || art.key === 'pdf-if-any' ? 'nightly' : 'core',
        steps: [
          phase('D0 · layout', '确认 timeline | surface 分栏可调', '分栏可见', {
            severity: 'major',
            assertUi: [{ type: 'geometry', rule: 'surface 面板与 timeline 不重叠到不可用' }],
          }),
          phase('D1 · generate', `发：「${art.prompt}」`, `工具执行；${art.open}`, {
            severity: 'blocker',
            assertUi: [
              { type: 'visible', target: `surface kind≈${art.kind}` },
              { type: 'state', target: 'composer', state: 'idle when done' },
            ],
          }),
          phase('D2 · follow', fol.follow, fol.expect, {
            severity: 'blocker',
            assertUi: [{ type: 'geometry', rule: '操作后无整窗闪白' }],
          }),
          phase('D3 · chat', '发「用一句话描述刚打开的内容」', '描述与 surface 一致', {
            severity: 'major',
          }),
        ],
      }),
    );
  }
  return out;
}

const OAUTH_PROVIDERS = ['claude', 'codex', 'grok'] as const;
const OAUTH_ACTS = [
  { key: 'login', act: '点登录完成授权', expect: '面板已登录；模型可选' },
  { key: 'cancel', act: '打开授权后取消/关窗', expect: '无永久 loading' },
  { key: 'logout', act: '登出该订阅', expect: '模型入口收回' },
  { key: 'chat', act: '登录后用该模型短聊「只回 OAUTH_OK」', expect: '回复成功' },
] as const;

function desktopOauthCapFlows(): Scenario[] {
  const out: Scenario[] = [];
  for (const [p, a] of cart([...OAUTH_PROVIDERS], [...OAUTH_ACTS])) {
    out.push(
      flow({
        id: `desktop.cap.oauth-${p}__${a.key}`,
        module: 'desktop.oauth',
        surface: 'desktop',
        title: `OAuth ${p} · ${a.key}`,
        why: '订阅插件是付费路径',
        combo: ['oauth', p, a.key],
        mustNot: ['取消后僵尸登录中', '登录成功但不能选模', '串用其它 provider 凭证'],
        priority: 'P0',
        tier: 'nightly',
        estimateMin: 10,
        steps: [
          phase('O1', `设置 → OAuth → ${p}`, '面板可见该行', { severity: 'major' }),
          phase('O2', a.act, a.expect, { severity: 'blocker' }),
        ],
      }),
    );
  }
  return out;
}

const CLOUD_FEATURES = [
  { key: 'redeem', steps: ['打开兑换/权益入口', '输入无效码看错误', '有效码（若有）看成功'] },
  { key: 'subscription-status', steps: ['打开会员/订阅页', '状态与登录一致', '返回会话可聊'] },
  { key: 'quota-display', steps: ['找额度/用量展示', '发一条消息后再看', '数字合理或明确无'] },
] as const;

function desktopCloudFlows(): Scenario[] {
  return CLOUD_FEATURES.map((f) =>
    flow({
      id: `desktop.cap.cloud-${f.key}`,
      module: 'desktop.cloud',
      surface: 'desktop',
      title: `云能力：${f.key}`,
      why: '云权益/兑换易静默失败',
      combo: ['cloud', f.key],
      mustNot: ['白屏', '无效码无反馈', '额度与真实不符到误导扣费'],
      priority: 'P1',
      tier: 'nightly',
      steps: f.steps.map((s, i) =>
        phase(`C${i + 1}`, s, 'UI 有明确成功/失败反馈', {
          severity: i === f.steps.length - 1 ? 'blocker' : 'major',
        }),
      ),
    }),
  );
}

/** Mixed capability: login → new session → artifact → switch session → reopen */
function desktopEndToEndCapFlows(): Scenario[] {
  return [
    flow({
      id: 'desktop.cap.e2e-login-html-session-switch',
      module: 'desktop.artifact',
      surface: 'desktop',
      title: 'E2E：登录 → 新会话 → 写 HTML 打开 → 切会话 → 切回仍可定位文件',
      why: '跨能力串联是真实用户一天内的路径',
      combo: ['e2e', 'auth', 'session', 'artifact', 'html', 'surface'],
      mustNot: ['任一步严重阻断', '切回后丢文件或 surface 白屏'],
      priority: 'P0',
      estimateMin: 25,
      tier: 'nightly',
      steps: [
        phase('E1', '确保已登录（云或 BYOK 可用）', '能发消息', { severity: 'blocker' }),
        phase('E2', '新建会话', '空 feed', { severity: 'major' }),
        phase('E3', '生成 HTML 并打开 surface', '右栏可见页面', {
          assertUi: [{ type: 'visible', target: 'html surface' }],
        }),
        phase('E4', '切到另一会话发短消息', '不串 HTML 内容', { severity: 'blocker' }),
        phase('E5', '切回原会话', '历史在；文件仍可打开', { severity: 'blocker' }),
      ],
    }),
    flow({
      id: 'desktop.cap.e2e-vite-pptx-docx-tour',
      module: 'desktop.artifact',
      surface: 'desktop',
      title: 'E2E：同会话连续产出 Vite 说明 + pptx + docx（可分步，但同一会话）',
      why: '连续产出压力测工具与 surface 切换',
      combo: ['e2e', 'vite', 'pptx', 'docx', 'surface'],
      mustNot: ['后一个产出冲掉前一个未保存文件', 'surface 切换白屏'],
      priority: 'P0',
      estimateMin: 40,
      tier: 'nightly',
      steps: [
        phase('V1', '创建最小 Vite 项目并 build', 'build 成功', { severity: 'blocker' }),
        phase('V2', '生成 pptx 并打开', 'pptx surface ok', { severity: 'blocker' }),
        phase('V3', '生成 docx 并打开', 'docx surface ok', { severity: 'blocker' }),
        phase('V4', '问三个产物路径', '三条路径都对', { severity: 'major' }),
      ],
    }),
    flow({
      id: 'desktop.cap.e2e-approval-write-html',
      module: 'desktop.agent-flow',
      surface: 'desktop',
      title: 'E2E：manual 审批下写 HTML → Approve → surface 打开',
      why: '审批+写文件+预览三联',
      combo: ['e2e', 'approval', 'html', 'surface'],
      mustNot: ['审批空白头', 'Approve 后无文件', 'surface 打不开'],
      priority: 'P0',
      estimateMin: 15,
      steps: [
        phase('W1', '设 manual 审批', '模式生效', { severity: 'major' }),
        phase('W2', '要求写入 HTML 文件', '出现审批；标题固态可读', {
          assertUi: [{ type: 'class', target: 'activity', has: ['is-awaiting'] }],
        }),
        phase('W3', 'Approve', '写入完成', { severity: 'blocker' }),
        phase('W4', '打开 HTML surface', '可见内容', { severity: 'blocker' }),
      ],
    }),
  ];
}

export const desktopCapabilityFlows: Scenario[] = [
  ...desktopAuthFlows(),
  ...desktopSessionFlows(),
  ...desktopArtifactFlows(),
  ...desktopOauthCapFlows(),
  ...desktopCloudFlows(),
  ...desktopEndToEndCapFlows(),
];
