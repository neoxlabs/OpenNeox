/// pilot:D-11 —— 允许名单的「记住拒绝」与批量移除。
///
/// 纯策略层: 不改 SharedPreferences 也能测, 落盘再单独验一次。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/local_agent/phone_use_policy.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('默认允许名单 19 个 App', () {
    expect(PhoneUsePolicy.defaultAllow.length, 19);
    expect(PhoneUsePolicy.defaultAllow, contains('com.tencent.mm'));
  });

  test('记住拒绝: 加进禁止名单, 并从允许名单里拿掉', () {
    const p = PhoneUsePolicy(mode: 'open', allow: ['a', 'com.foo', 'b'], deny: []);
    final r = p.refused('com.foo');
    expect(r.allow, ['a', 'b']);
    expect(r.deny, ['com.foo']);
    expect(r.mode, 'open');
  });

  test('记住拒绝: 已经在禁止名单里不重复加 (大小写也不重复)', () {
    const p = PhoneUsePolicy(mode: 'allowlist', allow: [], deny: ['Com.Foo']);
    final r = p.refused('com.foo');
    expect(r.deny, ['Com.Foo']);
  });

  test('批量移除: 两个名单一起清, 一次可清多个', () {
    const p = PhoneUsePolicy(mode: 'open', allow: ['a', 'b', 'c'], deny: ['x', 'y']);
    final r = p.withoutPackages(['a', 'c', 'x']);
    expect(r.allow, ['b']);
    expect(r.deny, ['y']);
  });

  test('批量移除: 不认识的包名不影响原名单', () {
    const p = PhoneUsePolicy(mode: 'open', allow: ['a'], deny: ['b']);
    final r = p.withoutPackages(['nope']);
    expect(r.allow, ['a']);
    expect(r.deny, ['b']);
  });

  test('拒绝落盘后重新 load 仍然是拒绝状态', () async {
    SharedPreferences.setMockInitialValues({});
    final p = await PhoneUsePolicy.load();
    await p.refused('com.example.shop').save();

    final again = await PhoneUsePolicy.load();
    expect(again.deny, contains('com.example.shop'));
    expect(again.allow, isNot(contains('com.example.shop')));
  });
}
