/**
 * CloudMigrationDialog — 推/拉云端的完整确认 + 进度 + 完成 modal.
 *
 *   解决 toast 一闪而过的体验 — 用户不知道发生了什么.
 *   覆盖三态:
 *     1. confirming — 解释将发生什么 (上传位置/留不留本地/怎么回来), 用户 yes/no
 *     2. progress   — 阶段化进度条 (packing → uploading → migrating → done)
 *     3. done       — 成功/失败的明确结尾 + next action
 *
 *   mode='push':  desktop → cloud
 *   mode='pull':  cloud → desktop
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconCloudUp, IconCloudDown } from '../shell/shellIcons';
import { useI18n } from '../../hooks/useI18n';
import { useEnterTransition } from '../../hooks/useEnterTransition';

export type MigrationMode = 'push' | 'pull';

interface SessionInfo {
  id: string;
  title: string;
  workspacePath?: string | null;
  modelId?: string | null;
  messageCount?: number;
}

interface Props {
  open: boolean;
  mode: MigrationMode;
  session: SessionInfo | null;
  /** 当前进度 stage + pct (来自 cloudMigration.onProgress) */
  progress?: { stage: string; pct?: number; msg?: string } | null;
  /** 终态 — null=进行中, 'success'/'failed'=完成 */
  outcome?: 'success' | 'failed' | null;
  /** 失败原因 */
  errorMessage?: string;
  /** 没登录 NeoxCloud — confirming 状态显示登录引导, 禁 confirm 按钮 */
  notLoggedIn?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 完成态 "好的"; success 时可再传 "在新位置打开" 等 */
  onClose: () => void;
  /** "去登录" 跳到 Settings → 远程访问 */
  onGoLogin?: () => void;
}

function getStageLabel(isZh: boolean): Record<string, string> {
  return isZh
    ? {
        packing: '打包工作区',
        uploading: '上传到云端',
        migrating: '云端分配 pod',
        preparing: '通知云端 snapshot',
        waiting: '等云端 snapshot',
        downloading: '下载快照',
        extracting: '展开到本机',
        finalizing: '收尾',
      }
    : {
        packing: 'Packing workspace',
        uploading: 'Uploading to cloud',
        migrating: 'Cloud allocating pod',
        preparing: 'Notifying cloud snapshot',
        waiting: 'Waiting for cloud snapshot',
        downloading: 'Downloading snapshot',
        extracting: 'Extracting to local',
        finalizing: 'Finishing up',
      };
}

