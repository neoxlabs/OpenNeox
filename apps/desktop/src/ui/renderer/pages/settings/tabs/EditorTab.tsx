import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useSettingsContext } from '../SettingsContext';
import KeymapTab from './KeymapTab';
import { CustomSelect } from '../../../components/CustomSelect';
import Icons from '../../../components/Icons';
import { isChatModelInfo } from '../../../utils/modelKind';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  Switch,
} from '../../../components/settings-base';
import './EditorTab.clay.css';

/* 线条图标 (16px, 1.5 粗细) —— 行左边 28px 软方块里放 (UI 3.0 陶土风) */
const LineIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const IconSpark = () => <LineIcon><path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" /></LineIcon>;
const IconCube = () => <LineIcon><path d="M8 2.2l5 2.8v6l-5 2.8-5-2.8v-6z" /><path d="M3 5l5 2.8L13 5M8 7.8v6" /></LineIcon>;
const IconChip = () => <LineIcon><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" /></LineIcon>;

interface InlineCompletionConfig {
  enabled: boolean;
  providerId?: string;
  model?: string;
  effective?: { providerId: string; model: string; source: 'override' | 'auto'; isFast: boolean };
}

const EditorTab: React.FC = () => {
  const { language } = useI18n();
  const { providers } = useSettingsContext();
  const isZh = language === 'zh';

  const [cfg, setCfg] = useState<InlineCompletionConfig>({ enabled: true });
  /* 设置搜索跳到 #setting-keymap 时由 navigateToSetting 把 details 打开, onToggle 同步到这里 */
  const [keymapOpen, setKeymapOpen] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const c = await (window as any).neox?.aiGetInlineCompleteConfig?.();
      if (c) setCfg(c);
    } catch (e) {
      console.error('Failed to load inline completion config:', e);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const updateConfig = useCallback(async (updates: {
    enabled?: boolean; providerId?: string | null; model?: string | null;
  }) => {
    try {
      await (window as any).neox?.aiSetInlineCompleteConfig?.(updates);
      await loadConfig();
    } catch (e) {
      console.error('Failed to save inline completion config:', e);
    }
  }, [loadConfig]);

  const eff = cfg.effective;
  const selectedProvider = providers.find((p: any) => p.id === cfg.providerId);
  const availableModels: string[] = selectedProvider?.models?.map((m: any) => m.name).filter(Boolean) ?? [];

  const stateText = !cfg.enabled
    ? (isZh ? '已关闭' : 'Off')
    : eff
      ? (isZh
        ? `正在用 ${eff.model}${eff.isFast ? '' : '（偏慢，建议换 mini / flash / haiku）'}`
        : `Using ${eff.model}${eff.isFast ? '' : ' (slow — prefer mini / flash / haiku)'}`)
      : (isZh ? '还没有可用的模型，在下面选一个服务商。' : 'No model available yet — pick a provider below.');
  const stateWarn = cfg.enabled && (!eff || !eff.isFast);

  return (
    <div className="settings-panel-content ed3">
      <PageTitle
        title={isZh ? '编辑器' : 'Editor'}
        subtitle={isZh ? '代码补全和快捷键' : 'Code completion and shortcuts'}
      />

      <Section>
        <SectionTitle title={isZh ? '补全' : 'Completion'} />
        <SettingsCard>
          <SettingsRow
            leading={<span className="ed3-ico"><IconSpark /></span>}
            title={isZh ? '打字时给出补全建议' : 'Suggestions while you type'}
            desc={(
              <>
                {isZh ? '灰字提示接下来要写的内容，按 Tab 采纳。' : 'Grey text suggests what comes next — Tab to accept.'}
                <span className={`ed3-state${stateWarn ? ' is-warn' : ''}`}>{stateText}</span>
              </>
            )}
            control={<Switch checked={cfg.enabled} aria-label={isZh ? '行内补全' : 'Inline completion'} onChange={(v) => updateConfig({ enabled: v })} />}
          />
          {cfg.enabled && (
            <SettingsRow
              leading={<span className="ed3-ico"><IconCube /></span>}
              title={isZh ? '服务商' : 'Provider'}
              desc={isZh ? '选「默认」就用你在对话里当前选的模型。' : '"Default" uses the model currently selected in chat.'}
              control={
                <div className="ed3-select">
                  <CustomSelect
                    value={cfg.providerId ?? ''}
                    onChange={(v) => updateConfig({ providerId: v || null, model: null })}
                    options={[
                      { value: '', label: isZh ? '默认' : 'Default' },
                      ...providers.map((p: any) => ({ value: p.id, label: p.name || p.id })),
                    ]}
                  />
                </div>
              }
            />
          )}
          {cfg.enabled && cfg.providerId && (
            <SettingsRow
              leading={<span className="ed3-ico"><IconChip /></span>}
              title={isZh ? '模型' : 'Model'}
              desc={isZh ? '小模型最跟手：haiku / mini / flash。' : 'Small models feel best: haiku / mini / flash.'}
              control={
                <div className="ed3-select">
                  <CustomSelect
                    value={cfg.model ?? ''}
                    onChange={(v) => updateConfig({ model: v || null })}
                    options={[
                      { value: '', label: isZh ? '自动 (优先选 fast hint)' : 'Auto (prefer fast hint)' },
                      /* 行内补全用的模型 —— 图像模型进来毫无意义 (它不会补全代码),
                       * 跟团队指挥官下拉同一个判据。 */
                      ...availableModels.filter((m) => isChatModelInfo({ id: m, name: m }))
                        .map((m) => ({ value: m, label: m })),
                    ]}
                  />
                </div>
              }
            />
          )}
        </SettingsCard>
        {cfg.enabled && <p className="ed-note">{isZh ? 'Cmd+K 行内编辑不走这里，始终用主模型。' : 'Cmd+K inline edit always uses the main model.'}</p>}
      </Section>

      {/* 快捷键默认收起: 17 行 IDE 文件操作平铺会把整页撑到三屏 (设置页首页不平铺列表) */}
      <Section>
        <details className="ed-keymap" id="setting-keymap" open={keymapOpen} onToggle={(e) => setKeymapOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="ed-keymap__summary">
            <Icons.ChevronRight />
            <span className="ed-keymap__title">{isZh ? '键盘快捷键' : 'Keyboard shortcuts'}</span>
            <span className="ed-keymap__hint">{isZh ? '搜索、改键、恢复默认' : 'Search, rebind, reset'}</span>
          </summary>
          {keymapOpen && <KeymapTab embedded />}
        </details>
      </Section>
    </div>
  );
};

export default EditorTab;
