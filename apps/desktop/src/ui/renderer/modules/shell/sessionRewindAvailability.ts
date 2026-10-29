
const KEY = 'neox.sessionRewind.enabled';

export function isSessionRewindEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** 按 checkpoint 整段退回 —— 还没接通 (见上), 默认关; 本机自测 localStorage[KEY_CKPT]='1'。 */
const KEY_CKPT = 'neox.checkpointRollback.enabled';
export function isCheckpointRollbackEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY_CKPT) === '1';
  } catch {
    return false;
  }
}