export const CloudMigrationDialog: React.FC<Props> = ({
  open, mode, session, progress, outcome, errorMessage, notLoggedIn,
  onConfirm, onCancel, onClose, onGoLogin,
}) => {
  const { isZh } = useI18n();
  /* 入场动画: motion-macos / motion-win32 的 .nx-in--modal */
  const entered = useEnterTransition();
  const STAGE_LABEL = getStageLabel(isZh);
  /* phase 推导: outcome 优先, progress 次之, 都没就 confirming */
  const phase: 'confirming' | 'progress' | 'done' = outcome
    ? 'done'
    : progress
      ? 'progress'
      : 'confirming';

  /* ETA 估算 — 从首次 progress 到达时刻起算 elapsed, 根据当前 pct 推剩余时间.
   *   pct 突然回退 (e.g. 阶段切换) 时 reset, 不显误导 ETA. */
  const etaStateRef = useRef<{ startedAt: number; lastPct: number } | null>(null);
  const eta = useMemo(() => {
    if (phase !== 'progress' || !progress || progress.pct == null) return null;
    const pct = progress.pct;
    const now = Date.now();
    const s = etaStateRef.current;
    if (!s || pct < s.lastPct - 5 /* pct 退超过 5 视为 reset */) {
      etaStateRef.current = { startedAt: now, lastPct: pct };
      return null;
    }
    etaStateRef.current = { startedAt: s.startedAt, lastPct: pct };
    const elapsedMs = now - s.startedAt;
    if (pct < 5 || elapsedMs < 3000) return null; /* 首 3s + 起步阶段不显, 速率不稳 */
    const remainMs = (elapsedMs / pct) * (100 - pct);
    const remainSec = Math.round(remainMs / 1000);
    if (remainSec < 5) return isZh ? '快好了' : 'Almost done';
    if (remainSec < 60) return isZh ? `约 ${remainSec} 秒` : `~${remainSec}s`;
    return isZh ? `约 ${Math.ceil(remainSec / 60)} 分钟` : `~${Math.ceil(remainSec / 60)}m`;
  }, [phase, progress, isZh]);
  useEffect(() => {
    if (phase !== 'progress') etaStateRef.current = null;
  }, [phase]);

  /* Esc 关 confirming / done; progress 不让 Esc 关 (防误关迁移中) */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (phase === 'progress') return;
      (phase === 'done' ? onClose : onCancel)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, onCancel, onClose]);

  if (!open || !session) return null;

  const isPush = mode === 'push';
  const Icon = isPush ? IconCloudUp : IconCloudDown;
  const titlePush = isZh ? '推到云端继续' : 'Push to cloud';
  const titlePull = isZh ? '拉回本机' : 'Pull back to local';

  return (
    <div className={`cloud-mig-overlay nx-in nx-in--scrim ${entered ? 'is-in' : ''}`} onClick={(e) => {
      /* 点遮罩关 — 仅 confirming/done; progress 不关 */
      if (e.target !== e.currentTarget) return;
      if (phase === 'progress') return;
      (phase === 'done' ? onClose : onCancel)();
    }}>
      <div className={`cloud-mig-dialog nx-in nx-in--modal ${entered ? 'is-in' : ''}`} role="dialog" aria-modal="true">
        <header className="cloud-mig-dialog__header">
          <span className="cloud-mig-dialog__icon"><Icon size={18} /></span>
          <h3 className="cloud-mig-dialog__title">{isPush ? titlePush : titlePull}</h3>
        </header>

        {phase === 'confirming' && (
          <>
            <div className="cloud-mig-dialog__body">
              <p className="cloud-mig-dialog__lead"><strong>{session.title}</strong></p>
              <p className="cloud-mig-dialog__line">
                {isPush
                  ? (isZh
                      ? '上传当前工作区到云端 sandbox 继续跑 · 本地保留备份'
                      : 'Upload the current workspace to a cloud sandbox and keep running · Local copy preserved')
                  : (isZh
                      ? '从云端拉回最新文件覆盖本机 · 云端 pod 销毁'
                      : 'Pull the latest files from cloud and overwrite local · The cloud pod is destroyed')}
              </p>
              {session.workspacePath && (
                <p className="cloud-mig-dialog__meta">
                  {isZh ? '工作区: ' : 'Workspace: '}<code>{session.workspacePath}</code>
                </p>
              )}
            </div>
            {notLoggedIn && (
              <p className="cloud-mig-dialog__warn">
                {isZh ? '⚠ 还没登录 NeoxCloud — 推到云端需要先登录' : '⚠ Not signed in to NeoxCloud — sign in first to push to cloud'}
              </p>
            )}
            <footer className="cloud-mig-dialog__footer">
              <button type="button" className="cloud-mig-dialog__btn" onClick={onCancel}>
                {isZh ? '取消' : 'Cancel'}
              </button>
              {notLoggedIn ? (
                <button
                  type="button"
                  className="cloud-mig-dialog__btn cloud-mig-dialog__btn--primary"
                  onClick={onGoLogin}
                >
                  {isZh ? '去登录' : 'Sign in'}
                </button>
              ) : (
                <button
                  type="button"
                  className="cloud-mig-dialog__btn cloud-mig-dialog__btn--primary"
                  onClick={onConfirm}
                >
                  {isPush
                    ? (isZh ? '推到云端' : 'Push to cloud')
                    : (isZh ? '拉回本机' : 'Pull to local')}
                </button>
              )}
            </footer>
          </>
        )}

        {phase === 'progress' && progress && (
          <>
            <div className="cloud-mig-dialog__body">
              <p className="cloud-mig-dialog__lead">
                {isPush
                  ? (isZh ? '正在推到云端…' : 'Pushing to cloud…')
                  : (isZh ? '正在拉回本机…' : 'Pulling to local…')}
              </p>
              <div className="cloud-mig-dialog__bar">
                <div
                  className="cloud-mig-dialog__bar-fill"
                  style={{ width: `${Math.max(2, Math.min(100, progress.pct ?? 0))}%` }}
                />
              </div>
              <p className="cloud-mig-dialog__stage">
                {STAGE_LABEL[progress.stage] ?? progress.stage}
                {progress.pct !== undefined ? ` · ${progress.pct}%` : ''}
                {eta ? (isZh ? ` · 预计 ${eta}` : ` · ETA ${eta}`) : ''}
              </p>
              {progress.msg && (
                <p className="cloud-mig-dialog__meta">{progress.msg}</p>
              )}
            </div>
            <footer className="cloud-mig-dialog__footer">
              <button
                type="button"
                className="cloud-mig-dialog__btn"
                onClick={onClose}
                title={isZh ? '把这个对话框隐藏, 迁移继续在后台跑. 完成会有 toast 通知.' : 'Hide this dialog — the migration keeps running in the background and toasts when done.'}
              >
                {isZh ? '后台运行' : 'Run in background'}
              </button>
            </footer>
          </>
        )}

        {phase === 'done' && (
          <>
            <div className="cloud-mig-dialog__body">
              {outcome === 'success' ? (
                <>
                  <p className="cloud-mig-dialog__lead cloud-mig-dialog__lead--ok">
                    {isPush
                      ? (isZh ? '已推到云端' : 'Pushed to cloud')
                      : (isZh ? '已拉回本机' : 'Pulled to local')}
                  </p>
                  <p className="cloud-mig-dialog__line">
                    {isPush
                      ? (isZh
                          ? '会话在云端继续跑, mobile 上能看到 · 回家右键 → 拉回本机'
                          : 'Session keeps running in the cloud and shows up on mobile · Back on this machine, right-click → Pull to local')
                      : (isZh
                          ? '云端 pod 已销毁, session 回到本机'
                          : 'Cloud pod destroyed — the session is back on this machine')}
                  </p>
                </>
              ) : (
                <>
                  <p className="cloud-mig-dialog__lead cloud-mig-dialog__lead--fail">
                    {isPush
                      ? (isZh ? '推送失败' : 'Push failed')
                      : (isZh ? '拉回失败' : 'Pull failed')}
                  </p>
                  <p className="cloud-mig-dialog__meta">
                    {errorMessage ?? (isZh ? '未知错误. 试着重新点一次或检查 NeoxCloud 登录状态.' : 'Unknown error. Try again or check your NeoxCloud sign-in status.')}
                  </p>
                </>
              )}
            </div>
            <footer className="cloud-mig-dialog__footer">
              <button
                type="button"
                className="cloud-mig-dialog__btn cloud-mig-dialog__btn--primary"
                onClick={onClose}
              >
                {isZh ? '好' : 'OK'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};
