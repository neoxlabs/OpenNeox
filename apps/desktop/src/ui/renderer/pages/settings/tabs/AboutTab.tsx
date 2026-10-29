import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../../state/appStore';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { productLinks } from '../../../utils/productLinks';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { brandLockupWordmarkUrl, brandMarkRingUrl } from '../../../utils/brandAssets';
import { UiSlot } from '../../../modules/shell/uiSlots';
import potLump from '../../../media/clay/upd-lump.webp';
import potRaw from '../../../media/clay/upd-raw.webp';
import potGlazed from '../../../media/clay/upd-glazed.webp';
import potTag from '../../../media/clay/upd-tag.webp';

const AboutLink: React.FC<{
  icon: React.ReactNode;
  label: string;
  url: string;
  opName: string;
}> = ({ icon, label, url, opName }) => {
  const open = useCallback(() => {
    const p = window.neox?.openExternal?.(url);
    if (p && typeof p.catch === 'function') {
      p.catch((err: any) => {
        console.warn('[AboutTab] openExternal failed:', err);
        dispatchOpFailed({ op: opName, message: err?.message || String(err) });
      });
    }
  }, [url, opName]);
  return (
    <div
      className="about-link-item"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      {icon}
      <span>{label}</span>
      <Icons.ExternalLink />
    </div>
  );
};

/** 底部那一行纯文字外链 —— 键盘可达 (真 button), 打不开时照旧走 dispatchOpFailed。 */
const AboutTextLink: React.FC<{ label: string; url: string }> = ({ label, url }) => (
  <button
    type="button"
    className="about-links__item"
    onClick={() => {
      const p = window.neox?.openExternal?.(url);
      if (p && typeof p.catch === 'function') {
        p.catch((err: any) => dispatchOpFailed({ op: label, message: err?.message || String(err) }));
      }
    }}
  >{label}</button>
);

type UpdateState = 'idle' | 'checking' | 'installing' | 'paused' | 'ready' | 'has-update' | 'up-to-date' | 'error';

