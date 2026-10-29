/**
 * 手机信号分类: 什么叫醒 Pilot、什么只记账、什么丢掉。叫醒是一轮模型调用, 分错一类就是要么漏要么烧钱。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@neoxlabs/core', () => ({ readPilotProfiles: () => ({}) }));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({ getDatabase: () => ({ getSession: () => null }) }));
vi.mock('../pilotCallService.js', () => ({ getCurrentCall: () => null, inQuietHours: () => false }));
vi.mock('../runtimeEnqueue.js', () => ({ awaitSessionReply: async () => '', enqueueToSessionRuntime: async () => true }));
vi.mock('../pilotTelegram.js', () => ({ pushFromPilot: async () => false }));

const { classify } = await import('../pilotSignals.js');
const sig = (pkg: string, title: string, text = '', category?: string) =>
  classify({ app: pkg, package: pkg, title, text, at: Date.now(), category });

describe('classify', () => {
  it('未接来电 → 叫醒', () => {
    expect(sig('com.google.android.dialer', '未接来电', '张三')).toMatchObject({ cls: 'wake', kind: 'missed_call' });
    expect(sig('com.android.incallui', 'Missed call', 'Mom')).toMatchObject({ cls: 'wake', kind: 'missed_call' });
  });
  it('短信 → 叫醒; 验证码短信 → 只记账; 营销短信 → 丢', () => {
    expect(sig('com.google.android.apps.messaging', '王总', '下午的会改到四点')).toMatchObject({ cls: 'wake', kind: 'sms' });
    expect(sig('com.google.android.apps.messaging', '10690', '您的验证码是 384912, 5 分钟内有效')).toMatchObject({ cls: 'ledger', kind: 'code' });
    expect(sig('com.google.android.apps.messaging', '某商城', '会员日全场 5 折, 回T退订')).toMatchObject({ cls: 'drop' });
  });
  it('聊天软件 → 叫醒; 快递 / 银行等 → 记账; 系统 / 下载进度 → 丢', () => {
    expect(sig('com.tencent.mm', '李四', '晚上吃饭吗')).toMatchObject({ cls: 'wake', kind: 'chat' });
    expect(sig('com.cainiao.wireless', '菜鸟', '您的快递已到驿站')).toMatchObject({ cls: 'ledger', kind: 'other' });
    expect(sig('com.android.systemui', 'USB 调试已连接')).toMatchObject({ cls: 'drop' });
    expect(sig('com.example.app', '正在下载', '45%', 'progress')).toMatchObject({ cls: 'drop' });
  });
  it('正在响的来电本身不叫醒 (手机自己在响)', () => {
    expect(sig('com.google.android.dialer', '来电', '张三', 'call')).toMatchObject({ cls: 'drop' });
  });
});
