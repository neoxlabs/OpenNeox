import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n, setGlobalLanguage } from '../../hooks/useI18n';
import { UiSlot } from '../../modules/shell/uiSlots';
import { PPTX_AVAILABLE } from '../../modules/surface/pptxAvailability';
import { getEditionHook } from '../../modules/shell/editionHooks';
import { ProviderBrandLogo } from '../settings/tabs/ProviderBrandLogo';
import markRing from '../../assets/brand/mark-ring.webp';
import thumbDoc from '../../media/clay/thumb-doc.webp';
import thumbSlides from '../../media/clay/thumb-slides.webp';
import thumbSheet from '../../media/clay/thumb-sheet.webp';
import thumbImage from '../../media/clay/thumb-image.webp';
import sfcTerminal from '../../media/clay/sfc-terminal.webp';
import sfcWeb from '../../media/clay/sfc-web.webp';
import sfcPdf from '../../media/clay/sfc-pdf.webp';
import artWork from '../../media/onboarding/ob-work.webp';
import artCode from '../../media/onboarding/ob-code.webp';
import artPilot from '../../media/onboarding/ob-pilot.webp';
import artCoin from '../../media/onboarding/ob-coin.webp';
import artKey from '../../media/onboarding/ob-key.webp';
import './onboarding-v3.css';

const OnboardingPage = React.lazy(() => import('./OnboardingPage'));

type Step = 'login' | 'mode' | 'model';
type Mode = 'work' | 'code' | 'pilot';

interface MigrateScan {
  skills: Array<{ path: string; alreadyImported: boolean }>;
  mcp: Array<{ id: string; alreadyImported: boolean }>;
}

const Arrow = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" /></svg>
);
const Back = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5" /></svg>
);
const Check = () => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
);

