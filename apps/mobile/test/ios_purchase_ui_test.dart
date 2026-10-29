import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/errors/error_pill.dart';
import 'package:neox_app/core/feature_flags.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// iOS 没接应用内购买时, 界面上不许出现任何购买引导 (App Store 3.1.1 / 3.1.3(b))。
void main() {
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    debugUiLanguageOverride = 'zh';
  });

  test('iOS: 没接 IAP 时不出现购买入口', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(kIosInAppPurchaseReady, isFalse);
    expect(purchaseUiAllowed, isFalse);
    expect(ErrorKind.quota.actionLabel, '看额度');
  });

  test('Android: 照常有升级入口', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(purchaseUiAllowed, isTrue);
    expect(ErrorKind.quota.actionLabel, '看套餐');
  });

  test('英文: 短模板不吞掉带「升级套餐」的整句', () {
    debugUiLanguageOverride = 'en';
    /* 跟网关里的写法一样: 插进去的片段先各自 tr 过 */
    final week = tr('本周');
    final until = tr('3 天后重置');
    expect(tr('$week额度已用尽，$until'), 'This week allowance used up. Resets in 3 days');
    expect(tr('$week额度已用尽，$until，升级套餐可立即继续'), contains('Upgrade your plan'));
  });
}
