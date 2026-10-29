import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

/* ---------- dag ---------- */
const DAG_NODE_STATUS_CLS: Record<string, string> = {
  pending: 'is-pending',
  running: 'is-running',
  completed: 'is-done',
  failed: 'is-fail',
};

export const DagView: React.FC<{
  description?: string;
  nodeCount?: number;
  completedNodes?: number;
  failedNodes?: number;
  nodes?: Array<{
    id: string;
    name: string;
    status: string;
    agentId?: string;
    duration?: number;
  }>;
}> = ({ description, nodeCount, completedNodes, failedNodes, nodes }) => {
  const { isZh } = useI18n();
  return (
  <div className="atl-dag">
    <div className="atl-dag__head">
      {typeof nodeCount === 'number' && (
        <span className="atl-dag__stat">
          {completedNodes ?? 0}/{nodeCount} {isZh ? '完成' : 'done'}
          {typeof failedNodes === 'number' && failedNodes > 0 && (
            <span className="atl-dag__fail"> · {failedNodes} {isZh ? '失败' : 'failed'}</span>
          )}
        </span>
      )}
      {description && <span className="atl-dag__desc">{description}</span>}
    </div>
    {nodes && nodes.length > 0 && (
      <ul className="atl-dag__nodes">
        {nodes.map((n) => (
          <li
            key={n.id}
            className={`atl-dag__node ${DAG_NODE_STATUS_CLS[n.status] ?? 'is-pending'}`}
          >
            <span className="atl-dag__node-dot" aria-hidden="true" />
            <span className="atl-dag__node-name">{n.name}</span>
            {n.agentId && (
              <span className="atl-dag__node-agent">@{n.agentId.slice(0, 6)}</span>
            )}
            {typeof n.duration === 'number' && n.duration > 0 && (
              <span className="atl-dag__node-dur">{formatMs(n.duration)}</span>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
  );
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