export const OnboardingV3: React.FC<{ onComplete: () => void; onOpenSettings?: () => void }> = ({ onComplete, onOpenSettings }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const api = (window as any).neox;

  const hasAccount = getEditionHook('hasAccount') as unknown as boolean;
  const [authed, setAuthed] = useState<boolean>(() => {
    try { return !!(getEditionHook('isAuthenticated') as unknown as () => boolean)?.(); } catch { return false; }
  });
  const steps: Step[] = useMemo(
    () => (hasAccount && !authed ? ['login', 'mode', 'model'] : ['mode', 'model']) as Step[],
    // 登录成功后不把 login 从列表里抽走 —— 步骤条上第一格要显示「已完成」, 不是凭空消失
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasAccount],
  );
  const [step, setStep] = useState<Step>(steps[0]);
  const idx = steps.indexOf(step);
  const go = (d: 1 | -1) => {
    const n = steps[idx + d];
    if (n) setStep(n);
  };

  /* ── 用途 ── */
  const [mode, setMode] = useState<Mode>('work');
  const [pilotOk, setPilotOk] = useState(false);
  useEffect(() => {
    void api?.pilotAvailable?.().then((v: unknown) => setPilotOk(v === true)).catch(() => {});
  }, [api, authed]);
  /* 跟 NeoxModePicker 同一条默认模式链: 落盘 + window 全局 (主界面首帧没会话时读它) */
  const saveMode = (m: Mode) => {
    void api?.agentModeSetDefault?.(m).catch(() => {});
    try { (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode = m; } catch { /* ignore */ }
  };
  const pickMode = (m: Mode) => { setMode(m); saveMode(m); };
  /* 进到这一步先把默认值写一次 —— 用户不点卡直接「下一步」也算选了「工作」 */
  useEffect(() => { if (step === 'mode') saveMode(mode); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 模型 ── */
  const [via, setVia] = useState<'sub' | 'byok'>(hasAccount ? 'sub' : 'byok');
  const [connecting, setConnecting] = useState(false);
  const [scan, setScan] = useState<MigrateScan | null>(null);
  const [importState, setImportState] = useState<'idle' | 'busy' | { n: number; failed: number }>('idle');
  useEffect(() => {
    if (typeof api?.migrateScan !== 'function') return;
    void api.migrateScan().then((r: MigrateScan | null) => setScan(r)).catch(() => {});
  }, [api]);
  const fresh = useMemo(() => ({
    skills: scan?.skills.filter((x) => !x.alreadyImported) ?? [],
    mcp: scan?.mcp.filter((x) => !x.alreadyImported) ?? [],
  }), [scan]);
  const freshCount = fresh.skills.length + fresh.mcp.length;
  const runImport = async () => {
    if (typeof api?.migrateApply !== 'function') return;
    setImportState('busy');
    try {
      const r = await api.migrateApply({
        skillPaths: fresh.skills.map((x) => x.path),
        mcpIds: fresh.mcp.map((x) => x.id),
        withEnv: false,
        sessions: [],
      });
      setImportState({ n: r?.imported ?? 0, failed: r?.failed ?? 0 });
    } catch {
      setImportState({ n: 0, failed: 1 });
    }
  };
  const finish = useCallback(() => {
    if (via === 'byok') { setConnecting(true); return; }
    onComplete();
  }, [via, onComplete]);

  /* 回车 = 主按钮 (登录那步不接管: 那一颗是去浏览器, 回车误触会突然弹出浏览器) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || connecting) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (step === 'mode') go(1);
      else if (step === 'model') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stepName: Record<Step, string> = { login: zh ? '登录' : 'Sign in', mode: zh ? '用途' : 'Use', model: zh ? '模型' : 'Model' };

  const gallery = [
    { art: thumbDoc, name: zh ? '竞品调研报告' : 'Market research', kind: 'Word' },
    { art: thumbSlides, name: zh ? 'Q3 销售复盘' : 'Q3 sales review', kind: 'PPT' },
    { art: thumbSheet, name: zh ? '9 月销售汇总' : 'September sales', kind: 'Excel' },
    { art: sfcTerminal, name: zh ? '修好登录跳转' : 'Fix login redirect', kind: zh ? '代码' : 'Code' },
    { art: thumbImage, name: zh ? '生日贺卡海报' : 'Birthday poster', kind: zh ? '图片' : 'Image' },
    { art: sfcWeb, name: zh ? '活动落地页' : 'Event page', kind: zh ? '网页' : 'Web' },
    { art: sfcPdf, name: zh ? '期中成绩分析' : 'Grade analysis', kind: 'PDF' },
  ];

  const modes: Array<{ id: Mode; art: string; title: string; l1: string; l2: string }> = [
    { id: 'work', art: artWork, title: zh ? '工作' : 'Work', l1: PPTX_AVAILABLE ? (zh ? '写报告、做表格和 PPT' : 'Reports, sheets and slides') : (zh ? '写报告、做表格和文档' : 'Reports, sheets and documents'), l2: zh ? '调研、整理资料、出图' : 'Research, organize, make images' },
    { id: 'code', art: artCode, title: zh ? '写代码' : 'Code', l1: zh ? '修 bug、加功能、跑测试' : 'Fix bugs, add features, run tests', l2: zh ? '读懂整个项目' : 'Understand the whole repo' },
    ...(pilotOk ? [{ id: 'pilot' as Mode, art: artPilot, title: 'Pilot', l1: zh ? '会打电话的私人助理' : 'An assistant that calls you', l2: zh ? '记账、提醒、日程' : 'Expenses, reminders, calendar' }] : []),
  ];

  return (
    <div className="obv3" data-step={step}>
      <header className="obv3-top">
        <ol className="obv3-steps" aria-label={zh ? '引导步骤' : 'Onboarding steps'}>
          {steps.map((s, i) => (
            <li key={s} className={i === idx ? 'is-on' : i < idx || (s === 'login' && authed) ? 'is-done' : ''}>
              <b>{i < idx || (s === 'login' && authed) ? <Check /> : i + 1}</b>{stepName[s]}
            </li>
          ))}
        </ol>
        <div className="obv3-lang" role="group" aria-label={zh ? '语言' : 'Language'}>
          <button type="button" className={zh ? 'is-on' : ''} onClick={() => setGlobalLanguage('zh')}>中</button>
          <span>/</span>
          <button type="button" className={!zh ? 'is-on' : ''} onClick={() => setGlobalLanguage('en')}>EN</button>
          {/* 未登录也得够得着设置 (登录连不上时要去改代理, 见 settingsReachableWhenLoggedOut.test) */}
          <button type="button" className="obv3-settings" title={zh ? '设置' : 'Settings'} aria-label={zh ? '设置' : 'Settings'}
            onClick={() => {
              if (onOpenSettings) { onOpenSettings(); return; }
              try { window.dispatchEvent(new CustomEvent('neox:open-settings')); } catch { /* ignore */ }
            }}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></svg>
          </button>
        </div>
      </header>

      {step === 'login' && (
        <main className="obv3-page obv3-login-page">
          <section className="obv3-hero">
            <img className="obv3-hero__mark" src={markRing} alt="" draggable={false} />
            <h1>{zh ? '你好，我是 Neox' : "Hi, I'm Neox"}</h1>
            <p>{zh ? '电脑上的 AI 助手，帮你把事情做完、把成品交到手上' : 'An AI assistant on your computer — it gets things done and hands you the result'}</p>
            <UiSlot name="onboarding.login" props={{ onSuccess: () => { setAuthed(true); go(1); } }} />
          </section>
          <section className="obv3-gallery" aria-label={zh ? '成品示例' : 'Examples'}>
            <div className="obv3-gallery__label">{zh ? '这些都是 Neox 做出来的' : 'All made by Neox'}</div>
            <div className="obv3-gallery__track">
              {[...gallery, ...gallery].map((g, i) => (
                <div className="obv3-gcard" key={i} aria-hidden={i >= gallery.length}>
                  <div className="obv3-gcard__art"><img src={g.art} alt="" draggable={false} /></div>
                  <div className="obv3-gcard__cap"><span>{g.name}</span><em>{g.kind}</em></div>
                </div>
              ))}
            </div>
          </section>
          <footer className="obv3-terms">
            {zh ? '继续即表示同意 ' : 'By continuing you agree to the '}
            <a href="https://neox.ai/terms" target="_blank" rel="noreferrer">{zh ? '服务条款' : 'Terms'}</a>
            {zh ? ' 和 ' : ' and '}
            <a href="https://neox.ai/privacy" target="_blank" rel="noreferrer">{zh ? '隐私政策' : 'Privacy Policy'}</a>
          </footer>
        </main>
      )}

      {step === 'mode' && (
        <main className="obv3-page">
          <div className="obv3-head">
            <h1>{zh ? '你主要用 Neox 做什么？' : 'What will you mostly use Neox for?'}</h1>
            <p>{zh ? '决定默认打开哪个模式，随时能在顶栏切换' : 'Sets the default mode — switch anytime from the top bar'}</p>
          </div>
          <div className={`obv3-modes obv3-modes--${modes.length}`} role="radiogroup" aria-label={zh ? '用途' : 'Use'}>
            {modes.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id}
                className={`obv3-card obv3-mode${mode === m.id ? ' is-on' : ''}`} onClick={() => pickMode(m.id)}>
                <span className="obv3-mode__art"><img src={m.art} alt="" draggable={false} /></span>
                <span className="obv3-mode__text">
                  <b>{m.title}</b>
                  <span>{m.l1}</span>
                  <span>{m.l2}</span>
                </span>
                {mode === m.id && <span className="obv3-check" aria-hidden="true"><Check /></span>}
              </button>
            ))}
          </div>
          <div className="obv3-actions">
            {idx > 0 ? <button type="button" className="obv3-btn obv3-btn--ghost" onClick={() => go(-1)}><Back />{zh ? '上一步' : 'Back'}</button> : <span />}
            <button type="button" className="obv3-btn obv3-btn--primary" onClick={() => go(1)}>{zh ? '下一步' : 'Next'}<Arrow /></button>
          </div>
        </main>
      )}

      {step === 'model' && (
        <main className="obv3-page">
          <div className="obv3-head">
            <h1>{zh ? '用哪种方式调用模型？' : 'How should Neox call models?'}</h1>
            <p>{zh ? '之后在设置里随时能改' : 'You can change this later in Settings'}</p>
          </div>
          <div className="obv3-vias" role="radiogroup" aria-label={zh ? '调用方式' : 'Model access'}>
            {hasAccount && (
              <button type="button" role="radio" aria-checked={via === 'sub'} className={`obv3-card obv3-via${via === 'sub' ? ' is-on' : ''}`} onClick={() => setVia('sub')}>
                <img className="obv3-via__art" src={artCoin} alt="" draggable={false} />
                <span className="obv3-via__text">
                  <b>{zh ? '用订阅' : 'Use a plan'}<em className="obv3-tag">{zh ? '推荐' : 'Recommended'}</em></b>
                  <span>{zh ? '用套餐里的额度，不用配置' : 'Use your plan’s quota — nothing to set up'}</span>
                  <span>{zh ? '多家模型随时切换' : 'Switch between models anytime'}</span>
                </span>
                {via === 'sub' && <span className="obv3-check" aria-hidden="true"><Check /></span>}
              </button>
            )}
            <button type="button" role="radio" aria-checked={via === 'byok'} className={`obv3-card obv3-via${via === 'byok' ? ' is-on' : ''}`} onClick={() => setVia('byok')}>
              <img className="obv3-via__art" src={artKey} alt="" draggable={false} />
              <span className="obv3-via__text">
                <b>{zh ? '自带 Key' : 'Bring your own key'}</b>
                <span>{zh ? '用你自己的服务商账号' : 'Use your own provider account'}</span>
                <span className="obv3-provs">
                  {[['deepseek', 'DeepSeek'], ['kimi', 'Kimi'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Gemini'], ['qwen', zh ? '通义' : 'Qwen'], ['glm', zh ? '智谱' : 'GLM'], ['doubao', zh ? '豆包' : 'Doubao']].map(([id, label]) => (
                    <span key={id} className="obv3-prov"><ProviderBrandLogo presetId={id} fallbackLabel={label} size={24} /><span>{label}</span></span>
                  ))}
                </span>
              </span>
              {via === 'byok' && <span className="obv3-check" aria-hidden="true"><Check /></span>}
            </button>
          </div>
          {freshCount > 0 && (
            <div className="obv3-card obv3-migrate">
              <span className="obv3-migrate__logos" aria-hidden="true">
                <ProviderBrandLogo presetId="anthropic" fallbackLabel="Claude" size={26} />
                <ProviderBrandLogo presetId="openai" fallbackLabel="Codex" size={26} />
              </span>
              <span className="obv3-migrate__text">
                <b>{zh ? '发现本机装了 Claude Code / Codex' : 'Found Claude Code / Codex on this Mac'}</b>
                <span>
                  {importState === 'idle' || importState === 'busy'
                    ? (zh ? `一键导入 ${fresh.skills.length} 个技能、${fresh.mcp.length} 个 MCP；历史会话之后在设置里导` : `Import ${fresh.skills.length} skills and ${fresh.mcp.length} MCP servers — sessions later in Settings`)
                    : (zh ? `已导入 ${importState.n} 项${importState.failed ? `，${importState.failed} 项没成功` : ''}` : `Imported ${importState.n}${importState.failed ? `, ${importState.failed} failed` : ''}`)}
                </span>
              </span>
              {(importState === 'idle' || importState === 'busy') && (
                <button type="button" className="obv3-btn obv3-btn--soft" disabled={importState === 'busy'} onClick={() => void runImport()}>
                  {importState === 'busy' ? (zh ? '导入中…' : 'Importing…') : (zh ? '导入' : 'Import')}
                </button>
              )}
            </div>
          )}
          <div className="obv3-actions">
            {idx > 0 ? <button type="button" className="obv3-btn obv3-btn--ghost" onClick={() => go(-1)}><Back />{zh ? '上一步' : 'Back'}</button> : <span />}
            <button type="button" className="obv3-btn obv3-btn--primary" onClick={finish}>
              {via === 'byok' ? (zh ? '去填 Key' : 'Add a key') : (zh ? '开始使用' : 'Get started')}<Arrow />
            </button>
          </div>
        </main>
      )}

      {connecting && (
        <div className="model-connect-overlay">
          <Suspense fallback={<div className="neox-page-loading" role="status" aria-busy="true"><div className="sk-dots"><i /><i /><i /></div></div>}>
            <OnboardingPage connectOnly="byok" onComplete={onComplete} onCancel={() => setConnecting(false)} />
          </Suspense>
        </div>
      )}
    </div>
  );
};

export default OnboardingV3;
