import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';
import { NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, RowIcon } from '../../../components/settings-base';
import { pickPath } from './ModelProfileFields';
import { CustomSelect } from '../../../components/CustomSelect';
import Icons from '../../../components/Icons';


type Fix = {
  id: string;
  art: string;
  path: string;
  on: unknown;
  /** 关闭且内置值本来就是"开"时, 写这个值把它关掉 */
  off: unknown;
  isOn: (v: unknown) => boolean;
  title: { zh: string; en: string };
  does: { zh: string; en: string };
};

const FIXES: Fix[] = [
  {
    id: 'strict',
    art: NeoxIllus.fitStrict,
    path: 'completion.unknownTaskFallback',
    on: 'strict',
    off: 'lenient',
    isOn: (v) => v === 'strict',
    title: { zh: '说「做完了」, 其实没动手', en: 'Says "done" without doing anything' },
    does: { zh: '要求至少执行一次操作才能结束。', en: 'Requires at least one real action before finishing.' },
  },
  {
    id: 'trunc',
    art: NeoxIllus.fitTrunc,
    path: 'behavior.retryOnIncompleteStream',
    on: true,
    off: false,
    isOn: (v) => v === true,
    title: { zh: '回复写到一半就断了', en: 'Replies cut off halfway' },
    does: { zh: '断流时自动重试。', en: 'Retries automatically when the stream drops.' },
  },
  {
    id: 'timeout',
    art: NeoxIllus.fitRetry,
    path: 'transport.openai.streamRequestTimeoutMs',
    on: 900_000,
    /* 内置适配包默认 480s (kernel/profiles/defaults.ts) */
    off: 480_000,
    isOn: (v) => typeof v === 'number' && v >= 900_000,
    title: { zh: '经常超时', en: 'Keeps timing out' },
    does: { zh: '单次请求等待上限 8 分钟 → 15 分钟。', en: 'Request time limit 8 → 15 minutes.' },
  },
];

/** 「老是改不对文件」: 关掉这两个按原文替换的工具, 模型只能用 write_file 整个重写 */
const EDIT_TOOLS = ['edit', 'edit_batch'];

