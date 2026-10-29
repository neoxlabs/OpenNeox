import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { Segmented, Switch, NumberSettingInput, NeoxButton } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';


export interface FieldSpec {
  /** 覆盖路径, 与主进程 EDITABLE_PROFILE_PATHS 一一对应 */
  path: string;
  label: string;
  desc?: string;
  kind: 'switch' | 'segmented' | 'number' | 'text';
  options?: Array<{ value: string; label: string }>;
  /** number 用 */
  min?: number;
  max?: number;
  /** 秒 ↔ 毫秒: 存的是 ms, 给用户看秒 */
  unit?: 'ms-as-seconds';
  runtimeDefault?: unknown;
  /** text 用: 占位和字数上限 */
  placeholder?: string;
  maxLength?: number;
}

export interface FieldGroupSpec {
  title: string;
  desc?: string;
  /** 分组头的小插画 (NeoxIllus 透明底 PNG) */
  art?: string;
  fields: FieldSpec[];
}

export function buildFieldGroups(zh: boolean): FieldGroupSpec[] {
  return [
    {
      title: zh ? '推理' : 'Reasoning',
      art: NeoxIllus.fitHero,
      desc: zh
        ? '仅 GPT 系 (Responses 接口) 生效，输入框的推理档位优先。'
        : 'GPT family (Responses API) only. The model menu setting takes precedence.',
      fields: [
        {
          path: 'reasoning.effort',
          label: zh ? '推理强度' : 'Effort',
          desc: zh ? '模型不支持的档位会被忽略。' : 'Unsupported levels are ignored.',
          kind: 'segmented',
          options: [
            { value: 'minimal', label: zh ? '最低' : 'Min' },
            { value: 'low', label: zh ? '低' : 'Low' },
            { value: 'medium', label: zh ? '中' : 'Med' },
            { value: 'high', label: zh ? '高' : 'High' },
            { value: 'xhigh', label: zh ? '极高' : 'X-high' },
          ],
        },
        {
          path: 'reasoning.summary',
          label: zh ? '思考过程摘要' : 'Reasoning summary',
          desc: zh ? '思考过程的显示详略。' : 'Detail level of shown reasoning.',
          kind: 'segmented',
          options: [
            { value: 'auto', label: zh ? '自动' : 'Auto' },
            { value: 'concise', label: zh ? '简要' : 'Concise' },
            { value: 'detailed', label: zh ? '详细' : 'Detailed' },
          ],
        },
      ],
    },
    {
      title: zh ? '任务推进' : 'Task progression',
      art: NeoxIllus.fitStrict,
      desc: zh
        ? '判定任务是否真正完成。'
        : 'How strictly task completion is checked.',
      fields: [
        {
          path: 'completion.unknownTaskFallback',
          label: zh ? '意图不明确时' : 'When intent is unclear',
          desc: zh
            ? '严格：至少执行一次工具才算完成。'
            : 'Strict: at least one tool call before finishing.',
          kind: 'segmented',
          options: [
            { value: 'lenient', label: zh ? '宽松' : 'Lenient' },
            { value: 'strict', label: zh ? '严格' : 'Strict' },
          ],
        },
      ],
    },
    {
      title: zh ? '连接' : 'Connection',
      art: NeoxIllus.fitRetry,
      desc: zh ? '网络不稳或响应慢时调整。' : 'For flaky networks or slow models.',
      fields: [
        {
          path: 'transport.openai.parallelToolCalls',
          /* openai.ts: `this.transportProfile?.parallelToolCalls ?? true` */
          runtimeDefault: true,
          label: zh ? '允许一次调多个工具' : 'Parallel tool calls',
          desc: zh ? '关闭后更稳，速度稍慢。' : 'Off is steadier, slightly slower.',
          kind: 'switch',
        },
        {
          path: 'transport.openai.requestTimeoutMs',
          label: zh ? '请求超时' : 'Request timeout',
          desc: zh ? '秒。' : 'Seconds.',
          kind: 'number',
          min: 10,
          max: 1800,
          unit: 'ms-as-seconds',
        },
        {
          path: 'transport.openai.streamRequestTimeoutMs',
          label: zh ? '流式请求超时' : 'Streaming timeout',
          desc: zh ? '秒。' : 'Seconds.',
          kind: 'number',
          min: 10,
          max: 3600,
          unit: 'ms-as-seconds',
        },
        {
          path: 'behavior.retryOnIncompleteStream',
          label: zh ? '流断了自动重试' : 'Retry on incomplete stream',
          kind: 'switch',
        },
      ],
    },
    {
      title: zh ? '提示词' : 'Prompt',
      art: NeoxIllus.fitNote,
      fields: [
        {
          path: 'prompt.language',
          label: zh ? '系统提示词语言' : 'System prompt language',
          kind: 'segmented',
          options: [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'EN' },
          ],
        },
        {
          path: 'prompt.userInstructions',
          label: zh ? '专属指令' : 'Custom instructions',
          desc: zh ? '随每次请求发送，仅对该模型生效。' : 'Sent with every request to this model.',
          kind: 'text',
          placeholder: zh ? '例：回复不要用表格' : 'e.g. No tables in replies',
          maxLength: 800,
        },
      ],
    },
  ];
}

/** 从 `a.b.c` 取值 */
export function pickPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

interface RowProps {
  field: FieldSpec;
  effective: any;
  builtin: any;
  overridden: boolean;
  disabled?: boolean;
  onChange: (path: string, value: unknown) => void;
}

