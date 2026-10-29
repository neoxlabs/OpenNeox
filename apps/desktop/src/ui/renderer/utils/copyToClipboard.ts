import { dispatchHint, dispatchOpFailed } from '../components/notifyEvents';
import { getGlobalLanguage } from '../hooks/useI18n';

export interface CopyOptions {
  /** 复制的是什么 —— 进提示文案, 例如 "路径" → 「已复制路径」。省略则只说「已复制」。 */
  what?: string;
  /** 不弹成功提示 (调用方自己有更好的就地反馈, 比如按钮变成 ✓)。失败提示照给。 */
  silentOnSuccess?: boolean;
}

/**
 * @returns 复制成功与否 —— 调用方需要就地改 UI (按钮变勾) 时用得上。
 */
export async function copyToClipboard(text: string, opts?: CopyOptions): Promise<boolean> {
  const zh = getGlobalLanguage() === 'zh';
  const what = opts?.what?.trim();
  if (!text) {
    /* 空内容不算成功也不该报错 —— 多半是数据还没到 (输出还在跑 / 选区为空)。 */
    dispatchHint(zh ? '没有可复制的内容' : 'Nothing to copy', 'warning');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (!opts?.silentOnSuccess) {
      dispatchHint(
        what
          ? (zh ? `已复制${what}` : `Copied ${what}`)
          : (zh ? '已复制' : 'Copied'),
        'success',
      );
    }
    return true;
  } catch (err: any) {
    /* 剪贴板是会真失败的 (窗口失焦 / 非安全上下文 / 系统策略), 静默吞掉最坑:
     * 用户以为复制上了, 去粘贴时才发现是上一次的内容。 */
    dispatchOpFailed({
      op: zh ? '复制' : 'Copy',
      message: String(err?.message ?? err),
    });
    return false;
  }
}
