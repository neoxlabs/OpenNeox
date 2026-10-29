
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CustomSelect } from '../../components/CustomSelect';
import { useImageParamValues, setImageParam, reconcileImageParams, type ParamValue } from '../../state/imageGenParams';
import { getModelParamSpecs, modelHasTiers, type ParamSpec, type ImageTier } from '../../state/imageModelParamSpec';
import { defaultIsZh } from '../../hooks/useI18n';

interface Props {
  /** 选中模型的真实 name (e.g. openai/gpt-image-2). */
  modelName?: string;
  zh?: boolean;
}

const enumLabel = (val: { v: string; zh?: string; en?: string }, zh: boolean) => (zh ? (val.zh ?? val.v) : (val.en ?? val.v));

export const ImageParamsButton: React.FC<Props> = ({ modelName, zh = defaultIsZh() }) => {
  const values = useImageParamValues();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  /* 档位 (普通/高级) 决定 GPT 出图露出哪些参数 —— 有档位的家族才有这个值。
   * 它自己也是一条 spec, 所以要先读出来再算 specs, 否则会循环依赖。 */
  const tier: ImageTier = modelHasTiers(modelName)
    ? ((values['tier'] as ImageTier) ?? 'standard')
    : 'advanced';
  const specs = useMemo(() => getModelParamSpecs(modelName, tier), [modelName, tier]);

  useEffect(() => {
    const defs: Record<string, ParamValue> = {};
    for (const s of specs) if (s.default !== undefined) defs[s.key] = s.default;
    reconcileImageParams(specs.map(s => s.key), defs);
  }, [specs]);

  const openPanel = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      /* 自适应方向: 按钮上方空间不够(空态输入框在中间)就往下弹, 否则往上弹(输入框在底部时). */
      const spaceAbove = r.top;
      const spaceBelow = window.innerHeight - r.bottom;
      const openDown = spaceBelow > spaceAbove;
      setPanelPos(openDown
        ? { left: r.left, top: r.bottom + 8 }
        : { left: r.left, bottom: window.innerHeight - r.top + 8 });
    }
    setOpen(true);
  };

  /* 摘要: 显几个关键值 (质量/尺寸/分辨率/张数). */
  const summary = useMemo(() => {
    const parts: string[] = [];
    for (const key of ['quality', 'size', 'resolution', 'aspect_ratio', 'n']) {
      const spec = specs.find(s => s.key === key);
      if (!spec || values[key] == null) continue;
      const val = values[key];
      const opt = spec.values?.find(o => o.v === String(val));
      parts.push(opt ? enumLabel(opt, zh) : String(val));
    }
    return parts.slice(0, 3).join(' · ');
  }, [specs, values, zh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (document.getElementById('neox-image-params-panel')?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => (open ? setOpen(false) : openPanel())} title={zh ? '出图参数' : 'Generation params'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--neox-line, rgba(0,0,0,0.1))', background: open ? 'var(--neox-bg-subtle, rgba(0,0,0,0.04))' : 'transparent', color: 'var(--neox-fg-secondary, #6b7280)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>
        <span>{summary || (zh ? '参数' : 'Params')}</span>
      </button>

      {open && panelPos && createPortal(
        <div id="neox-image-params-panel"
          style={{ position: 'fixed', left: panelPos.left, ...(panelPos.top != null ? { top: panelPos.top } : { bottom: panelPos.bottom }), zIndex: 100000, width: 340, maxHeight: '64vh', overflowY: 'auto', background: 'color-mix(in srgb, var(--neox-bg-card, #fff) 94%, transparent)', backdropFilter: 'blur(28px) saturate(180%)', WebkitBackdropFilter: 'blur(28px) saturate(180%)', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', borderRadius: 12, boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: 14, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--neox-fg-primary)' }}>
            {zh ? '出图参数' : 'Generation parameters'}
            <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--neox-fg-hint, #9ca3af)', fontSize: 11 }}>{modelName}</span>
          </div>
          {specs.map(spec => (
            <ParamControl key={spec.key} spec={spec} value={values[spec.key]} zh={zh} onChange={(v) => setImageParam(spec.key, v)} />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};

const ParamControl: React.FC<{ spec: ParamSpec; value: ParamValue | undefined; zh?: boolean; onChange: (v: ParamValue) => void }> = ({ spec, value, zh = defaultIsZh(), onChange }) => {
  const label = zh ? spec.labelZh : spec.labelEn;
  const hint = zh ? spec.hintZh : spec.hintEn;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' };
  const labelStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--neox-fg-secondary, #6b7280)', fontWeight: 500, flexShrink: 0 };
  /* label + 可选一行小字 (消歧义). 用 labelNode 替换纯 span, 保持 row 布局不变. */
  const labelNode = hint
    ? (<span style={{ ...labelStyle, display: 'inline-flex', flexDirection: 'column', gap: 1, lineHeight: 1.25 }}>
        <span>{label}</span>
        <span style={{ fontSize: 9.5, fontWeight: 400, color: 'var(--neox-fg-hint, #b0b4bb)' }}>{hint}</span>
      </span>)
    : (<span style={labelStyle}>{label}</span>);

  if ((spec.type === 'enum' || spec.type === 'size') && spec.values?.length) {
    const many = spec.values.length > 5;
    if (many) {
      return (
        <div style={row}>
          {labelNode}
          <div style={{ maxWidth: 200, minWidth: 120, flex: '0 1 200px' }}>
            <CustomSelect
              className="img-params__select"
              value={String(value ?? '')}
              onChange={(v) => onChange(v)}
              options={spec.values.map(o => ({ value: String(o.v), label: enumLabel(o, zh) }))}
            />
          </div>
        </div>
      );
    }
    return (
      <div style={row}>
        {labelNode}
        <div style={{ display: 'inline-flex', borderRadius: 7, background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', padding: 2, gap: 2, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {spec.values.map(o => {
            const active = String(value) === o.v;
            return (
              <button key={o.v} type="button" onClick={() => onChange(o.v)}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: 'none', cursor: 'pointer', background: active ? 'var(--neox-bg-card,#fff)' : 'transparent', color: active ? 'var(--neox-fg-primary)' : 'var(--neox-fg-secondary,#6b7280)', fontWeight: active ? 600 : 500, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
                {enumLabel(o, zh)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (spec.type === 'range') {
    const min = spec.min ?? 0, max = spec.max ?? 100, step = spec.step ?? 1;
    if (max - min <= 12) {
      const cur = Number(value ?? min);
      return (
        <div style={row}>
          {labelNode}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button type="button" disabled={cur <= min} onClick={() => onChange(Math.max(min, cur - step))} style={stepBtn}>−</button>
            <span style={{ fontSize: 12, fontWeight: 600, minWidth: 16, textAlign: 'center', color: 'var(--neox-fg-primary)' }}>{cur}</span>
            <button type="button" disabled={cur >= max} onClick={() => onChange(Math.min(max, cur + step))} style={stepBtn}>+</button>
          </div>
        </div>
      );
    }
    const cur = Number(value ?? max);
    return (
      <div style={row}>
        {labelNode}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input type="range" min={min} max={max} step={step} value={cur} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 130 }} />
          <span style={{ fontSize: 11, color: 'var(--neox-fg-secondary)', minWidth: 30 }}>{cur}</span>
        </div>
      </div>
    );
  }

  if (spec.type === 'boolean') {
    const on = value === true;
    return (
      <div style={row}>
        {labelNode}
        <button type="button" onClick={() => onChange(!on)}
          style={{ width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', position: 'relative', background: on ? '#3b82f6' : 'var(--neox-bg-subtle, rgba(0,0,0,0.15))', transition: 'background 0.15s' }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
        </button>
      </div>
    );
  }
  return null;
};

const stepBtn: React.CSSProperties = { fontSize: 13, width: 22, height: 22, borderRadius: 5, border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: 'var(--neox-fg-secondary,#6b7280)', cursor: 'pointer', lineHeight: 1 };

export default ImageParamsButton;
