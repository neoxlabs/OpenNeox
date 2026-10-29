import { describe, expect, it } from 'vitest';
import {
  ApprovalNonceCache, argsDigest, canonicalJson, isWriteAction, signApproval, verifyApproval, withApproval,
} from '../pilotApproval.js';

/** 与手机端 apps/mobile/test/core/pilot/approval_token_test.dart 共用的固定向量 */
const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const VECTOR_ARGS = { to: '13800138000', text: '在吗？' };
const VECTOR_TOKEN =
  'v1.eyJ0IjoicGhvbmUiLCJhIjoic2VuZF9zbXMiLCJkIjoiOWUwZTI2ZGUzMWQ5ZDhhMzAxMDllOTI1YzU4Y2FjYjQ3MzBhNzRkNGQ0ZTBiMWJhNDM4MWJiN2NkMmU1NWRhOSIsImUiOjE3NzAwMDA2MDAwMDAsIm4iOiJhMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MCJ9.LKbkr__nxfAOXNJHisyRa2i6a0owrqo_mZP5wr8Fa78';
const VECTOR_NOW = 1770000000000;
/** pilot:D-05 batch 的固定向量: 嵌套 steps 的 canonicalJson 两端必须逐字节一致 */
const VECTOR_BATCH_ARGS = { steps: [{ op: 'tap', target: 3 }, { tool: 'phone_ui', args: { op: 'type', target: 4, text: '奶茶' } }] };
const VECTOR_BATCH_TOKEN =
  'v1.eyJ0IjoicGhvbmUiLCJhIjoiYmF0Y2giLCJkIjoiMTA1MzYzYmEwZDU0YTljZTNiMDlhNTdiMjU4YzM3NTE3OGEzOTc3YWFhYjljMGIzZDEzYTU1YjRkZTlhZTQ5MiIsImUiOjE3NzAwMDA2MDAwMDAsIm4iOiJiMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MCJ9.YjbvYUvRRF-lQfEk_dR_KhIXMlBvRtzHkNKxgHYWit0';

describe('pilotGate 写动作判定', () => {
  it('手机的写动作要令牌, 读动作不要', () => {
    /* 10 条: 写 / 读各半 */
    expect(isWriteAction('phone', 'send_sms', { to: '1', text: 'hi' })).toBe(true);
    expect(isWriteAction('phone', 'phone_call', { to: '1' })).toBe(true);
    expect(isWriteAction('phone', 'set_alarm', { op: 'alarm', hour: 7 })).toBe(true);
    expect(isWriteAction('phone', 'phone_calendar', { op: 'add', title: '会' })).toBe(true);
    expect(isWriteAction('phone', 'phone_ui', { op: 'tap', target: 3 })).toBe(true);
    expect(isWriteAction('phone', 'phone_ui', { op: 'type', target: 3, text: 'x' })).toBe(true);
    expect(isWriteAction('phone', 'phone_ui', { op: 'tap_at', x: 10, y: 20 })).toBe(true);
    expect(isWriteAction('phone', 'phone_calendar', { op: 'list' })).toBe(false);
    expect(isWriteAction('phone', 'phone_ui', { op: 'snapshot' })).toBe(false);
    expect(isWriteAction('phone', 'read_sms', { query: '验证码' })).toBe(false);
    expect(isWriteAction('phone', 'get_location', {})).toBe(false);
    expect(isWriteAction('phone', 'open_app', { op: 'open', package: 'me.ele' })).toBe(false);
  });

  it('batch 整批按写动作处理: 里面可能是点按 / 填字', () => {
    const steps = { steps: [{ op: 'tap', target: 3 }, { tool: 'open_app', args: { op: 'open', package: 'me.ele' } }] };
    expect(isWriteAction('phone', 'batch', steps)).toBe(true);
    expect(isWriteAction('phone', 'batch', { steps: [{ op: 'snapshot' }] })).toBe(true);
  });

  it('电脑的写动作只有加日历 / 提醒 / 发消息', () => {
    expect(isWriteAction('computer', 'calendar_add', { title: '会' })).toBe(true);
    expect(isWriteAction('computer', 'apple_reminders', { title: '买奶' })).toBe(true);
    expect(isWriteAction('computer', 'send_imessage', { recipient: '妈', message: '到了' })).toBe(true);
    expect(isWriteAction('computer', 'calendar_events', {})).toBe(false);
    expect(isWriteAction('computer', 'contacts_search', { query: '王' })).toBe(false);
    /* 工具名在两个域里撞车时不能互相放行 */
    expect(isWriteAction('computer', 'phone_call', { to: '1' })).toBe(false);
  });
});

