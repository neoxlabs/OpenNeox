/// S-07: 以用户名义发出去的同一内容 (同收件人 + 同文本) 2 分钟内第二次不发。
///
/// 两层都测: 守卫本身的判定窗口 + 真正接在 send_sms 上时第二次不再走原生发送。
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import 'package:neox_app/core/local_agent/tools/outward_send_guard.dart';
import 'package:neox_app/core/local_agent/tools/phone_tools.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('OutwardSendGuard', () {
    test('2 分钟内第二次拦下, 窗口满了放行', () {
      var now = DateTime(2026, 10, 18, 9, 0);
      final guard = OutwardSendGuard(clock: () => now);
      guard.remember(recipient: '+8613800138000', text: '我晚点到');

      now = now.add(const Duration(minutes: 1));
      expect(guard.isDuplicate(recipient: '+8613800138000', text: '我晚点到'), isTrue);

      now = now.add(const Duration(minutes: 1));
      expect(guard.isDuplicate(recipient: '+8613800138000', text: '我晚点到'), isFalse);
    });

    test('收件人 / 文本任一不同都放行', () {
      final now = DateTime(2026, 10, 18, 9, 0);
      final guard = OutwardSendGuard(clock: () => now);
      guard.remember(recipient: '+8613800138000', text: '我晚点到');

      expect(guard.isDuplicate(recipient: '+8613900139000', text: '我晚点到'), isFalse);
      expect(guard.isDuplicate(recipient: '+8613800138000', text: '我马上到'), isFalse);
    });

    test('号码里的空格 / 横线不影响判重, 首尾空白也不影响', () {
      final now = DateTime(2026, 10, 18, 9, 0);
      final guard = OutwardSendGuard(clock: () => now);
      guard.remember(recipient: '+86 138-0013-8000', text: '  我晚点到\r\n');

      expect(guard.isDuplicate(recipient: '+8613800138000', text: '我晚点到'), isTrue);
    });

    test('没记过就不算重复 (发送失败不记账, 允许重试)', () {
      final guard = OutwardSendGuard(clock: () => DateTime(2026, 10, 18, 9, 0));
      expect(guard.isDuplicate(recipient: '+8613800138000', text: '我晚点到'), isFalse);
    });
  });

  group('send_sms 发送层去重', () {
    const ch = MethodChannel('neox.phone/tools');
    final sends = <Map<String, Object?>>[];
    var confirms = 0;
    var now = DateTime(2026, 10, 18, 9, 0);
    var failNext = false;

    OutwardSendGuard freshGuard() => OutwardSendGuard(clock: () => now);
    SendSmsTool freshTool(OutwardSendGuard guard) => SendSmsTool((_, __) async {
          confirms++;
          return true;
        }, guard: guard);

    setUp(() {
      sends.clear();
      confirms = 0;
      now = DateTime(2026, 10, 18, 9, 0);
      failNext = false;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(ch, (call) async {
        switch (call.method) {
          case 'ensure':
            final perms = (call.arguments as Map)['permissions'] as List;
            return {for (final p in perms) p: true};
          case 'sendSms':
            sends.add(Map<String, Object?>.from(call.arguments as Map));
            if (failNext) return {'error': '没信号'};
            return {'sent': true};
        }
        return null;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(ch, null);
    });

    sdk.ToolContext ctx() => sdk.ToolContext(cancel: sdk.AgentCancelToken());

    test('同样内容 2 分钟内第二次被拦下: 不再发, 也不再问用户', () async {
      final tool = freshTool(freshGuard());

      final first = await tool.run({'to': '+86 138-0013-8000', 'text': '我晚点到'}, ctx());
      expect(first.isError, isFalse);
      expect(sends, hasLength(1));
      expect(confirms, 1);

      now = now.add(const Duration(minutes: 1));
      final second = await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());
      expect(second.isError, isTrue);
      expect(second.output, contains('2 分钟内已发过同样内容'));
      expect(second.output, contains('不要重复发送'));
      expect(sends, hasLength(1));
      expect(confirms, 1);
    });

    test('换一句 / 换个人照发', () async {
      final tool = freshTool(freshGuard());

      await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());
      await tool.run({'to': '+8613800138000', 'text': '我马上到'}, ctx());
      await tool.run({'to': '+8613900139000', 'text': '我晚点到'}, ctx());

      expect(sends, hasLength(3));
    });

    test('超过 2 分钟可以再发', () async {
      final tool = freshTool(freshGuard());

      await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());
      now = now.add(const Duration(minutes: 2));
      final again = await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());

      expect(again.isError, isFalse);
      expect(sends, hasLength(2));
    });

    test('发送失败不记账: 马上重试还能发', () async {
      final tool = freshTool(freshGuard());
      failNext = true;

      final failed = await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());
      expect(failed.isError, isTrue);

      failNext = false;
      final retried = await tool.run({'to': '+8613800138000', 'text': '我晚点到'}, ctx());
      expect(retried.isError, isFalse);
      expect(sends, hasLength(2));
    });
  });
}
