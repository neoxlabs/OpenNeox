import { describe, expect, it } from 'vitest';
import {
  AUTH_CANCELED_MARKER,
  AUTH_CANCELED_MESSAGE,
  canDismissLogin,
  isUserCanceledAuthError,
  stripIpcErrorPrefix,
} from './authCancel';

describe('canDismissLogin —— 什么时候允许关掉登录页', () => {
  it('闲着的时候当然能关', () => {
    expect(canDismissLogin({ loading: false, oauthRunning: false })).toBe(true);
  });

  it('等浏览器授权时必须能关 —— 这就是实拍那个 bug', () => {
    expect(canDismissLogin({ loading: true, oauthRunning: true })).toBe(true);
  });

  it('短请求在飞时不给关 (会留半截状态)', () => {
    expect(canDismissLogin({ loading: true, oauthRunning: false })).toBe(false);
  });

  it('oauthRunning 但 loading 已落 (取消后收尾中) 也能关', () => {
    expect(canDismissLogin({ loading: false, oauthRunning: true })).toBe(true);
  });
});

describe('isUserCanceledAuthError —— 取消是正常结束, 不是故障', () => {
  it('认得出主进程 cancel 抛的那条', () => {
    expect(isUserCanceledAuthError(new Error(AUTH_CANCELED_MESSAGE))).toBe(true);
  });

  it('套了 Electron IPC 壳之后仍然认得出 —— 跨进程只有 message 活得下来', () => {
    const wrapped = new Error(
      `Error invoking remote method 'auth:launch-oauth': Error: ${AUTH_CANCELED_MESSAGE}`,
    );
    expect(isUserCanceledAuthError(wrapped)).toBe(true);
  });

  it('字符串形式的异常也认', () => {
    expect(isUserCanceledAuthError(AUTH_CANCELED_MESSAGE)).toBe(true);
  });

  it('真故障不许被当成取消吃掉', () => {
    expect(isUserCanceledAuthError(new Error('OAUTH_TIMEOUT: 浏览器登录超时'))).toBe(false);
    expect(isUserCanceledAuthError(new Error('Failed to fetch'))).toBe(false);
    expect(isUserCanceledAuthError(new Error('Login canceled by user'))).toBe(false); // 没 marker 的旧串不认
    expect(isUserCanceledAuthError(null)).toBe(false);
    expect(isUserCanceledAuthError(undefined)).toBe(false);
  });

  it('marker 是消息的一部分 —— 契约别被改跑偏', () => {
    expect(AUTH_CANCELED_MESSAGE).toContain(AUTH_CANCELED_MARKER);
  });
});

describe('stripIpcErrorPrefix —— IPC 内部串不许进用户视野', () => {
  it('剥掉一层壳', () => {
    expect(stripIpcErrorPrefix(
      "Error invoking remote method 'auth:launch-oauth': Error: 邮箱或密码错误",
    )).toBe('邮箱或密码错误');
  });

  it('剥掉套娃的多层壳', () => {
    expect(stripIpcErrorPrefix(
      "Error invoking remote method 'a:b': Error: Error invoking remote method 'c:d': Error: 网络异常",
    )).toBe('网络异常');
  });

  it('各种 Error 子类名都认 (TypeError / RangeError)', () => {
    expect(stripIpcErrorPrefix(
      "Error invoking remote method 'x': TypeError: Failed to fetch",
    )).toBe('Failed to fetch');
  });

  it('没有 Error: 中缀时也能剥', () => {
    expect(stripIpcErrorPrefix(
      "Error invoking remote method 'x': 服务不可用",
    )).toBe('服务不可用');
  });

  it('本来就干净的文案原样返回, 不许被啃掉', () => {
    expect(stripIpcErrorPrefix('邮箱已被注册, 直接登录即可')).toBe('邮箱已被注册, 直接登录即可');
    expect(stripIpcErrorPrefix('')).toBe('');
  });

  it('正文里恰好含 Error 字样的不受影响', () => {
    expect(stripIpcErrorPrefix('密码错误 (Error 401)')).toBe('密码错误 (Error 401)');
  });

  it('多行 message 保留后续行 —— 别把详情截没了', () => {
    expect(stripIpcErrorPrefix(
      "Error invoking remote method 'x': Error: 第一行\n第二行",
    )).toBe('第一行\n第二行');
  });
});