export const ModelFitSimple: React.FC<{
  models: any[];
  selected: any;
  current: any;
  onSelect: (mp: any) => void;
  resolved: any;
  loading: boolean;
  busy: boolean;
  overriddenCount: number;
  onSet: (path: string, value: unknown) => Promise<void> | void;
  onResetAll: () => void;
  /** 关工具之后让设置页重新读一遍 (极客模式的工具表跟着变) */
  onToolsChanged: () => void;
  onOpenToolList: () => void;
}> = ({ models, selected, current, onSelect, resolved, loading, busy, overriddenCount, onSet, onResetAll, onToolsChanged, onOpenToolList }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const keyOf = (mp: any) => `${mp?.providerId}::${mp?.model}`;
  const isCurrent = !!selected && !!current && keyOf(selected) === keyOf(current);
  const api = (window as any).neox;

  /* ── 工具开关 (改文件) ── */
  const [disabledTools, setDisabledTools] = React.useState<string[] | null>(null);
  const [toolSource, setToolSource] = React.useState<string>('builtin');
  const [toolBusy, setToolBusy] = React.useState(false);
  const loadTools = React.useCallback(async () => {
    if (!selected?.model) { setDisabledTools(null); return; }
    const res = await api?.modelProfileGetToolsetOverride?.({
      model: selected.model,
      profileId: selected.profileId,
      builtinDisabledTools: selected.builtinDisabledTools ?? selected.disabledTools ?? [],
    }).catch(() => null);
    setDisabledTools(res?.success ? (res.effectiveDisabledTools ?? []) : null);
    setToolSource(res?.source ?? 'builtin');
  }, [api, selected?.model, selected?.profileId, selected?.builtinDisabledTools, selected?.disabledTools]);
  React.useEffect(() => { void loadTools(); }, [loadTools]);
  const editOff = !!disabledTools && EDIT_TOOLS.every((t) => disabledTools.includes(t));
  const toggleEdit = async (off: boolean) => {
    if (!disabledTools || !selected?.model) return;
    setToolBusy(true);
    try {
      const next = off
        ? Array.from(new Set([...disabledTools, ...EDIT_TOOLS]))
        : disabledTools.filter((t) => !EDIT_TOOLS.includes(t));
      await api?.modelProfileSetToolsetOverride?.({ model: selected.model, disabledTools: next });
      await loadTools();
      onToolsChanged();
    } finally {
      setToolBusy(false);
    }
  };

  /* ── 专属叮嘱 ── */
  const savedNote = String(pickPath(resolved?.effective, 'prompt.userInstructions') ?? '');
  const [note, setNote] = React.useState(savedNote);
  const [noteSaving, setNoteSaving] = React.useState(false);
  React.useEffect(() => { setNote(savedNote); }, [savedNote, selected?.model]);
  const noteDirty = note.trim() !== savedNote.trim();
  const saveNote = async () => {
    setNoteSaving(true);
    try { await onSet('prompt.userInstructions', note.trim() ? note.trim() : null); } finally { setNoteSaving(false); }
  };

  const toggle = (f: Fix, next: boolean) => {
    const builtinOn = f.isOn(pickPath(resolved?.builtin, f.path));
    /* 目标状态跟内置一致 → 清掉覆盖; 不一致 → 写覆盖。这样"恢复默认"永远是干净的 */
    if (next === builtinOn) void onSet(f.path, null);
    else void onSet(f.path, next ? f.on : f.off);
  };

  return (
    <div className="mfs">
      <Section>
        <SettingsCard>
          <SettingsRow
            leading={<span className="mf3-ico"><Icons.Sliders /></span>}
            title={zh ? '模型' : 'Model'}
            desc={zh ? '仅作用于所选模型，可随时恢复默认。' : 'Applies to the selected model only. Reset anytime.'}
            control={(
              <span className="mfs-picker">
                <CustomSelect
                  className="mfs-picker__select"
                  value={keyOf(selected)}
                  onChange={(v) => {
                    const mp = models.find((m) => keyOf(m) === v);
                    if (mp) onSelect(mp);
                  }}
                  options={models.map((m) => ({
                    value: keyOf(m),
                    label: `${m.model} · ${m.providerName}${keyOf(m) === keyOf(current) ? (zh ? ' (当前)' : ' (current)') : ''}`,
                  }))}
                />
                {isCurrent && <em>{zh ? '正在用' : 'In use'}</em>}
              </span>
            )}
          />
        </SettingsCard>
      </Section>

      {loading ? (
        <div className="mfs-note neox-text-shimmer">{zh ? '读取中…' : 'Loading…'}</div>
      ) : !resolved ? (
        <div className="mfs-note">
          {zh ? '读不到这个模型的适配。若刚更新过应用，重启一次即可。' : 'Could not read this model’s adaptation. If the app was just updated, restart it.'}
        </div>
      ) : (
        <>
          <Section>
            <SectionTitle title={zh ? '常见症状' : 'Common symptoms'} />
            <SettingsCard>
              {FIXES.map((f) => {
                const on = f.isOn(pickPath(resolved.effective, f.path));
                const changed = pickPath(resolved.overrides, f.path) !== undefined;
                const title = zh ? f.title.zh : f.title.en;
                return (
                  <SwitchRow
                    key={f.id}
                    leading={<RowIcon src={f.art} />}
                    title={<>{title}{changed && <span className="set-tag">{zh ? '已修改' : 'Modified'}</span>}</>}
                    ariaLabel={title}
                    desc={zh ? f.does.zh : f.does.en}
                    checked={on}
                    disabled={busy}
                    onChange={(v) => toggle(f, v)}
                  />
                );
              })}
              <SwitchRow
                leading={<RowIcon src={NeoxIllus.fitEdit} />}
                title={<>{zh ? '老是改不对文件' : 'Keeps botching file edits'}{toolSource === 'model' && <span className="set-tag">{zh ? '已修改' : 'Modified'}</span>}</>}
                ariaLabel={zh ? '老是改不对文件' : 'Keeps botching file edits'}
                desc={zh ? '改为整文件重写，不再局部替换。' : 'Rewrites whole files instead of patching.'}
                checked={editOff}
                disabled={toolBusy || disabledTools === null}
                onChange={(v) => void toggleEdit(v)}
              />
            </SettingsCard>
          </Section>

          <Section>
            <SectionTitle title={zh ? '专属指令' : 'Custom instructions'} />
            <SettingsCard>
              <SettingsRow className="nx-row--top mfs-noterow">
                <span className="nx-row__leading"><RowIcon src={NeoxIllus.fitNote} /></span>
                <span className="nx-row__info">
                  <span className="nx-row__title">{zh ? '给这个模型的叮嘱' : 'Notes for this model'}</span>
                  <span className="nx-row__desc">{zh ? '随每次请求发送，仅对该模型生效。' : 'Sent with every request to this model.'}</span>
                  <textarea
                    value={note}
                    maxLength={800}
                    rows={3}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={zh ? '例：回复不要用表格；代码注释用中文；不要修改 package-lock.json' : 'e.g. No tables in replies; never touch package-lock.json'}
                  />
                  <span className="mfs-notecard__actions">
                    <span>{note.length}/800</span>
                    {savedNote && !noteDirty && (
                      <button type="button" className="mfs-link" disabled={noteSaving || busy} onClick={() => { setNote(''); void onSet('prompt.userInstructions', null); }}>
                        {zh ? '清空' : 'Clear'}
                      </button>
                    )}
                    <NeoxButton size="sm" onClick={() => void saveNote()} disabled={!noteDirty || noteSaving || busy}>
                      {noteSaving ? (zh ? '保存中…' : 'Saving…') : noteDirty ? (zh ? '保存' : 'Save') : (zh ? '已保存' : 'Saved')}
                    </NeoxButton>
                  </span>
                </span>
              </SettingsRow>
            </SettingsCard>
          </Section>

          <div className="mfs-foot">
            <button type="button" className="mfs-link" onClick={onOpenToolList}>
              {zh ? '更多设置 →' : 'More settings →'}
            </button>
            {overriddenCount > 0 && (
              <NeoxButton size="sm" onClick={onResetAll} disabled={busy}>
                {zh ? `恢复默认 (${overriddenCount} 项)` : `Reset (${overriddenCount})`}
              </NeoxButton>
            )}
          </div>
        </>
      )}
    </div>
  );
};
