/**
 * 洞察卡上那个按钮真去办 (今天页和各房间页共用):
 *   remind  → 在当前分身上挂一个到点响铃的提醒
 *   checkin → 让它把这个习惯今天打上卡
 *   ask     → 把话交给它, 然后去对话页看它怎么说
 * 办成的那条记在 done 里, 卡片就收起来。
 */
import { useCallback, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { boardApi } from '../board/boardKit';
import type { Insight, InsightAction } from './pilotData';

type Runtime = { sendPrompt?: (t: string, o?: { images?: Array<{ mediaType: string; data: string; name?: string }> }) => Promise<unknown> };

/** 'HH:mm' (已过就明天) → 毫秒 */
function atToMs(at: string): number {
  const [h, m] = at.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function useInsightRunner(sessionId: string | null, onGoChat: () => void) {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional() as Runtime | null;
  const [done, setDone] = useState<Record<string, boolean>>({});

  /** 直接把一句话交给它, 去对话页 (房间页底下「帮我理理财」这类) */
  const ask = useCallback(async (prompt: string) => {
    await runtime?.sendPrompt?.(prompt);
    onGoChat();
  }, [runtime, onGoChat]);

  const run = useCallback(async (i: Insight, a: InsightAction) => {
    try {
      if (a.kind === 'remind') {
        if (!sessionId) throw new Error(isZh ? '先建一个分身' : 'Create a Pilot first');
        const r = await boardApi().pilotAddReminder?.(sessionId, { title: a.title, at: atToMs(a.at), ring: true });
        if (r && !r.ok) throw new Error(r.error || 'failed');
        dispatchHint(isZh ? `好，${a.at} 叫你` : `OK, I'll remind you at ${a.at}`, 'success');
      } else if (a.kind === 'checkin') {
        await runtime?.sendPrompt?.(isZh ? `「${a.habit}」今天打卡` : `Check in "${a.habit}" for today`);
        dispatchHint(isZh ? '打好卡了' : 'Checked in', 'success');
      } else {
        await ask(a.prompt);
      }
      setDone((m) => ({ ...m, [i.id]: true }));
    } catch (e) {
      dispatchOpFailed({ op: a.label, message: (e as Error).message });
    }
  }, [sessionId, isZh, runtime, ask]);

  return { run, ask, done, runtime };
}
