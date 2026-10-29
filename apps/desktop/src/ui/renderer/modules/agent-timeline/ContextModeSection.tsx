import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { NeoxIllus } from '../../media/illus';
import { ChoiceDialog } from './ChoiceDialog';

export type ContextProfile = 'full' | 'lean';

const EVENT = 'neox:context-profile';
let cached: ContextProfile | null = null;
let loading: Promise<ContextProfile> | null = null;

function load(): Promise<ContextProfile> {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;
  const fn = (window as any).neox?.contextGetConfig;
  const p: Promise<ContextProfile> = (typeof fn === 'function' ? Promise.resolve(fn()) : Promise.resolve(null))
    .then((c: any): ContextProfile => (cached = c?.profile === 'lean' ? 'lean' : 'full'))
    .catch((): ContextProfile => (cached = 'full'))
    .finally(() => { loading = null; });
  loading = p;
  return p;
}

export async function setContextProfile(next: ContextProfile): Promise<void> {
  const prev = cached ?? 'full';
  cached = next;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  try {
    const r = await (window as any).neox?.contextSetConfig?.({ profile: next });
    if (r && r.success === false) throw new Error(r.error || 'save failed');
  } catch (err) {
    /* 没存上就退回去 —— 界面显示的必须是真实生效的档 */
    cached = prev;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: prev }));
    throw err;
  }
}

export function useContextProfile(): ContextProfile {
  const [profile, setProfile] = React.useState<ContextProfile>(cached ?? 'full');
  React.useEffect(() => {
    let alive = true;
    void load().then((p) => { if (alive) setProfile(p); });
    const on = (e: Event) => setProfile((e as CustomEvent<ContextProfile>).detail);
    window.addEventListener(EVENT, on);
    return () => { alive = false; window.removeEventListener(EVENT, on); };
  }, []);
  return profile;
}

export function requestModeName(p: ContextProfile, isZh: boolean): string {
  return p === 'lean' ? (isZh ? '节约' : 'Saver') : (isZh ? '标准' : 'Standard');
}

const MODES: Array<{
  id: ContextProfile;
  art: string;
  tokens: { zh: string; en: string };
  bar: number;
  points: { zh: string[]; en: string[] };
}> = [
  {
    id: 'full',
    art: NeoxIllus.work,
    tokens: { zh: '每次请求开局约 17–26K token', en: '~17–26K tokens per request to start' },
    bar: 1,
    points: {
      zh: ['完整的做事规范', '25 个常用工具随时可用', '复杂任务、较弱的模型最稳'],
      en: ['Full working guidance', '25 common tools always ready', 'Steadiest on hard tasks and weaker models'],
    },
  },
  {
    id: 'lean',
    art: NeoxIllus.quota,
    tokens: { zh: '每次请求开局约 3K token', en: '~3K tokens per request to start' },
    bar: 0.13,
    points: {
      zh: ['精简规范 + 读写改、命令、搜索 6 个基础工具', '其余工具用到时模型自己解锁', '省 token, 首字更快'],
      en: ['Short guidance + 6 basics: read, write, edit, shell, search', 'Other tools unlocked when needed', 'Fewer tokens, faster first reply'],
    },
  },
];

/** 「+」菜单 → 请求模式 的弹窗: 两张卡并排, 点卡即切 */
export const RequestModeDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { isZh } = useI18n();
  const profile = useContextProfile();
  return (
    <ChoiceDialog<ContextProfile>
      title={isZh ? '请求模式' : 'Request mode'}
      sub={isZh ? '每次发给模型的请求要带多少东西。切换后从下一句开始生效。' : 'How much goes into every request to the model. Takes effect from your next message.'}
      options={MODES.map((m) => ({
        id: m.id,
        art: m.art,
        name: requestModeName(m.id, isZh),
        lead: isZh ? m.tokens.zh : m.tokens.en,
        bar: m.bar,
        points: isZh ? m.points.zh : m.points.en,
      }))}
      current={profile}
      onPick={setContextProfile}
      onClose={onClose}
      foot={isZh ? '实测同样 7 个编程任务, 节约模式总输入少 60%, 全部完成。' : 'Measured on the same 7 coding tasks: Saver used 60% less input, all completed.'}
    />
  );
};

/** 设置页「上下文」里的同一个开关 (沿用设置页的 setting-row / mode-selector 样式) */
export const ContextModeSettingRow: React.FC = () => {
  const { isZh } = useI18n();
  const profile = useContextProfile();
  const [err, setErr] = React.useState<string | null>(null);
  const pick = (p: ContextProfile) => {
    if (p === profile) return;
    setErr(null);
    setContextProfile(p).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="setting-row">
      <div className="setting-info">
        <span className="setting-label">{isZh ? '请求模式' : 'Request mode'}</span>
        <span className="setting-desc">
          {err
            ? (isZh ? `没切成: ${err}` : `Couldn't switch: ${err}`)
            : profile === 'lean'
              ? (isZh ? '节约 — 短提示词 + 6 个基础工具, 每次请求开局约 3K token; 其余工具模型按需解锁。省 token、首字更快' : 'Saver — short prompt + 6 basic tools, ~3K tokens per request; other tools unlocked on demand')
              : (isZh ? '标准 — 完整提示词 + 常用工具常驻 (每次请求开局约 17-26K token), 复杂任务最稳' : 'Standard — full guidance and common tools (~17-26K tokens per request)')}
        </span>
      </div>
      <div className="mode-selector">
        <button className={`mode-btn ${profile === 'full' ? 'active' : ''}`} onClick={() => pick('full')}>
          {requestModeName('full', isZh)}
        </button>
        <button className={`mode-btn ${profile === 'lean' ? 'active' : ''}`} onClick={() => pick('lean')}>
          {requestModeName('lean', isZh)}
        </button>
      </div>
    </div>
  );
};

/** 输入框模型按钮上的小标 —— 节约时才出现, 一眼知道当前在省模式 */
export const ContextModeBadge: React.FC = () => {
  const { isZh } = useI18n();
  const profile = useContextProfile();
  if (profile !== 'lean') return null;
  return (
    <span className="atl-composer__ctxmode-badge" title={isZh ? '节约模式: 短提示词 + 基础工具' : 'Saver mode: short prompt + basic tools'}>
      {requestModeName('lean', isZh)}
    </span>
  );
};
