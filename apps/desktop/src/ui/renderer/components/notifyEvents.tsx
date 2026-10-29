import React, { useEffect } from 'react';
import { useToast, Toast } from './Toast';
import { translateError } from '../i18n/errors';
import { getGlobalLanguage } from '../hooks/useI18n';

export interface OpFailedPayload {
  /** 业务操作的中文短名: "创建会话" / "删除会话" / "打开项目" / ... */
  op: string;
  /** 用户能看懂的失败原因, 已经过 friendly 处理. 不要塞英文 stack.
   *  传 code 时这里仅作 fallback (i18n 缺该 code 时用), 通常可省略. */
  message?: string;
  /** 错误码 (e.g. 'quota.exhausted' / 'auth.invalid_key') — 推荐传, 走 i18n 自动翻译 + 多语言 + nextAction.
   *  老 UPPERCASE code (HTTP_429 / QUOTA_EXCEEDED 等) 也支持, 自动 alias 到新命名空间. */
  code?: string;
}

const EVENT_NAME = 'neox:op-failed';
const HINT_EVENT_NAME = 'neox:hint';
const COOLDOWN_MS = 3000;
const lastFired: Map<string, number> = new Map();

export interface HintPayload {
  /** 一句话, 已是终端中文文案 */
  message: string;
  /** info(默认) / success / warning. 不要传 error — 错误走 dispatchOpFailed */
  tone?: 'info' | 'success' | 'warning';
}

/** 任意模块调用: 弹一个轻量提示 toast (不是错误, 是引导/提示).
 *  e.g. "三栏都开会比较挤, 已自动调整宽度". 同 message 3 秒内只弹一次. */
export function dispatchHint(message: string, tone: 'info' | 'success' | 'warning' = 'info'): void {
  if (typeof window === 'undefined') return;
  const key = `hint|${tone}|${message}`;
  const now = Date.now();
  const last = lastFired.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastFired.set(key, now);
  window.dispatchEvent(new CustomEvent<HintPayload>(HINT_EVENT_NAME, { detail: { message, tone } }));
}

/** 任意模块调用: 弹一个全局 error toast.
 *
 *  推荐用法: `dispatchOpFailed({ op: '删除会话', code: 'auth.invalid_key' })` — UI 自动用当前语言翻译,
 *           带 nextAction (e.g. "去登录"). 比手拼 message 友好.
 *  Legacy: `dispatchOpFailed({ op: '删除会话', message: '某英文 stack' })` 仍工作, 显示原 message. */
export function dispatchPanelToast(
  msg: string,
  type: 'info' | 'success' | 'warning' | 'error' = 'info',
  op = 'Git 面板',
): void {
  if (type === 'error') { dispatchOpFailed({ op, message: msg }); return; }
  dispatchHint(msg, type);
}

export function dispatchOpFailed(payload: OpFailedPayload): void {
  if (typeof window === 'undefined') return;
  const dedupKey = `${payload.op}|${payload.code ?? ''}|${payload.message ?? ''}`;
  const now = Date.now();
  const last = lastFired.get(dedupKey) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastFired.set(dedupKey, now);
  window.dispatchEvent(new CustomEvent<OpFailedPayload>(EVENT_NAME, { detail: payload }));
}

/** 从任意 error 形态抽出错误码 — NeoxError.code / err.code / err.error.code 都试一遍.
 *  没有就返 undefined, caller 走 fallback message 路径. */
export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const anyErr = err as any;
  if (typeof anyErr.code === 'string' && anyErr.code) return anyErr.code;
  /* NeoxCloud gateway envelope: { error: { code, message, ... } } */
  if (anyErr.error && typeof anyErr.error === 'object' && typeof anyErr.error.code === 'string') {
    return anyErr.error.code;
  }
  /* axios 包: response.data.error.code */
  if (anyErr.response?.data?.error?.code && typeof anyErr.response.data.error.code === 'string') {
    return anyErr.response.data.error.code;
  }
  return undefined;
}

/**
 * 推荐的"操作失败"派发助手 — 自动从 err 抽 code, 给 i18n 翻译能力.
 *
 *   旧:  dispatchOpFailed({ op: '创建会话', message: friendlyOpError(err) })
 *   新:  dispatchOpFailedFromError('创建会话', err)
 *
 *   优势: code 命中 ErrorCodeRegistry 时, toast 走当前语言 i18n + 自动 hint; 没 code 才回落到 message.
 */
