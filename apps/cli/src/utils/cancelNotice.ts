const CANCEL_TITLE = /^(?:(?:selection|deletion|configuration|model (?:addition|removal)|model switch)\s+)?cancell?ed\.?$|^(?:已取消|操作已取消|配置已取消|已取消模型切换)$/i;

export function isCancelNotice(title: string): boolean {
  return CANCEL_TITLE.test(title.trim());
}
