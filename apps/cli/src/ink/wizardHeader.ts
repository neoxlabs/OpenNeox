import { useEffect, useState } from 'react';

export interface WizardHeader {
  /** 向导名, e.g. "添加 Provider" */
  title: string;
  /** 当前步骤, e.g. "1/4 名称和地址" */
  step?: string;
  /** 补充的几行 (确认页的配置预览) */
  lines?: string[];
}

let current: WizardHeader | null = null;
const listeners = new Set<(h: WizardHeader | null) => void>();

export function setWizardHeader(h: WizardHeader | null): void {
  current = h;
  for (const fn of listeners) {
    try { fn(h); } catch { /* */ }
  }
}

export function useWizardHeader(): WizardHeader | null {
  const [h, setH] = useState<WizardHeader | null>(current);
  useEffect(() => {
    listeners.add(setH);
    setH(current);
    return () => { listeners.delete(setH); };
  }, []);
  return h;
}
