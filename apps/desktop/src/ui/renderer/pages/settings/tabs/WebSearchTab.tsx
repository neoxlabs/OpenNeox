import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { PageTitle, NeoxInput, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, RowIcon } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';
import './WebSearchTab.clay.css';

type Engine = 'auto' | 'bocha' | 'serper' | 'custom';

const WebSearchTab: React.FC = () => {
  const {
    webSearchEnabled,
    webSearchEngine,
    setWebSearchEngine,
    webSearchUrl,
    setWebSearchUrl,
    webSearchApiKey,
    setWebSearchApiKey,
    webSearchApiKeyVisible,
    setWebSearchApiKeyVisible,
    webSearchSaving,
    handleWebSearchToggle,
    handleWebSearchSave,
  } = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';
  const engine = (webSearchEngine || 'auto') as Engine;

  const engines: Array<{ id: Engine; art: string; name: string; desc: string; tag: string }> = [
    {
      id: 'auto',
      art: NeoxIllus.webNative,
      name: zh ? '自带' : 'Built-in',
      desc: zh ? 'Neox 订阅全模型可搜；自带 Key 时仅 GPT / Claude / Kimi / Grok。' : 'All models on a Neox plan; with your own key, GPT / Claude / Kimi / Grok only.',
      tag: zh ? '免配置' : 'No setup',
    },
    {
      id: 'bocha',
      art: NeoxIllus.webBocha,
      name: zh ? '博查' : 'Bocha',
      desc: zh ? '国内搜索，中文结果好。' : 'China-based search, strong on Chinese results.',
      tag: zh ? '需 Key' : 'Key needed',
    },
    {
      id: 'serper',
      art: NeoxIllus.webSerper,
      name: 'Serper',
      desc: zh ? 'Google 结果，免费 2500 次。' : 'Google results, 2,500 free searches.',
      tag: zh ? '需 Key' : 'Key needed',
    },
    {
      id: 'custom',
      art: NeoxIllus.webCustom,
      name: zh ? '自定义' : 'Custom',
      desc: zh ? '接你自己的搜索接口。' : 'Point it at your own endpoint.',
      tag: 'URL',
    },
  ];

  const needsKey = engine === 'bocha' || engine === 'serper';
  const ready = engine === 'auto' || (needsKey ? !!webSearchApiKey : !!webSearchUrl);
  const current = engines.find((e) => e.id === engine) ?? engines[0];

  return (
    <div className="settings-panel-content ws3">
      <PageTitle
        title={zh ? '联网搜索' : 'Web search'}
        subtitle={zh ? '让 Agent 查最新的资料' : 'Let the agent look up the latest material'}
      />

      <div id="setting-web-search">
        <Section>
          <SettingsCard>
            <SwitchRow
              leading={<RowIcon src={NeoxIllus.webHero} />}
              title={zh ? '联网搜索' : 'Web search'}
              desc={webSearchEnabled
                ? (zh ? `正在用「${current.name}」搜索${ready ? '' : '，还没配好'}。` : `Searching with ${current.name}${ready ? '' : ' — not set up yet'}.`)
                : (zh ? '关着时 Agent 只用它已知的内容。' : 'While off, the agent answers from what it already knows.')}
              checked={webSearchEnabled}
              ariaLabel={zh ? '联网搜索' : 'Web search'}
              onChange={(v) => handleWebSearchToggle(v)}
            />
          </SettingsCard>
        </Section>

        {webSearchEnabled && (
          <>
            <Section>
              <SectionTitle title={zh ? '用哪个搜索' : 'Search backend'} />
              <SettingsCard>
                {engines.map((e) => (
                  <SettingsRow
                    key={e.id}
                    className={`set-radio-row${engine === e.id ? ' is-on' : ''}`}
                    onClick={() => setWebSearchEngine(e.id as any)}
                    leading={<><span className="set-radio" aria-hidden="true" /><RowIcon src={e.art} /></>}
                    title={<>{e.name}<span className="set-tag">{engine === e.id ? (zh ? '在用' : 'In use') : e.tag}</span></>}
                    desc={e.desc}
                  />
                ))}
              </SettingsCard>
            </Section>

            {needsKey && (
              <div className="ws-config">
                <div className="ws-config__head">
                  <h4>{zh ? `${current.name} API Key` : `${current.name} API key`}</h4>
                  <a href={engine === 'bocha' ? 'https://open.bochaai.com' : 'https://serper.dev'} target="_blank" rel="noopener noreferrer" className="mfs-link">
                    {zh ? '去获取' : 'Get a key'} ↗
                  </a>
                </div>
                <div className="ws-config__row">
                  <div className="ws-config__input">
                    <NeoxInput
                      type={webSearchApiKeyVisible ? 'text' : 'password'}
                      value={webSearchApiKey}
                      onChange={(e) => setWebSearchApiKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleWebSearchSave(); }}
                      placeholder={engine === 'bocha' ? 'sk-…' : (zh ? 'Serper API Key' : 'Serper API key')}
                    />
                    <button type="button" className="ws-config__eye" onClick={() => setWebSearchApiKeyVisible(!webSearchApiKeyVisible)}
                      aria-label={webSearchApiKeyVisible ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')}>
                      {webSearchApiKeyVisible ? <Icons.Lock /> : <Icons.Eye />}
                    </button>
                  </div>
                  <NeoxButton size="sm" onClick={handleWebSearchSave} disabled={webSearchSaving}>
                    {webSearchSaving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
                  </NeoxButton>
                </div>
                {!webSearchApiKey && <p className="ws-config__warn">{zh ? '没填 Key 搜不了。' : 'Searches fail until a key is saved.'}</p>}
              </div>
            )}

            {engine === 'custom' && (
              <div className="ws-config">
                <div className="ws-config__head">
                  <h4>{zh ? '搜索接口 URL' : 'Search endpoint URL'}</h4>
                  <span className="ws-config__hint">{zh ? 'Anthropic /messages 或 OpenAI /responses 格式' : 'Anthropic /messages or OpenAI /responses format'}</span>
                </div>
                <div className="ws-config__row">
                  <div className="ws-config__input">
                    <NeoxInput
                      type="text"
                      value={webSearchUrl}
                      onChange={(e) => setWebSearchUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleWebSearchSave(); }}
                      placeholder="https://your-api.com/v1/messages"
                    />
                  </div>
                  <NeoxButton size="sm" onClick={handleWebSearchSave} disabled={webSearchSaving}>
                    {webSearchSaving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
                  </NeoxButton>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default WebSearchTab;
