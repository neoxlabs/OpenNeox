import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { NeoxIllus } from '../../media/illus';
import { ChoiceDialog, type ChoiceOption } from './ChoiceDialog';
import { getEditionHook } from '../shell/editionHooks';

type Route = 'subscribe' | 'byok' | 'local';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

function openSettings(tab: string): void {
  try { localStorage.setItem('neox-settings-initial-tab', tab); } catch { /* 设置页已开着时靠下面的事件切页 */ }
  window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab, from: 'voice-setup' } }));
}

export const VoiceSetupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { isZh } = useI18n();
  const hasAccount = getEditionHook('hasAccount');
  const options: Array<ChoiceOption<Route>> = [
    ...(hasAccount ? [{
      id: 'subscribe' as const,
      art: NeoxIllus.billingHero,
      name: isZh ? '订阅 Neox' : 'Subscribe',
      lead: isZh ? '点了就能说，什么都不用配' : 'Just talk — nothing to set up',
      points: isZh
        ? ['边说边出字，中英混说也认得准', '按说话时长用订阅额度', '输入框和 Pilot 都能直接说']
        : ['Live text as you speak, mixed Chinese/English', 'Uses your plan by speaking time', 'Works in the composer and Pilot'],
    }] : []),
    {
      id: 'byok',
      art: NeoxIllus.ttsHero,
      name: isZh ? '用自己的 Key' : 'Use your own key',
      lead: isZh ? '阿里云百炼 / 讯飞 / 火山 / OpenAI' : 'DashScope / iFlytek / Volcengine / OpenAI',
      points: isZh
        ? ['选一家，把 Key 贴进去', '费用记在你自己的账上', '不用登录也能用']
        : ['Pick a provider and paste a key', 'Billed to your own account', 'Works without signing in'],
    },
    {
      id: 'local',
      art: NeoxIllus.runLocal,
      name: isZh ? '本地识别' : 'On-device',
      lead: isZh ? '不联网、不花钱' : 'Offline and free',
      points: isZh
        ? ['下载一个离线模型 (约 200 MB)', '说的话不出这台电脑', '准确度略低于云端']
        : ['Download an offline model (~200 MB)', 'Your voice never leaves this computer', 'Slightly less accurate than cloud'],
      disabled: !IS_MAC,
      disabledNote: isZh ? '目前只支持 Mac' : 'Mac only for now',
    },
  ];
  return (
    <ChoiceDialog<Route>
      title={isZh ? '开启语音输入' : 'Turn on voice input'}
      sub={isZh ? '选一种方式，配好回来点麦克风就能说。' : 'Pick one, then come back and tap the mic.'}
      options={options}
      /* 没有「当前档」—— 给一个不在选项里的值, 三张卡都不描边 */
      current={'' as Route}
      onPick={(id) => {
        openSettings(id === 'subscribe' ? 'subscription' : 'tts');
        onClose();
      }}
      onClose={onClose}
    />
  );
};
