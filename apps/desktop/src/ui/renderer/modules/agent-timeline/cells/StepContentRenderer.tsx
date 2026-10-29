import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { StepContent } from '../types';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { setActiveSurface } from '../../../state/surfaceStore';
import { ExploreView } from './ExploreView';
import { ImageResultView } from './ImageResultView';
import { SeenImagesView } from './SeenImagesView';
import { SearchView } from './SearchView';
import { ReadFileView } from './ReadFileView';
import { PlanView } from './PlanView';
import { LogView, ThinkingView } from './TextStatusViews';
import { ChangeView } from './ChangeView';
import { ReadDocView } from './ReadDocView';
import { WebView } from './WebView';
import { OfficeEditView } from './OfficeEditView';
import { WakeupView } from './WakeupView';
import { AskUserView } from './AskUserView';
import { DeepResearchCard } from './DeepResearchCard';
import { BrowserResultView } from './BrowserResultView';
import { CodeView } from './CodeView';
import { ContextStatusView } from './ContextStatusView';
import { CompactionView } from './CompactionView';
import { TargetContinueView } from './TargetContinueView';
import { DelegationView, WorkerView } from './AgentDelegationViews';
import { ExternalAgentView } from './ExternalAgentView';
import { DagView } from './DagView';
import { FileListView } from './FileListView';
import { OpChipView } from './OpChipView';
import { SkillCardView } from './SkillCardView';
import { InstructionsCardView } from './InstructionsCardView';
import { ComputerRunView } from './ComputerRunView';
import { TimerCardView } from './TimerCardView';
import { TargetOpView } from './TargetOpView';
import { NetworkView } from './NetworkView';
import { DataResultView } from './DataResultView';
import { TurnSummaryView } from './TurnSummaryView';
import { EditDiffCard } from './EditDiffCard';
import { TerminalView } from './TerminalView';
import { ErrorView } from './ErrorView';
import { contentDataMarkers } from './contentMarkers';
import { NeoxCard } from '../../../components/NeoxCards';
import { ToolCardView } from '../toolCards/ToolCardView';
import { useI18n } from '../../../hooks/useI18n';

const SURFACE_KIND_LABEL: Record<string, { zh: string; en: string }> = {
  doc:      { zh: '文档',     en: 'doc' },
  diagram:  { zh: '图表',     en: 'diagram' },
  html:     { zh: 'HTML',     en: 'HTML' },
  image:    { zh: '图片',     en: 'image' },
  diff:     { zh: '文件对比', en: 'file diff' },
  plan:     { zh: '方案',     en: 'plan' },
  todo:     { zh: '清单',     en: 'todo list' },
  web:      { zh: '网页',     en: 'web page' },
  svg:      { zh: 'SVG',      en: 'SVG' },
  json:     { zh: 'JSON',     en: 'JSON' },
  chart:    { zh: '图表',     en: 'chart' },
  pdf:      { zh: 'PDF',      en: 'PDF' },
  terminal: { zh: '终端',     en: 'terminal' },
};

const SurfaceRefAction: React.FC<{ surfaceId: string; kind: string; title?: string }> = ({ surfaceId, kind, title }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const sessionId = runtime?.activeSession?.id;
  const handleClick = useCallback(() => {
    if (!sessionId) return;
    setActiveSurface(sessionId, surfaceId);
  }, [sessionId, surfaceId]);
  const kindEntry = SURFACE_KIND_LABEL[kind];
  const kindLabel = (isZh ? kindEntry?.zh : kindEntry?.en) || kind || 'surface';
  return (
    <button
      type="button"
      className="atl-surface-ref"
      onClick={handleClick}
      title={title
        ? (isZh ? `在右侧重新打开: ${title}` : `Reopen on the right: ${title}`)
        : (isZh ? `在右侧重新打开 ${kindLabel}` : `Reopen ${kindLabel} on the right`)}
    >
      <span className="atl-surface-ref__icon" aria-hidden="true">↗</span>
      <span className="atl-surface-ref__label">
        {isZh
          ? <>右侧重新打开 {title ? `「${title}」` : kindLabel}</>
          : <>Reopen {title ? `"${title}"` : kindLabel} on the right</>}
      </span>
    </button>
  );
};

/* ============================================================
 * CollapsibleContent — 自动弹性折叠超长内容
 *   每个工具内部 view 已经各自做了截断 (Terminal 40 行 / Code 30 / ReadFile 20…),
 *   但有些组合(diff/explore/dag 等)整体仍可能超 ~10 屏行,这里在外层再做一次
 *   高度兜底: 超过阈值 → 限高 + "展开更多"；展开态也保留上限, 避免长结果撑爆 timeline.
 * ============================================================ */
