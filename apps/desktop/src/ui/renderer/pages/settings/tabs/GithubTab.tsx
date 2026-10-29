import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { CustomSelect } from '../../../components/CustomSelect';
import { useEditionMembership as useMembership } from '../../../modules/shell/editionHooks';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../../shared/neoxCloud';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  SwitchRow,
  NeoxInput,
  NeoxButton,
  Segmented,
} from '../../../components/settings-base';
import Icons from '../../../components/Icons';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import './GithubTab.clay.css';

interface RepoEntry { repo: string; path: string }
interface GithubCfg {
  enabled: boolean;
  repos?: RepoEntry[];
  mention?: string;
  pollIntervalMs?: number;
  autoPush?: boolean;
  allowedUsers?: string[];
  providerId?: string;
  modelName?: string;
}
interface Status {
  login?: string;
  lastPollAt?: string;
  lastError?: string | null;
  recent?: Array<{ at: string; repo: string; number: number; user: string; status: string; note?: string }>;
}
interface TokenInfo { ok: boolean; login?: string; source?: string; error?: string }

/** 首页内联的最近处理只露这几条, 其余进二级页 */
const RECENT_PREVIEW = 3;

function fmtAgo(iso: string | undefined, zh: boolean): string {
  if (!iso) return zh ? '还没拉过' : 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return zh ? `${s} 秒前` : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return zh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.round(h / 24);
  return zh ? `${d} 天前` : `${d}d ago`;
}

const GithubTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const { providers } = useSettingsContext();
  const membership = useMembership();
  const api = (window as any).neox;

  const [cfg, setCfg] = useState<GithubCfg | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [newRepo, setNewRepo] = useState('');
  const [newPath, setNewPath] = useState('');
  const [mentionDraft, setMentionDraft] = useState('');
  const [usersDraft, setUsersDraft] = useState('');
  /* 首页放全部设置; 只有「最近处理」全量列表进二级页 */
  const [view, setView] = useState<'home' | 'recent'>('home');

  const reload = useCallback(async () => {
    try {
      const c = await api?.getGithubChannelConfig?.();
      if (c) { setCfg(c); setMentionDraft(c.mention ?? '@neox'); setUsersDraft((c.allowedUsers ?? []).join(', ')); }
    } catch (err: any) { dispatchOpFailed({ op: zh ? '读取 GitHub 设置' : 'Load GitHub settings', message: err?.message ?? String(err) }); }
    try { setStatus(await api?.getGithubChannelStatus?.()); } catch { /* 状态没有就没有 */ }
  }, [api, zh]);

  useEffect(() => {
    void reload();
    void (async () => { try { setToken(await api?.getGithubTokenInfo?.()); } catch { setToken({ ok: false, error: 'ipc' }); } })();
    const t = setInterval(() => { void (async () => { try { setStatus(await api?.getGithubChannelStatus?.()); } catch { /* ignore */ } })(); }, 10_000);
    return () => clearInterval(t);
  }, [api, reload]);

  const save = useCallback(async (patch: Partial<GithubCfg>) => {
    try {
      const next = await api?.setGithubChannelConfig?.(patch);
      if (next) setCfg(next);
    } catch (err: any) {
      dispatchOpFailed({ op: zh ? '保存 GitHub 设置' : 'Save GitHub settings', message: err?.message ?? String(err) });
      void reload();
    }
  }, [api, zh, reload]);

  const pickFolder = useCallback(async () => {
    try {
      const dir = await api?.openFolderDialog?.();
      if (typeof dir === 'string' && dir) setNewPath(dir);
    } catch { /* 用户取消 */ }
  }, [api]);

  const addRepo = useCallback(async () => {
    const repo = newRepo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { dispatchHint(zh ? '仓库要写成 owner/repo' : 'Repository must be owner/repo', 'warning'); return; }
    if (!newPath.trim()) { dispatchHint(zh ? '选一下这个仓库在本机的 clone 目录' : 'Pick the local clone folder', 'warning'); return; }
    const repos = [...(cfg?.repos ?? []).filter((r) => r.repo.toLowerCase() !== repo.toLowerCase()), { repo, path: newPath.trim() }];
    await save({ repos });
    setNewRepo(''); setNewPath('');
    dispatchHint(zh ? `已加入 ${repo}` : `Added ${repo}`, 'success');
  }, [newRepo, newPath, cfg, save, zh]);

  const removeRepo = useCallback(async (repo: string) => {
    await save({ repos: (cfg?.repos ?? []).filter((r) => r.repo !== repo) });
  }, [cfg, save]);

  const modelOptions = [
    { value: '', label: zh ? '默认模型 (跟主模型走)' : 'Default model' },
    ...(membership?.models || [])
      .filter((m) => m.allowed && m.modelId !== 'auto')
      .map((m) => ({ value: `${NEOX_CLOUD_PROVIDER_ID}::${m.modelId}`, label: m.displayName || m.modelId })),
    ...(providers as any[])
      .filter((p) => p.id !== NEOX_CLOUD_PROVIDER_ID)
      .flatMap((p) => (p.models || []).map((m: any) => ({ value: `${p.id}::${m.name}`, label: `${m.label || m.name}  ·  ${p.name}` }))),
  ];
  const modelValue = cfg?.providerId && cfg?.modelName ? `${cfg.providerId}::${cfg.modelName}` : '';
  /* 配置里写的模型不在任何 provider 的模型清单里 (手填 / 清单还没刷新): 照样显示出来, 别让人以为是"默认" */
  if (modelValue && !modelOptions.some((o) => o.value === modelValue)) {
    modelOptions.push({ value: modelValue, label: `${cfg!.modelName}  ·  ${cfg!.providerId}` });
  }

  if (!cfg) return <div className="settings-panel-content"><PageTitle title="GitHub" /></div>;

  const tokenLine = token == null
    ? (zh ? '检查本机 GitHub 登录…' : 'Checking GitHub sign-in…')
    : token.ok
      ? (zh ? `以 @${token.login} 的身份 (${token.source === 'env' ? 'GITHUB_TOKEN 环境变量' : 'gh CLI 登录'}) 拉评论、回评论、推分支。` : `Acting as @${token.login} (${token.source === 'env' ? 'GITHUB_TOKEN env' : 'gh CLI login'}).`)
      : (zh ? '本机没有 GitHub 登录: 终端里跑 `gh auth login`, 或设 GITHUB_TOKEN 环境变量后重启 Neox。' : 'No GitHub sign-in on this machine: run `gh auth login`, or set GITHUB_TOKEN and restart Neox.');

  const stateLine = token && !token.ok
    ? tokenLine
    : status?.lastError
      ? (zh ? `出错: ${status.lastError}` : `Error: ${status.lastError}`)
      : cfg.enabled
        ? (zh ? `上次拉取 ${fmtAgo(status?.lastPollAt, zh)}${token?.login ? ` · 账号 @${token.login}` : ''}` : `Last poll ${fmtAgo(status?.lastPollAt, zh)}${token?.login ? ` · @${token.login}` : ''}`)
        : (zh ? '已关闭' : 'Off');
  const stateWarn = !!((token && !token.ok) || status?.lastError);

  const recent = [...(status?.recent ?? [])].reverse();
  const statusWord = (s: string) => (s === 'replied' ? (zh ? '已回复' : 'replied') : s === 'failed' ? (zh ? '失败' : 'failed') : (zh ? '进行中' : 'running'));
  const back = { label: 'GitHub', onBack: () => setView('home') };

  if (view === 'recent') {
    return (
      <div className="settings-panel-content gh3">
        <PageTitle title={zh ? '最近处理' : 'Recent'} back={back} />
        <SettingsCard>
          {recent.length === 0 && <SettingsRow title={zh ? '还没有处理过评论' : 'Nothing handled yet'} />}
          {recent.map((r, i) => (
            <SettingsRow
              key={`${r.at}-${i}`}
              title={`${r.repo}#${r.number} · @${r.user}`}
              desc={`${statusWord(r.status)} · ${fmtAgo(r.at, zh)}${r.note ? ` · ${r.note}` : ''}`}
            />
          ))}
        </SettingsCard>
      </div>
    );
  }

  const pollMs = cfg.pollIntervalMs ?? 30000;
  const pollOptions: Array<{ value: string; label: string }> = [
    { value: '15000', label: zh ? '15 秒' : '15s' },
    { value: '30000', label: zh ? '30 秒' : '30s' },
    { value: '60000', label: zh ? '1 分钟' : '1m' },
    { value: '300000', label: zh ? '5 分钟' : '5m' },
  ];
  /* 配置里是别的间隔 (手改过的): 多给一段显示出来, 别让分段一段都不亮 */
  if (!pollOptions.some((o) => o.value === String(pollMs))) {
    pollOptions.push({ value: String(pollMs), label: `${Math.round(pollMs / 1000)}s` });
  }

  const shownRecent = recent.slice(0, RECENT_PREVIEW);
  const pollLabel = ({ 15000: zh ? '15 秒' : '15s', 30000: zh ? '30 秒' : '30s', 60000: zh ? '1 分钟' : '1m', 300000: zh ? '5 分钟' : '5m' } as Record<number, string>)[pollMs] ?? `${Math.round(pollMs / 1000)}s`;
  const runSummary = [
    cfg.mention ?? '@neox',
    (cfg.allowedUsers ?? []).length ? (zh ? `只认 ${cfg.allowedUsers!.length} 人` : `${cfg.allowedUsers!.length} people`) : (zh ? '所有人' : 'anyone'),
    cfg.autoPush !== false ? (zh ? '自动推送' : 'auto-push') : (zh ? '只回评论' : 'reply only'),
    zh ? `每 ${pollLabel}` : `every ${pollLabel}`,
  ].join(' · ');

  return (
    <div className="settings-panel-content gh3">
      <PageTitle
        title="GitHub"
        subtitle={zh ? `PR 评论里 ${cfg.mention ?? '@neox'}，它就去改` : `Comment ${cfg.mention ?? '@neox'} on a PR and it does the work`}
      />

      {/* 账号 + 总开关 */}
      <Section>
        <SettingsCard>
          <SwitchRow
            leading={<span className="gh3-ico" aria-hidden="true"><Icons.GitBranch /></span>}
            title={zh ? '监听 PR 评论' : 'Watch PR comments'}
            desc={<span className={`gh3-state${stateWarn ? ' is-warn' : ''}`}>{stateLine}</span>}
            checked={cfg.enabled}
            onChange={(v) => void save({ enabled: v })}
          />
          <SettingsRow
            leading={<span className="gh3-ico" aria-hidden="true"><Icons.GitBranch /></span>}
            title={token?.ok ? `@${token.login}` : (zh ? '本机 GitHub 账号' : 'Local GitHub account')}
            desc={zh ? '在本机签出 PR 分支，改完推回去，再回复到评论区。' : 'Checks out the PR branch locally, pushes the fix, and replies on the PR.'}
          />
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle
          title={zh ? '盯哪些仓库' : 'Repositories'}
          desc={zh ? '每个仓库要指一个本机 clone: PR 分支从它 fetch, 签出到独立的 worktree, 不会动你自己正在改的文件。' : 'Each repository needs a local clone; PR branches are fetched from it into a separate worktree, never touching your own working tree.'}
        />
        <SettingsCard>
          {(cfg.repos ?? []).length === 0 && (
            <SettingsRow title={zh ? '还没有仓库' : 'No repositories yet'} desc={zh ? '下面加一个。' : 'Add one below.'} />
          )}
          {(cfg.repos ?? []).map((r) => (
            <SettingsRow
              key={r.repo}
              title={r.repo}
              desc={<span className="gh3-path">{r.path}</span>}
              control={
                <NeoxButton variant="ghost" size="sm" onClick={() => void removeRepo(r.repo)}>{zh ? '移除' : 'Remove'}</NeoxButton>
              }
            />
          ))}
          <div className="gh3-add">
            <div className="gh3-add__repo">
              <NeoxInput value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder="owner/repo" />
            </div>
            <div className="gh3-add__path">
              <NeoxInput value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder={zh ? '本机 clone 目录' : 'Local clone folder'} />
              <NeoxButton variant="secondary" size="sm" onClick={() => void pickFolder()}>{zh ? '选择…' : 'Browse…'}</NeoxButton>
            </div>
            <NeoxButton variant="secondary" size="sm" onClick={() => void addRepo()}>{zh ? '加入' : 'Add'}</NeoxButton>
          </div>
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle title={zh ? '触发与运行' : 'Trigger & run'} desc={runSummary} />
        <SettingsCard>
          <SettingsRow
            title={zh ? '召唤词' : 'Mention word'}
            desc={zh ? '评论里带这个词才会触发 (整词匹配, 不分大小写)。' : 'Only comments containing this word trigger a run (whole word, case-insensitive).'}
            control={
              <div className="gh3-input gh3-input--mention">
                <NeoxInput
                  value={mentionDraft}
                  onChange={(e) => setMentionDraft(e.target.value)}
                  onBlur={() => { const m = mentionDraft.trim() || '@neox'; setMentionDraft(m); if (m !== cfg.mention) void save({ mention: m }); }}
                />
              </div>
            }
          />
          <SettingsRow
            title={zh ? '只认这些人' : 'Allowed commenters'}
            desc={zh ? 'GitHub 用户名, 逗号分隔; 留空 = 仓库里谁评论都算。机器人账号和 Neox 自己的回复永远不算。' : 'GitHub logins, comma-separated; empty = anyone on the repo. Bots and Neox\'s own replies never trigger.'}
            control={
              <div className="gh3-input gh3-input--users">
                <NeoxInput
                  value={usersDraft}
                  onChange={(e) => setUsersDraft(e.target.value)}
                  placeholder={zh ? '留空 = 所有人' : 'empty = anyone'}
                  onBlur={() => {
                    const list = usersDraft.split(/[,\s]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
                    if (list.join(',') !== (cfg.allowedUsers ?? []).join(',')) void save({ allowedUsers: list });
                  }}
                />
              </div>
            }
          />
          <SwitchRow
            title={zh ? '改完自动推到 PR 分支' : 'Push commits to the PR branch'}
            desc={zh ? '关掉就只回评论, 提交留在本机 worktree 里。fork 来的 PR 永远不推。' : 'Off = reply only; commits stay in the local worktree. Fork PRs are never pushed.'}
            checked={cfg.autoPush !== false}
            onChange={(v) => void save({ autoPush: v })}
          />
          <SettingsRow
            title={zh ? '用哪个模型' : 'Model'}
            desc={zh ? 'PR 任务是后台跑的, 可以单独给它配个便宜的。' : 'PR runs happen in the background; a cheaper model is fine here.'}
            control={
              <div className="gh3-input gh3-input--model">
                <CustomSelect
                  value={modelValue}
                  options={modelOptions}
                  placeholder={zh ? '默认模型' : 'Default model'}
                  onChange={(v) => {
                    if (!v) { void save({ providerId: '', modelName: '' }); return; }
                    const i = v.indexOf('::');
                    void save({ providerId: v.slice(0, i), modelName: v.slice(i + 2) });
                  }}
                />
              </div>
            }
          />
          <SettingsRow
            title={zh ? '拉取间隔' : 'Poll interval'}
            desc={zh ? '多久看一次新评论。不用公网地址、不用 webhook。' : 'How often to check for new comments. No public URL or webhook needed.'}
            control={
              <Segmented
                aria-label={zh ? '拉取间隔' : 'Poll interval'}
                value={String(pollMs)}
                options={pollOptions}
                onChange={(v) => void save({ pollIntervalMs: Number(v) })}
              />
            }
          />
        </SettingsCard>
      </Section>

      {/* 最近处理: 首页露前几条, 全量进二级页 */}
      <Section>
        <SectionTitle title={zh ? '最近处理' : 'Recent'} />
        <SettingsCard>
          {shownRecent.length === 0 && (
            <SettingsRow title={zh ? '还没有处理过评论' : 'Nothing handled yet'} />
          )}
          {shownRecent.map((r, i) => (
            <SettingsRow
              key={`${r.at}-${i}`}
              title={`${r.repo}#${r.number} · @${r.user}`}
              desc={`${statusWord(r.status)} · ${fmtAgo(r.at, zh)}${r.note ? ` · ${r.note}` : ''}`}
            />
          ))}
          {recent.length > 0 && (
            <SettingsRow
              title={zh ? '查看全部' : 'View all'}
              desc={zh ? `共 ${recent.length} 条` : `${recent.length} in total`}
              onClick={() => setView('recent')}
              control={<span className="gh3-go"><Icons.ChevronRight /></span>}
            />
          )}
        </SettingsCard>
      </Section>
    </div>
  );
};

export default GithubTab;
