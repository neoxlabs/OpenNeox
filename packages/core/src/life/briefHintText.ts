/**
 * Single source for brief_hint text. Events store a rule id and interpolation data;
 * presentation renders the surrounding copy in the active language and uses stored
 * title/summary only as a fallback. User-provided values remain unchanged.
 */

export type BriefHintLang = 'zh' | 'en';

/** 规则的插值参数 — 只存数据, 不存文案. */
export interface BriefHintParams {
  /** morning_greeting: 从 profile 挑出来的兴趣项, 已 join 成一串 */
  items?: string;
  /** evening_summary: 今天完成的件数 */
  count?: number;
  /** stale_outcome / overdue_reminder: 被引用事项的标题 (未裁剪) */
  subject?: string;
}

export interface BriefHintText {
  title: string;
  summary?: string;
  suggestedPrompt?: string;
}

const MAX_SUBJECT = 30;

function clip(s: string, max = MAX_SUBJECT): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* macOS 上 emoji 渲染成 3D 立体贴纸, 跟 flat UI 不搭 —— subject 来自用户自己的提醒标题,
 * 可能带 emoji, 插值前先剥掉. 注意只洗"参数", 不洗渲染结果:
 * 洗渲染结果会把模板里引号两侧的空格一起吃掉 (the"收快递"reminder). */
function sanitizeSubject(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按语言渲染一条 brief_hint. 参数不全 (老数据反解失败等) 返回 null —— 调用方退回库里存的原文,
 * 宁可显示旧语言, 也不显示 `Did you handle the "" reminder?` 这种残句.
 */
export function renderBriefHint(
  ruleId: string,
  params: BriefHintParams,
  lang: BriefHintLang,
): BriefHintText | null {
  const zh = lang === 'zh';
  switch (ruleId) {
    case 'morning_greeting': {
      const items = (params.items ?? '').trim();
      return {
        title: zh ? '早上好 · 今天想做点什么?' : 'Good morning · What are we doing today?',
        summary: items
          ? (zh
            ? `你上次说过对 ${items} 感兴趣, 要不要从这里开始?`
            : `You mentioned interest in ${items} — want to start there?`)
          : (zh
            ? '我可以帮你规划一天 — 只要告诉我你想做的事.'
            : 'I can plan your day — just tell me what you want to get done.'),
        suggestedPrompt: zh ? '帮我规划一下今天' : 'Plan my day',
      };
    }
    case 'evening_summary': {
      const n = Number(params.count);
      if (!Number.isFinite(n) || n <= 0) return null;
      return {
        title: zh
          ? `今天完成 ${n} 件事 · 辛苦了`
          : `You wrapped up ${n} thing${n === 1 ? '' : 's'} today · Nice`,
        summary: zh
          ? '要不要花两分钟看看明天要办的事? 或者今晚就这样了'
          : 'Want to take two minutes to peek at tomorrow? Or wrap it up for tonight.',
        suggestedPrompt: zh ? '帮我看看明天要办的事' : 'What is on for tomorrow?',
      };
    }
    case 'stale_outcome': {
      const subject = sanitizeSubject(params.subject ?? '');
      if (!subject) return null;
      const t = clip(subject);
      return {
        title: zh ? `还记得"${t}"吗?` : `Remember "${t}"?`,
        summary: zh
          ? '5 天前你办到一半, 要继续还是标记完成?'
          : 'You started this 5 days ago — continue or mark done?',
        suggestedPrompt: zh ? `继续: ${subject}` : `Continue: ${subject}`,
      };
    }
    case 'overdue_reminder': {
      const subject = sanitizeSubject(params.subject ?? '');
      if (!subject) return null;
      const t = clip(subject);
      return {
        title: zh ? `上次提醒的"${t}"办了吗?` : `Did you handle the "${t}" reminder?`,
        summary: zh ? '要现在办, 或者标记完成' : 'Do it now, or mark it done',
        suggestedPrompt: zh ? `完成: ${t}` : `Done: ${t}`,
      };
    }
    case 'health_morning':
      return {
        title: zh ? '晨间健康提示' : 'Morning health nudge',
        summary: zh
          ? '别忘了早餐 · 有兴趣的话可以来一次 15 分钟的短运动'
          : 'Grab breakfast · Maybe a 15-minute quick workout if you feel up to it',
        suggestedPrompt: zh ? '推荐一个 15 分钟的晨间锻炼' : 'Suggest a 15-min morning workout',
      };
    default:
      return null;
  }
}

/**
 * Recover interpolation data from legacy rendered fields when structured parameters
 * are absent; return null when recovery is ambiguous so callers keep the stored text.
 */
export function recoverBriefHintParams(
  ruleId: string,
  stored: { title?: string | null; summary?: string | null; suggestedPrompt?: string | null },
): BriefHintParams | null {
  const title = (stored.title ?? '').trim();
  const summary = (stored.summary ?? '').trim();
  const prompt = (stored.suggestedPrompt ?? '').trim();
  switch (ruleId) {
    case 'morning_greeting': {
      /* 无兴趣项时是另一句固定文案 → items 空串, 照样能渲 */
      const m = /^你上次说过对 (.+) 感兴趣/.exec(summary)
        ?? /^You mentioned interest in (.+) — want to start there\?$/.exec(summary);
      return { items: m ? m[1] : '' };
    }
    case 'evening_summary': {
      const m = /今天完成 (\d+) 件事/.exec(title) ?? /You wrapped up (\d+) thing/.exec(title);
      return m ? { count: Number(m[1]) } : null;
    }
    case 'stale_outcome': {
      const m = /^(?:继续|Continue): (.+)$/.exec(prompt);
      return m ? { subject: m[1] } : null;
    }
    case 'overdue_reminder': {
      const m = /^(?:完成|Done): (.+)$/.exec(prompt);
      return m ? { subject: m[1] } : null;
    }
    case 'health_morning':
      return {};
    default:
      return null;
  }
}

/**
 * 展示侧入口: 拿 payload + 库里存的原文, 吐出当前语言的文案.
 * 优先 i18nParams, 其次反解老数据, 都不行就返回 null (调用方用库里原文兜底).
 */
export function localizeBriefHint(
  payload: { ruleId?: string; i18nParams?: BriefHintParams; suggestedPrompt?: string } | null | undefined,
  stored: { title?: string | null; summary?: string | null },
  lang: BriefHintLang,
): BriefHintText | null {
  const ruleId = payload?.ruleId;
  if (!ruleId) return null;
  const params = payload?.i18nParams
    ?? recoverBriefHintParams(ruleId, { ...stored, suggestedPrompt: payload?.suggestedPrompt });
  if (!params) return null;
  return renderBriefHint(ruleId, params, lang);
}
