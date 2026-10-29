import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { getDocumentParseMode, setDocumentParseMode, type DocumentParseMode } from '../../../services/documentParseClient';
import { PageTitle, NeoxInput, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, RowIcon } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';
import './ExperimentalTab.clay.css';

type FlagKey = 'enableFGTS' | 'enablePTC' | 'enableCheckpoint';

const ExperimentalTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';

  const [flags, setFlags] = useState<Record<FlagKey, boolean>>({ enableFGTS: false, enablePTC: false, enableCheckpoint: true });
  const [docParseMode, setDocParseModeState] = useState<DocumentParseMode>(() => getDocumentParseMode());

  useEffect(() => {
    (async () => {
      try {
        const config = await window.neox.experimentalGetConfig?.();
        if (config) setFlags({ enableFGTS: config.enableFGTS, enablePTC: config.enablePTC, enableCheckpoint: config.enableCheckpoint });
      } catch (e) {
        console.error('Failed to load experimental config:', e);
      }
    })();
  }, []);

  const setFlag = useCallback((key: FlagKey, value: boolean) => {
    setFlags(prev => ({ ...prev, [key]: value }));
    window.neox.experimentalSetConfig?.({ [key]: value }).catch((e: unknown) =>
      console.error('Failed to update experimental config:', e),
    );
  }, []);

  const handleDocParseModeChange = useCallback((mode: DocumentParseMode) => {
    setDocumentParseMode(mode);
    setDocParseModeState(mode);
  }, []);

  const onCount = Object.values(flags).filter(Boolean).length;

  const cards: Array<{ key: FlagKey; art: string; title: string; tag: string; desc: string; anchor?: string }> = [
    {
      key: 'enableFGTS',
      art: NeoxIllus.expFgts,
      title: zh ? '工具参数边写边传' : 'Stream tool arguments',
      tag: zh ? '仅 Anthropic' : 'Anthropic only',
      desc: zh ? '模型还在写参数就开始传，少等一个来回。' : 'Sends tool arguments while the model is still writing them.',
    },
    {
      key: 'enablePTC',
      art: NeoxIllus.expPtc,
      title: zh ? '脚本批量调工具' : 'Scripted tool calls',
      tag: zh ? 'GPT 自动跳过' : 'Skipped on GPT',
      desc: zh ? '一段脚本串起多个工具，一次跑完。' : 'One short script chains several tools in a single step.',
    },
    {
      key: 'enableCheckpoint',
      art: NeoxIllus.expSnap,
      title: zh ? '文件快照 / 回滚' : 'File checkpoints',
      tag: zh ? '推荐开' : 'Recommended',
      desc: zh
        ? '每轮改动前拍快照，改坏了在右栏一键回滚。快照存在 用户目录/.neox/checkpoints，单个项目最多约 200 MB，可在 设置 → 存储 里清理；主目录、磁盘根目录下不会启用。'
        : 'Snapshots files before each turn; roll a turn back from the right panel. Stored in ~/.neox/checkpoints, capped at ~200 MB per project, clearable under Settings → Storage. Disabled in home or drive-root workspaces.',
      anchor: 'setting-checkpoint',
    },
  ];

  return (
    <div className="settings-panel-content ex3">
      <PageTitle
        title={zh ? '实验性功能' : 'Experimental'}
        subtitle={zh ? '还在打磨的新能力，先给你用 · 切换后下一条消息生效，不用重启' : 'Still being tuned, yours to try · changes apply from the next message, no restart'}
      />

      <Section>
        <SectionTitle title={zh ? '工具调用' : 'Tool calls'} desc={zh ? `已开 ${onCount} / ${cards.length}` : `${onCount} of ${cards.length} on`} />
        <SettingsCard>
          {cards.map(c => (
            <SwitchRow
              key={c.key}
              id={c.anchor}
              leading={<RowIcon src={c.art} />}
              title={<>{c.title}<span className="set-tag">{c.tag}</span></>}
              ariaLabel={c.title}
              desc={c.desc}
              checked={flags[c.key]}
              onChange={(v) => setFlag(c.key, v)}
            />
          ))}
        </SettingsCard>
      </Section>

      {/* 文档解析: 两张选择卡 (本地 / 云端), 选中的那张钴蓝细边 + 右上小勾 */}
      <Section>
        <SectionTitle
          title={zh ? '文档解析' : 'Document parsing'}
          desc={docParseMode === 'local'
            ? (zh ? '本机解析，免费，文件不出本机。' : 'Parsed on this machine. Free, nothing leaves it.')
            : (zh ? '扫描件、复杂表格更准，按次计费。' : 'Better on scans and complex tables. Charged per parse.')}
        />
        <SettingsCard>
          <div className="ex3-pick" role="radiogroup" aria-label={zh ? '文档解析方式' : 'Document parsing mode'}>
            {([
              { value: 'local' as DocumentParseMode, title: zh ? '本地' : 'Local', sub: zh ? '免费 · 文件不出本机' : 'Free · stays on this machine', icon: <path d="M3.5 4.5h9v6.5h-9zM2 12.5h12" /> },
              { value: 'cloud' as DocumentParseMode, title: zh ? '云端' : 'Cloud', sub: zh ? '按次计费 · 扫描件更准' : 'Per parse · better on scans', icon: <path d="M5.2 12.5h6.1a2.7 2.7 0 0 0 .3-5.4 3.9 3.9 0 0 0-7.4 1 2.2 2.2 0 0 0 .9 4.4z" /> },
            ]).map(o => {
              const on = docParseMode === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`ex3-pick__card${on ? ' is-on' : ''}`}
                  onClick={() => handleDocParseModeChange(o.value)}
                >
                  <span className="ex3-pick__ico">
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{o.icon}</svg>
                  </span>
                  <span className="ex3-pick__title">{o.title}</span>
                  <span className="ex3-pick__sub">{o.sub}</span>
                  {on && (
                    <span className="ex3-pick__check" aria-hidden="true">
                      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.3 6.6 11.2 12.5 4.8" /></svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </SettingsCard>
      </Section>

      <JevSection zh={zh} />
    </div>
  );
};

type JevTestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; ms: number; model: string }
  | { kind: 'fail'; error: string };

/* Jev 加持 — 用户自带 TypeSafe key; 开了之后每条消息先让 Jev 预判要用的工具包并提前解锁。
 * key 只存密文, 主进程不回传明文, 这里只拿到末 4 位用来回显。 */
const JevSection: React.FC<{ zh: boolean }> = ({ zh }) => {
  const [enabled, setEnabled] = useState(false);
  const [keyHint, setKeyHint] = useState('');
  const [draft, setDraft] = useState('');
  const [test, setTest] = useState<JevTestState>({ kind: 'idle' });

  const reload = useCallback(async () => {
    const config = await window.neox.experimentalGetConfig?.();
    if (!config) return;
    setEnabled(config.jevEnabled === true);
    setKeyHint(typeof config.jevKeyHint === 'string' ? config.jevKeyHint : '');
  }, []);

  useEffect(() => {
    reload().catch((e: unknown) => console.error('Failed to load Jev config:', e));
  }, [reload]);

  const toggle = useCallback((next: boolean) => {
    setEnabled(next);
    window.neox.experimentalSetConfig?.({ jevEnabled: next }).catch((e: unknown) =>
      console.error('Failed to update Jev config:', e),
    );
  }, []);

  const runTest = useCallback(async (apiKey?: string) => {
    setTest({ kind: 'running' });
    const r = await window.neox.experimentalJevTest?.(apiKey);
    if (r?.success) setTest({ kind: 'ok', ms: r.ms, model: r.model });
    else setTest({ kind: 'fail', error: r?.error === 'no_key' ? (zh ? '还没填 key' : 'No key yet') : String(r?.error ?? 'unknown') });
  }, [zh]);

  /* 保存前先真测一次 —— 填错的 key 不落盘, 免得开着开关却每轮静默失败 */
  const saveKey = useCallback(async () => {
    const key = draft.trim();
    if (!key) return;
    setTest({ kind: 'running' });
    const r = await window.neox.experimentalJevTest?.(key);
    if (!r?.success) {
      setTest({ kind: 'fail', error: String(r?.error ?? 'unknown') });
      return;
    }
    await window.neox.experimentalSetConfig?.({ jevApiKey: key });
    setDraft('');
    setTest({ kind: 'ok', ms: r.ms, model: r.model });
    await reload();
  }, [draft, reload]);

  const clearKey = useCallback(async () => {
    await window.neox.experimentalSetConfig?.({ jevApiKey: '' });
    setTest({ kind: 'idle' });
    await reload();
  }, [reload]);

  const live = enabled && !!keyHint;
  const status = test.kind === 'running'
    ? { tone: '', text: zh ? '测试中…' : 'Testing…' }
    : test.kind === 'ok'
      ? { tone: 'ok', text: zh ? `连通 · ${test.ms}ms` : `Connected · ${test.ms}ms` }
      : test.kind === 'fail'
        ? { tone: 'bad', text: zh ? `失败：${test.error}` : `Failed: ${test.error}` }
        : keyHint
          ? { tone: '', text: zh ? `已保存 ${keyHint}` : `Saved ${keyHint}` }
          : { tone: '', text: zh ? '还没填 key，开关不会生效' : 'No key yet — the switch has no effect' };

  return (
    <Section>
      <SectionTitle title={zh ? 'Jev 加持' : 'Jev boost'} />
      <div id="setting-jev">
        <SettingsCard>
          <SwitchRow
            leading={<RowIcon src={NeoxIllus.expJev} />}
            title={zh ? 'Jev 加持' : 'Jev boost'}
            desc={zh
              ? '发消息前先预判要用的工具，提前备好。你输入的内容会发给 TypeSafe。'
              : 'Predicts the tools a message needs and readies them first. What you type is sent to TypeSafe.'}
            checked={enabled}
            onChange={toggle}
          />
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.apiHero} />}
            title={zh ? 'TypeSafe key' : 'TypeSafe key'}
            desc={(
              <>
                <span className={`exp-jev__status${status.tone ? ` is-${status.tone}` : ''}${live ? ' is-live' : ''}`}>{status.text}</span>
                {' · '}{zh ? '在 console.typesafe.ai/keys 获取' : 'Get one at console.typesafe.ai/keys'}
              </>
            )}
            control={(
              <span className="exp-jev__key">
                <span className="exp-jev__input">
                  <NeoxInput
                    type="password"
                    value={draft}
                    placeholder={keyHint ? (zh ? '替换 key' : 'Replace key') : 'API key'}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
                  />
                </span>
                {draft.trim()
                  ? <NeoxButton variant="secondary" size="sm" disabled={test.kind === 'running'} onClick={() => void saveKey()}>{zh ? '保存' : 'Save'}</NeoxButton>
                  : keyHint
                    ? (
                      <>
                        <NeoxButton variant="secondary" size="sm" disabled={test.kind === 'running'} onClick={() => void runTest()}>{zh ? '测试' : 'Test'}</NeoxButton>
                        <NeoxButton variant="ghost" size="sm" onClick={() => void clearKey()}>{zh ? '清除' : 'Clear'}</NeoxButton>
                      </>
                    )
                    : null}
              </span>
            )}
          />
        </SettingsCard>
      </div>
    </Section>
  );
};

export default ExperimentalTab;
