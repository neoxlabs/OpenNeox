import React, { useEffect, useRef, useState } from 'react';
import { NeoxInput } from './NeoxInput';

interface Props {
  /** 当前值 (已是展示单位, 如"秒") */
  value?: number;
  /** 提交时回调 —— 只在值合法且真的变了时触发 */
  onCommit: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  ariaLabel?: string;
  disabled?: boolean;
}

export const NumberSettingInput: React.FC<Props> = ({
  value, onCommit, min, max, step, width = 92, ariaLabel, disabled,
}) => {
  const [text, setText] = useState<string>(String(value ?? ''));
  const editingRef = useRef(false);
  const dirtyRef = useRef(false);

  /* 外部值变了 (别处改动 / 恢复默认) 且用户没在编辑 → 同步显示 */
  useEffect(() => {
    if (!editingRef.current) setText(String(value ?? ''));
  }, [value]);

  const commit = () => {
    editingRef.current = false;
    // Focus/blur, clearing, and Escape must not turn an unset value into min.
    if (!dirtyRef.current || text.trim() === '') {
      dirtyRef.current = false;
      setText(String(value ?? ''));
      return;
    }
    dirtyRef.current = false;
    const n = Number(text);
    if (!Number.isFinite(n)) { setText(String(value ?? '')); return; }
    let next = n;
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <NeoxInput
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      style={{ width }}
      aria-label={ariaLabel}
      value={text}
      onFocus={() => { editingRef.current = true; }}
      onChange={(e) => { editingRef.current = true; dirtyRef.current = true; setText(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') {
          dirtyRef.current = false;
          editingRef.current = false;
          setText(String(value ?? ''));
          e.currentTarget.blur();
        }
      }}
    />
  );
};
