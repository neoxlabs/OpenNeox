/// 聊天模式偏好 (2026-09-23) —— 跟桌面 chatModeStore 同一套规则:
///   · 切换 = 改这个会话 + 改新会话的默认值
///   · 会话第一次发送时钉住当时的模式, 之后改默认值不影响它
///   · 重启 (重新读 prefs) 后都还在
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/composer/chat_mode_pref.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late SharedPreferences prefs;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  test('没设过 = Agent', () {
    final c = ChatModeController(prefs);
    expect(c.state.isOn(null), isFalse);
    expect(c.state.isOn('s1'), isFalse);
  });

  test('还没会话时切到聊天 → 新会话沿用, 发第一条时钉住', () {
    final c = ChatModeController(prefs);
    c.set(null, true);
    expect(c.pin('s1'), isTrue);
    /* 别处把默认改回 Agent, 已钉住的会话不受影响 */
    c.set('s2', false);
    expect(c.state.isOn('s1'), isTrue);
    expect(c.state.isOn('s2'), isFalse);
    expect(c.state.isOn('s3'), isFalse); // 新会话跟最近一次选择
  });

  test('pin 对已钉住的会话不改它', () {
    final c = ChatModeController(prefs);
    c.set('s1', true);
    c.set(null, false);
    expect(c.pin('s1'), isTrue);
  });

  test('重启后还在', () {
    ChatModeController(prefs)
      ..set('s1', true)
      ..set('s2', false);
    final again = ChatModeController(prefs);
    expect(again.state.isOn('s1'), isTrue);
    expect(again.state.isOn('s2'), isFalse);
    expect(again.state.defaultOn, isFalse);
  });
}
