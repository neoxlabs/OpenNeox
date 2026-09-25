import { describe, expect, it, vi } from 'vitest';
import { dispatchChatByMode } from '../services/chatModeDispatcher.js';

describe('recovery dispatch', () => {
  it.each(['isRetry', 'isContinue', 'isResume'] as const)(
    'forwards %s and an empty prompt to the runtime',
    async flag => {
      const chat = vi.fn().mockResolvedValue('');
      const abortSignal = new AbortController().signal;
      const handlers = { onText: vi.fn() };
      await dispatchChatByMode({
        currentMode: 'agentic',
        sessionId: 'existing-session',
        prompt: '',
        [flag]: true,
        abortSignal,
        singleHandlers: handlers,
        singleRuntime: { chat } as any,
      });
      expect(chat).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: 'existing-session',
          prompt: '',
          [flag]: true,
          abortSignal,
        }),
        handlers,
      );
    },
  );

  it('does not turn an ordinary message into recovery', async () => {
    const chat = vi.fn().mockResolvedValue('');
    await dispatchChatByMode({
      currentMode: 'agentic',
      sessionId: 'existing-session',
      prompt: 'new task',
      singleRuntime: { chat } as any,
    });
    expect(chat.mock.calls[0][0]).toMatchObject({
      prompt: 'new task',
      isRetry: undefined,
      isContinue: undefined,
      isResume: undefined,
    });
  });
});
