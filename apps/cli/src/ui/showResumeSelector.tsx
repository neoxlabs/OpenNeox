import React from 'react';
import { render } from '../../vendor/ink/src/index.js';
import { getResumeSessions } from '@neoxlabs/core/memory/resumeSessions.js';
import { ResumeSelector } from '../ink/components/ResumeSelector.js';

export async function showResumeSelector(): Promise<string | null> {
  // 非交互终端没法跑富选择器 → 当作新建
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  let sessions;
  try {
    sessions = await getResumeSessions(50);
  } catch {
    return null;
  }
  if (!sessions || sessions.length === 0) return null;

  return await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try { instance.unmount(); } catch { /* noop */ }
      resolve(value);
    };

    const instance = render(
      <ResumeSelector
        sessions={sessions}
        onResume={(id) => finish(id)}
        onNew={() => finish(null)}
      />,
      { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false },
    );

    instance.waitUntilExit().then(() => finish(null)).catch(() => finish(null));
  });
}
