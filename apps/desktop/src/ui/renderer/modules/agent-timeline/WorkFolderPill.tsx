import React, { useEffect, useState } from 'react';
import './work-folder.css';
import { dispatchHint } from '../../components/notifyEvents';

function splitDir(dir: string): { parent: string; name: string } {
  const segs = dir.split(/[\\/]/).filter(Boolean);
  return { parent: segs[segs.length - 2] ?? '', name: segs[segs.length - 1] ?? dir };
}

export const WorkFolderPill: React.FC<{ dir: string; running: boolean; zh: boolean }> = ({ dir, running, zh }) => {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (running) return;
    let alive = true;
    const api = (window as { neox?: { listFiles?: (p: string) => Promise<{ success?: boolean; files?: Array<{ isFile?: boolean }> }> } }).neox;
    void api?.listFiles?.(dir).then((r) => {
      if (alive && r?.success) setCount((r.files ?? []).filter((f) => f.isFile).length);
    }).catch(() => { /* 数不出来就不显示个数 */ });
    return () => { alive = false; };
  }, [dir, running]);

  const { parent, name } = splitDir(dir);
  const open = () => {
    const api = (window as { neox?: { surfaceOpenExternal?: (p: string) => Promise<unknown> } }).neox;
    void api?.surfaceOpenExternal?.(dir).then((r: any) => {
      if (r?.success === false) {
        /* 带上系统给的原因 —— 只说「打开失败」等于不告诉用户/我们到底哪一步坏了 */
        dispatchHint(`${zh ? '打开文件夹失败' : 'Couldn’t open the folder'}${r.error ? `：${r.error}` : ''}`, 'warning');
      }
    }).catch((e: any) => dispatchHint(`${zh ? '打开文件夹失败' : 'Couldn’t open the folder'}：${e?.message || e}`, 'warning'));
  };
  return (
    <div className="nx-wf" role="group" aria-label={zh ? '任务文件夹' : 'Task folder'}>
      <div className="nx-wf__pill" title={dir}>
        <svg className="nx-wf__icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
          <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z" />
        </svg>
        {parent && <span className="nx-wf__parent">{parent} /</span>}
        <span className="nx-wf__name">{name}</span>
        {count !== null && count > 0 && (
          <span className="nx-wf__count">· {zh ? `${count} 个文件` : `${count} file${count === 1 ? '' : 's'}`}</span>
        )}
        <button type="button" className="nx-wf__open" onClick={open}>
          {zh ? '打开文件夹' : 'Open folder'}
        </button>
      </div>
    </div>
  );
};

export default WorkFolderPill;
