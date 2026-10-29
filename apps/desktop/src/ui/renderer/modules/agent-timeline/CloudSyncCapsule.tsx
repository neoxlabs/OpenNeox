import React from 'react';
import { IconCloud, IconCloudUp, IconCloudDown } from '../shell/shellIcons.js';
import type { CloudLocation } from '../shell/cloudLocation.js';
import { useI18n } from '../../hooks/useI18n';

interface Props {
  state: Exclude<CloudLocation, 'local'>;
  onClick?: () => void;
}

const STATE_TEXT = {
  zh: { cloud: 'Cloud', migrating: '推送中', 'syncing-back': '拉回中' },
  en: { cloud: 'Cloud', migrating: 'Pushing', 'syncing-back': 'Pulling' },
} as const;

export const CloudSyncCapsule = React.memo(function CloudSyncCapsule({ state, onClick }: Props) {
  const { isZh } = useI18n();
  const isBusy = state === 'migrating' || state === 'syncing-back';
  const Icon = state === 'migrating'
    ? IconCloudUp
    : state === 'syncing-back'
      ? IconCloudDown
      : IconCloud;

  return (
    <button
      type="button"
      className={`atl-svc__badge atl-cloud-capsule${isBusy ? ' is-busy' : ''}`}
      onClick={onClick}
      title={isBusy ? (isZh ? '迁移进行中, 完成会自动更新' : 'Migration in progress; updates when complete') : (isZh ? '点击查看 cloud 详情' : 'Click to view cloud details')}
    >
      <span className="atl-svc__icon">
        <Icon size={14} />
      </span>
      <span>{(isZh ? STATE_TEXT.zh : STATE_TEXT.en)[state]}</span>
    </button>
  );
});
