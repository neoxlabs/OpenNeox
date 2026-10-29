/* phone_sms_digest_test.dart — 短信只回码与来源 (pilot:D-10)
 *
 * 原生侧 (SmsDigest.kt) 负责把正文留在手机里; 这里钉住 Dart 这一半:
 * 10 条短信摆成 10 行, 只有发件方 / 时间 / 验证码 / 金额 —— 就算桥上多带了正文,
 * 格式化函数也不许把它打出来。
 */
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/tools/phone_tools.dart';

void main() {
  final t0 = DateTime(2026, 10, 18, 9, 12).millisecondsSinceEpoch;

  test('10 条短信只输出发件方 / 时间 / 验证码 / 金额', () {
    final rows = <Object?>[
      {'from': '1069', 'at': t0, 'code': '123456', 'amount': null, 'kind': 'code'},
      {'from': '95588', 'at': t0, 'code': null, 'amount': '¥268.00', 'kind': 'amount'},
      {'from': '95588', 'at': t0, 'code': null, 'amount': null, 'kind': 'other'},
      {'from': '10086', 'at': t0, 'code': '8888', 'amount': null, 'kind': 'code'},
      {'from': '10086', 'at': t0, 'code': null, 'amount': '¥32.00', 'kind': 'amount'},
      {'from': '1069', 'at': t0, 'code': null, 'amount': null, 'kind': 'other'},
      {'from': '1069', 'at': t0, 'code': null, 'amount': null, 'kind': 'other'},
      {'from': '1069', 'at': t0, 'code': '654321', 'amount': null, 'kind': 'code'},
      {'from': '1069', 'at': t0, 'code': null, 'amount': null, 'kind': 'other'},
      {'from': '1069', 'at': t0, 'code': null, 'amount': '¥100', 'kind': 'amount'},
    ];

    final out = formatSmsDigestLines(rows);
    final lines = out.split('\n');

    expect(lines.length, 10);
    expect(lines[0], '[2026-10-18 09:12] 1069: 验证码 123456');
    expect(lines[1], '[2026-10-18 09:12] 95588: 金额 ¥268.00');
    expect(lines[2], contains('无验证码 / 金额'));
    expect(lines[7], contains('验证码 654321'));
    expect(lines[9], contains('金额 ¥100'));
  });

  test('桥上多带了正文字段也不打出来', () {
    final out = formatSmsDigestLines([
      {
        'from': '1069',
        'at': t0,
        'code': '123456',
        'amount': null,
        'kind': 'code',
        'text': '【某某银行】验证码 123456，余额 1,234.56 元，取件码 8-2-1234',
      },
    ]);

    expect(out, contains('验证码 123456'));
    expect(out, isNot(contains('余额')));
    expect(out, isNot(contains('取件码')));
    expect(out, isNot(contains('某某银行')));
  });

  test('空结果说清楚', () {
    expect(formatSmsDigestLines(const []), '没有符合的短信');
  });
}