const fmtSize = (b: number): string =>
  b <= 0 ? '0 MB'
  : b < 1024 ? `${b} B`
  : b < 1048576 ? `${(b / 1024).toFixed(0)} KB`
  : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB`
  : `${(b / 1073741824).toFixed(2)} GB`;

const fmtEta = (seconds: number, zh: boolean): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return zh ? `剩 ${Math.ceil(seconds)} 秒` : `${Math.ceil(seconds)}s left`;
  const m = Math.ceil(seconds / 60);
  if (m < 60) return zh ? `剩 ${m} 分钟` : `${m} min left`;
  return zh ? `剩 ${Math.ceil(m / 60)} 小时` : `${Math.ceil(m / 60)}h left`;
};

const UpdateMark: React.FC<{ state: UpdateState; percent?: number }> = ({ state, percent = 0 }) => {
  const p = Math.max(0, Math.min(100, percent));
  const thrown = state === 'installing' || state === 'paused' || state === 'error';
  const fired = state === 'ready' || state === 'up-to-date';
  return (
  <span
    className={`nx-upd__stage nx-pot nx-upd__stage--${state}`}
    style={{ ['--p' as string]: `${p}%` }}
    aria-hidden
  >
    {fired ? (
      <img className="nx-pot__art" src={potGlazed} alt="" draggable={false} />
    ) : thrown ? (
      <>
        {/* 淡影 = 成品轮廓; 实体按进度从下往上显出来 */}
        <img className="nx-pot__art nx-pot__ghost" src={potRaw} alt="" draggable={false} />
        <img className="nx-pot__art nx-pot__fill" src={potRaw} alt="" draggable={false}
          style={{ clipPath: `inset(${Math.round(100 - (18 + p * 0.82))}% 0 0 0)` }} />
      </>
    ) : (
      <img className="nx-pot__art nx-pot__lump" src={potLump} alt="" draggable={false} />
    )}
    {/* 盘面一道光扫过 = 转盘在转 (检查中 / 拉坯中) */}
    {(state === 'checking' || state === 'installing') && <span className="nx-pot__spin" />}
    {state === 'installing' && (
      <svg className="nx-pot__arc" viewBox="0 0 100 40" preserveAspectRatio="none">
        <ellipse cx="50" cy="20" rx="46" ry="15" pathLength={100}
          strokeDasharray={`${p} 100`} />
      </svg>
    )}
    {state === 'has-update' && <img className="nx-pot__tag" src={potTag} alt="" draggable={false} />}
    {state === 'up-to-date' && (
      <span className="nx-upd__sparks">
        <i /><i /><i /><i />
      </span>
    )}
    {(state === 'has-update' || state === 'ready' || state === 'up-to-date' || state === 'error' || state === 'paused') && (
      <span className="nx-upd__badge">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {(state === 'has-update' || state === 'ready') && <path d="M10 4.5v10M6 10.5l4 4 4-4" />}
          {state === 'up-to-date' && <path d="M5 10.4l3.2 3.2L15 6.6" />}
          {state === 'error' && <><path d="M10 5v6.5" /><circle cx="10" cy="15" r="0.6" fill="currentColor" /></>}
          {state === 'paused' && <path d="M7.5 6v8M12.5 6v8" />}
        </svg>
      </span>
    )}
  </span>
  );
};

/**
 * UpdateCenter —— 无边框的更新区。
 *   左: 进度圆环插画 / 中: 标题 + 一行事实 (版本、体积、速度、剩余) / 右: 当前该做的动作。
 *   下载中和暂停时底下多一条细进度轨 —— 圆环给"感觉", 这条给"精确到哪了"。
 */
export const UpdateCenter: React.FC<{
  state: UpdateState;
  info: { currentVersion: string; latestVersion: string; error?: string; ready: boolean; releaseNotes?: string;
          progress?: { percent: number; transferred: number; total: number; speed: number } };
  appVersion?: string;
  language: string;
  canPause: boolean;
  onCheck: () => void;
  onInstall: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}> = ({ state, info, appVersion, language, canPause, onCheck, onInstall, onPause, onResume, onCancel }) => {
  const zh = language === 'zh';
  const pr = info.progress;
  const percent = pr?.percent ?? 0;
  const downloading = state === 'installing';
  const paused = state === 'paused';

  const title =
    state === 'checking' ? (zh ? '正在检查更新' : 'Checking for updates')
    : downloading ? (percent >= 100 ? (zh ? '正在安装' : 'Installing') : (zh ? '正在下载更新' : 'Downloading update'))
    : paused ? (zh ? '下载已暂停' : 'Download paused')
    : state === 'ready' ? (zh ? '更新已就绪' : 'Update ready')
    : state === 'has-update' ? (zh ? '有新版本' : 'New version available')
    : state === 'up-to-date' ? (zh ? '已是最新版本' : "You're up to date")
    : state === 'error' ? (zh ? '更新失败' : 'Update failed')
    : (zh ? '检查更新' : 'Check for updates');

  const liveRef = useRef<{ at: number; text: string; ema: number }>({ at: 0, text: '', ema: 0 });
  const liveSub = (() => {
    if (!(downloading || paused)) return '';
    const now = Date.now();
    const cur = liveRef.current;
    if (pr && pr.speed > 0) cur.ema = cur.ema > 0 ? cur.ema * 0.7 + pr.speed * 0.3 : pr.speed;
    const stale = now - cur.at >= 1000 || !cur.text || paused || (pr?.percent ?? 0) >= 100;
    if (!stale) return cur.text;
    const size = pr && pr.total > 0 ? `${fmtSize(pr.transferred)} / ${fmtSize(pr.total)}` : '';
    const speed = downloading && cur.ema > 0 ? `${fmtSize(cur.ema)}/s` : '';
    const eta = downloading && cur.ema > 0 && pr && pr.total > 0
      ? fmtEta((pr.total - pr.transferred) / cur.ema, zh) : '';
    const resumeHint = paused ? (zh ? '已下载的部分会保留，继续时接着下' : 'Downloaded part is kept — resume continues from here') : '';
    cur.at = now;
    cur.text = [size, speed, eta, resumeHint].filter(Boolean).join(' · ');
    return cur.text;
  })();

  /* 副标题只放**事实**, 不放废话。下载态给体积/速度/剩余时间, 其余给版本号。 */
  const sub = (() => {
    if (state === 'error') return info.error || '';
    if (downloading || paused) return liveSub;
    if (state === 'has-update' || state === 'ready') {
      return `${info.currentVersion || appVersion || ''} → ${info.latestVersion}`;
    }
    if (state === 'up-to-date') return appVersion ? `v${appVersion}` : '';
    if (state === 'checking') return zh ? '正在向发布源确认…' : 'Asking the release feed…';
    return zh ? '看看有没有可以升级的版本' : 'See if a newer version is available';
  })();

  return (
    <section className={`nx-upd nx-upd--${state}`}>
      <UpdateMark state={state} percent={percent} />

      <div className="nx-upd__text">
        <div className="nx-upd__title">{title}</div>
        {/* 下载态不 key 到文字上: key 一变就重挂+淡入, 200ms 一次就是频闪 */}
        {sub && (downloading || paused)
          ? <div className="nx-upd__sub nx-upd__sub--live">{sub}</div>
          : sub && <div className="nx-upd__sub" key={sub}>{sub}</div>}
        {(downloading || paused) && (
          <div className="nx-upd__trackrow">
            <div className="nx-upd__track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="nx-upd__track-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="nx-upd__pct">{percent}%</span>
          </div>
        )}
        {/* 下完会弹「重启安装」(UpdateReadyHost); 暂停续传只有 mac 自研 updater 有 */}
        {(downloading || paused) && (
          <div className="nx-upd__note">
            {canPause
              ? (zh ? '下完会提示你重启，暂停后已下载的部分会保留' : 'You’ll be asked to restart when it’s done; pausing keeps what’s downloaded')
              : (zh ? '下完会提示你重启' : 'You’ll be asked to restart when it’s done')}
          </div>
        )}
      </div>

      <div className="nx-upd__acts">
        {(downloading || paused) && canPause && (
          <button
            type="button"
            className="nx-upd__icon-btn"
            onClick={paused ? onResume : onPause}
            title={paused ? (zh ? '继续下载' : 'Resume') : (zh ? '暂停下载' : 'Pause')}
            aria-label={paused ? (zh ? '继续下载' : 'Resume') : (zh ? '暂停下载' : 'Pause')}
          >
            {paused
              ? <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5 19 12 8 18.5Z" /></svg>
              : <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="7" y="5" width="3.4" height="14" rx="1.2" /><rect x="13.6" y="5" width="3.4" height="14" rx="1.2" /></svg>}
          </button>
        )}
        {(downloading || paused) && (
          <button
            type="button"
            className="nx-upd__icon-btn"
            onClick={onCancel}
            title={zh ? '取消下载 (删掉已下载的部分)' : 'Cancel (discards what was downloaded)'}
            aria-label={zh ? '取消下载' : 'Cancel download'}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        )}
        {(state === 'has-update' || state === 'ready') && (
          <button type="button" className="nx-upd__cta" onClick={onInstall}>
            {info.ready ? (zh ? '重启安装' : 'Restart to install') : (zh ? '立即升级' : 'Update now')}
          </button>
        )}
        {(state === 'idle' || state === 'up-to-date' || state === 'error') && (
          <button type="button" className="nx-upd__ghost" onClick={onCheck}>
            {state === 'error' ? (zh ? '重试' : 'Retry') : (zh ? '检查更新' : 'Check')}
          </button>
        )}
      </div>
    </section>
  );
};

/**
 * AboutTab - renders about / version info, update check, links, and developer options.
 */
const AboutTab: React.FC = () => {
  const { t, language } = useI18n();
  const { darkMode } = useAppStore();

  // ── App info ──
  const [appInfo, setAppInfo] = useState<any>(null);
  const [cliDebugEnabled, setCliDebugEnabled] = useState(false);
  useEffect(() => {
    (async () => {
      try { setCliDebugEnabled(await window.neox.getCliDebugPreference()); }
      catch (err) { console.error('Failed to load CLI debug preference:', err); }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const info = await window.neox.getAppInfo();
        setAppInfo(info);
      } catch (error) {
        console.error('Failed to load app info:', error);
      }
    })();
  }, []);

  // ── Update state ──
  const [updateInfo, setUpdateInfo] = useState<{
    checking: boolean;
    installing: boolean;
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    /** 用户按了暂停 —— 半成品还在盘上, 「继续」能接着下 (断点续传) */
    paused?: boolean;
    /** 后台预下载已完成 — 一步到「重启安装」, 不需要再下载 */
    ready: boolean;
    message: string;
    error?: string;
    progress?: { percent: number; transferred: number; total: number; speed: number };
    downloadUrl?: string;
    /** 官网更新日志里这个版本的正文 (双语, `<!--zh-->` 分段) —— 主进程检查更新时顺手取的 */
    releaseNotes?: string;
  }>({ checking: false, installing: false, currentVersion: '', latestVersion: '', hasUpdate: false, ready: false, message: '' });

  /* 开页即问主进程"有没有已预下载就绪的更新" —— 后台自动更新下好的包不该逼用户再点一次
   * 检测才现身, 有就直接呈现「重启安装」。 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const staged = await window.neox.updateStagedStatus?.();
        if (!cancelled && staged?.ready) {
          setUpdateInfo(prev => (prev.checking || prev.installing) ? prev : {
            ...prev,
            hasUpdate: true,
            ready: true,
            latestVersion: staged.version || prev.latestVersion,
            releaseNotes: typeof (staged as { releaseNotes?: string }).releaseNotes === 'string' ? (staged as { releaseNotes?: string }).releaseNotes : prev.releaseNotes,
            message: language === 'zh' ? `新版本 ${staged.version || ''} 已下载就绪` : `Version ${staged.version || ''} is downloaded and ready`,
          });
        }
      } catch { /* 查询失败 = 当作没有就绪包, 走正常检测流程 */ }
    })();
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    if (typeof window.neox?.onUpdateProgress !== 'function') return undefined;
    return window.neox.onUpdateProgress((progress: any) => {
      setUpdateInfo(prev => {
        /* 暂停这一拍只更新数字, 不要把界面从"已暂停"拽回"下载中" */
        if (progress?.paused) {
          return { ...prev, paused: true, installing: false };
        }
        const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
        const transferred = Math.max(0, Number(progress.transferred) || 0);
        const total = Math.max(0, Number(progress.total) || 0);
        const speed = Math.max(0, Number(progress.speed) || 0);
        const formatSize = (bytes: number) => bytes < 1024 ? `${bytes}B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)}KB` : `${(bytes/1048576).toFixed(1)}MB`;
        const sizePart = total > 0 ? ` · ${formatSize(transferred)} / ${formatSize(total)}` : '';
        const speedPart = speed > 0 ? ` · ${formatSize(speed)}/s` : '';
        return {
          ...prev,
          hasUpdate: true,
          paused: false,
          installing: true,
          progress: { percent, transferred, total, speed },
          message: language === 'zh' ? `正在下载更新 ${percent}%${sizePart}${speedPart}` : `Downloading update ${percent}%${sizePart}${speedPart}`,
        };
      });
    });
  }, [language]);

  useEffect(() => {
    const bridge = window.neox as unknown as { onUpdateReady?: (cb: (p: { version?: string }) => void) => () => void };
    if (typeof bridge?.onUpdateReady !== 'function') return undefined;
    return bridge.onUpdateReady((p) => {
      setUpdateInfo(prev => ({
        ...prev,
        hasUpdate: true,
        ready: true,
        installing: false,
        paused: false,
        progress: undefined,
        latestVersion: p?.version || prev.latestVersion,
        message: language === 'zh' ? `新版本 ${p?.version || ''} 已下载就绪` : `Version ${p?.version || ''} is downloaded and ready`,
      }));
    });
  }, [language]);

  // ── Check update ──
  const handleCheckUpdate = useCallback(async () => {
    setUpdateInfo(prev => ({ ...prev, checking: true, message: '', error: undefined, progress: undefined }));
    try {
      const result = await window.neox.updateCheck?.();
      if (result) {
        /* 手动检测也要认后台预下载的包 — 就绪且版本对得上, 直接给「重启安装」而不是再下一遍 */
        const staged = await window.neox.updateStagedStatus?.().catch(() => null);
        const ready = !!(result.hasUpdate && staged?.ready && staged.version === result.latestVersion);
        setUpdateInfo(prev => ({
          ...prev, checking: false, currentVersion: result.currentVersion, latestVersion: result.latestVersion,
          hasUpdate: result.hasUpdate, ready, downloadUrl: result.downloadUrl || undefined,
          releaseNotes: typeof result.releaseNotes === 'string' ? result.releaseNotes : prev.releaseNotes,
          message: result.hasUpdate
            ? (ready
              ? (language === 'zh' ? `新版本 ${result.latestVersion} 已下载就绪` : `Version ${result.latestVersion} is downloaded and ready`)
              : (language === 'zh' ? `发现新版本: ${result.latestVersion}` : `New version available: ${result.latestVersion}`))
            : (language === 'zh' ? '已是最新版本' : 'Already up to date'),
          error: result.error,
        }));
      }
    } catch (e) {
      setUpdateInfo(prev => ({ ...prev, checking: false, message: language === 'zh' ? '检查失败' : 'Check failed', error: String(e) }));
    }
  }, [language]);

  // ── Install update ──
  const handleInstallUpdate = useCallback(async () => {
    /* 已预下载就绪 → 一步重启安装, 不再走下载。update:install 不带 filePath 时
     * 主进程自己解析暂存包 (mac getStagedMacUpdate / win electronUpdaterReadyToInstall)。 */
    if (updateInfo.ready) {
      setUpdateInfo(prev => ({ ...prev, installing: true, progress: undefined, message: language === 'zh' ? '正在重启安装...' : 'Restarting to install...', error: undefined }));
      try {
        const result = await window.neox.updateInstall?.();
        if (result && !result.success) {
          /* 暂存包失踪 (被清理/重启过) — 摘掉就绪态, 退回正常「立即升级」下载流程 */
          setUpdateInfo(prev => ({ ...prev, installing: false, ready: false, message: result.message || (language === 'zh' ? '安装失败' : 'Install failed'), error: result.error }));
        }
      } catch (e) {
        setUpdateInfo(prev => ({ ...prev, installing: false, ready: false, message: language === 'zh' ? '安装失败' : 'Install failed', error: String(e) }));
      }
      return;
    }
    setUpdateInfo(prev => ({ ...prev, installing: true, progress: undefined, message: language === 'zh' ? '正在下载更新...' : 'Downloading update...', error: undefined }));
    try {
      let filePath: string | undefined;
      const url = updateInfo.downloadUrl;
      if (typeof window.neox?.updateDownload === 'function') {
        const dl = await window.neox.updateDownload(url || '');
        if (dl?.success && dl?.filePath) {
          filePath = dl.filePath;
          setUpdateInfo(prev => ({ ...prev, progress: prev.progress ? { ...prev.progress, percent: 100 } : prev.progress, message: language === 'zh' ? '下载完成, 正在重启安装...' : 'Download complete, restarting to install...' }));
        } else if (dl?.paused) {
          /* 用户按了暂停 —— 保持暂停态, 半成品留着等「继续」 */
          setUpdateInfo(prev => ({ ...prev, installing: false, paused: true }));
          return;
        } else {
          const err = dl?.error || (language === 'zh' ? '更新下载失败' : 'Update download failed');
          setUpdateInfo(prev => ({ ...prev, installing: false, progress: undefined, message: language === 'zh' ? '更新下载失败' : 'Update download failed', error: err }));
          return;
        }
      } else {
        setUpdateInfo(prev => ({ ...prev, installing: false, progress: undefined, message: language === 'zh' ? '更新服务不可用' : 'Update service unavailable', error: language === 'zh' ? '当前版本缺少更新下载接口' : 'The update download API is unavailable' }));
        return;
      }
      const result = await window.neox.updateInstall?.(filePath);
      if (result) {
        setUpdateInfo(prev => ({ ...prev, installing: false, hasUpdate: !result.success, progress: undefined, message: result.message || (result.success ? (language === 'zh' ? '更新完成' : 'Update complete') : (language === 'zh' ? '更新失败' : 'Update failed')), error: result.error }));
      }
    } catch (e) {
      setUpdateInfo(prev => ({ ...prev, installing: false, progress: undefined, message: language === 'zh' ? '安装失败' : 'Install failed', error: String(e) }));
    }
  }, [language, updateInfo.downloadUrl, updateInfo.ready]);

  const [pauseSupported, setPauseSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.neox.updateDownloadControl?.('state');
        if (cancelled || !r?.supported) return;
        setPauseSupported(true);
        const st = r.state;
        /* 开页时**正在下** —— 进度事件要 200ms 才来下一拍, 而且刚进页面时可能刚好
         * 落在两拍之间。直接用这一份快照把界面摆到下载态, 别让用户先看半秒的"检查更新"。 */
        if (st && st.active) {
          setUpdateInfo(prev => ({
            ...prev,
            hasUpdate: true,
            installing: true,
            paused: false,
            latestVersion: st.version || prev.latestVersion,
            progress: {
              percent: st.total > 0 ? Math.round((st.transferred / st.total) * 100) : 0,
              transferred: st.transferred, total: st.total, speed: 0,
            },
          }));
          return;
        }
        if (st && st.transferred > 0 && !st.active) {
          setUpdateInfo(prev => prev.installing ? prev : {
            ...prev,
            hasUpdate: true,
            paused: true,
            latestVersion: st.version || prev.latestVersion,
            progress: {
              percent: st.total > 0 ? Math.round((st.transferred / st.total) * 100) : 0,
              transferred: st.transferred, total: st.total, speed: 0,
            },
            message: '',
          });
        }
      } catch { /* 拿不到就当不支持 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handlePause = useCallback(async () => {
    /* 先把界面切到暂停 —— 主进程 abort 到 fetch 真正断开有几百毫秒,
       这期间进度还会再推一两拍, 不先切用户会觉得"点了没反应"。 */
    setUpdateInfo(prev => ({ ...prev, paused: true, installing: false }));
    try { await window.neox.updateDownloadControl?.('pause'); } catch { /* ignore */ }
  }, []);

  const handleResume = useCallback(async () => {
    setUpdateInfo(prev => ({ ...prev, paused: false, installing: true, error: undefined }));
    try {
      const r = await window.neox.updateDownloadControl?.('resume');
      if (r?.done) {
        const result = await window.neox.updateInstall?.(r.filePath);
        setUpdateInfo(prev => ({ ...prev, installing: false, message: result?.message || '', error: result?.error }));
        return;
      }
      if (r?.paused) { setUpdateInfo(prev => ({ ...prev, installing: false, paused: true })); return; }
      if (r && r.ok === false) {
        setUpdateInfo(prev => ({ ...prev, installing: false, paused: false, error: r.error }));
      }
    } catch (e) {
      setUpdateInfo(prev => ({ ...prev, installing: false, error: String(e) }));
    }
  }, []);

  const handleCancelDownload = useCallback(async () => {
    try { await window.neox.updateDownloadControl?.('cancel'); } catch { /* ignore */ }
    setUpdateInfo(prev => ({ ...prev, installing: false, paused: false, progress: undefined, message: '' }));
  }, []);

  // ── Dev mode ──
  const DEV_MODE_KEY = 'neox-dev-mode';
  const [devMode, setDevMode] = useState<boolean>(() => { try { return localStorage.getItem(DEV_MODE_KEY) === '1'; } catch { return false; } });
  const [uiDebugEnabled, setUiDebugEnabled] = useState<boolean>(() => { try { return localStorage.getItem('neox-ui-debug') === '1'; } catch { return false; } });
  const versionClickCountRef = useRef(0);
  const versionClickResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleDevMode = useCallback((next?: boolean) => {
    const target = next ?? !devMode;
    setDevMode(target);
    try { if (target) localStorage.setItem(DEV_MODE_KEY, '1'); else localStorage.removeItem(DEV_MODE_KEY); } catch {}
    dispatchHint(target ? (language === 'zh' ? '开发者模式已开启' : 'Developer mode enabled') : (language === 'zh' ? '开发者模式已关闭' : 'Developer mode disabled'), target ? 'success' : 'info');
  }, [devMode, language]);

  const handleVersionTap = useCallback(() => {
    versionClickCountRef.current += 1;
    if (versionClickResetTimerRef.current) clearTimeout(versionClickResetTimerRef.current);
    versionClickResetTimerRef.current = setTimeout(() => { versionClickCountRef.current = 0; }, 2000);
    if (!devMode && versionClickCountRef.current >= 4 && versionClickCountRef.current < 7) {
      const left = 7 - versionClickCountRef.current;
      dispatchHint(language === 'zh' ? `再点 ${left} 次开启开发者模式` : `${left} more taps to enable developer mode`, 'info');
    }
    if (versionClickCountRef.current >= 7) { versionClickCountRef.current = 0; toggleDevMode(true); }
  }, [devMode, language, toggleDevMode]);

  // ── Keyboard shortcut: Cmd+Shift+Alt+D ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); toggleDevMode(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleDevMode]);

  // ── Render ──
  const aboutWordmarkUrl = brandLockupWordmarkUrl(darkMode === 'light' ? 'light' : 'dark');
  /* 版本行说人话: darwin / arm64 这种是 node 的叫法 */
  const osLabel = (p?: string) => p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : (p ?? '');
  const archLabel = (p?: string, a?: string) =>
    a === 'arm64' ? (p === 'darwin' ? 'Apple Silicon' : 'ARM64') : a === 'x64' ? (p === 'darwin' ? 'Intel' : 'x64') : (a ?? '');
  const updateState: UpdateState =
    updateInfo.error ? 'error'
    : updateInfo.installing ? 'installing'
    : updateInfo.paused ? 'paused'
    : updateInfo.checking ? 'checking'
    : updateInfo.ready ? 'ready'
    : updateInfo.hasUpdate ? 'has-update'
    : updateInfo.message ? 'up-to-date'
    : 'idle';

  return (
    <div className="settings-panel-content about-panel">
      <div className="settings-list">
        {/* Hero -- centered logo + tappable version (7-tap enables devMode). */}
        <div className="about-hero about-hero--centered about-id">
          <img src={brandMarkRingUrl()} alt="" aria-hidden="true" className="about-id__mark" draggable={false} />
          <div className="about-id__text">
            <img src={aboutWordmarkUrl} alt="Neox" className="about-id__word" draggable={false} />
            {appInfo && (
              <button
                type="button"
                className="about-hero-version about-hero-version--tap about-id__ver"
                onClick={handleVersionTap}
                title={language === 'zh' ? '点击查看版本信息' : 'Click for version info'}
                aria-label="version"
              >
                <span className="about-ver-num">{appInfo.version}</span>
                <span className="about-id__sys">{osLabel(appInfo.platform)}{appInfo.arch ? ` · ${archLabel(appInfo.platform, appInfo.arch)}` : ''}</span>
                {devMode && <span className="about-ver-devbadge" aria-label="developer mode">DEV</span>}
              </button>
            )}
          </div>
        </div>

        <UpdateCenter
          state={updateState}
          info={updateInfo}
          appVersion={appInfo?.version}
          language={language}
          canPause={pauseSupported}
          onCheck={handleCheckUpdate}
          onInstall={handleInstallUpdate}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={handleCancelDownload}
        />

        {/* Developer panel -- hidden by default, 7-tap version or Cmd+Shift+Alt+D to enable. */}
        {devMode && (
          <div className="about-devpanel">
            <div className="about-devpanel__head">
              <span className="about-devpanel__badge">DEV</span>
              <span className="about-devpanel__title">{language === 'zh' ? '开发者选项' : 'Developer Options'}</span>
              <button
                type="button"
                className="about-devpanel__close"
                onClick={() => toggleDevMode(false)}
                title={language === 'zh' ? '关闭开发者模式' : 'Disable developer mode'}
                aria-label="close"
              >&times;</button>
            </div>
            <div className="about-devpanel__row" id="setting-cli-debug">
              <div className="about-devpanel__info">
                <span className="about-devpanel__label">{language === 'zh' ? 'CLI 调试日志' : 'CLI Debug Logs'}</span>
                <span className="about-devpanel__hint">
                  {language === 'zh'
                    ? '把 Agent 后台进程的详细日志写进 ~/.neox/logs。子进程那部分要重启才跟上。'
                    : 'Writes verbose agent-process logs to ~/.neox/logs. The child process picks it up after a restart.'}
                </span>
              </div>
              <div className="language-toggle">
                {([false, true] as const).map((v) => (
                  <button
                    key={String(v)}
                    className={`toggle-btn ${cliDebugEnabled === v ? 'active' : ''}`}
                    onClick={async () => {
                      try { await window.neox.setCliDebugPreference(v); setCliDebugEnabled(v); }
                      catch (err) { console.error('Failed to update CLI debug preference:', err); }
                    }}
                  >{v ? t.common.on : t.common.off}</button>
                ))}
              </div>
            </div>
            <div className="about-devpanel__row">
              <div className="about-devpanel__info">
                <span className="about-devpanel__label">{language === 'zh' ? '诊断日志' : 'Diagnostic Logs'}</span>
                <span className="about-devpanel__hint">
                  {language === 'zh'
                    ? '排障时打开, 协助技术支持快速定位. 重启后生效.'
                    : 'Enable for troubleshooting. Restart to take effect.'}
                </span>
              </div>
              <div className="language-toggle">
                <button
                  className={`toggle-btn ${!uiDebugEnabled ? 'active' : ''}`}
                  onClick={() => {
                    try { localStorage.removeItem('neox-ui-debug'); } catch { /* ignore */ }
                    setUiDebugEnabled(false);
                  }}
                >{t.common.off}</button>
                <button
                  className={`toggle-btn ${uiDebugEnabled ? 'active' : ''}`}
                  onClick={() => {
                    try { localStorage.setItem('neox-ui-debug', '1'); } catch { /* ignore */ }
                    setUiDebugEnabled(true);
                  }}
                >{t.common.on}</button>
              </div>
            </div>
          </div>
        )}


        <UiSlot name="settings.about.sections" props={{
          zh: language === 'zh',
          allUrl: productLinks.changelog,
          platform: appInfo?.platform === 'win32'
            ? 'win'
            : appInfo?.platform === 'darwin'
              ? 'mac'
              : (appInfo?.platform ?? ''),
        }} />

        <nav className="about-links" aria-label={language === 'zh' ? '相关链接' : 'Links'}>
          {([
            [language === 'zh' ? '官网' : 'Website', productLinks.website],
            [language === 'zh' ? '文档' : 'Docs', productLinks.docs],
            [language === 'zh' ? '更新日志' : 'Changelog', productLinks.changelog],
            [language === 'zh' ? '反馈' : 'Feedback', productLinks.feedback],
            [language === 'zh' ? '隐私政策' : 'Privacy', productLinks.privacy],
            [language === 'zh' ? '服务条款' : 'Terms', productLinks.terms],
          ] as Array<[string, string]>).map(([label, url]) => (
            <AboutTextLink key={url} label={label} url={url} />
          ))}
        </nav>

        {/* 年份取当前年 — 写死的 2025 到了 2026 就是过期信息 */}
        <div className="about-footer">&copy; {new Date().getFullYear()} Neox. All rights reserved.</div>
      </div>
    </div>
  );
};

export default AboutTab;
