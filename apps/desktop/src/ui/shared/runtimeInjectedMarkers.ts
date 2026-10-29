const RUNTIME_INJECTED = /<(current-time|reply-language)>[\s\S]*?<\/\1>/g;

/** 剥掉所有运行时注入标记, 并收掉因此留下的行尾空白。非字符串原样返回。 */
export function stripRuntimeInjectedMarkers<T>(text: T): T {
  if (typeof text !== 'string') return text;
  return (text as string).replace(RUNTIME_INJECTED, '').replace(/[ \t]+$/gm, '') as unknown as T;
}
