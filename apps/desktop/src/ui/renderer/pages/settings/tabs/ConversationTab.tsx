import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import {
  useTimelineDensityPreference,
  useTimelineFontScalePreference,
  useTimelineLineHeightPreference,
  useComposerStylePreference,
  type ComposerStyle,
  TIMELINE_FONT_SCALE_MIN,
  TIMELINE_FONT_SCALE_MAX,
  TIMELINE_FONT_SCALE_DEFAULT,
  TIMELINE_LINE_HEIGHT_MIN,
  TIMELINE_LINE_HEIGHT_MAX,
  TIMELINE_LINE_HEIGHT_DEFAULT,
} from '../../../modules/agent-timeline/timelinePreferences';
import type { TimelineDensity } from '../../../modules/agent-timeline/types';
import { PageTitle, Section, SectionTitle, SettingsCard, SettingsRow } from '../../../components/settings-base';
import './ConversationTab.clay.css';

/* 行左边 28px 软方块里的线条图标 (1.5 粗细, UI 3.0 陶土风) */
const IconAa = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <text x="8" y="11.5" textAnchor="middle" fontSize="9">Aa</text>
  </svg>
);
const IconLines = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" aria-hidden="true">
    <path d="M3 4h10M3 8h10M3 12h10" />
  </svg>
);

/* 滑块 —— 直接用 native range + settings-base.css 的 .nx-slider 皮肤 (track/fill/thumb 都有),
 * 不自造拖拽: 键盘、触屏、a11y 全是浏览器给的。 */
const ScaleSlider: React.FC<{
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; label: string;
}> = ({ value, min, max, step, onChange, label }) => {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="nx-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{ ['--nx-slider-pct' as any]: `${pct}%` }}
    />
  );
};