const COLLAPSE_THRESHOLD_PX = 280;
const COLLAPSE_EXPANDED_MAX_PX = 560;

const CollapsibleContent: React.FC<{ children: React.ReactNode; maxHeight?: number; expandedMaxHeight?: number }> = ({ children, maxHeight, expandedMaxHeight }) => {
  const { isZh } = useI18n();
  const threshold = maxHeight || COLLAPSE_THRESHOLD_PX;
  const expandedLimit = expandedMaxHeight || COLLAPSE_EXPANDED_MAX_PX;
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    let disposed = false;
    let raf: number | null = null;

    const measure = () => {
      if (disposed) return;
      const next = el.scrollHeight > threshold + 16;
      setOverflows((prev) => (prev === next ? prev : next));
    };

    const scheduleMeasure = () => {
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    };

    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null;
    ro?.observe(el);
    return () => {
      disposed = true;
      if (raf !== null) window.cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [threshold]);

  const handleWheel = undefined;

  const collapsed = overflows && !expanded;
  const boundedExpanded = overflows && expanded;
  const innerStyle = collapsed
    ? { maxHeight: threshold, overflow: 'hidden' as const }
    : boundedExpanded
      ? { maxHeight: expandedLimit, overflowY: 'auto' as const, overflowX: 'hidden' as const }
      : undefined;
  return (
    <div className={`atl-collapse${collapsed ? ' is-collapsed' : ''}${boundedExpanded ? ' is-expanded-scroll' : ''}`}>
      <div
        ref={innerRef}
        className="atl-collapse__inner"
        style={innerStyle}
        onWheel={collapsed ? handleWheel : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="atl-collapse__toggle"
          onMouseDown={(e) => {
            // 防止外层 tool row / timeline selection 抢事件，导致按钮点了但马上被父级重绘/折叠抵消。
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? (isZh ? '收起' : 'Collapse') : (isZh ? '展开更多' : 'Show more')}
        </button>
      )}
    </div>
  );
};

/* ============================================================
 * Content 分发
 * ============================================================ */