export function dispatchOpFailedFromError(op: string, err: unknown, fallback?: string): void {
  const code = extractErrorCode(err);
  const message = friendlyOpError(err, fallback);
  dispatchOpFailed({ op, message, code });
}

/**
 * 已知中文 op → 英文 op 映射 (EN UI 时用).
 *
 *   dispatchOpFailed 的调用点遍布全仓且大量硬编码中文 op ('删除会话' / '打开项目' ...),
 *   不动调用方签名 — 在这里集中翻译; 映射不到的 op (动态拼接 / 调用点已自带双语) 原样显示。
 */
const OP_EN: Record<string, string> = {
  '发送消息': 'Send message',
  '创建会话': 'Create session',
  '删除会话': 'Delete session',
  '重命名会话': 'Rename session',
  '导出会话': 'Export session',
  '暂停会话': 'Pause session',
  '恢复会话': 'Resume session',
  '停止会话': 'Stop session',
  '加载会话列表': 'Load sessions',
  '加载模型列表': 'Load models',
  '云端运行': 'Cloud run',
  '云端会话恢复': 'Recover cloud session',
  '提交回答': 'Submit answer',
  '同意操作': 'Approve action',
  '拒绝操作': 'Reject action',
  '在 Finder 中显示': 'Reveal in Finder',
  /* 另两个平台的同一操作 —— 操作名现在由 utils/fileManagerLabels 按平台产出,
   * 只此一处映射会让 Windows/Linux 上的英文界面漏出中文 op。 */
  '在资源管理器中显示': 'Reveal in File Explorer',
  '在文件管理器中显示': 'Reveal in File Manager',
  '压缩上下文': 'Compact context',
  '撤回上一步': 'Undo last step',
  '创建快照': 'Create snapshot',
  '回滚改动': 'Revert changes',
  '撤销删除': 'Undo delete',
  '打开项目': 'Open project',
  '恢复上次打开的项目': 'Restore last project',
  '保存引导完成标记': 'Save onboarding state',
  '选择项目文件夹': 'Select project folder',
  '新建工作区': 'Create workspace',
  '复制文件引用': 'Copy file reference',
  '暂停进程': 'Pause process',
  '恢复进程': 'Resume process',
  '停止进程': 'Stop process',
  '停止后台任务': 'Stop background task',
  '暂停后台任务': 'Pause background task',
  '恢复后台任务': 'Resume background task',
  '保存路由': 'Save routing',
  '添加 Provider 到路由': 'Add provider to routing',
};

/** EN UI 下把已知中文 op 翻成英文; 未知 op 原样返回. */
function localizeOp(op: string, lang: string): string {
  if (lang === 'zh') return op;
  return OP_EN[op] ?? op;
}

/**
 * 常见英文 stderr → 中文人话.
 *
 *   git / 网络层的错误消息是英文的, 原样塞进"提交失败: xxx"这种中文句子里, 对用户等于没说。
 *   这里只覆盖高频且明确的几条 —— 匹配不上就保持原文(总比瞎猜强), 不做模糊映射。
 */
const STDERR_HUMANIZE: Array<[RegExp, string, string]> = [
  [/nothing to commit|no changes added to commit/i,
    '没有需要提交的改动', 'Nothing to commit'],
  [/Please tell me who you are|unable to auto-detect email/i,
    'Git 还没配置用户名和邮箱 (git config user.name / user.email)',
    'Git has no user name or email set (git config user.name / user.email)'],
  [/could not read Username|Authentication failed|Invalid username or password/i,
    'Git 认证失败 — 检查凭据或访问令牌', 'Git authentication failed — check your credentials or access token'],
  [/Permission denied \(publickey\)/i,
    'SSH 公钥被拒 — 检查密钥是否已加到远端账号', 'SSH key rejected — is the key added to your remote account?'],
  [/failed to push some refs/i,
    '推送被拒 — 远端有你本地没有的提交, 先 pull 再推',
    'Push rejected — the remote has commits you do not, pull first'],
  [/Your local changes .* would be overwritten/i,
    '本地有未提交的改动会被覆盖 — 先提交或贮藏(stash)',
    'Uncommitted local changes would be overwritten — commit or stash them first'],
  [/CONFLICT|Automatic merge failed/i,
    '有合并冲突需要先解决', 'There are merge conflicts to resolve first'],
  [/not a git repository/i,
    '这个目录不是 Git 仓库', 'This folder is not a Git repository'],
  [/pathspec .* did not match/i,
    '找不到指定的分支或文件', 'No such branch or file'],
  [/index\.lock.*File exists|Unable to create .*index\.lock/i,
    'Git 索引被占用 — 可能有另一个 Git 操作在跑, 稍后重试',
    'The Git index is locked — another Git operation may be running, try again shortly'],
  [/ECONNREFUSED/i,
    '连接被拒绝 — 检查地址/端口, 走代理请确认代理已启动',
    'Connection refused — check the address and port; if you use a proxy, make sure it is running'],
  [/ENOTFOUND|EAI_AGAIN/i,
    '域名解析失败 — 检查网络或地址是否写错', 'Could not resolve the host — check your network or the address'],
  [/ETIMEDOUT|ESOCKETTIMEDOUT/i,
    '连接超时 — 检查网络是否可达', 'Connection timed out — check that the network is reachable'],
  [/ENOSPC/i, '磁盘空间不足', 'Not enough disk space'],
  [/EACCES|EPERM/i,
    '没有权限 — 检查文件或目录的访问权限', 'Permission denied — check the file or folder permissions'],
];

