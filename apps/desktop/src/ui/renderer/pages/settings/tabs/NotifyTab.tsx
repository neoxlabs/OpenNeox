import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useSettingsContext } from '../SettingsContext';
import { useNotifyConfig } from '../../../state/notifyStore';
import Icons from '../../../components/Icons';
import { CustomSelect } from '../../../components/CustomSelect';
import { PageTitle, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow } from '../../../components/settings-base';
import { featureIntrosEnabled, resetFeatureIntros, setFeatureIntrosEnabled } from '../../../components/featureIntro/FeatureIntro';
import './NotifyTab.clay.css';

/* 行首图标: 稿里的线条图标, 现成图标库没有的三个在这里画 (1.5 线宽由 NotifyTab.clay.css 压) */
const Glyph: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="nt3-glyph" aria-hidden="true">{children}</span>
);
const CheckCircleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.3 2.3 4.7-5" />
  </svg>
);
const MusicIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" />
  </svg>
);
const WindowIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18" />
  </svg>
);

const NotifyTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [notifyConfig, updateNotifyConfig] = useNotifyConfig();
  const { agentRuntime, setAgentRuntime } = useSettingsContext();
  const saveRt = async (partial: any) => {
    if (!agentRuntime) return;
    setAgentRuntime({ ...agentRuntime, ...partial } as any);
    try { await (window.neox as any).setAgentRuntimeConfig?.(partial); } catch (err) { console.error(err); }
  };

  const [availableSounds, setAvailableSounds] = useState<Array<{
    id: string;
    name: string;
    path?: string;
  }>>([{ id: 'none', name: 'None' }, { id: 'default', name: 'Default' }]);

  useEffect(() => {
    (async () => {
      try {
        const sounds = await window.neox.listAvailableSounds?.();
        if (sounds && sounds.length > 0) {
          setAvailableSounds(sounds);
        }
      } catch (error) {
        console.error('Failed to load available sounds:', error);
      }
    })();
  }, []);

  const [introsOn, setIntrosOn] = useState(featureIntrosEnabled);
  const [introsReset, setIntrosReset] = useState(false);

  const on = notifyConfig.enabled;
  const quiet = notifyConfig.quietHours;
  const setQuiet = (patch: Partial<typeof quiet>) => updateNotifyConfig({ ...notifyConfig, quietHours: { ...quiet, ...patch } });

  return (
    <div className="settings-panel-content nt3">
      <PageTitle
        title={zh ? '通知' : 'Notifications'}
        subtitle={zh ? '做完了叫你一声 · 只在你切到别的应用时才弹' : 'A heads-up when work is done · only when you are in another app'}
      />

      {/* UI 3.0: 总开关不再单独占页头, 放进「怎么提醒」第一行 */}
      <Section>
        <SectionTitle title={zh ? '怎么提醒' : 'How'} />
        <SettingsCard>
          <SwitchRow
            leading={<Glyph><CheckCircleIcon /></Glyph>}
            title={zh ? '任务完成时通知' : 'Notify when tasks finish'}
            checked={on}
            onChange={(v) => updateNotifyConfig({ ...notifyConfig, enabled: v })}
          />
          <SettingsRow
            leading={<Glyph><MusicIcon /></Glyph>}
            title={zh ? '提示音' : 'Sound'}
            desc={zh ? '完成时播放。' : 'Plays on completion.'}
            control={(
              <span className="nt-row">
                <span className="nt-row__grow">
                  <CustomSelect
                    className="nx-select-cs"
                    value={notifyConfig.sound}
                    disabled={!on}
                    onChange={(v) => updateNotifyConfig({ ...notifyConfig, sound: v })}
                    options={availableSounds.map(sound => ({
                      value: sound.id,
                      label: sound.id === 'none' ? (zh ? '无' : 'None')
                        : sound.id === 'default' ? (zh ? '默认' : 'Default')
                        : sound.name,
                    }))}
                  />
                </span>
                <NeoxButton
                  variant="ghost"
                  size="sm"
                  onClick={() => { if (notifyConfig.sound !== 'none') void window.neox.playSound?.(notifyConfig.sound); }}
                  disabled={!on || notifyConfig.sound === 'none'}
                  title={zh ? '试听' : 'Preview'}
                  aria-label={zh ? '试听' : 'Preview'}
                >
                  <Icons.Play />
                </NeoxButton>
              </span>
            )}
          />
          <SwitchRow
            advanced
            leading={<Glyph><WindowIcon /></Glyph>}
            title={zh ? '系统通知横幅' : 'System banner'}
            desc={zh ? '在系统通知中心显示。' : 'Shows in the notification center.'}
            checked={notifyConfig.systemNotification}
            disabled={!on}
            onChange={(v) => updateNotifyConfig({ ...notifyConfig, systemNotification: v })}
          />
          {agentRuntime && (
            <SwitchRow
              advanced
              leading={<Glyph><Icons.Cube /></Glyph>}
              title={zh ? '后台任务也通知' : 'Background work too'}
              desc={zh ? '后台命令、子 Agent 跑完也推。' : 'Background commands and sub-agents.'}
              checked={agentRuntime.osNotifications.enabled}
              onChange={(v) => void saveRt({ osNotifications: { ...agentRuntime.osNotifications, enabled: v } })}
            />
          )}
        </SettingsCard>
      </Section>

      {/* 免打扰时段 — 影响完成通知与提醒到点弹窗 */}
      <Section>
        <SectionTitle title={zh ? '免打扰' : 'Quiet hours'} />
        <SettingsCard>
          <SwitchRow
            leading={<Glyph><Icons.Moon /></Glyph>}
            title={zh ? '免打扰时段' : 'Quiet hours'}
            desc={zh ? '时段内一律不弹，到点自动恢复。' : 'Nothing pops in this window.'}
            checked={quiet.enabled}
            onChange={(v) => setQuiet({ enabled: v })}
          />
          {quiet.enabled && (
            <SettingsRow
              leading={<Glyph><Icons.Clock /></Glyph>}
              title={zh ? '时段' : 'Window'}
              control={(
                <span className="nt-row">
                  <input type="time" className="nx-select" value={quiet.start}
                    onChange={(e) => setQuiet({ start: e.target.value })} aria-label={zh ? '开始' : 'Start'} />
                  <span className="nt-row__arrow">→</span>
                  <input type="time" className="nx-select" value={quiet.end}
                    onChange={(e) => setQuiet({ end: e.target.value })} aria-label={zh ? '结束' : 'End'} />
                </span>
              )}
            />
          )}
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle title={zh ? '新手引导' : 'Guidance'} />
        <SettingsCard>
          <SwitchRow
            leading={<Glyph><Icons.Lightbulb /></Glyph>}
            title={zh ? '功能介绍' : 'Feature tips'}
            desc={zh ? '第一次用某个功能时，弹一次怎么用。' : 'Show how to use a feature the first time you open it.'}
            checked={introsOn}
            onChange={(v) => { setFeatureIntrosEnabled(v); setIntrosOn(v); }}
          />
          <SettingsRow
            leading={<Glyph><Icons.Play /></Glyph>}
            title={zh ? '介绍再看一遍' : 'Show tips again'}
            desc={introsReset
              ? (zh ? '已重置，下次进各功能会再弹。' : 'Reset. Each feature shows its tip again.')
              : (zh ? '看过的全部重新弹。' : 'Show every tip again.')}
            control={
              <NeoxButton variant="ghost" size="sm" disabled={introsReset}
                onClick={() => { resetFeatureIntros(); setIntrosOn(true); setIntrosReset(true); }}>
                {zh ? '重置' : 'Reset'}
              </NeoxButton>
            }
          />
        </SettingsCard>
      </Section>
    </div>
  );
};

export default NotifyTab;
