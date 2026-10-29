import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/i18n/en_strings.dart';
import 'package:neox_app/core/i18n/tr.dart';

void main() {
  tearDown(() => debugUiLanguageOverride = 'zh');

  test('中文界面原样返回', () {
    debugUiLanguageOverride = 'zh';
    expect(tr('取消'), '取消');
    expect(tr('已用 42%'), '已用 42%');
  });

  test('英文界面: 精确匹配', () {
    debugUiLanguageOverride = 'en';
    expect(tr('取消'), 'Cancel');
    expect(tr('退出登录'), 'Sign out');
  });

  test('英文界面: 插值模板按位置取值', () {
    debugUiLanguageOverride = 'en';
    expect(tr('已用 42%'), '42% used');
    expect(tr('编辑了 5 个文件'), 'Edited 5 files');
    expect(tr('验证码已发到 a@b.com'), 'Code sent to a@b.com');
  });

  test('英文界面: 数量为 1 用单数', () {
    debugUiLanguageOverride = 'en';
    expect(tr('编辑了 1 个文件'), 'Edited 1 file');
    expect(tr('1 台'), '1 device');
    expect(tr('11 台'), '11 devices');
    expect(tr('编辑了 21 个文件'), 'Edited 21 files');
  });

  test('英文界面: 没有译文的退回原文', () {
    debugUiLanguageOverride = 'en';
    expect(tr('这句不在对照表里'), '这句不在对照表里');
  });

  test('对照表: 占位符数量一致, 译文不含中文', () {
    final cjk = RegExp(r'[一-鿿]');
    kEnStrings.forEach((zh, en) {
      final nz = '{}'.allMatches(zh).length;
      final ne = RegExp(r'\{\d*\}').allMatches(en).length;
      expect(ne, nz, reason: zh);
      expect(cjk.hasMatch(en), isFalse, reason: en);
    });
  });
}
