import React, { useEffect, useMemo, useState } from 'react';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import DockRail from './dock/DockRail';
import type { DockPill, DockTone } from './dock/dockTypes';
import { DockPopList, worstTone, AgentGlyph, type DockPopRowData } from './dock/DockPopList';
import { AgentBrandLogo } from './components/AgentBrandLogo';
import { useSubAgents, abortSubAgent, type SubAgent } from '../../state/subAgentsStore';

/* ============ helpers ============ */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

function toneOf(status: SubAgent['status']): DockTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'aborted') return 'muted';
  return 'running';
}

function clip(s: string, max: number): string {
  const one = (s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * 模型短名 —— 药丸横向空间很紧, 全名 (含路由前缀 / 长后缀) 会把任务描述挤没。
 * 取最后一段并截断; 完整名走 detail。
 */
function shortModelName(model: string): string {
  /* 去掉渠道前缀 (neox-cloud:deepseek-v4.1-flash → deepseek-v4.1-flash) 和路由路径 */
  const tail = (model.split('/').pop() || model).replace(/^[\w.-]+:/, '');
  return tail.length > 22 ? tail.slice(0, 21) + '…' : tail;
}

/* ============ pills hook ============ */

const AgentLogo: React.FC<{ model?: string; size?: number }> = ({ model, size = 15 }) => (
  <AgentBrandLogo model={model} size={size} className="nx-pop__logo" fallback={<AgentGlyph />} />
);

/** 几个子 Agent 的 logo 叠成一摞 (最多 3 个, 同一个模型只出一次) */
const LogoStack: React.FC<{ models: Array<string | undefined> }> = ({ models }) => {
  const uniq = Array.from(new Set(models.map(m => m ?? ''))).slice(0, 3);
  if (uniq.length <= 1) return <AgentLogo model={uniq[0] || undefined} />;
  return (
    <span className="nx-dock__logo-stack">
      {uniq.map((m) => <span key={m || 'x'} className="nx-dock__logo-chip"><AgentLogo model={m || undefined} size={12} /></span>)}
    </span>
  );
};

export function useSubAgentPills(): DockPill[] {
  const { activeSession, selectedModel } = useNeoxRuntime();
  const { isZh } = useI18n();
  const agents = useSubAgents(activeSession?.id);
  const leadModel = selectedModel?.id || selectedModel?.name;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (agents.length === 0) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [agents.length]);

  return useMemo(() => {
    const shown = agents.filter((a) => !/^\s*调研\s*[:：]/.test(a.description || ''));
    if (shown.length === 0) return [];
    const nameOf = (a: SubAgent) => (a.name && !/^Agent-\d+(#\d+)?$/.test(a.name) ? a.name : a.description) || a.name || a.agentId.slice(0, 12);
    const elapsedOf = (a: SubAgent) => (a.status === 'running'
      ? Math.max(a.elapsedSeconds, Math.floor((nowMs - a.startedAtMs) / 1000))
      : a.elapsedSeconds);
    const modelOf = (a: SubAgent) => a.model || leadModel;
    const running = shown.filter(a => a.status === 'running');
    const failed = shown.filter(a => a.status === 'failed');
    const one = shown.length === 1 ? shown[0] : null;
    const statusWord = (a: SubAgent) => a.status === 'running' ? ''
      : a.status === 'completed' ? (isZh ? '已完成' : 'done')
      : a.status === 'failed' ? (isZh ? '失败' : 'failed')
      : (isZh ? '已终止' : 'aborted');
    const rows: DockPopRowData[] = [...shown]
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAtMs - a.startedAtMs)
      .map((a) => ({
        id: `subagent:${a.agentId}`,
        tone: toneOf(a.status),
        lead: <AgentLogo model={modelOf(a)} />,
        title: clip(nameOf(a), 22),
        note: [modelOf(a) ? shortModelName(modelOf(a)!) : '', a.toolUseCount > 0 ? (isZh ? `${a.toolUseCount} 步` : `${a.toolUseCount} steps`) : '', statusWord(a)].filter(Boolean).join(' · '),
        desc: a.description && a.description !== nameOf(a) ? clip(a.description, 120) : undefined,
        meta: formatElapsed(elapsedOf(a)),
        actions: a.status === 'running'
          ? [{ id: 'abort', label: isZh ? '终止' : 'Abort', danger: true, onClick: () => { void abortSubAgent(a.agentId); } }]
          : undefined,
      }));
    const pill: DockPill = {
      id: 'subagents',
      tone: worstTone(shown.map(a => toneOf(a.status))),
      icon: <LogoStack models={shown.map(modelOf)} />,
      label: one ? clip(nameOf(one), 18) : (isZh ? '子 Agent' : 'Sub-agents'),
      meta: one ? formatElapsed(elapsedOf(one)) : String(shown.length),
      weight: running.length ? 22 : 46,
      attention: failed.length > 0,
      expandDetail: false,
      updatedAt: Math.min(...shown.map(a => a.startedAtMs)),
      ariaLabel: isZh ? `子 Agent ${shown.length} 个` : `${shown.length} sub-agents`,
      popTitle: isZh ? '子 Agent' : 'Sub-agents',
      popMeta: [
        running.length ? (isZh ? `${running.length} 个在跑` : `${running.length} running`) : '',
        failed.length ? (isZh ? `${failed.length} 个失败` : `${failed.length} failed`) : '',
      ].filter(Boolean).join(' · ') || (isZh ? '都做完了' : 'all done'),
      panel: <DockPopList rows={rows} />,
    };
    return [pill];
  }, [agents, nowMs, isZh, leadModel]);
}

/* ============ 独立组件形态 ============ */

export const SubAgentsBar: React.FC = () => {
  const pills = useSubAgentPills();
  return <DockRail pills={pills} />;
};

export default SubAgentsBar;
