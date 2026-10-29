import React, { useEffect, useMemo, useState } from 'react';
import { copyToClipboard } from '../../../utils/copyToClipboard';
import { useI18n } from '../../../hooks/useI18n';
import type { ProcessRow, ServiceConfig } from './ServicesSurfaceViewer';

/* ──────────────────────────────────────────────────────────────────────
 * EnvPane — env 变量管理: 默认 mask 敏感 / 搜索 / 单项复制 / 一键 .env 复制
 *
 *   敏感 key 启发判定 — 大小写不敏感: 含 token/secret/password/key/cred/api 等.
 *   mask 模式下 value 显示成 ••••, 点眼睛 icon 临时展示. 不持久化展示状态,
 *   切到别的 tab 再回来重新 mask, 防意外泄露.
 *
 *   搜索: 实时 filter key/value 子串匹配. 100+ 个变量场景下能秒定位.
 * ────────────────────────────────────────────────────────────────────── */
const SENSITIVE_KEY_PATTERN = /(token|secret|passwd|password|pwd|key|cred|auth|api[_-]?key|access[_-]?key)/i;

export const EnvPane: React.FC<{
  env?: Record<string, string>;
  /** 空状态点 "立即添加" 时跳到编辑表单 */
  onEditConfig?: () => void;
}> = ({ env, onEditConfig }) => {
  const { isZh } = useI18n();
  const { language } = useI18n();
  const zh = language === 'zh';
  const entries = useMemo(() => env ? Object.entries(env) : [], [env]);
  const [search, setSearch] = useState('');
  /* per-key 展示状态: Set 里的 key 是"已被点击展开"的, 没在 set 里且是敏感 key 则 mask. */
  const [unmasked, setUnmasked] = useState<Set<string>>(() => new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /* 切 service 时清空展开状态, 避免敏感值跨上下文泄露. env reference 变就重置. */
  useEffect(() => { setUnmasked(new Set()); }, [env]);

  if (entries.length === 0) {
    return (
      <div className="sfc-services__pane-empty">
        <div className="sfc-services__pane-empty-title">{isZh ? '未配置环境变量' : 'No environment variables'}</div>
        <div className="sfc-services__pane-empty-sub">
          为该服务声明 <code>KEY=VAL</code> 环境变量, 启动时会作为 spawn env 注入子进程.
          适合放 <code>SPRING_PROFILES_ACTIVE</code> / <code>NODE_ENV</code> / API token 等启动期需要的配置.
        </div>
        {onEditConfig && (
          <button
            className="sfc-svc-btn sfc-svc-btn--primary sfc-services__pane-empty-cta"
            onClick={onEditConfig}
          >+ {isZh ? '在编辑表单中添加' : 'Add in the edit form'}</button>
        )}
      </div>
    );
  }
  const filtered = search.trim()
    ? entries.filter(([k, v]) => {
        const q = search.toLowerCase();
        return k.toLowerCase().includes(q) || v.toLowerCase().includes(q);
      })
    : entries;
  const sensitiveCount = entries.filter(([k]) => SENSITIVE_KEY_PATTERN.test(k)).length;

  const toggleUnmask = (k: string) => {
    setUnmasked(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const copyOne = async (k: string, v: string) => {
    try {
      await copyToClipboard(`${k}=${v}`);
      setCopiedKey(k);
      setTimeout(() => setCopiedKey(prev => prev === k ? null : prev), 1200);
    } catch { /* 剪贴板权限缺失时静默 */ }
  };
  const copyAll = () => {
    const text = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    void copyToClipboard(text);
    setCopiedKey('__all__');
    setTimeout(() => setCopiedKey(prev => prev === '__all__' ? null : prev), 1200);
  };
  const revealAll = () => setUnmasked(new Set(entries.map(([k]) => k)));
  const maskAll = () => setUnmasked(new Set());

  return (
    <div className="sfc-services__pane sfc-services__pane--env">
      <div className="sfc-services__pane-bar">
        <input
          className="sfc-services__pane-search"
          type="search"
          placeholder={isZh ? `搜索 ${entries.length} 个变量` : `Search ${entries.length} variables`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {sensitiveCount > 0 && (
          unmasked.size === entries.length ? (
            <button className="sfc-svc-btn sfc-svc-btn--small" onClick={maskAll} title={isZh ? `隐藏全部 (含 ${sensitiveCount} 个敏感)` : `Hide all (${sensitiveCount} sensitive)`}>👁 {isZh ? '全部隐藏' : 'Hide all'}</button>
          ) : (
            <button className="sfc-svc-btn sfc-svc-btn--small" onClick={revealAll} title={isZh ? `显示全部值 (含 ${sensitiveCount} 个敏感)` : `Reveal all (${sensitiveCount} sensitive)`}>👁 {isZh ? '全部显示' : 'Reveal all'}</button>
          )
        )}
        <button className="sfc-svc-btn sfc-svc-btn--small" onClick={copyAll}>
          {copiedKey === '__all__' ? (isZh ? '✓ 已复制' : '✓ Copied') : (isZh ? '复制 .env' : 'Copy .env')}
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="sfc-services__pane-empty">{zh ? `没有匹配"${search}"的变量` : `No variable matches "${search}"`}</div>
      ) : (
        <div className="sfc-services__env-list">
          {filtered.map(([k, v]) => {
            const isSensitive = SENSITIVE_KEY_PATTERN.test(k);
            const isUnmasked = unmasked.has(k);
            const showValue = !isSensitive || isUnmasked;
            return (
              <div key={k} className="sfc-services__env-row">
                <code className="sfc-services__env-key">{k}</code>
                <code className={`sfc-services__env-val${isSensitive && !isUnmasked ? ' is-masked' : ''}`}>
                  {showValue ? (v || <span className="sfc-services__env-empty">{isZh ? '(空)' : '(empty)'}</span>) : '•'.repeat(Math.min(20, v.length || 8))}
                </code>
                <div className="sfc-services__env-actions">
                  {isSensitive && (
                    <button
                      className="sfc-services__env-iconbtn"
                      onClick={() => toggleUnmask(k)}
                      title={isUnmasked ? (isZh ? '隐藏' : 'Hide') : (isZh ? '显示' : 'Reveal')}
                      aria-label={isUnmasked ? (isZh ? '隐藏值' : 'Hide value') : (isZh ? '显示值' : 'Reveal value')}
                    >{isUnmasked ? '🙈' : '👁'}</button>
                  )}
                  <button
                    className="sfc-services__env-iconbtn"
                    onClick={() => copyOne(k, v)}
                    title={`复制 ${k}=...`}
                    aria-label={isZh ? '复制' : 'Copy'}
                  >{copiedKey === k ? '✓' : '⧉'}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * HealthPane — healthcheck 状态卡片
 *
 *   信息密度:
 *     ┌──────────────────────────────────────┐
 *     │  ● Healthy            12s ago        │  ← 显眼状态徽章 + 最近探测
 *     │                                       │
 *     │  HTTP    GET /healthz                 │  ← 探测方式与目标
 *     │  Port    8080                         │
 *     │  Timeout 2000ms (默认 2s)            │
 *     └──────────────────────────────────────┘
 *
 *   未配置: 给一个可操作的引导 (不是干巴巴"未配置"), 提示用户去编辑表单加. */
export const HealthPane: React.FC<{
  config?: ServiceConfig;
  proc?: ProcessRow;
  /** 空状态点 "立即添加" 时跳到编辑表单 */
  onEditConfig?: () => void;
}> = ({ config, proc, onEditConfig }) => {
  const { isZh } = useI18n();
  const hc = config?.healthcheck;
  if (!hc) {
    return (
      <div className="sfc-services__pane-empty">
        <div className="sfc-services__pane-empty-title">{isZh ? '未配置 health check' : 'No health check configured'}</div>
        <div className="sfc-services__pane-empty-sub">
          加 healthcheck 让 Neox 5s 周期探测服务真实可用性:<br />
          <code>http</code>{isZh ? ' (GET URL, 200-399 算通过) · ' : ' (GET the URL, 200-399 passes) · '}<code>port</code>{isZh ? ' (TCP 连接成功算通过) · ' : ' (a successful TCP connect passes) · '} <code>log_pattern</code> (stdout 命中正则一次即 latched).
        </div>
        {onEditConfig && (
          <button
            className="sfc-svc-btn sfc-svc-btn--primary sfc-services__pane-empty-cta"
            onClick={onEditConfig}
          >+ {isZh ? '在编辑表单中添加' : 'Add in the edit form'}</button>
        )}
      </div>
    );
  }

  /* 探测时间字段在 proc 上, proc?.health_checked_at 是 ms 时间戳. */
  const lastCheckSec = proc?.health_checked_at
    ? Math.max(0, Math.floor((Date.now() - proc.health_checked_at) / 1000))
    : null;
  const healthy = proc?.healthy;
  const statusLabel = healthy === true ? 'Healthy' : healthy === false ? 'Failing' : 'Pending';
  const statusClass = healthy === true ? 'sfc-services__hc-status--ok'
    : healthy === false ? 'sfc-services__hc-status--bad' : 'sfc-services__hc-status--pending';
  const kindLabel = ({ http: 'HTTP', port: 'TCP Port', log_pattern: '日志正则' } as const)[hc.kind] || hc.kind;
  /* 状态文案: 服务跑着才有意义讲探测情况; 没跑 / 没 pid 直接给提示. */
  const isRunning = proc?.status === 'running';
  const ctxHint = !proc
    ? '服务尚未启动, 启动后 5s 内开始首次探测.'
    : !isRunning
      ? '服务已退出, 不再探测.'
      : healthy === undefined
        ? '已启动, 等待首次探测结果…'
        : null;

  return (
    <div className="sfc-services__pane sfc-services__pane--health">
      <div className="sfc-services__hc-card">
        <div className="sfc-services__hc-status-row">
          <span className={`sfc-services__hc-status ${statusClass}`}>
            <span className="sfc-services__hc-status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <span className="sfc-services__hc-last-check">
            {lastCheckSec !== null ? `${lastCheckSec}s 前` : '尚未探测'}
          </span>
        </div>
        {ctxHint && <div className="sfc-services__hc-ctxhint">{ctxHint}</div>}
        <div className="sfc-services__hc-fields">
          <div className="sfc-services__hc-row">
            <label>{isZh ? '方式' : 'Type'}</label>
            <code>{kindLabel}</code>
          </div>
          <div className="sfc-services__hc-row">
            <label>{isZh ? '目标' : 'Target'}</label>
            <code className="sfc-services__hc-target">{hc.target}</code>
          </div>
          <div className="sfc-services__hc-row">
            <label>{isZh ? '超时' : 'Timeout'}</label>
            <code>{hc.timeoutMs !== undefined ? `${hc.timeoutMs}ms` : '默认 (2000ms)'}</code>
          </div>
          <div className="sfc-services__hc-row">
            <label>{isZh ? '周期' : 'Interval'}</label>
            <code>5s</code>
          </div>
        </div>
      </div>
      <div className="sfc-services__hc-help">
        <strong>{isZh ? '探测规则' : 'Probe rules'}</strong>
        <ul>
          <li><code>http</code>{isZh ? ': GET URL, 200-399 视为通过' : ': GET the URL, 200-399 counts as passing'}</li>
          <li><code>port</code>{isZh ? ': TCP connect 通过即 healthy' : ': a successful TCP connect means healthy'}</li>
          <li><code>log_pattern</code>{isZh ? ': stdout 匹配一次即 latched (不再轮询)' : ': one match on stdout latches it (no further polling)'}</li>
        </ul>
      </div>
    </div>
  );
};
