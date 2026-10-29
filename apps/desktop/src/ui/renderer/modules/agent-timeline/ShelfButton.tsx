/**
 * 首页右下角「成品架 N」(UI 3.0 设计稿) —— 点开成品架 (LibraryPage)。
 * N = 所有会话做出来、文件还在的成品数, 来自 library:session-outputs (主进程 30 秒缓存)。
 */
import React, { useEffect, useState } from 'react';

export const ShelfButton: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const api = window.neox as unknown as { librarySessionOutputs?: () => Promise<{ items?: unknown[] }> };
    /* 只是个角标数字 —— 晚几秒再要, 别跟启动抢主进程 (冷缓存要读 200 个会话的时间线) */
    const timer = window.setTimeout(() => {
      api.librarySessionOutputs?.()
        .then((r) => { if (alive) setCount(Array.isArray(r?.items) ? r.items.length : 0); })
        .catch(() => { /* 老主进程没有这个接口: 不显示数字 */ });
    }, 4000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);
  return (
    <button
      type="button"
      className="atl-shelf-btn"
      onClick={() => window.dispatchEvent(new CustomEvent('neox:open-shelf'))}
      title={isZh ? '成品架 — 所有任务做出来的东西' : 'Shelf — everything your tasks produced'}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="m8 2 6 3-6 3-6-3z" /><path d="m2 8 6 3 6-3M2 11l6 3 6-3" /></svg>
      <span>{isZh ? '成品架' : 'Shelf'}</span>
      {count !== null && count > 0 && <em>{count}</em>}
    </button>
  );
};

export default ShelfButton;
