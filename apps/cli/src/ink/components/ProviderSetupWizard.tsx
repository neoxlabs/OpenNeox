import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from '../../../vendor/ink/src/index.js';
import { ProviderGuide, type DetectedProvider } from './ProviderGuide.js';
import { t } from '../../i18n/index.js';

export interface ProviderSetupWizardProps {
  onComplete: () => void;
  onStartSetup: () => void;
  onManualEdit?: () => void;
  onAutoCreate?: (selectedIndices?: number[]) => void;
  detectedProviders?: DetectedProvider[];
}

/**
 * Provider 配置向导组件
 * 用于在 CLI 启动时引导用户配置 Provider
 */
export const ProviderSetupWizard: React.FC<ProviderSetupWizardProps> = ({
  onComplete,
  onStartSetup,
  onManualEdit,
  onAutoCreate,
  detectedProviders = [],
}) => {
  const { exit } = useApp();
  const [showGuide, setShowGuide] = useState(true);

  // 处理用户输入（在引导页面不再需要这个，因为 ProviderGuide 自己处理了）
  // 保留作为备用
  useInput((input, key) => {
    // ESC 退出（全局）
    if (key.escape && !showGuide) {
      onComplete();
      exit();
    }
  });

  if (showGuide) {
    return (
      <ProviderGuide
        detectedProviders={detectedProviders}
        onContinue={() => {
          setShowGuide(false);
          onStartSetup();
        }}
        onManualEdit={() => {
          setShowGuide(false);
          onManualEdit?.();
          onComplete();
          exit();
        }}
        onAutoCreate={(indices) => {
          setShowGuide(false);
          onAutoCreate?.(indices);
          onComplete();
          exit();
        }}
        onExit={() => {
          onComplete();
          exit();
        }}
      />
    );
  }

  // 引导页面关闭后，显示配置中提示
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan">{t().ui.startingProviderSetup}</Text>
      <Text dimColor>{t().ui.completeSetupInPopup}</Text>
    </Box>
  );
};

// 重新导出类型
export type { DetectedProvider };
