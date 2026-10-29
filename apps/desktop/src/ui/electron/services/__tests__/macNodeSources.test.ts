import { describe, expect, it } from 'vitest';
import { decodeAttributedBody, normPhone, parseBankSms } from '../macNodeSources';

describe('parseBankSms', () => {
  it('招行消费: 金额 / 商户 / 尾号 / 余额', () => {
    const t = parseBankSms('【招商银行】您账户1234于10月14日12:30在美团支付消费人民币36.50元，余额2,001.30');
    expect(t).toMatchObject({ kind: 'expense', amount: 36.5, currency: 'CNY', bank: '招商银行', card: '1234', balance: 2001.3 });
    expect(t?.merchant).toContain('美团');
  });

  it('工资入账算收入', () => {
    const t = parseBankSms('【工商银行】您尾号8888卡10月10日09:01工资收入(代发工资)15,000.00元，余额20,312.55元。');
    expect(t).toMatchObject({ kind: 'income', amount: 15000, bank: '工商银行', card: '8888' });
  });

  it('余额里的数不当成金额', () => {
    const t = parseBankSms('【建设银行】您尾号0001的储蓄卡10月12日转出人民币200.00元,活期余额5000.00元。');
    expect(t?.amount).toBe(200);
    expect(t?.kind).toBe('expense');
  });

  it('退款算收入', () => {
    expect(parseBankSms('【招商银行】您尾号1234信用卡10月13日退款人民币59.00元')?.kind).toBe('income');
  });

  it('验证码 / 还款 / 账单 / 没署名的一律不算', () => {
    expect(parseBankSms('【招商银行】验证码 123456, 您正在支付 36.50 元')).toBeNull();
    expect(parseBankSms('【招商银行】您尾号1234信用卡还款1000.00元已入账')).toBeNull();
    expect(parseBankSms('【招商银行】本期应还人民币3,200.00元, 最低还款320.00元')).toBeNull();
    expect(parseBankSms('您在美团消费36.50元')).toBeNull();
    expect(parseBankSms('【美团】您的订单已支付36.50元')).toBeNull();
  });
});

describe('decodeAttributedBody', () => {
  it('取出 typedstream 里的第一段 NSString', () => {
    const text = '晚上一起吃饭吗';
    const bytes = Buffer.from(text, 'utf8');
    const buf = Buffer.concat([
      Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped'), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
      Buffer.from('NSMutableAttributedString'), Buffer.from([0x00, 0x84, 0x84]), Buffer.from('NSAttributedString'),
      Buffer.from([0x00, 0x84, 0x84, 0x08]), Buffer.from('NSObject'), Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84]),
      Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, bytes.length]), bytes, Buffer.from([0x86, 0x84]),
    ]);
    expect(decodeAttributedBody(buf)).toBe(text);
  });

  it('长正文用 0x81 + 两字节长度', () => {
    const text = 'x'.repeat(300);
    const buf = Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81, 300 & 0xff, 300 >> 8]), Buffer.from(text)]);
    expect(decodeAttributedBody(buf)).toBe(text);
  });

  it('没有就给空串', () => {
    expect(decodeAttributedBody(null)).toBe('');
    expect(decodeAttributedBody(Buffer.from('nothing here'))).toBe('');
  });
});

describe('normPhone', () => {
  it('去掉 +86 / 空格 / 横线', () => {
    expect(normPhone('+86 138-0013-8000')).toBe('13800138000');
    expect(normPhone('138 0013 8000')).toBe('13800138000');
    expect(normPhone('+1 (415) 555-0100')).toBe('14155550100');
  });
});
