/**
 * 工具错误 → 给人看的文字: 结构化 JSON 错误取 summary/error + 工具名/状态/退出码/命令; 普通字符串补 "Error: " 前缀。
 * (从 InkUIAdapter 搬出来的纯函数)
 */
export function parseErrorMessage(error: string): string {
  const trimmed = error.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      const parts: string[] = [];
      if (parsed.summary) parts.push(parsed.summary);
      else if (parsed.error) parts.push(parsed.error);
      if (parsed.tool) parts.push(`Tool: ${parsed.tool}`);
      if (parsed.status && parsed.status !== 'error') parts.push(`Status: ${parsed.status}`);
      if (parsed.metadata) {
        if (parsed.metadata.exit_code !== undefined) parts.push(`Exit code: ${parsed.metadata.exit_code}`);
        if (parsed.metadata.command) parts.push(`Command: ${parsed.metadata.command}`);
      }
      return parts.length > 0 ? parts.join('\n') : error;
    } catch {
      // Not valid JSON, return as-is
    }
  }
  return error.startsWith('Error:') ? error : `Error: ${error}`;
}
