/**
 * 底部信息面板的外观 (数据见 ink/bottomPanel.ts)。跟 ContextMenu 同一套: 粗体标题 + 右侧灰字, 下面是内容行。
 *
 *   订阅用量                       刷新中… · Esc 关闭
 *   套餐      Max
 *   5 小时    ━━━━━━──────────────   18%  3 小时后重置
 */
import React from 'react';
import { Box, Text, useInput, useStdout } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';
import { useBottomPanel, closeBottomPanel } from '../bottomPanel.js';
import { getLanguage } from '../../i18n/index.js';

export const BottomPanel: React.FC = () => {
  const panel = useBottomPanel();
  const { columns = 80 } = useStdout();
  useInput((_input, key) => {
    if (key.escape) closeBottomPanel();
  }, { isActive: !!panel });
  if (!panel) return null;

  let zh = false;
  try { zh = getLanguage() === 'zh'; } catch { /* */ }
  const width = Math.max(30, Math.min(72, columns - 4));
  const close = panel.closeHint ?? (zh ? 'Esc 关闭' : 'Esc to close');
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Box width={width} justifyContent="space-between">
        <Text bold>{panel.title}</Text>
        <Text>
          {panel.status ? (
            <Text color={panel.statusTone === 'error' ? NeoxTheme.functional.error : NeoxTheme.text.dim}>{panel.status + ' · '}</Text>
          ) : null}
          <Text color={NeoxTheme.text.dim}>{close}</Text>
        </Text>
      </Box>
      {panel.lines.map((l, i) => <Text key={i}>{l || ' '}</Text>)}
    </Box>
  );
};