export const StepContentRenderer: React.FC<{ content: StepContent | undefined; stepTitle?: string; stepContext?: string }> = ({ content, stepTitle, stepContext }) => {
  if (!content || content.type === 'none') return null;
  /* diff 类型: DiffView 全 inline 展开, 不套 CollapsibleContent — 套了就跟 .atl-feed 形成
   * 双滚条 (CollapsibleContent 内部也有 overflow 截断), 改动卡片"嫌长"由卡片 chevron 折叠. */
  if (content.type === 'turn_summary') {
    return (
      <div className="atl-tool__content atl-tool__content--turn-summary" {...contentDataMarkers(content)}>
        <TurnSummaryView
          totalFiles={content.totalFiles}
          totalAdds={content.totalAdds}
          totalDels={content.totalDels}
          changes={content.changes}
          turnId={content.turnId}
        />
      </div>
    );
  }

  if (content.type === 'diff') {
    return <EditDiffCard content={content} dense />;
  }

  /* 跟 diff 同款的早返回: 不套 atl-tool__content, 也不套 CollapsibleContent ——
   * 外行已经写了标题和状态, 卡内就是内容本身 (「不要卡片嵌套」)。 */
  if (content.type === 'deep_research') {
    return <DeepResearchCard content={content} />;
  }

  if (content.type === 'seen_images') {
    return (
      <div className="atl-tool__content" {...contentDataMarkers(content)}>
        <SeenImagesView images={content.images} />
      </div>
    );
  }

  if (content.type === 'terminal') {
    return (
      <div className="atl-tool__content atl-tool__content--terminal" {...contentDataMarkers(content)}>
        <TerminalView
          key={content.toolId || 'terminal-no-toolid'}
          command={content.command}
          output={content.output}
          exitCode={content.exitCode}
          streaming={content.streaming}
          toolId={content.toolId}
          pid={content.pid}
          backgrounded={content.backgrounded}
        />
      </div>
    );
  }

  return (
    <div className="atl-tool__content" {...contentDataMarkers(content)}>
      <CollapsibleContent maxHeight={undefined}>
      {(() => {
        switch (content.type) {
          /* note: 'diff' / 'terminal' 走上面早返回, 这里不会到达 */
          case 'search':
            return (
              <SearchView
                pattern={content.pattern}
                totalHits={content.totalHits}
                hits={content.hits}
              />
            );
          case 'plan':
            return <PlanView goal={content.goal} steps={content.steps} planPath={content.planPath} frozen={content.frozen} />;
          case 'thinking':
            return <ThinkingView text={content.text} />;
          case 'image':
            return (
              <ImageResultView
                paths={content.paths}
                prompt={content.prompt}
                model={content.model}
                cached={content.cached}
              />
            );
          case 'error':
            /* 判据来自数据 (content.isBrowser), 不是标题文案 —— 标题早就中文化了,
             * 原来那句 /^browser/ 永远为假。code 前缀那半留着兜老数据。 */
            if (content.isBrowser || /^BROWSER_/i.test(content.code || '')) {
              return (
                <BrowserResultView
                  lines={[{ text: [content.code, content.message].filter(Boolean).join(' ') }]}
                  title={stepTitle}
                  context={stepContext}
                />
              );
            }
            return (
              <ErrorView
                code={content.code}
                message={content.message}
                suggestion={content.suggestion}
                action={content.action}
                repeatCount={content.repeatCount}
                lastAt={content.lastAt}
                requestId={content.requestId}
              />
            );
          case 'readfile':
            return (
              <ReadFileView
                file={content.file}
                totalLines={content.totalLines}
                offset={content.offset}
                limit={content.limit}
                preview={content.preview}
                displayFile={content.displayFile}
                fileName={content.fileName}
                directory={content.directory}
                language={content.language}
              />
            );
          case 'readdoc':
            return (
              <ReadDocView
                status={content.status}
                fileName={content.fileName}
                chars={content.chars}
                sizeLabel={content.sizeLabel}
              />
            );
          case 'askUser':
            return (
              <AskUserView
                requestId={content.requestId}
                status={content.status}
                questions={content.questions}
                error={content.error}
                attemptedAnswers={content.attemptedAnswers}
                createdAt={content.createdAt}
                timeoutSec={content.timeoutSec}
              />
            );
          case 'office':
            return <OfficeEditView content={content} />;
          case 'tool_card':
            return <ToolCardView card={content.card} />;
          case 'web':
            return (
              <WebView
                kind={content.kind}
                query={content.query}
                url={content.url}
                results={content.results}
              />
            );
          case 'compaction':
            return (
              <CompactionView
                status={content.status}
                originalTokens={content.originalTokens}
                finalTokens={content.finalTokens}
                budgetTokens={content.budgetTokens}
                originalMsgs={content.originalMsgs}
                keptMsgs={content.keptMsgs}
                droppedMsgs={content.droppedMsgs}
                compressionBuckets={content.compressionBuckets}
                compressionTotalBuckets={content.compressionTotalBuckets}
                compressionCompletedBuckets={content.compressionCompletedBuckets}
                compressionSummaryModel={content.compressionSummaryModel}
                errorDetail={content.errorDetail}
              />
            );
          case 'target_continuation':
            return (
              <TargetContinueView
                iteration={content.iteration}
                consecutiveBlocks={content.consecutiveBlocks}
                kind={content.kind}
              />
            );
          case 'worker':
            return (
              <WorkerView
                agentId={content.agentId}
                role={content.role}
                model={content.model}
                task={content.task}
                status={content.status}
                summary={content.summary}
                error={content.error}
              />
            );
          case 'delegation':
            return (
              <DelegationView
                role={content.role}
                roleName={content.roleName}
                model={content.model}
                task={content.task}
                status={content.status}
                summary={content.summary}
                error={content.error}
                toolCount={content.toolCount}
                currentStatus={content.currentStatus}
                isBackground={content.isBackground}
                toolRecords={content.toolRecords}
              />
            );
          case 'external_agent':
            return (
              <ExternalAgentView
                agentId={content.agentId}
                displayName={content.displayName}
                task={content.task}
                status={content.status}
                summary={content.summary}
                error={content.error}
                toolCallId={content.toolCallId}
                elapsedMs={content.elapsedMs}
                isBackground={content.isBackground}
                branch={content.branch}
                changedFiles={content.changedFiles}
              />
            );
          case 'explore':
            return (
              <ExploreView
                role={content.role}
                task={content.task}
                status={content.status}
                summary={content.summary}
                error={content.error}
                toolCount={content.toolCount}
                tokens={content.tokens}
                elapsed={content.elapsed}
                currentStatus={content.currentStatus}
                toolRecords={content.toolRecords}
                groupMembers={content.groupMembers}
              />
            );
          case 'dag':
            return (
              <DagView
                description={content.description}
                nodeCount={content.nodeCount}
                completedNodes={content.completedNodes}
                failedNodes={content.failedNodes}
                nodes={content.nodes}
              />
            );
          case 'filelist':
            return (
              <FileListView
                root={content.root}
                entries={content.entries}
                total={content.total}
              />
            );
          case 'log':
            return <LogView level={content.level} message={content.message} />;
          case 'change':
            return <ChangeView items={content.items} more={content.more} />;
          case 'network':
            return (
              <NetworkView
                variant={content.variant}
                label={content.label}
                tone={content.tone}
                fields={content.fields}
                list={content.list}
                extra={content.extra}
              />
            );
          case 'data':
            return (
              <DataResultView
                records={content.records}
                total={content.total}
                fields={content.fields}
                raw={content.raw}
              />
            );
          case 'code':
            return (
              <>
                {content.surfaceRef && (
                  /* surface tool call (open_surface/update_surface 等) — 卡片顶端加个"右侧重新打开"
                   * 按钮, 点击通过 surfaceStore.setActiveSurface 重新激活右侧对应 tab.
                   * 用户报"左侧没有再次进入文档的地方", 这就是入口. */
                  <SurfaceRefAction
                    surfaceId={content.surfaceRef.surfaceId}
                    kind={content.surfaceRef.kind}
                    title={content.surfaceRef.title}
                  />
                )}
                {content.isBrowser ? (
                  <BrowserResultView
                    lines={content.lines}
                    title={stepTitle}
                    context={stepContext}
                    progress={content.progress}
                    progressText={content.progressText}
                  />
                ) : (
                  <CodeView
                    lines={content.lines}
                    progress={content.progress}
                    progressText={content.progressText}
                  />
                )}
              </>
            );
          case 'wakeup':
            return (
              <WakeupView
                status={content.status}
                reason={content.reason}
                prompt={content.prompt}
                delaySeconds={content.delaySeconds}
                dueAtMs={content.dueAtMs}
                dueAtIso={content.dueAtIso}
                clamped={content.clamped}
                message={content.message}
              />
            );
          case 'timer_card':
            return (
              <TimerCardView
                subKind={content.subKind}
                status={content.status}
                title={content.title}
                context={content.context}
                atText={content.atText}
                recurrence={content.recurrence}
              />
            );
          case 'neox_card':
            return (
              <div className="atl-richcard">
                <NeoxCard kind={content.kind} body={content.body} />
              </div>
            );
          case 'skill':
            return (
              <SkillCardView
                skillId={content.skillId}
                skillName={content.skillName}
                trustLevel={content.trustLevel}
                allowedTools={content.allowedTools}
                model={content.model}
                body={content.body}
                saved={content.saved}
              />
            );
          case 'computer':
            return (
              <ComputerRunView
                app={content.app}
                icon={content.icon}
                steps={content.steps}
                screenshot={content.screenshot}
                totalMs={content.totalMs}
                ok={content.ok}
                note={content.note}
              />
            );
          case 'browser':
            /* 复用 ComputerRunView —— 浏览器和 Computer Use 这两张卡回答的是同三个问题
             * (在哪 / 做了什么 / 现在什么样), 拆成两个组件只会分头长歪。
             * 浏览器没有 App 图标, 组件的 logo 位自己会退成空白块。 */
            return (
              <ComputerRunView
                app={content.site}
                steps={content.steps}
                screenshot={content.screenshot}
                totalMs={content.totalMs}
                ok={content.steps.some((s) => s.ok === false) ? false : undefined}
                note={content.note}
                foot={{ ...content.signals, url: content.url }}
              />
            );
          case 'instructions':
            return (
              <InstructionsCardView
                workspace={content.workspace}
                sources={content.sources}
                failures={content.failures}
                chars={content.chars}
              />
            );
          case 'context_status':
            return (
              <ContextStatusView
                suggestion={content.suggestion}
                advice={content.advice}
                snapshotAvailable={content.snapshotAvailable}
                sessionId={content.sessionId}
                worstPct={content.worstPct}
                input={content.input}
                output={content.output}
                toolCalls={content.toolCalls}
                time={content.time}
                turns={content.turns}
              />
            );
          case 'op_chip':
            return (
              <OpChipView
                icon={content.icon}
                label={content.label}
                target={content.target}
                hint={content.hint}
                tone={content.tone}
                deletionSnapshotId={content.deletionSnapshotId}
              />
            );
          case 'target_op':
            return (
              <TargetOpView
                variant={content.variant}
                label={content.label}
                target={content.target}
                note={content.note}
                subMissionCount={content.subMissionCount}
                completedSubMissions={content.completedSubMissions}
                subMissions={content.subMissions}
                tone={content.tone}
              />
            );
          default:
            return null;
        }
      })()}
      </CollapsibleContent>
    </div>
  );
};