const MiniIco: React.FC<{ d: React.ReactNode }> = ({ d }) => (
  <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const icClip = <path d="M10.5 5.5 6 10a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4L4 8a4.2 4.2 0 0 0 6 6l3.5-3.5" />;
const icMic = <><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" /></>;
const icSend = <path d="M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5z" />;
const icSun = <><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>;
const icPlus = <path d="M8 3.5v9M3.5 8h9" />;
const icHome = <path d="M3 7.5 8 3.5l5 4V13H3z" />;

function ComposerMini({ kind, zh }: { kind: ComposerStyle; zh: boolean }) {
  const ph = zh ? '描述任务，或 / 技能、@ 引用上下文…' : 'Describe a task, / for skills, @ for context…';
  if (kind === 'standard') {
    return (
      <span className="cvm cvm--std">
        <span className="cvm__mode">Agentic</span>
        <span className="cvm__ph">{ph}</span>
        <span className="cvm__bar">
          <span className="cvm__ico"><MiniIco d={icClip} /></span>
          <span className="cvm__ico is-ring"><MiniIco d={icMic} /></span>
          <span className="cvm__ico">···</span>
          <span className="cvm__fill" />
          <span className="cvm__sq"><MiniIco d={icHome} /></span>
          <span className="cvm__chip is-model"><i className="cvm__dot" />deepseek</span>
          <span className="cvm__chip">◌ 0%</span>
          <span className="cvm__sq is-send"><MiniIco d={icSend} /></span>
          <span className="cvm__chip is-ring"><MiniIco d={icSun} />{zh ? '思考' : 'Think'}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="cvm cvm--min">
      <span className="cvm__ph">{ph}</span>
      <span className="cvm__bar">
        <span className="cvm__round is-plus"><MiniIco d={icPlus} /></span>
        <span className="cvm__chip is-model is-ring"><i className="cvm__dot" />deepseek</span>
        <span className="cvm__chip is-ring"><MiniIco d={icSun} />{zh ? '思考' : 'Think'}</span>
        <span className="cvm__fill" />
        <span className="cvm__round is-ring"><MiniIco d={icMic} /></span>
        <span className="cvm__round is-send"><MiniIco d={icSend} /></span>
      </span>
    </span>
  );
}

/* 显示密度的示意: 同一轮对话 (读文件 → 改代码 → 跑测试) 在三档下各展开多少。
 * 极简 = 一行「做了 3 步」折起; 标准 = 改代码那步摊开 (关键步骤), 其余一行; 完整 = 每步都摊开。 */
function DensityMini({ kind, zh }: { kind: TimelineDensity; zh: boolean }) {
  const steps = [
    { verb: zh ? '读取' : 'Read', arg: 'main.ts', key: false },
    { verb: zh ? '编辑' : 'Edit', arg: 'main.ts', key: true },
    { verb: zh ? '运行' : 'Run', arg: 'npm test', key: false },
  ];
  const Body = ({ edit }: { edit: boolean }) => (
    <span className={`cvd__body${edit ? ' is-diff' : ''}`}>
      <i /><i /><i className="is-short" />
    </span>
  );
  return (
    <span className="cvm cvd">
      <span className="cvd__msg"><i className="is-short" /></span>
      {kind === 'minimal' ? (
        <span className="cvd__row is-fold"><b>✓</b>{zh ? '做了 3 步' : '3 steps done'}<em>›</em></span>
      ) : steps.map((s) => {
        const open = kind === 'debug' || s.key;
        return (
          <span key={s.verb} className={`cvd__step${open ? ' is-open' : ''}`}>
            <span className="cvd__row"><b>●</b>{s.verb}<span className="cvd__arg">{s.arg}</span>{!open && <em>›</em>}</span>
            {open && <Body edit={s.key} />}
          </span>
        );
      })}
    </span>
  );
}

/** 插画选择卡 —— 跟 Agent 权限的审批三档同一套 (.ws-engine); preview 有就用它代替插画 */
function ChoiceCards<T extends string>({ value, options, onPick, label, zh }: {
  value: T;
  options: Array<{ id: T; art?: string; preview?: React.ReactNode; name: string; desc: string }>;
  onPick: (v: T) => void;
  label: string;
  zh: boolean;
}) {
  return (
    <div className={`cv-choices${options.length === 2 ? ' cv-choices--2' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id}
          className={`ws-engine${value === o.id ? ' is-on' : ''}`} onClick={() => onPick(o.id)}>
          <span className={`ws-engine__stage${o.preview ? ' is-preview' : ''}`} aria-hidden="true">
            {o.preview ?? <img src={o.art} alt="" draggable={false} />}
          </span>
          <span className="ws-engine__head">
            <b>{o.name}</b>
            {value === o.id && (
              <span className="cv3-check" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
              </span>
            )}
            {value === o.id && <span className="cv3-sr">{zh ? '当前' : 'Current'}</span>}
          </span>
          <span className="ws-engine__desc">{o.desc}</span>
        </button>
      ))}
    </div>
  );
}

const ConversationTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [timelineDensity, setTimelineDensity] = useTimelineDensityPreference();
  const [fontScale, setFontScale] = useTimelineFontScalePreference();
  const [lineHeight, setLineHeight] = useTimelineLineHeightPreference();
  const [composerStyle, setComposerStyle] = useComposerStylePreference();

  const isDefault =
    fontScale === TIMELINE_FONT_SCALE_DEFAULT && lineHeight === TIMELINE_LINE_HEIGHT_DEFAULT;
  const resetAll = () => {
    setFontScale(TIMELINE_FONT_SCALE_DEFAULT);
    setLineHeight(TIMELINE_LINE_HEIGHT_DEFAULT);
  };

  /* 预览块吃的是跟真对话区【同一对】变量和【同一组】基准值:
   *   正文  .atl-msg__text  = 13px / line-height 1.7
   *   辅助行 (工具行/时间戳) = 12px / 1.5
   * 基准值改了这里要跟着改, 否则预览会骗人。 */
  const previewVars = {
    ['--nx-fs-scale' as any]: fontScale,
    ['--nx-lh-scale' as any]: lineHeight,
    /* 与 .agent-timeline 相同: 必须在设置了 scale 的节点上重绑 token,
     * 否则 var(--neox-fs-*) 仍是 :root 算死的基准值。 */
    ['--neox-fs-xxs' as any]: 'calc(11px * var(--nx-fs-scale, 1))',
    ['--neox-fs-xs' as any]: 'calc(12px * var(--nx-fs-scale, 1))',
    ['--neox-fs-sm' as any]: 'calc(13px * var(--nx-fs-scale, 1))',
    ['--neox-fs-md' as any]: 'calc(14px * var(--nx-fs-scale, 1))',
    ['--neox-fs-lg' as any]: 'calc(16px * var(--nx-fs-scale, 1))',
    ['--neox-fs-xl' as any]: 'calc(18px * var(--nx-fs-scale, 1))',
  } as React.CSSProperties;

  const composerOptions: Array<{ id: ComposerStyle; preview: React.ReactNode; name: string; desc: string }> = [
    { id: 'standard', preview: <ComposerMini kind="standard" zh={zh} />, name: zh ? '标准' : 'Standard', desc: zh ? '常用工具摆在下沿' : 'Tools along the bottom' },
    { id: 'minimal', preview: <ComposerMini kind="minimal" zh={zh} />, name: zh ? '简约' : 'Minimal', desc: zh ? '工具收进「+」' : 'Tools tuck into “+”' },
  ];
  const densityOptions: Array<{ id: TimelineDensity; preview: React.ReactNode; name: string; desc: string }> = [
    { id: 'minimal', preview: <DensityMini kind="minimal" zh={zh} />, name: zh ? '极简' : 'Minimal', desc: zh ? '做完的步骤折起来' : 'Finished steps fold away' },
    { id: 'normal', preview: <DensityMini kind="normal" zh={zh} />, name: zh ? '标准' : 'Normal', desc: zh ? '关键步骤展开' : 'Key steps open' },
    { id: 'debug', preview: <DensityMini kind="debug" zh={zh} />, name: zh ? '完整' : 'Full', desc: zh ? '每一步都展开' : 'Every step open' },
  ];

  return (
    <div className="settings-panel-content cv3">
      <PageTitle
        title={zh ? '对话区' : 'Conversation'}
        subtitle={zh ? '字号、输入框和显示密度' : 'Text size, input box and density'}
      />

      <Section>
        <SectionTitle title={zh ? '字号与行距' : 'Text size & spacing'} />
        <SettingsCard>
          <SettingsRow
            id="setting-timeline-font"
            leading={<span className="cv3-ico"><IconAa /></span>}
            title={zh ? '字号' : 'Size'}
            desc={zh ? '只影响对话区，设置页和侧栏不变。' : 'Conversation area only.'}
            control={(
              <span className="cv-slider">
                <ScaleSlider value={fontScale} min={TIMELINE_FONT_SCALE_MIN} max={TIMELINE_FONT_SCALE_MAX} step={0.05}
                  onChange={setFontScale} label={zh ? '字号' : 'Font size'} />
                <em>{Math.round(fontScale * 100)}%</em>
              </span>
            )}
          />
          {/* 字号能调而行距写死时, 字调大反而更挤, 所以两个必须成对提供。 */}
          <SettingsRow
            id="setting-timeline-line-height"
            leading={<span className="cv3-ico"><IconLines /></span>}
            title={zh ? '行距' : 'Spacing'}
            control={(
              <span className="cv-slider">
                <ScaleSlider value={lineHeight} min={TIMELINE_LINE_HEIGHT_MIN} max={TIMELINE_LINE_HEIGHT_MAX} step={0.05}
                  onChange={setLineHeight} label={zh ? '行间距' : 'Line spacing'} />
                <em>{Math.round(lineHeight * 100)}%</em>
              </span>
            )}
          />
          <SettingsRow className="cv-preview-row">
            <div className="cv-preview" style={previewVars}>
              <div style={{ fontSize: 'calc(13px * var(--nx-fs-scale, 1))', lineHeight: 'calc(1.7 * var(--nx-lh-scale, 1))', color: 'var(--neox-fg-primary)' }}>
                {zh ? '这段是对话区正文的实际观感，拖上面的滑块就能看出效果。' : 'This is what conversation text will look like — drag the sliders above.'}
              </div>
              <div style={{ marginTop: 4, fontSize: 'calc(12px * var(--nx-fs-scale, 1))', lineHeight: 'calc(1.5 * var(--nx-lh-scale, 1))', color: 'var(--neox-fg-secondary)' }}>
                {zh ? '读取文件 · src/main.ts · 1.2s — 工具行小一号，同样跟着缩放。' : 'Read file · src/main.ts · 1.2s — tool rows are one step smaller and scale along.'}
              </div>
            </div>
            <button type="button" className="cv3-reset" onClick={resetAll} disabled={isDefault}>{zh ? '恢复默认' : 'Reset'}</button>
          </SettingsRow>
        </SettingsCard>
      </Section>

      <div className="mfs">
        <section className="ag-approval" id="setting-composer-style">
          <div className="ag-approval__head"><h3>{zh ? '输入框形态' : 'Input box'}</h3></div>
          <ChoiceCards value={composerStyle} options={composerOptions} onPick={setComposerStyle} label={zh ? '输入框形态' : 'Input box style'} zh={zh} />
        </section>

        {/* 显示密度 (从 Agent 策略搬来 —— 跟字号/行距是同一类"对话区看起来怎么样") */}
        <section className="ag-approval" id="setting-timeline-density">
          <div className="ag-approval__head"><h3>{zh ? '显示密度' : 'Density'}</h3></div>
          <ChoiceCards value={timelineDensity} options={densityOptions} onPick={setTimelineDensity} label={zh ? '显示密度' : 'Density'} zh={zh} />
        </section>
      </div>
    </div>
  );
};

export default ConversationTab;
