
export type DbInitFailure = {
  dbPath: string;
  message: string;
  at: number;
};

let _last: DbInitFailure | null = null;

type DbInitFailureListener = (failure: DbInitFailure) => void;
const _listeners = new Set<DbInitFailureListener>();

/** 订阅库初始化失败。返回取消订阅函数。 */
export function onDbInitFailure(listener: DbInitFailureListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function recordDbInitFailure(dbPath: string, error: unknown): DbInitFailure {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  _last = { dbPath, message, at: Date.now() };
  for (const listener of _listeners) {
    try {
      listener(_last);
    } catch {
      /* 上报方抛错绝不影响库初始化流程 */
    }
  }
  return _last;
}

export function clearDbInitFailure(dbPath?: string): void {
  /* 只清本次这条路径的失败记录: 辅助库 (monitor/knowledge) 打开成功不该抹掉主会话库的失败原因。 */
  if (!dbPath || _last?.dbPath === dbPath) _last = null;
}

export function getDbInitFailure(): DbInitFailure | null {
  return _last;
}

/** 给用户看的文案: 明确说"这不是登录问题", 并给出原错误。 */
export function describeDbInitFailure(failure: DbInitFailure): string {
  const firstLine = failure.message.split('\n')[0]?.slice(0, 300) || 'unknown error';
  return (
    `会话库无法打开 (${failure.dbPath}): ${firstLine}。` +
    '这不是账号登录问题 —— 登录凭据单独存放, 重新登录也修不好这个库。' +
    '损坏的库会被改名成 <库文件>.broken.<时间戳> 留档, 并尝试从最近的备份恢复; ' +
    '如果仍然失败, 请查看该目录下的 Neox 日志。'
  );
}