describe('pilotGate 令牌', () => {
  it('固定向量: 同一组参数签出来逐字节一致 (手机端用同一串断言)', () => {
    expect(signApproval('phone', 'send_sms', VECTOR_ARGS, KEY, { now: VECTOR_NOW, nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }))
      .toBe(VECTOR_TOKEN);
  });

  it('签名与参数都对 → 放行', () => {
    const t = verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'send_sms', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW + 1000 });
    expect(t?.action).toBe('send_sms');
    expect(t?.tool).toBe('phone');
    expect(t?.nonce).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('参数被改 (金额 / 收件人 / 文案) → 拒', () => {
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'send_sms', args: { ...VECTOR_ARGS, text: '转账 320' } }, KEY, { now: VECTOR_NOW })).toBeNull();
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'send_sms', args: { ...VECTOR_ARGS, to: '13800138001' } }, KEY, { now: VECTOR_NOW })).toBeNull();
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'send_sms', args: {} }, KEY, { now: VECTOR_NOW })).toBeNull();
  });

  it('换动作 → 拒 (批了短信不能拿去打电话)', () => {
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'phone_call', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW })).toBeNull();
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'computer', action: 'send_sms', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW })).toBeNull();
  });

  it('换了密钥 / 篡改签名 → 拒', () => {
    const other = Buffer.from('ffffffffffffffffffffffffffffffff', 'utf8');
    expect(verifyApproval(VECTOR_TOKEN, { tool: 'phone', action: 'send_sms', args: VECTOR_ARGS }, other, { now: VECTOR_NOW })).toBeNull();
    expect(verifyApproval(`${VECTOR_TOKEN}x`, { tool: 'phone', action: 'send_sms', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW })).toBeNull();
    const [v, body, mac] = VECTOR_TOKEN.split('.');
    expect(verifyApproval(`${v}.${body}.${mac.slice(0, -2)}AA`, { tool: 'phone', action: 'send_sms', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW })).toBeNull();
  });

  it('过期 (10 分钟) → 拒; 差 1 毫秒还认', () => {
    const token = signApproval('phone', 'set_alarm', { op: 'alarm', hour: 7 }, KEY, { now: 1_000_000 });
    expect(verifyApproval(token, { tool: 'phone', action: 'set_alarm', args: { op: 'alarm', hour: 7 } }, KEY, { now: 1_000_000 + 600_000 - 1 })).not.toBeNull();
    expect(verifyApproval(token, { tool: 'phone', action: 'set_alarm', args: { op: 'alarm', hour: 7 } }, KEY, { now: 1_000_000 + 600_000 })).toBeNull();
  });

  it('格式不对 / 空 → 拒', () => {
    for (const bad of [null, undefined, '', 'v1', 'v2.x.y', 'v1.@@@.@@@', 42, {}]) {
      expect(verifyApproval(bad, { tool: 'phone', action: 'send_sms', args: VECTOR_ARGS }, KEY, { now: VECTOR_NOW })).toBeNull();
    }
  });

  it('重放同一个令牌 → 第二次拒', () => {
    const cache = new ApprovalNonceCache();
    const token = signApproval('phone', 'phone_call', { to: '10086' }, KEY, { now: VECTOR_NOW });
    const t = verifyApproval(token, { tool: 'phone', action: 'phone_call', args: { to: '10086' } }, KEY, { now: VECTOR_NOW + 10 });
    expect(t).not.toBeNull();
    expect(cache.consume(t!, VECTOR_NOW + 10)).toBe(true);
    expect(cache.consume(t!, VECTOR_NOW + 11)).toBe(false);
    /* 过期后的 nonce 会被清掉 (不再占内存), 但那时令牌本身已经验不过了 */
    expect(cache.consume(t!, VECTOR_NOW + 600_001)).toBe(true);
    expect(cache.size).toBe(1);
  });
});