export function stripPlumbing(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out
      /* Electron ipcRenderer.invoke 的包装 */
      .replace(/^Error invoking remote method\s+'[^']*':\s*/i, '')
      /* 错误类名前缀 (可能套好几层) */
      .replace(/^(?:Neox)?Error:\s*/i, '')
      .trim();
  } while (out !== prev && out.length > 0);
  return out || text;
}

export function friendlyOpError(err: unknown, fallback?: string): string {
  const zh = getGlobalLanguage() === 'zh';
  const fb = fallback ?? (zh ? '操作失败' : 'Operation failed');
  if (!err) return fb;
  let msg: string;
  if (err instanceof Error) {
    msg = err.message || fb;
  } else if (typeof err === 'string') {
    msg = err;
  } else if (typeof err === 'object' && err && 'message' in err) {
    msg = String((err as any).message ?? fb);
  } else {
    msg = String(err);
  }
  /* 第一行 + 截断, 不让 stack trace 撑爆 toast */
  msg = msg.split('\n')[0]!.trim();
  msg = stripPlumbing(msg);
  /* 高频英文 stderr 翻成人话 —— 在截断之前做, 否则关键词可能被切掉 */
  for (const [re, humanZh, humanEn] of STDERR_HUMANIZE) {
    if (re.test(msg)) return zh ? humanZh : humanEn;
  }
  if (msg.length > 100) msg = msg.slice(0, 100) + '…';
  return msg || fb;
}

/** 挂在 AppShell 顶层 — 监听全局 op-failed 事件, 转 useToast 弹 error toast. */
export const NotifyToastHost: React.FC = () => {
  const { messages, removeToast, toast } = useToast();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpFailedPayload>).detail;
      if (!detail) return;
      /* error 类 toast 默认 8s, 用户原则: 关键错误必须看得见.
       *
       * 优先用 code 走 i18n 翻译 — 当前语言, 自动带 hint. 没传 code 才 fallback 到 message.
       * 这里没用 useI18n hook (NotifyToastHost 不是组件子树底层, useI18n 重 render 触发 re-listen 不必要),
       * 直接 read getGlobalLanguage() 即可 — 切语言时下一条 toast 自动新语言. */
      const lang = getGlobalLanguage();
      const op = localizeOp(detail.op, lang);
      let text: string;
      if (detail.code) {
        const tr = translateError(detail.code, lang, detail.message);
        text = lang === 'zh' ? `${op}失败: ${tr.message}` : `${op} failed: ${tr.message}`;
      } else {
        text = lang === 'zh'
          ? `${op}失败: ${detail.message ?? '未知原因'}`
          : `${op} failed: ${detail.message ?? 'unknown reason'}`;
      }
      toast.error(text);
    };
    const hintHandler = (e: Event) => {
      const detail = (e as CustomEvent<HintPayload>).detail;
      if (!detail) return;
      const fn = detail.tone === 'warning' ? toast.warning
        : detail.tone === 'success' ? toast.success
        : toast.info;
      fn(detail.message);
    };
    window.addEventListener(EVENT_NAME, handler as EventListener);
    window.addEventListener(HINT_EVENT_NAME, hintHandler as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, handler as EventListener);
      window.removeEventListener(HINT_EVENT_NAME, hintHandler as EventListener);
    };
  }, [toast]);

  return <Toast messages={messages} onRemove={removeToast} />;
};
