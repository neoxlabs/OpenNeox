const RECOVERABLE_CONNECTION_ERROR_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|chat completion timeout|chat completion idle timeout/i;

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
