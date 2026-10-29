/* ============================================================
 * HistoryCellRenderer — Phase 3.12 §6.2 渲染分发器
 *
 *   按 HistoryCell.kind 路由到对应 *View 组件 (cells/ 已就位的 35 文件).
 *
 *   12 covered kind 中 user / assistant_text 是 message row, 由消费者层
 *   (TimelineSteps → messageRouter / MessageCell) 直接处理, 不进本组件;
 *   本组件负责剩余 10 个 tool-shaped cell.
 *
 *   Phase D tail 后 cells 数据自洽 — HistoryCell 已扩字段, 渲染层不再回看
 *   StepContent. legacyContent prop 仍接受 (向后兼容老调用方), 但只在 cell
 *   字段不全 (运行时校验失败) 时降级使用.
 * ============================================================ */
import React from 'react';
import type { HistoryCell } from './HistoryCell';
import { ThinkingView, LogView } from './TextStatusViews';
import { TerminalView } from './TerminalView';
import { WebView } from './WebView';
import { PlanView } from './PlanView';
import { AskUserView } from './AskUserView';
import { WakeupView } from './WakeupView';
import { ErrorView } from './ErrorView';
import { CompactionView } from './CompactionView';
import { TargetContinueView } from './TargetContinueView';
import { EditDiffCard } from './EditDiffCard';
import { CodeView } from './CodeView';
import { ExploreView } from './ExploreView';
import { DelegationView, WorkerView } from './AgentDelegationViews';
import { ExternalAgentView } from './ExternalAgentView';

export interface HistoryCellRendererProps {
  cell: HistoryCell;
  /** TimelineStep 透传 — 老 *View (BrowserResultView) 个别用 stepTitle 判 prefix */
  stepTitle?: string;
  stepContext?: string;
}

