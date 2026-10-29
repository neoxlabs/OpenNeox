import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/payment_parser.dart';

void main() {
  ParsedPayment? p(String pkg, String title, String text) => parsePayment(pkg: pkg, title: title, text: text);

  test('银行短信: 消费, 余额不当金额, 认商户和分类', () {
    final r = p('sms', '95588', '【工商银行】您尾号1234卡10月11日12:30在美团外卖消费人民币35.50元，余额1,234.00元。');
    expect(r, isNotNull);
    expect(r!.amount, 35.5);
    expect(r.income, isFalse);
    expect(r.via, '工商银行');
    expect(r.merchant, '美团外卖');
    expect(r.category, '吃饭');
  });

  test('银行短信: 工资入账算收入', () {
    final r = p('sms', '95533', '【建设银行】您尾号8888的储蓄卡10月10日代发工资收入12,000.00元，可用余额15,000.00元。');
    expect(r!.income, isTrue);
    expect(r.amount, 12000);
  });

  test('支付宝 / 微信支付', () {
    final a = p('com.eg.android.AlipayGphone', '支付宝', '你向滴滴出行付款23.80元');
    expect(a!.amount, 23.8);
    expect(a.category, '交通');
    final w = p('com.tencent.mm', '微信支付', '微信支付凭证 已支付¥18.00 商户: 瑞幸咖啡');
    expect(w!.amount, 18);
    expect(w.via, '微信');
    expect(w.category, '吃饭');
  });

  test('不算的: 微信聊天、验证码、还款提醒、余额宝', () {
    expect(p('com.tencent.mm', '张三', '我刚花了35元吃饭'), isNull);
    expect(p('sms', '95588', '【工商银行】验证码123456，您正在支付35.00元'), isNull);
    expect(p('sms', '95555', '【招商银行】您的信用卡本期应还款2,000.00元，到期还款日10月20日'), isNull);
    expect(p('com.eg.android.AlipayGphone', '支付宝', '余额宝转入100.00元成功'), isNull);
    expect(p('sms', '10086', '您本月话费已扣款50元'), isNull, reason: '没有银行标记也没有卡尾号');
  });

  test('衣食住行归类', () {
    expect(dimOf(guessCategory('优衣库旗舰店')), LifeDim.clothes);
    expect(dimOf(guessCategory('物业费')), LifeDim.home);
    expect(dimOf('其它'), LifeDim.other);
  });
}
