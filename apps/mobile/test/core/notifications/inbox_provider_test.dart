/// inbox_provider_test.dart — 消息铃的 store 是进程单例, 不该跟着 Provider 一起销毁 (2026-10-18).
///
/// 真机上第二个 ProviderScope 读消息铃会抛「A InboxStore was used after being disposed」:
/// 第一个作用域退出时把单例 dispose 了, 而同进程里它还要接着用。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/notifications/inbox.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('两个 ProviderScope 先后读写同一个 store, 不抛「used after being disposed」', () async {
    final first = ProviderContainer();
    final s1 = first.read(inboxProvider);
    expect(s1, same(InboxStore.instance), reason: '始终是进程里那一个 store');
    await s1.load();
    first.dispose();

    /* 第一个作用域退出了 (外壳重建 / 测试之间), 单例还得能用 */
    final second = ProviderContainer();
    final s2 = second.read(inboxProvider);
    expect(s2, same(InboxStore.instance));

    /* 这里就是原来炸的那一下: notifyListeners 打在已 dispose 的对象上 */
    await s2.add(kind: 'alert', title: '第二个作用域写进来的');
    expect(s2.items.first.title, '第二个作用域写进来的');
    second.dispose();
  });

  test('作用域退出后单例仍然通知得动 (没被 dispose)', () async {
    final c = ProviderContainer();
    final s = c.read(inboxProvider);
    var fired = 0;
    s.addListener(() => fired++);
    c.dispose();

    await s.add(kind: 'reminder', title: '退出作用域之后');
    expect(fired, greaterThan(0));
  });
}