export const ProfileFieldRow: React.FC<RowProps> = ({ field, effective, builtin, overridden, disabled, onChange }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const rawSet = pickPath(effective, field.path);
  /* 没定这一格时按运行时真正用的值显示 (runtimeDefault), 不然开关跟实际相反 */
  const raw = (rawSet === undefined || rawSet === null) && field.runtimeDefault !== undefined ? field.runtimeDefault : rawSet;
  const builtinRaw = pickPath(builtin, field.path);
  const [textDraft, setTextDraft] = React.useState(typeof rawSet === 'string' ? rawSet : '');
  React.useEffect(() => { setTextDraft(typeof rawSet === 'string' ? rawSet : ''); }, [rawSet]);

  const toDisplay = (v: any) => (field.unit === 'ms-as-seconds' && typeof v === 'number' ? Math.round(v / 1000) : v);
  const fromDisplay = (v: number) => (field.unit === 'ms-as-seconds' ? v * 1000 : v);

  let control: React.ReactNode = null;
  if (field.kind === 'switch') {
    control = (
      <Switch
        checked={raw === true}
        disabled={disabled}
        aria-label={field.label}
        onChange={(v) => onChange(field.path, v)}
      />
    );
  } else if (field.kind === 'segmented') {
    control = (
      <Segmented
        value={raw == null ? '' : String(raw)}
        options={field.options || []}
        aria-label={field.label}
        onChange={(v) => {
          /* are.maxLevel 存的是数字, 分段控件给的是字符串 */
          const num = Number(v);
          onChange(field.path, field.path === 'are.maxLevel' && Number.isFinite(num) ? num : v);
        }}
      />
    );
  } else if (field.kind === 'text') {
    /* 失焦才存 —— 每敲一个字写一次配置文件没必要 */
    control = (
      <textarea
        className="mp-field__text"
        rows={2}
        value={textDraft}
        maxLength={field.maxLength}
        placeholder={field.placeholder}
        disabled={disabled}
        aria-label={field.label}
        onChange={(e) => setTextDraft(e.target.value)}
        onBlur={() => {
          const next = textDraft.trim();
          if (next === (typeof rawSet === 'string' ? rawSet.trim() : '')) return;
          onChange(field.path, next ? next : null);
        }}
      />
    );
  } else {
    control = (
      <NumberSettingInput
        value={raw == null ? undefined : Number(toDisplay(raw))}
        min={field.min}
        max={field.max}
        width={88}
        disabled={disabled}
        ariaLabel={field.label}
        onCommit={(n) => onChange(field.path, fromDisplay(n))}
      />
    );
  }

  /* raw == null 的两种情况都得让用户看懂, 不能只留一排没高亮的按钮:
       · 适配包里本来就没定这一格 → "未设置", 走该字段自己的内置默认
       · 主进程没返回数据 → 由外层的失败提示说明, 这里控件禁用 */
  const unset = (rawSet === undefined || rawSet === null) && field.runtimeDefault === undefined && field.kind !== 'text';
  const usingRuntimeDefault = (rawSet === undefined || rawSet === null) && field.runtimeDefault !== undefined;

  return (
    <div className={`mp-field ${overridden ? 'overridden' : ''} mp-field--${field.kind}`}>
      <div className="mp-field__info">
        <span className="mp-field__label">
          {field.label}
          {unset && !overridden && (
            <span className="mp-field__unset">{zh ? '未设置' : 'Unset'}</span>
          )}
          {usingRuntimeDefault && !overridden && (
            <span className="mp-field__unset">{zh ? '默认' : 'Default'}</span>
          )}
          {overridden && (
            <button
              type="button"
              className="mp-field__revert"
              disabled={disabled}
              onClick={() => onChange(field.path, null)}
              title={zh
                ? `恢复内置默认${builtinRaw === undefined ? '' : `（${String(builtinRaw)}）`}`
                : `Reset to built-in${builtinRaw === undefined ? '' : ` (${String(builtinRaw)})`}`}
            >
              {zh ? '已改 · 恢复' : 'Changed · reset'}
            </button>
          )}
        </span>
        {field.desc && <span className="mp-field__desc">{field.desc}</span>}
      </div>
      <div className="mp-field__control">{control}</div>
    </div>
  );
};

interface GroupsProps {
  groups: FieldGroupSpec[];
  effective: any;
  builtin: any;
  overrides: Record<string, unknown>;
  disabled?: boolean;
  onChange: (path: string, value: unknown) => void;
  onResetAll?: () => void;
  overriddenCount: number;
}

export const ProfileFieldGroups: React.FC<GroupsProps> = ({
  groups, effective, builtin, overrides, disabled, onChange, onResetAll, overriddenCount,
}) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  return (
    <>
      <div className="mp-fields-head">
        <span className="mp-tool-count">
          {overriddenCount > 0
            ? (zh ? `${overriddenCount} 项已改过` : `${overriddenCount} changed`)
            : (zh ? '全部使用内置默认' : 'All built-in defaults')}
        </span>
        {overriddenCount > 0 && onResetAll && (
          <NeoxButton size="sm" onClick={onResetAll} disabled={disabled}>
            {zh ? '全部恢复默认' : 'Reset all'}
          </NeoxButton>
        )}
      </div>
      {groups.map((g) => (
        <div className="mp-field-group" key={g.title}>
          <div className={`mp-field-group__head${g.art ? ' has-art' : ''}`}>
            {g.art && (
              <span className="mp-field-group__art" aria-hidden="true">
                <img src={g.art} alt="" draggable={false} />
              </span>
            )}
            <span className="mp-field-group__title">
              <h4>{g.title}</h4>
              {g.desc && <p>{g.desc}</p>}
            </span>
          </div>
          <div className="mp-field-list">
            {g.fields.map((f) => (
              <ProfileFieldRow
                key={f.path}
                field={f}
                effective={effective}
                builtin={builtin}
                overridden={pickPath(overrides, f.path) !== undefined}
                disabled={disabled}
                onChange={onChange}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
};
