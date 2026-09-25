import React, { useState } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { t } from '../../i18n/index.js';

export interface InterruptInputBoxProps {
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/**
 * InterruptInputBox - 运行时插队输入框
 *
 * 功能:
 * - 在AI运行过程中弹出,允许用户输入消息
 * - 消息会被加入队列,等待下次请求时发送
 * - 醒目的UI设计,给人"插队"的感觉
 * - Enter提交,ESC取消
 */
export const InterruptInputBox: React.FC<InterruptInputBoxProps> = ({
  onSubmit,
  onCancel,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);

  const cursorPosition = inputValue.length - cursorOffset;

  useInput((input, key) => {
    // ESC - 取消
    if (key.escape) {
      onCancel();
      return;
    }

    // Enter - 提交(不允许空消息)
    if (key.return) {
      const trimmed = inputValue.trim();
      if (trimmed) {
        onSubmit(trimmed);
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursorOffset === inputValue.length) return;
      const deletePos = cursorPosition - 1;
      const newValue = inputValue.slice(0, deletePos) + inputValue.slice(deletePos + 1);
      setInputValue(newValue);
      return;
    }

    // 左右箭头 - 移动光标
    if (key.leftArrow) {
      setCursorOffset(Math.min(cursorOffset + 1, inputValue.length));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset(Math.max(cursorOffset - 1, 0));
      return;
    }

    // Home/End
    if (key.home || (key.ctrl && input === 'a')) {
      setCursorOffset(inputValue.length);
      return;
    }

    if (key.end || (key.ctrl && input === 'e')) {
      setCursorOffset(0);
      return;
    }

    // 普通字符输入
    if (!key.ctrl && !key.meta && input) {
      const newValue = inputValue.slice(0, cursorPosition) + input + inputValue.slice(cursorPosition);
      setInputValue(newValue);
      return;
    }
  }, { isActive: true });

  // 渲染光标
  const beforeCursor = inputValue.slice(0, cursorPosition);
  const cursorChar = inputValue[cursorPosition] || ' ';
  const afterCursor = inputValue.slice(cursorPosition + 1);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      width="80%"
    >
      {/* 标题 */}
      <Box marginBottom={1} justifyContent="center">
        <Text bold color="yellow">
          ★ {t().ui.interruptMessage} - {t().ui.willSendNextRequest}
        </Text>
      </Box>

      {/* 输入区域 */}
      <Box flexDirection="column">
        <Text dimColor>{t().ui.enterYourMessage}:</Text>
        <Box marginTop={1}>
          <Text color="green" bold>❯ </Text>
          {inputValue ? (
            <Text>
              {beforeCursor}
              <Text inverse>{cursorChar}</Text>
              {afterCursor}
            </Text>
          ) : (
            <Box>
              <Text inverse> </Text>
              <Text dimColor>{t().ui.typeMessage}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* 提示 */}
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>Enter: {t().ui.enterToConfirm}</Text>
        <Text dimColor>ESC: {t().common.cancel}</Text>
      </Box>
    </Box>
  );
};
