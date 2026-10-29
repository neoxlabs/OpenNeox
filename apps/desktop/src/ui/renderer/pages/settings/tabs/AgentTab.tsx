import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { confirmAsync } from '../../../components/confirmEvents';
import { PageTitle, Segmented, NumberSettingInput, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow } from '../../../components/settings-base';
import { PLAIN_TOOL_LABEL_EN, PLAIN_TOOL_LABEL_ZH } from '../../../modules/agent-timeline/toolLabelMaps';
import { setServiceAutoShowMode, useServiceAutoShowMode } from '../../../state/serviceAutoShow';

type ApprovalMode = 'auto' | 'manual' | 'dangerous';

/** 行首线条字形 (UI 3.0 稿 set-perm3): 28px 浅底方块里一枚 16px 1.5 线宽图标, 本页所有行都用它 */
const Glyph: React.FC<{ d: string }> = ({ d }) => (
  <span className="nx-row-glyph" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  </span>
);

const AgentTab: React.FC = () => {
  const {
    sandboxEnabled,
    approvalMode,
    piiFilterEnabled,
    servicesStopConfirmation,
    setServicesStopConfirmation,
    agentRuntime,
    setAgentRuntime,
    handleSandboxChange,
    handleApprovalModeChange,
    handlePiiFilterChange,
  } = useSettingsContext();
  const { t, language } = useI18n();
  const zh = language === 'zh';
  /* 服务面板自动显示方式 —— 跟版面偏好一样按机器存, 见 state/serviceAutoShow.ts */
  const serviceAutoShowMode = useServiceAutoShowMode();

  const saveRt = React.useCallback(async (partial: Partial<NonNullable<typeof agentRuntime>>) => {
    if (!agentRuntime) return;
    const next = { ...agentRuntime } as NonNullable<typeof agentRuntime>;
    for (const k of Object.keys(partial) as Array<keyof NonNullable<typeof agentRuntime>>) {
      const v = (partial as any)[k];
      /* 标量字段 (modelOrchestration 等) 直接赋值, 对象节才展开合并 */
      (next as any)[k] = (v !== null && typeof v === 'object' && !Array.isArray(v))
        ? { ...(agentRuntime as any)[k], ...v } as any
        : v;
    }
    setAgentRuntime(next);
    try { await (window.neox as any).setAgentRuntimeConfig?.(partial); } catch (err) { console.error(err); }
  }, [agentRuntime, setAgentRuntime]);

  /* 「都不问」跟输入框里一样先确认一次 —— 它连删文件、任意命令都不拦 */
  const pickApproval = async (mode: ApprovalMode) => {
    if (mode === approvalMode) return;
    if (mode === 'dangerous') {
      const ok = await confirmAsync({
        title: zh ? '切到「都不问」？' : 'Switch to “Never”?',
        message: zh ? '删文件、跑任意命令都不会再问你，危险命令也不拦。' : 'Deleting files and running any command will no longer ask — risky ones included.',
        confirmLabel: zh ? '都不问' : 'Switch',
        variant: 'danger',
      });
      if (!ok) return;
    }
    void handleApprovalModeChange(mode);
  };

  /* 按「管得多 → 管得少」排, 跟分段控件从左到右一致 */
  const approvalOptions: Array<{ id: ApprovalMode; name: string; desc: string }> = [
    {
      id: 'manual',
      name: zh ? '每步都问' : 'Every step',
      desc: zh ? '每一步动手前都问你，最慢也最稳。' : 'Asks before every action. Slowest, safest.',
    },
    {
      id: 'auto',
      name: zh ? '危险操作才问' : 'Risky actions',
      desc: zh ? '改文件、跑命令直接做；删除、重置、强推前先问你。' : 'Edits and commands run; delete, reset, force-push ask first.',
    },
    {
      id: 'dangerous',
      name: zh ? '都不问' : 'Never',
      desc: zh ? '什么都不拦。只在你清楚它要做什么时用。' : 'Nothing is blocked. Only when you know what it will do.',
    },
  ];
  const currentApproval = approvalOptions.find((o) => o.id === approvalMode) ?? approvalOptions[1];

  const [alwaysAllow, setAlwaysAllow] = React.useState<Array<{ toolName: string; timestamp: number }> | null>(null);
  const loadAlwaysAllow = React.useCallback(async () => {
    const fn = (window.neox as any)?.listAlwaysAllow as undefined | (() => Promise<Array<{ toolName: string; timestamp: number }>>);
    if (typeof fn !== 'function') return;
    try { setAlwaysAllow(await fn()); } catch { setAlwaysAllow(null); }
  }, []);
  React.useEffect(() => { void loadAlwaysAllow(); }, [loadAlwaysAllow]);
  const revokeAlways = async (toolName: string) => {
    setAlwaysAllow((list) => (list ? list.filter((x) => x.toolName !== toolName) : list));
    try { await (window.neox as any).revokeAlwaysAllow?.(toolName); } catch { void loadAlwaysAllow(); }
  };

  const os = agentRuntime?.osSandbox;
  const osMode = (os?.mode ?? (os?.level === 'strict' ? 'read-only' : 'workspace-write')) as 'read-only' | 'workspace-write' | 'danger-full-access';
  const allowNet = os?.allowNetwork !== false;

  return (
    <div className="settings-panel-content">
      <PageTitle
        title={zh ? '权限' : 'Permissions'}
        subtitle={zh ? 'Agent 能做什么、什么时候先问你' : 'What the agent may do, and when it asks first'}
      />

      {/* ── 动手前问不问你 (UI 3.0 稿 set-perm3) ──
          三张大插画卡 → 一条三段分段 (好扫、省地方), 选中档下面一行字说清这一档会怎样;
          「同一个命令只问一次」从标题右边挪进卡里成一行。 */}
      <Section>
        <SettingsCard className="ag-approval-card">
          <div className="ag-approval-card__top">
            <span className="ag-approval-card__label">{zh ? '动手前问不问你' : 'Ask before acting'}</span>
            <div className="ag-seg" role="radiogroup" aria-label={zh ? '什么时候问你' : 'When to ask you'}>
              {approvalOptions.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={approvalMode === o.id}
                  className={`ag-seg__btn${approvalMode === o.id ? ' is-on' : ''}${o.id === 'dangerous' ? ' is-danger' : ''}`}
                  onClick={() => void pickApproval(o.id)}
                >
                  {o.name}
                </button>
              ))}
            </div>
            <p className="ag-approval-card__desc">{currentApproval.desc}</p>
          </div>
          {agentRuntime && (
            <SwitchRow
              leading={<Glyph d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />}
              title={zh ? '同一个命令只问一次' : 'Ask once per command'}
              desc={zh ? '这次会话里问过的命令不再重复问' : 'A command you approved won’t be asked again in this session'}
              checked={agentRuntime.approvalCache.enabled}
              onChange={(v) => void saveRt({ approvalCache: { enabled: v } })}
            />
          )}
        </SettingsCard>
      </Section>

      {agentRuntime && (
        <Section>
          <SectionTitle title={zh ? '保护' : 'Protection'} />
          <SettingsCard>
            <SwitchRow
              leading={<Glyph d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />}
              title={zh ? '读过网页后，发送和删除先问' : 'Ask before sending after reading the web'}
              desc={zh ? '看过网页、文档或屏幕后，发消息、提交、删文件先问你。「都不问」档不问。' : 'After reading a page, document or the screen, sending, submitting and deleting ask first. “Never” skips this.'}
              checked={agentRuntime.injectionGuard !== false}
              onChange={async (v) => {
                if (!v) {
                  const ok = await confirmAsync({
                    title: zh ? '关掉这道确认？' : 'Turn this off?',
                    message: zh ? '网页、文档里藏的指令能直接让它发消息、删文件。' : 'Instructions hidden in pages or documents could make it send messages or delete files without asking.',
                    confirmLabel: zh ? '关掉' : 'Turn off',
                    variant: 'danger',
                  });
                  if (!ok) return;
                }
                void saveRt({ injectionGuard: v });
              }}
            />
            <SwitchRow
              leading={<Glyph d="M7.5 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM11.5 12H21M18 12v3M21 12v2" />}
              title={zh ? '发送前抹掉密钥' : 'Strip secrets before sending'}
              desc={zh ? '密码、Key、Token 换成 <REDACTED> 再发给模型。' : 'Passwords, keys and tokens become <REDACTED> before reaching the model.'}
              checked={piiFilterEnabled}
              onChange={handlePiiFilterChange}
            />
            <SwitchRow
              advanced
              leading={<Glyph d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" />}
              title={t.settings.agent.sandbox}
              desc={sandboxEnabled ? t.settings.agent.sandboxOnDesc : t.settings.agent.sandboxOffDesc}
              checked={sandboxEnabled}
              onChange={handleSandboxChange}
            />
            {os && (
              <SwitchRow
                advanced
                leading={<Glyph d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3ZM9.5 12.5h5v3.5h-5zM10.5 12.5v-1.3a1.5 1.5 0 0 1 3 0v1.3" />}
                title={zh ? 'OS 级沙箱' : 'OS-level sandbox'}
                desc={zh ? '更硬，部分命令跑不起来。' : 'Stricter; some commands won’t run.'}
                checked={os.enabled}
                onChange={(v) => void saveRt({ osSandbox: { ...os, enabled: v } })}
              />
            )}
            {os?.enabled && (
              <SettingsRow
                advanced
                leading={<Glyph d="M12 4l8 4-8 4-8-4 8-4ZM4 12l8 4 8-4M4 16l8 4 8-4" />}
                title={zh ? '隔离档位' : 'Isolation level'}
                desc={osMode === 'danger-full-access'
                  ? (zh ? '无护栏：命令可改任意文件、任意联网。' : 'No guard: any file, any network.')
                  : (zh ? '.git、~/.ssh、~/.aws、~/.neox、~/.npmrc 恒为只读。' : '.git, ~/.ssh, ~/.aws, ~/.neox, ~/.npmrc stay read-only.')}
                control={(
                  <Segmented
                    value={osMode}
                    onChange={(v) => void saveRt({ osSandbox: { ...os, mode: v as typeof osMode } })}
                    options={[
                      { value: 'read-only', label: zh ? '只读' : 'Read-only' },
                      { value: 'workspace-write', label: zh ? '工作区可写' : 'Workspace' },
                      { value: 'danger-full-access', label: zh ? '完全放开' : 'Full' },
                    ]}
                    aria-label={zh ? '隔离档位' : 'Isolation level'}
                  />
                )}
              />
            )}
            {os?.enabled && osMode === 'workspace-write' && (
              <SwitchRow
                advanced
                leading={<Glyph d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14.5 14.5 0 0 1 20 0M12 19.5h.01" />}
                title={zh ? '沙箱里允许联网' : 'Allow network in sandbox'}
                checked={allowNet}
                onChange={(v) => void saveRt({ osSandbox: { ...os, allowNetwork: v } })}
              />
            )}
          </SettingsCard>
        </Section>
      )}

      {/* 总是允许: 一排等宽命令片, 点 × 撤销。只能在审批卡上加 (内核按工具记, 还不支持手写命令规则) */}
      {alwaysAllow && (
        <Section>
          <div className="ag-always__head">
            <SectionTitle title={zh ? '总是允许' : 'Always allowed'} />
            <span className="ag-always__hint">{zh ? '在审批卡上点「总是允许」会记到这里' : 'Added when you choose “Always allow” on an approval card'}</span>
          </div>
          <SettingsCard className="ag-always">
            {alwaysAllow.length === 0 ? (
              <p className="ag-always__empty">{zh ? '还没有。每次都会按上面的档位问你。' : 'Nothing yet — the level above applies every time.'}</p>
            ) : (
              <div className="ag-always__chips">
                {alwaysAllow.map((x) => (
                  <span key={x.toolName} className="ag-chip" title={x.toolName}>
                    <span>{(zh ? PLAIN_TOOL_LABEL_ZH : PLAIN_TOOL_LABEL_EN)[x.toolName] ?? x.toolName}</span>
                    <button type="button" className="ag-chip__x" onClick={() => void revokeAlways(x.toolName)}
                      aria-label={zh ? `不再总是允许 ${x.toolName}` : `Stop always allowing ${x.toolName}`}>
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M3 3l6 6M9 3l-6 6" /></svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </SettingsCard>
        </Section>
      )}

      {agentRuntime && (
        <Section>
          <SectionTitle title={zh ? '命令与提交' : 'Commands & commits'} />
          <SettingsCard>
            <SwitchRow
              leading={<Glyph d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM3 12h5M16 12h5" />}
              title={zh ? '提交时署名 Neox' : 'Credit Neox in commits'}
              desc={zh ? '提交信息末尾加 Co-Authored-By: Neox。' : 'Adds “Co-Authored-By: Neox” to commits it makes.'}
              checked={agentRuntime.gitCoAuthor?.enabled !== false}
              onChange={(v) => void saveRt({ gitCoAuthor: { enabled: v } })}
            />
            <SwitchRow
              advanced
              leading={<Glyph d="M4 5h16v14H4zM8 10l3 2-3 2M13 15h3" />}
              title={zh ? '长命令转后台继续跑' : 'Move long commands to the background'}
              desc={zh ? '前台最多等 60 秒，之后转后台，跑完通知它。' : 'Waits up to 60s, then keeps running in the background and reports back.'}
              checked={agentRuntime.adoptOnTimeout.enabled}
              onChange={(v) => void saveRt({ adoptOnTimeout: { enabled: v } })}
            />
            {/* 默认超时只管转不了后台的命令 (关了上面那项 / 开了沙箱); 能转后台时只认模型自己给的 timeout */}
            <SettingsRow
              advanced
              leading={<Glyph d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2" />}
              title={zh ? '转不了后台时的超时' : 'Timeout when it can’t go to the background'}
              desc={zh ? '关了上一项或开了沙箱时，命令到点就停。' : 'Applies when the option above is off or the sandbox is on.'}
              control={(
                <span className="ag-num">
                  {/* NumberSettingInput 而不是受控 input + onChange 钳制 —— 后者输入"90"时首字符 9 < min 被拒回弹 */}
                  <NumberSettingInput value={Math.round(agentRuntime.bashTimeout.defaultMs / 1000)} min={10} max={3600} width={72}
                    ariaLabel={zh ? '命令默认超时(秒)' : 'Default command timeout (s)'}
                    onCommit={(sec) => void saveRt({ bashTimeout: { ...agentRuntime.bashTimeout, defaultMs: sec * 1000 } })} />
                  <em>{zh ? '秒' : 's'}</em>
                </span>
              )}
            />
            <SwitchRow
              advanced
              leading={<Glyph d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />}
              title={zh ? '保留彩色输出和进度条' : 'Keep colored output and progress bars'}
              checked={agentRuntime.pty.enabled}
              onChange={(v) => void saveRt({ pty: { enabled: v } })}
            />
            {/* 落 config.agentRuntime.servicesStopConfirmation; 消费方 ServicesSurfaceViewer 读同一份 */}
            <SwitchRow
              advanced
              leading={<Glyph d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9.5 9.5h5v5h-5z" />}
              title={zh ? '手动停服务时先确认' : 'Confirm when you stop a service'}
              checked={servicesStopConfirmation === 'always'}
              onChange={(v) => {
                const next = v ? 'always' : 'never';
                setServicesStopConfirmation(next);
                void (window as any)?.neox?.setAgentRuntimeConfig?.({ servicesStopConfirmation: next });
              }}
            />
          </SettingsCard>
        </Section>
      )}

      <Section>
        <SectionTitle title={zh ? '后台服务' : 'Background services'} />
        <SettingsCard>
          <SettingsRow
            leading={<Glyph d="M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01" />}
            title={zh ? '服务起来时自动显示' : 'Show the service panel automatically'}
            desc={zh
              ? 'agent 起 dev server、长跑命令或预览服务时，右侧自动打开服务面板（日志 + 预览）。服务退出后停在「已退出」，不会自动关。'
              : 'When the agent starts a dev server, a long-running command or a preview service, the service panel opens on the right (logs + preview). It stays on “stopped” after the service exits.'}
            control={(
              <Segmented
                value={serviceAutoShowMode}
                onChange={(v) => setServiceAutoShowMode(v)}
                options={[
                  { value: 'push', label: zh ? '右侧推开' : 'Push' },
                  { value: 'float', label: zh ? '悬浮' : 'Float' },
                  { value: 'off', label: zh ? '不自动' : 'Off' },
                ]}
                aria-label={zh ? '服务面板自动显示方式' : 'How to show the service panel'}
              />
            )}
          />
        </SettingsCard>
      </Section>

      {agentRuntime && (
        <Section advanced>
          <SectionTitle title={zh ? '模型' : 'Models'} />
          <SettingsCard>
            <SwitchRow
              leading={<Glyph d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3ZM18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />}
              title={zh ? '让 Agent 自己挑模型' : 'Let the agent pick models'}
              desc={zh ? '按任务在你配好的模型里换着用，每次换都说理由。' : 'Switches among your models per task, always with a reason.'}
              checked={agentRuntime.modelOrchestration === 'on'}
              onChange={(v) => void saveRt({ modelOrchestration: v ? 'on' : 'off' })}
            />
          </SettingsCard>
        </Section>
      )}
    </div>
  );
};

export default AgentTab;
