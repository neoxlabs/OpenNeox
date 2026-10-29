
export interface SelectPromptHandle {
  cancel: () => void;
}

export class SelectPromptGuard {
  private active: SelectPromptHandle | null = null;

  /** 收起正在等选择的选择框; 返 false = 当前没有在等的框 */
  cancelActive(): boolean {
    const active = this.active;
    if (!active) return false;
    active.cancel();
    return true;
  }

  /**
   * 弹一个选择框并等结果。settle 只生效一次 —— 用户选中 / ESC / 外部撤销都走同一个口。
   * 100ms 延时跟原 promptSelect 一致: 让上一次隐藏的那一帧先画完, 避免残影。
   */
  run(params: {
    show: (settle: (value: string | null) => void) => void;
    hide: () => void;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let handle: SelectPromptHandle | null = null;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        if (this.active === handle) this.active = null;
        params.hide();
        setTimeout(() => resolve(value), 100);
      };
      handle = { cancel: () => settle(null) };
      this.active = handle;
      params.hide();
      setTimeout(() => {
        /* 还没弹出来就被撤销了 —— 别再画出来 */
        if (!settled) params.show((value) => settle(value));
      }, 100);
    });
  }
}