describe('pilotGate 参数摘要与签发助手', () => {
  it('键顺序不影响摘要, 值顺序影响数组', () => {
    expect(argsDigest({ a: 1, b: 2 })).toBe(argsDigest({ b: 2, a: 1 }));
    expect(argsDigest({ a: [1, 2] })).not.toBe(argsDigest({ a: [2, 1] }));
  });

  it('canonicalJson 与手机端一致 (7.0 → 7, null 保留, 中文不转义)', () => {
    expect(canonicalJson({ b: [1, 2.5, null], a: { y: 7.0, x: '中' } })).toBe('{"a":{"x":"中","y":7},"b":[1,2.5,null]}');
  });

  it('batch 固定向量: 嵌套 steps 的摘要两端逐字节一致', () => {
    expect(signApproval('phone', 'batch', VECTOR_BATCH_ARGS, KEY, { now: VECTOR_NOW, nonce: 'b1b2c3d4e5f60718293a4b5c6d7e8f90' }))
      .toBe(VECTOR_BATCH_TOKEN);
    expect(verifyApproval(VECTOR_BATCH_TOKEN, { tool: 'phone', action: 'batch', args: VECTOR_BATCH_ARGS }, KEY, { now: VECTOR_NOW + 1 })?.action).toBe('batch');
  });

  it('batch 令牌绑定整组 steps: 改一步就验不过', () => {
    const steps = { steps: [{ op: 'tap', target: 3 }, { tool: 'phone_ui', args: { op: 'type', target: 4, text: '珍珠奶茶' } }] };
    const signed = withApproval('phone', 'batch', steps, KEY, { now: VECTOR_NOW });
    expect(signed.approval).toBeTruthy();
    expect(verifyApproval(signed.approval, { tool: 'phone', action: 'batch', args: steps }, KEY, { now: VECTOR_NOW + 1 })).not.toBeNull();

    const retargeted = { steps: [{ op: 'tap', target: 9 }, { tool: 'phone_ui', args: { op: 'type', target: 4, text: '珍珠奶茶' } }] };
    expect(verifyApproval(signed.approval, { tool: 'phone', action: 'batch', args: retargeted }, KEY, { now: VECTOR_NOW + 1 })).toBeNull();

    const extra = { steps: [...steps.steps, { op: 'tap', target: 7 }] };
    expect(verifyApproval(signed.approval, { tool: 'phone', action: 'batch', args: extra }, KEY, { now: VECTOR_NOW + 1 })).toBeNull();
  });

  it('withApproval: 写动作带令牌且能验回, 读动作不带', () => {
    const w = withApproval('phone', 'phone_calendar', { op: 'add', title: '体检' }, KEY, { now: VECTOR_NOW });
    expect(w.approval).toBeTruthy();
    expect(verifyApproval(w.approval, { tool: 'phone', action: 'phone_calendar', args: { op: 'add', title: '体检' } }, KEY, { now: VECTOR_NOW + 1 })).not.toBeNull();
    const r = withApproval('phone', 'contacts_search', { query: '王' }, KEY);
    expect(r.approval).toBeUndefined();
    const noKey = withApproval('phone', 'send_sms', { to: '1', text: 'x' }, null);
    expect(noKey.approval).toBeUndefined();
  });
});
