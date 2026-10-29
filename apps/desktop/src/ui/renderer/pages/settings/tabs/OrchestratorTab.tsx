import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { CustomSelect } from '../../../components/CustomSelect';
import { useEditionMembership as useMembership } from '../../../modules/shell/editionHooks';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../../shared/neoxCloud';
import { PageTitle, NumberSettingInput, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, RowIcon } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';
import './OrchestratorTab.clay.css';

const OrchestratorTab: React.FC = () => {
  const {
    providers,
    agenticSideAgentEnabled,
    handleAgenticSideAgentEnabledChange,
    agenticSideAgentDisableThinking,
    handleAgenticSideAgentDisableThinkingChange,
    agenticSideAgentToolUseSummary,
    handleAgenticSideAgentFeatureChange,
    agenticSideAgentSessionTitle,
    agentRuntime,
    setAgentRuntime,
    modelProfile,
  } = useSettingsContext();

  const { language } = useI18n();
  const zh = language === 'zh';
  const membership = useMembership();

  const mainModel: string = modelProfile?.model || '';
  const [taskAgentMap, setTaskAgentMap] = useState<Record<string, { providerId: string; model: string }>>({});

  const reloadMap = useCallback(async () => {
    try {
      const res = await (window.neox as any).modelProfileGetTaskAgentMap?.();
      if (res?.success) setTaskAgentMap(res.map || {});
    } catch (err) { console.error('[subagent] load task agent map failed:', err); }
  }, []);
  useEffect(() => { void reloadMap(); }, [reloadMap]);

  const mainKey = mainModel.trim().toLowerCase();
  const currentPair = taskAgentMap[mainKey];

  const setForCurrentModel = useCallback(async (providerId: string, model: string) => {
    if (!mainModel) return;
    try {
      const res = await (window.neox as any).modelProfileSetTaskAgentForModel?.({ mainModel, providerId, model });
      if (res?.success) setTaskAgentMap(res.map || {});
    } catch (err) { console.error('[subagent] set task agent failed:', err); }
  }, [mainModel]);

  const clearForModel = useCallback(async (key: string) => {
    try {
      const res = await (window.neox as any).modelProfileSetTaskAgentForModel?.({ mainModel: key });
      if (res?.success) setTaskAgentMap(res.map || {});
    } catch (err) { console.error('[subagent] clear task agent failed:', err); }
  }, []);

  const taskAgentOptions = [
    { value: '', label: zh ? '自动（同系列更快更省的型号）' : 'Auto (faster, cheaper sibling model)' },
    ...(membership?.models || [])
      .filter(m => m.allowed && m.modelId !== 'auto')
      .map(m => ({ value: `${NEOX_CLOUD_PROVIDER_ID}::${m.modelId}`, label: m.displayName || m.modelId })),
    ...providers
      .filter((p: any) => p.id !== NEOX_CLOUD_PROVIDER_ID)
      .flatMap((p: any) => (p.models || []).map((m: any) => ({ value: `${p.id}::${m.name}`, label: `${m.label || m.name}  ·  ${p.name}` }))),
  ];

  const titleOn = agenticSideAgentEnabled && agenticSideAgentSessionTitle;
  const setTitleOn = (on: boolean) => {
    if (on && !agenticSideAgentEnabled) void handleAgenticSideAgentEnabledChange(true);
    void handleAgenticSideAgentFeatureChange('sessionTitle', on);
  };
  const setDepth = (n: number) => {
    if (!agentRuntime) return;
    setAgentRuntime({ ...agentRuntime, threadDepth: { max: n } } as any);
    void (window.neox as any).setAgentRuntimeConfig?.({ threadDepth: { max: n } });
  };
  const setTeams = (n: number) => {
    if (!agentRuntime) return;
    setAgentRuntime({ ...agentRuntime, maxConcurrentTeams: n } as any);
    void (window.neox as any).setAgentRuntimeConfig?.({ maxConcurrentTeams: n });
  };
  const otherPairs = Object.entries(taskAgentMap).filter(([k]) => k !== mainKey);

  return (
    <div className="settings-panel-content orc3">
      <PageTitle
        title={zh ? '子 Agent' : 'Sub-agents'}
        subtitle={zh ? '主 Agent 拆任务，子 Agent 并行干活' : 'The main agent splits work; sub-agents run it in parallel'}
      />

      <div className="mfs">
        <section className="mfs-hero sa2-hero">
          <img className="mfs-hero__art" src={NeoxIllus.saHero} alt="" draggable={false} />
          <div className="sa2-hero__body">
            <p>{zh ? '子 Agent 的模型按主模型分别设置。' : 'The sub-agent model is set per main model.'}</p>
            <div className="sa2-pair">
              <span className="sa2-pair__main" title={mainModel}>{mainModel || (zh ? '无主模型' : 'No main model')}</span>
              <span className="sa2-pair__arrow" aria-hidden="true">→</span>
              <div className="sa2-pair__select">
                <CustomSelect
                  value={currentPair ? `${currentPair.providerId}::${currentPair.model}` : ''}
                  onChange={(value) => {
                    if (!value) { void clearForModel(mainKey); return; }
                    const idx = value.indexOf('::');
                    void setForCurrentModel(value.slice(0, idx), value.slice(idx + 2));
                  }}
                  options={taskAgentOptions}
                  placeholder={zh ? '自动 (推荐)' : 'Auto (recommended)'}
                />
              </div>
            </div>
            {otherPairs.length > 0 && (
              <div className="sa-pair-list sa2-others">
                <span className="sa2-others__label">{zh ? '其它主模型' : 'Other main models'}</span>
                {otherPairs.map(([k, v]) => (
                  <span className="sa-pair" key={k}>
                    <span className="sa-pair__main">{k}</span>
                    <span className="sa-pair__arrow">→</span>
                    <span className="sa-pair__sub">{v.model}</span>
                    <button type="button" className="sa-pair__x" onClick={() => void clearForModel(k)}
                      aria-label={zh ? `把 ${k} 改回自动` : `Revert ${k} to auto`} title={zh ? '改回自动' : 'Revert to auto'}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

      </div>

      <Section>
        <SectionTitle title={zh ? '会话标题' : 'Session titles'} />
        <SettingsCard>
          <SwitchRow
            leading={<RowIcon src={NeoxIllus.saTitle} />}
            title={zh ? '自动起会话标题' : 'Auto session titles'}
            desc={zh ? '首条消息后生成标题，用子 Agent 模型。' : 'Titles each chat after the first message, using the sub-agent model.'}
            checked={titleOn}
            onChange={setTitleOn}
          />
          <SwitchRow
            leading={<RowIcon src={NeoxIllus.styleConcise} />}
            title={zh ? '起标题时不思考' : 'No thinking for titles'}
            desc={zh ? '更快更省。' : 'Faster and cheaper.'}
            checked={agenticSideAgentDisableThinking}
            disabled={!titleOn}
            onChange={(v) => void handleAgenticSideAgentDisableThinkingChange(v)}
          />
        </SettingsCard>
      </Section>

      {agentRuntime && (
        <Section>
          <SectionTitle title={zh ? '并行' : 'Parallelism'} />
          <SettingsCard>
            <SettingsRow
              leading={<RowIcon src={NeoxIllus.saDepth} />}
              title={zh ? '嵌套层数' : 'Nesting depth'}
              desc={zh ? '子 Agent 还能再派子 Agent 的层数。0 = 不派。' : 'How deep sub-agents can dispatch their own. 0 = none.'}
              control={(
                <NumberSettingInput value={agentRuntime.threadDepth.max} min={0} max={20} width={72}
                  ariaLabel={zh ? '子 Agent 最多套几层' : 'Max sub-agent depth'} onCommit={setDepth} />
              )}
            />
            <SettingsRow
              leading={<RowIcon src={NeoxIllus.saTeam} />}
              title={zh ? '同时运行的团队' : 'Concurrent teams'}
              desc={zh ? '超出后新开团队会被拦下，并提示占用的会话。' : 'Beyond this, new teams are blocked and the holder is shown.'}
              control={(
                <NumberSettingInput value={agentRuntime.maxConcurrentTeams ?? 1} min={1} max={5} width={72}
                  ariaLabel={zh ? '同时最多几个团队' : 'Max concurrent teams'} onCommit={setTeams} />
              )}
            />
          </SettingsCard>
        </Section>
      )}

    </div>
  );
};

export default OrchestratorTab;
