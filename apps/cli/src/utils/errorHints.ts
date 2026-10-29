
import { L } from '../i18n/index.js';
import { getCliEdition } from '../edition/index.js';

export function smartErrorHint(msg: string, fallback?: string): string | undefined {
  if (/算力紧张|capacity|overloaded|server.*busy|too many requests/i.test(msg)) {
    return L('服务器高峰期算力不足, 等 1-3 分钟重试. 若反复, 切换其他模型: /model', 'The server is at capacity — retry in 1-3 minutes. If it keeps happening, switch models: /model');
  }
  if (/rate.*limit|429/i.test(msg)) {
    /* 没有账号体系的构建 (开源版) 没有 /upgrade —— 限流来自用户自己的服务商 */
    return getCliEdition().account
      ? L('触发 rate limit. 等待或升级 plan: /upgrade', 'Rate limited. Wait, or upgrade your plan: /upgrade')
      : L('触发服务商的 rate limit. 等一会儿重试, 或换个模型: /model', 'Rate limited by your provider. Wait and retry, or switch models: /model');
  }
  if (/context.*long|too long|token.*limit/i.test(msg)) {
    return L('上下文超长. /clear 清旧消息, 或换更大窗口模型 (/model 切 200k+ ctx).', 'The context is too long. /clear old messages, or switch to a bigger-window model (/model, 200k+).');
  }
  if (/timeout|timed out|deadline/i.test(msg)) {
    return L('请求超时. server 慢或网络抖, 重试一次.', 'The request timed out — the server is slow or the network flaky. Try again.');
  }
  return fallback;
}
