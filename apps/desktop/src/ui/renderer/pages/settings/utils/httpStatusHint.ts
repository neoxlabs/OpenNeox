export const httpStatusHint = (code: number | undefined, zh: boolean): string | null => {
  if (!code) return null;
  if (code === 401) return zh ? '密钥无效或未授权 (401)' : 'Invalid or unauthorized key (401)';
  if (code === 403) return zh ? '密钥无权限 / 被拒 (403)' : 'Forbidden (403)';
  if (code === 402) return zh ? '余额不足 (402)' : 'Insufficient balance (402)';
  if (code === 404) return zh ? '端点或模型不存在 (404)' : 'Endpoint or model not found (404)';
  if (code === 429) return zh ? '限流 / 额度用尽 (429)' : 'Rate limited (429)';
  if (code === 400) return zh ? '请求被上游拒绝 (400)' : 'Bad request (400)';
  /* 409/422 之类原本会掉进 `HTTP ${code}` 裸码 —— 归到"上游拒绝"更像人话 */
  if (code === 408) return zh ? '上游响应超时 (408)' : 'Upstream timeout (408)';
  if (code === 413) return zh ? '请求内容过大 (413)' : 'Payload too large (413)';
  if (code >= 500) return zh ? `上游服务异常 (${code})` : `Upstream error (${code})`;
  if (code >= 400) return zh ? `请求被上游拒绝 (${code})` : `Rejected by upstream (${code})`;
  return null;
};
