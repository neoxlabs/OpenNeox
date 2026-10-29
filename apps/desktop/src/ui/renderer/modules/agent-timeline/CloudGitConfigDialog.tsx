/**
 * CloudGitConfigDialog — 大项目推到云端时, 让用户配 git 认证.
 *
 *   触发场景: workspace > 100MB 且检测到 git remote, NeoxShellHost 弹这个先收集 git auth,
 *   submit 后才走 pushViaGit IPC.
 *
 *   字段:
 *     - Repository URL (预填 origin remote)
 *     - 分支 (默认当前 HEAD branch)
 *     - 认证模式 (token / 用户名密码)
 *     - 未 commit 改动处理: 忽略 / 自动 commit 到临时分支 / patch 上传
 */
import { useI18n } from '../../hooks/useI18n';
import React, { useRef, useState } from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import type { WorkspaceAnalysisRenderer } from '../shell/useCloudSessions';
import { useEscClose } from '../../hooks/useEscClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface GitConfig {
  gitUrl: string;
  branch: string;
  headCommit: string | null;
  authMode: 'token' | 'userpass';
  authUser?: string;
  authToken: string;
  dirtyMode: 'ignore' | 'auto-commit-temp' | 'patch';
}

interface Props {
  open: boolean;
  analysis: WorkspaceAnalysisRenderer | null;
  sessionTitle: string;
  onConfirm: (cfg: GitConfig) => void;
  onCancel: () => void;
  onUploadInstead: () => void;
}

