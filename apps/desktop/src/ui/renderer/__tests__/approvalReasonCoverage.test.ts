import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 后端真相源: permission = ASK 的工具 → 它的英文 reason */
function backendAskTools(): Map<string, string | null> {
  const src = stripComments(readFileSync(
    resolve(HERE, '../../../../../../packages/kernel/src/core/permissions/defaultPermissions.ts'),
    'utf8',
  ));
  const out = new Map<string, string | null>();
  for (const m of src.matchAll(/toolName:\s*'([^']+)'([\s\S]{0,300}?)\},/g)) {
    const body = m[2];
    if (!body.includes('ToolPermission.ASK')) continue;
    const r = /reason:\s*'([^']+)'/.exec(body);
    out.set(m[1], r ? r[1] : null);
  }
  return out;
}

/** 前端中文表的键 */
function zhReasonKeys(): Set<string> {
  const src = readFileSync(
    resolve(HERE, '../modules/agent-timeline/approvalPresentation.ts'),
    'utf8',
  );
  const blk = /const APPROVAL_REASON_ZH[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  expect(blk, '找不到 APPROVAL_REASON_ZH').toBeTruthy();
  const body = stripComments(blk![1]);
  return new Set([...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
}

describe('权限卡中文理由覆盖率', () => {
  const backend = backendAskTools();
  const zh = zhReasonKeys();

  it('后端确实解析出了一批需审批的工具 —— 解析失败必须红, 不能静默变成"0 个都覆盖了"', () => {
    expect(backend.size).toBeGreaterThan(15);
  });

  it('每一个需审批的工具都有中文理由 —— 漏一个就是中文界面上蹦英文', () => {
    const missing = [...backend.keys()].filter((k) => !zh.has(k));
    expect(missing, `缺中文理由: ${missing.join(', ')}`).toEqual([]);
  });

  it('中文表里不许有后端不存在的工具名 —— 白写的键永远不会命中, 且没人会发现', () => {
    const ghost = [...zh].filter((k) => !backend.has(k));
    expect(ghost, `后端没有这些工具: ${ghost.join(', ')}`).toEqual([]);
  });

  it('跑命令这个主场景必须命中 (后端叫 execute_bash, 不是 bash/execute_shell/run_command)', () => {
    expect(backend.has('execute_bash')).toBe(true);
    expect(zh.has('execute_bash')).toBe(true);
  });
});

describe('审批档位说明 vs 后端语义', () => {
  const kernel = stripComments(readFileSync(
    resolve(HERE, '../../../../../../packages/kernel/src/core/permissions/PermissionManager.ts'),
    'utf8',
  ));
  const ui = stripComments(readFileSync(
    resolve(HERE, '../modules/agent-timeline/TimelineComposer.tsx'),
    'utf8',
  ));

  it('后端语义: dangerous 全放行 / auto 只拦 critical / manual 读直通', () => {
    expect(kernel).toMatch(/scopeMode === 'dangerous'[\s\S]{0,80}ToolPermission\.ALLOW/);
    expect(kernel).toMatch(/scopeMode === 'manual'[\s\S]{0,140}ToolCategory\.READ[\s\S]{0,60}ToolPermission\.ASK/);
    expect(kernel).toMatch(/isHighRiskLevel\(risk\.level\)[\s\S]{0,60}ToolPermission\.ASK/);
    expect(kernel).toMatch(/scopeMode === 'auto'\) \{\s*if \(risk\.level === 'critical'\) return ToolPermission\.ASK;[\s\S]{0,140}ToolPermission\.ALLOW/);
  });

  it('英文 auto 档说的是"只有危险操作才问" —— 既不许说全自动, 也不许说改东西就问', () => {
    expect(ui).not.toMatch(/Tool calls auto-approved/);
    expect(ui).not.toMatch(/writes and commands ask first/);
    expect(ui).toMatch(/only risky actions ask first/);
  });

  it('dangerous 档必须写明"危险命令也不问" —— 这一档现在真的一条都不弹', () => {
    expect(ui).toMatch(/危险命令也不问/);
    expect(ui).toMatch(/never asks, not even for risky commands/);
  });

  it('manual 档两边都要说清"读取类直通" —— 不是"每个工具调用"', () => {
    expect(ui).toMatch(/读取类直接做, 其余每一步都要你点确认/);
    expect(ui).toMatch(/Reads run freely; every other step needs your approval/);
    expect(ui).not.toMatch(/Every tool call requires approval/);
  });
});

describe('审批档位命名 —— 三处必须同一套', () => {
  const composerSrc = stripComments(readFileSync(
    resolve(HERE, '../modules/agent-timeline/TimelineComposer.tsx'), 'utf8'));
  const agentTab = stripComments(readFileSync(
    resolve(HERE, '../pages/settings/tabs/AgentTab.tsx'), 'utf8'));

  const CANON = [
    { zh: '危险操作才问', en: 'Risky actions' },
    { zh: '每步都问',     en: 'Every step' },
    { zh: '都不问',       en: 'Never' },
  ];

  it('设置页仍是这套词 —— 它是基准, 变了要连带改另外两处', () => {
    for (const { zh, en } of CANON) {
      expect(agentTab, `设置页缺 ${zh}`).toContain(`'${zh}'`);
      expect(agentTab, `设置页缺 ${en}`).toContain(`'${en}'`);
    }
  });

  it('下拉菜单用同一套, 不许再出现 Auto / Manual / YOLO', () => {
    for (const { zh, en } of CANON) {
      expect(composerSrc, `下拉缺 ${en}`).toContain(`'${en}'`);
      expect(composerSrc, `下拉缺 ${zh}`).toContain(zh);
    }
    expect(composerSrc).not.toMatch(/label: 'YOLO'/);
    expect(composerSrc).not.toMatch(/label: 'Auto',/);
  });

  it('"+" 面板 hint 用同一套, 不许再是「默认 / 询问 / 放行」', () => {
    expect(composerSrc).not.toMatch(/默认 \/ 询问 \/ 放行/);
    expect(composerSrc).not.toMatch(/Default · Ask · Allow/);
    /* 2026-09 起 hint 只显示当前档位名 —— 必须取自下拉那张表, 不许另写一份字面量 */
    expect(composerSrc).toMatch(/hint: getApprovalOptions\(isZh\)\.find\(/);
  });
});

describe('「都不问」档必须可见', () => {
  const composerSrc = stripComments(readFileSync(
    resolve(HERE, '../modules/agent-timeline/TimelineComposer.tsx'), 'utf8'));
  const css = readFileSync(
    resolve(HERE, '../modules/agent-timeline/agent-timeline.css'), 'utf8');

  it('输入框药丸条里不再挂权限控件 (跟加号菜单重复, 且缩写后读不懂)', () => {
    expect(composerSrc).not.toMatch(/<ApprovalModeMenu\s+sessionId=\{activeSession\?\.id/);
  });

  it('加号菜单里必须有权限入口 —— 药丸拿掉后它是唯一的路', () => {
    expect(composerSrc).toMatch(/id: 'approval'/);
    expect(composerSrc).toMatch(/label: isZh \? '权限模式' : 'Permissions'/);
  });

  it('档位值来自 store, 不是本地猜的', () => {
    expect(composerSrc).toMatch(/const approvalMode = useApprovalMode\(activeSession\?\.id \?\? null\)/);
  });

  it('外层也带档位修饰类, 否则简约态的 display:none 选不到 dangerous 破不了例', () => {
    expect(composerSrc).toMatch(/atl-approval atl-approval--wrap-\$\{mode\}/);
  });

  it('简约态的隐藏规则被更高特异度压住 (0,3,0 > 0,2,0), 不是靠写在后面', () => {
    expect(css).toMatch(/\.atl-composer--minimal \.atl-approval\.atl-approval--wrap-dangerous\s*\{[^}]*display:\s*inline-flex\s*!important/);
  });

  it('dangerous 有区别于其它档的告警配色 —— 渲染出来还要让人一眼看见', () => {
    const block = css.slice(css.indexOf('.atl-approval--dangerous'), css.indexOf('.atl-approval--dangerous') + 200);
    expect(block).toMatch(/background:\s*#dc2626/);
    expect(block).toMatch(/color:\s*#ffffff/);
  });

  it('主题包压不掉 dangerous 的红 —— 有一条 0,5,0 的规则压回来', () => {
    expect(css).toMatch(
      /:root\[data-theme-pack\]\[data-theme\] \.atl-approval__btn\.atl-approval--dangerous\s*\{[^}]*background:\s*#dc2626\s*!important/,
    );
  });

  /* 按钮平时只渲染 `cur.label.charAt(0)` —— dangerous 就成了一个孤零零的「都」字,
   * 读不出"删文件、跑任意命令全部直接执行"。 */
  it('菜单里三档都写全称, 不许缩写 —— 这是现在唯一能读到档位名的地方', () => {
    for (const l of ['Risky actions', 'Every step', 'Never']) {
      expect(composerSrc).toContain(l);
    }
    /* 药丸没了, 首字缩写那套渲染也必须一起消失 */
    expect(composerSrc).not.toMatch(/cur\.label\.charAt\(0\)/);
  });
});
