/* Timeouts are deliberately absent. A timeout means the server is alive and the run may still
 * be going; "recovering" it re-sent the user's message into a second concurrent run while the
 * first kept executing (two browser sessions, duplicated side effects). Only transport failures,
 * where the run is gone with the connection, are safe to retry by re-sending. */
const RECOVERABLE_CONNECTION_ERROR_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up/i;

export function isRecoverableConnectionError(errorMessage: string): boolean {
  return RECOVERABLE_CONNECTION_ERROR_PATTERN.test(errorMessage);
}

interface TryRecoverableChatRetryOptions {
  errorMessage: string;
  showProgress: (message: string) => void;
  tryRecoverServerConnection: (reason: string) => Promise<boolean>;
  hasChatTransport: () => boolean;
  retryChat: () => Promise<void>;
}

interface RecoverableChatRetryResult {
  handled: boolean;
  retryError?: unknown;
}

export async function tryRecoverableChatRetry(
  options: TryRecoverableChatRetryOptions,
): Promise<RecoverableChatRetryResult> {
  if (!isRecoverableConnectionError(options.errorMessage)) {
    return { handled: false };
  }

  options.showProgress('连接断了, 正在重连…');
  const recovered = await options.tryRecoverServerConnection(options.errorMessage);
  if (!recovered || !options.hasChatTransport()) {
    return { handled: false };
  }

  options.showProgress('已重连, 重试这条消息…');
  try {
    await options.retryChat();
    return { handled: true };
  } catch (retryError) {
    return { handled: true, retryError };
  }
}
