import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/pair_client.dart';
import 'package:neox_app/features/pairing/pairing_page.dart';

void main() {
  test('账号不一致时显示电脑端给的原因，并提示检查同一账号', () {
    final e = PairingException(
      code: PairingErrorCode.serverRejected,
      message: '电脑端拒绝连接: 这台手机登录的账号与电脑不一致，请用同一账号登录手机后重试',
    );

    expect(pairingErrorMessage(e), contains('账号与电脑不一致'));
    expect(
      pairingErrorHints(PairingErrorCode.serverRejected, hasAccounts: true),
      contains('手机和电脑是否登录同一个账号'),
    );
    /* 没有账号体系 (开源版) 不提账号 */
    expect(
      pairingErrorHints(PairingErrorCode.serverRejected, hasAccounts: false),
      isNot(contains('手机和电脑是否登录同一个账号')),
    );
  });

  test('点一下连接被拒 / 没人确认: 提示语已说清楚, 不再列可能原因', () {
    for (final s in [403, 408, 429]) {
      expect(pairingErrorHints(PairingErrorCode.serverRejected, statusCode: s), isEmpty);
    }
  });

  test('配对码过期也把电脑端的原因带给用户', () {
    final e = PairingException(
      code: PairingErrorCode.serverRejected,
      message: '电脑端拒绝连接: backup_code invalid or expired',
    );

    expect(pairingErrorMessage(e), contains('invalid or expired'));
  });
}
