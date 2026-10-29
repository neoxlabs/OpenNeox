import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useSettingsContext } from '../SettingsContext';
import { PageTitle } from '../../../components/settings-base';

const RunconfigTab: React.FC = () => {
  const { language } = useI18n();
  const { setActiveTab } = useSettingsContext();

  return (
    <div className="settings-panel-content">
      <PageTitle title={language === 'zh' ? '运行配置' : 'Run Config'} />
      <div className="settings-list">
        <div className="settings-section">
          <p className="setting-desc">
            {language === 'zh'
              ? '此页面已并入「子 Agent」——左侧菜单的「高级 → 子 Agent」就是原来的运行模式配置。'
              : 'This page has been merged into Sub-agents — see “Advanced → Sub-agents” in the left nav.'}
          </p>
          <button
            type="button"
            className="account-btn account-btn--secondary"
            onClick={() => setActiveTab('orchestrator')}
          >
            {language === 'zh' ? '跳转到 子 Agent →' : 'Go to Sub-agents →'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RunconfigTab;
