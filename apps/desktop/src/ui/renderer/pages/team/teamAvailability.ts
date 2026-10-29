
const KEY = 'neox.team.enabled';

export function isTeamEnabled(): boolean {
  try {
    /* 默认开 —— 只有显式写 '0' 才关 (跟原来的默认关相反, 见文件头) */
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** 置灰入口的统一说明 —— 侧栏 title 和工作台横幅共用一句, 免得两处说法不一致 */
export function teamUnavailableReason(isZh: boolean): string {
  return isZh
    ? '已被本机关闭 (localStorage neox.team.enabled=0)。'
    : 'Disabled on this machine (localStorage neox.team.enabled=0).';
}
