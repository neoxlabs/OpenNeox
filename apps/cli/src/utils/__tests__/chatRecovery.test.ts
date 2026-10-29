/**
 * Only transport failures may be retried by re-sending the message.
 *
 * Found in a CLI trial: a turn hit the client-side completion timeout while the server run was
 * still executing. The timeout was classed as a connection error, the server answered the
 * health check, and the CLI re-sent the user's message — a second run started beside the
 * first, and the model told the user "you re-sent the same message".
 */
import { describe, it, expect, vi } from 'vitest';
import { isRecoverableConnectionError, tryRecoverableChatRetry } from '../chatRecovery.js';

describe('chat recovery', () => {
  it('treats transport failures as recoverable', () => {
    expect(isRecoverableConnectionError('fetch failed')).toBe(true);
    expect(isRecoverableConnectionError('read ECONNRESET')).toBe(true);
    expect(isRecoverableConnectionError('socket hang up')).toBe(true);
  });

  it('never re-sends on a timeout', async () => {
    const retryChat = vi.fn(async () => {});
    for (const msg of [
      'chat completion timeout after 900121ms (session=s)',
      'chat completion idle timeout after 120000ms (session=s)',
    ]) {
      expect(isRecoverableConnectionError(msg)).toBe(false);
      const r = await tryRecoverableChatRetry({
        errorMessage: msg,
        showProgress: () => {},
        tryRecoverServerConnection: async () => true,
        hasChatTransport: () => true,
        retryChat,
      });
      expect(r.handled).toBe(false);
    }
    expect(retryChat).not.toHaveBeenCalled();
  });
});