function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const CloudGitConfigDialog: React.FC<Props> = ({
  open, analysis, sessionTitle, onConfirm, onCancel, onUploadInstead,
}) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  /* 入场动画: motion-macos / motion-win32 的 .nx-in--* */
  const entered = useEnterTransition();
  const [gitUrl, setGitUrl] = useState(analysis?.git.remoteUrl ?? '');
  const [branch, setBranch] = useState(analysis?.git.branch ?? 'main');
  const [authMode, setAuthMode] = useState<'token' | 'userpass'>('token');
  const [authUser, setAuthUser] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [dirtyMode, setDirtyMode] = useState<'ignore' | 'auto-commit-temp' | 'patch'>(
    analysis?.git.dirty ? 'patch' : 'ignore',
  );

  // 当 analysis 切换时 (打开一次), 重置表单
  React.useEffect(() => {
    if (open && analysis) {
      setGitUrl(analysis.git.remoteUrl ?? '');
      setBranch(analysis.git.branch ?? 'main');
      setDirtyMode(analysis.git.dirty ? 'patch' : 'ignore');
    }
  }, [open, analysis]);

  /* Esc 关闭 — 跟遮罩点击同语义; Tab 锁在弹窗内 */
  useEscClose(open, onCancel);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  if (!open) return null;
  const canSubmit = gitUrl.trim().length > 0 && branch.trim().length > 0 && authToken.trim().length > 0;

  const submit = (): void => {
    if (!canSubmit) return;
    onConfirm({
      gitUrl: gitUrl.trim(),
      branch: branch.trim(),
      headCommit: analysis?.git.head ?? null,
      authMode,
      authUser: authMode === 'userpass' ? authUser : undefined,
      authToken,
      dirtyMode,
    });
  };

  return (
    <div className="cloud-mig-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={dialogRef} className={`cloud-mig-dialog cloud-git-dialog nx-in nx-in--modal ${entered ? 'is-in' : ''}`} role="dialog" aria-modal="true">
        <header className="cloud-mig-dialog__header">
          <h3 className="cloud-mig-dialog__title">{zh ? '推到云端 · git 模式 (推荐)' : 'Push to cloud · git mode (recommended)'}</h3>
        </header>
        <div className="cloud-mig-dialog__body">
          <div className="cloud-mig-dialog__lead">
            会话「{sessionTitle}」工作区 <strong>{analysis ? fmtBytes(analysis.payloadBytes) : '—'}</strong> · {analysis?.fileCount ?? 0} 个文件
            <br/>大项目走 git 克隆比直接上传快 10-100 倍, 仅传几 KB metadata。
          </div>

          <fieldset className="cloud-git-fs">
            <legend>{zh ? '仓库' : 'Repository'}</legend>
            <label className="cloud-git-row">
              <span className="cloud-git-label">URL</span>
              <input
                type="text"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                className="cloud-git-input cloud-git-input--mono"
              />
            </label>
            <label className="cloud-git-row">
              <span className="cloud-git-label">{zh ? '分支' : 'Branch'}</span>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="cloud-git-input"
              />
            </label>
          </fieldset>

          <fieldset className="cloud-git-fs">
            <legend>{zh ? '认证' : 'Authentication'}</legend>
            <div className="cloud-git-radios">
              <label>
                <input type="radio" name="authMode" checked={authMode === 'token'} onChange={() => setAuthMode('token')} />
                <strong>Personal Access Token</strong> (推荐 · GitHub PAT / GitLab token)
              </label>
              <label>
                <input type="radio" name="authMode" checked={authMode === 'userpass'} onChange={() => setAuthMode('userpass')} />
                用户名 + 密码 (老 git host)
              </label>
            </div>
            {authMode === 'userpass' && (
              <label className="cloud-git-row">
                <span className="cloud-git-label">{zh ? '用户名' : 'Username'}</span>
                <input
                  type="text"
                  value={authUser}
                  onChange={(e) => setAuthUser(e.target.value)}
                  className="cloud-git-input"
                />
              </label>
            )}
            <label className="cloud-git-row">
              <span className="cloud-git-label">{authMode === 'token' ? 'Token' : (zh ? '密码' : 'Password')}</span>
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={authMode === 'token' ? (zh ? 'github_pat_xxx 或 ghp_xxx' : 'github_pat_xxx or ghp_xxx') : '••••••'}
                className="cloud-git-input cloud-git-input--mono"
              />
            </label>
            <div className="cloud-git-hint">
              ⚠️ 凭证 send once, pod 用完立刻丢, 不存数据库
            </div>
          </fieldset>

          {analysis?.git.dirty && (
            <fieldset className="cloud-git-fs">
              <legend>未 commit 改动 ({analysis.git.dirtyFileCount} 个文件)</legend>
              <div className="cloud-git-radios">
                <label>
                  <input type="radio" name="dirtyMode" checked={dirtyMode === 'patch'} onChange={() => setDirtyMode('patch')} />
                  <strong>{zh ? '把 patch 一起送给 pod' : 'Send the patch to the pod'}</strong>{zh ? ' (推荐 · 几 KB 流量, 不动你本地 git)' : ' (recommended · a few KB, leaves your local git untouched)'}
                </label>
                <label>
                  <input type="radio" name="dirtyMode" checked={dirtyMode === 'auto-commit-temp'} onChange={() => setDirtyMode('auto-commit-temp')} />
                  自动 commit 到临时分支并 push (稳, 但 push 你 git host 一次)
                </label>
                <label>
                  <input type="radio" name="dirtyMode" checked={dirtyMode === 'ignore'} onChange={() => setDirtyMode('ignore')} />
                  忽略 (pod 拿到的就是 HEAD, 改动丢)
                </label>
              </div>
            </fieldset>
          )}
        </div>

        <footer className="cloud-mig-dialog__footer">
          <button type="button" className="cloud-mig-dialog__btn" onClick={onUploadInstead}>
            改走上传 (慢)
          </button>
          <button type="button" className="cloud-mig-dialog__btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="cloud-mig-dialog__btn cloud-mig-dialog__btn--primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            git 推送
          </button>
        </footer>
      </div>
    </div>
  );
};

/* 标记一下 React 在该文件不直接使用 (避免 lint 警告) */
void React;