export const HistoryCellRenderer: React.FC<HistoryCellRendererProps> = ({
  cell,
  stepTitle,
  stepContext,
}) => {
  switch (cell.kind) {
    /* ----- message row: 不走本路径, 消费者层路由 ----- */
    case 'user':
    case 'assistant_text':
      return null;

    /* ----- reasoning ----- */
    case 'reasoning':
      return <ThinkingView text={cell.text} />;

    /* ----- exec (terminal) ----- */
    case 'exec':
      return (
        <TerminalView
          key={cell.toolId || cell.id}
          command={cell.command}
          output={cell.output}
          exitCode={cell.exitCode}
          streaming={cell.status === 'running'}
          toolId={cell.toolId || cell.id}
          pid={cell.pid}
          backgrounded={cell.backgrounded}
        />
      );

    /* ----- web_search ----- */
    case 'web_search':
      return (
        <WebView
          kind={cell.variant}
          query={cell.query}
          url={cell.url}
          results={cell.results}
        />
      );

    /* ----- plan ----- */
    case 'plan':
      return (
        <PlanView
          goal={cell.explanation}
          steps={cell.steps.map((s, i) => ({
            id: String(i),
            content: s.text,
            status: s.status,
            ...(s.phase ? { phase: s.phase } : {}),
            ...(typeof s.estimateSec === 'number' ? { estimateSec: s.estimateSec } : {}),
          }))}
          planPath={cell.planPath}
          frozen={cell.frozen}
        />
      );

    /* ----- patch (diff / code) ----- */
    case 'patch': {
      if (cell.diff) {
        return (
          <EditDiffCard
            content={{
              type: 'diff',
              file: cell.diff.file,
              addCount: cell.diff.addCount,
              delCount: cell.diff.delCount,
              lines: cell.diff.lines,
              editHunks: cell.diff.editHunks,
              coalescedCount: cell.diff.coalescedCount,
              streaming: cell.diff.streaming,
              previousSnapshotId: cell.diff.previousSnapshotId,
            }}
            /* feed 里这张卡永远挂在有行头的工具行下 — 头部信息交给行头, 卡内只留 Undo/Review */
            dense
          />
        );
      }
      if (cell.code) {
        return (
          <CodeView
            lines={cell.code.lines}
            progress={cell.code.progress}
            progressText={cell.code.progressText}
          />
        );
      }
      return null;
    }

    /* ----- explore_group ----- */
    case 'explore_group':
      return (
        <ExploreView
          role={cell.role}
          task={cell.task}
          status={cell.status === 'running' ? 'running' : 'completed'}
          summary={cell.summary}
          error={cell.error}
          toolCount={cell.toolCount ?? cell.ops.length}
          tokens={cell.tokens}
          elapsed={cell.elapsed}
          currentStatus={cell.currentStatus}
          toolRecords={cell.ops.map((op) => ({
            name: op.tool,
            agentId: op.agentId,
            args: op.target,
            status: op.status ?? (cell.status === 'running' ? 'running' : 'done'),
            duration: op.durationMs,
            resultHint: op.resultHint,
          }))}
          groupMembers={cell.groupMembers}
        />
      );

    /* ----- background_task (worker / delegation / shell) ----- */
    case 'background_task': {
      if (cell.variant === 'worker') {
        return (
          <WorkerView
            agentId={cell.agentId}
            role={cell.role}
            model={cell.model}
            task={cell.description}
            status={cell.status === 'running' ? 'running'
              : cell.status === 'failed' ? 'failed'
              : 'completed'}
            summary={cell.summary}
            error={cell.error}
          />
        );
      }
      if (cell.variant === 'external') {
        return (
          <ExternalAgentView
            agentId={cell.agentId || cell.name}
            displayName={cell.name}
            task={cell.description}
            status={cell.status === 'running' ? 'running'
              : cell.status === 'failed' ? 'error'
              : 'completed'}
            summary={cell.summary}
            error={cell.error}
            toolCallId={cell.taskId}
            elapsedMs={cell.elapsedSeconds ? cell.elapsedSeconds * 1000 : undefined}
            isBackground={cell.isBackground}
            branch={cell.branch}
            changedFiles={cell.changedFileCount ? new Array(cell.changedFileCount).fill('') : undefined}
          />
        );
      }
      if (cell.variant === 'delegation') {
        return (
          <DelegationView
            role={cell.role}
            roleName={cell.roleName}
            model={cell.model}
            task={cell.description}
            status={cell.status === 'running' ? 'running'
              : cell.status === 'failed' ? 'error'
              : 'completed'}
            summary={cell.summary}
            error={cell.error}
            toolCount={cell.toolUseCount}
            currentStatus={cell.currentStatus}
            isBackground={cell.isBackground}
            toolRecords={cell.toolRecords}
          />
        );
      }
      /* shell variant — XML 兼容路径, 走 BackgroundShellCell. 但 BackgroundShellCell
       *  当前由 messageRouter 直接处理 user_message XML, 不走本组件. 这里兜底渲染空. */
      return null;
    }

    /* ----- ask_user ----- */
    case 'ask_user': {
      const askStatus = cell.status === 'waiting' ? 'waiting'
        : cell.status === 'answered' ? 'answered'
        : cell.status === 'expired' ? 'timeout'
        : cell.status === 'dismissed' ? 'interrupted'
        : 'waiting';
      return (
        <AskUserView
          requestId={cell.toolCallId}
          status={askStatus}
          questions={cell.questions}
          error={cell.error}
          attemptedAnswers={cell.answers}
          createdAt={cell.createdAt}
          timeoutSec={cell.timeoutSec}
        />
      );
    }

    /* ----- system_notice (按 subtype discriminate) ----- */
    case 'system_notice': {
      if (cell.subtype === 'wakeup') {
        const p = cell.payload;
        return (
          <WakeupView
            status={p.status}
            reason={p.reason}
            prompt={p.prompt}
            delaySeconds={p.delaySeconds}
            dueAtMs={p.dueAtMs}
            dueAtIso={p.dueAtIso}
            clamped={p.clamped}
            message={p.message}
          />
        );
      }
      if (cell.subtype === 'error') {
        const p = cell.payload;
        return (
          <ErrorView
            code={p.code}
            message={p.message}
            suggestion={p.suggestion}
            action={p.action}
            repeatCount={(p as { repeatCount?: number }).repeatCount}
            lastAt={(p as { lastAt?: string }).lastAt}
            requestId={p.requestId}
          />
        );
      }
      if (cell.subtype === 'compact') {
        const p = cell.payload;
        return (
          <CompactionView
            status={p.status}
            originalTokens={p.originalTokens}
            finalTokens={p.finalTokens}
            budgetTokens={p.budgetTokens}
            originalMsgs={p.originalMsgs}
            keptMsgs={p.keptMsgs}
            droppedMsgs={p.droppedMsgs}
            compressionBuckets={p.compressionBuckets}
            compressionTotalBuckets={p.compressionTotalBuckets}
            compressionCompletedBuckets={p.compressionCompletedBuckets}
            compressionSummaryModel={p.compressionSummaryModel}
            errorDetail={p.errorDetail}
          />
        );
      }
      if (cell.subtype === 'target_continue') {
        const p = cell.payload;
        return (
          <TargetContinueView
            iteration={p.iteration}
            consecutiveBlocks={p.consecutiveBlocks}
          />
        );
      }
      if (cell.subtype === 'log') {
        const p = cell.payload;
        return <LogView level={p.level} message={p.message} />;
      }
      /* memory_saved / 其它 subtype 兜底 — 显示 payload.message 或 subtype 名 */
      const fallbackMsg = typeof (cell.payload as { message?: unknown })?.message === 'string'
        ? (cell.payload as { message: string }).message
        : String(cell.subtype);
      return <LogView level="info" message={fallbackMsg} />;
    }

    /* ----- mcp_tool (Phase 5 未接) ----- */
    case 'mcp_tool':
      return null;

    default: {
      const _exhaustive: never = cell;
      void _exhaustive;
      void stepTitle;
      void stepContext;
      return null;
    }
  }
};
