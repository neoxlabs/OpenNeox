import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { PageTitle, Section, SectionTitle, SettingsCard } from '../../../components/settings-base';
import { useLocalVoice } from './voice/useLocalVoice';
import { VoiceInputSection } from './voice/VoiceInputSection';
import { VoiceOutputSection } from './voice/VoiceOutputSection';
import { VoiceLockRows, WakeWordRows } from './voice/VoiceExtras';
import './voice/voice.css';
import './TtsTab.clay.css';

const TtsTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const lv = useLocalVoice();

  return (
    <div className="settings-panel-content tts3">
      <PageTitle
        title={zh ? '语音' : 'Voice'}
        subtitle={zh ? '说话代替打字，回复念给你听' : 'Talk instead of typing, hear the replies'}
      />

      <SectionTitle title={zh ? '语音输入' : 'Voice input'} />
      <VoiceInputSection zh={zh} lv={lv} />

      <SectionTitle title={zh ? '语音播报' : 'Read aloud'} />
      <VoiceOutputSection zh={zh} lv={lv} />

      <Section advanced>
        <SectionTitle title={zh ? '唤醒与声纹' : 'Wake word & voice lock'} />
        <SettingsCard>
          <VoiceLockRows zh={zh} />
          <WakeWordRows />
        </SettingsCard>
      </Section>
    </div>
  );
};

export default TtsTab;
