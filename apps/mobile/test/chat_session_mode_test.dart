/// 「是不是 Chat」判据 (chat:C1-02) —— 跟桌面读同一份用例表。
///
/// 两端结果不一样时, `packages/core` 的 vitest 和这里的 flutter test 至少有一个会红。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/session_routing/chat_session_mode.dart';

void main() {
  /* flutter test 的工作目录是 apps/mobile —— 往上两级就是仓库根。 */
  final fixture = File(
    '../../packages/core/src/runtime/__tests__/fixtures/chatSessionMode.cases.json',
  );

  test('两端共用的用例表存在', () {
    expect(
      fixture.existsSync(),
      isTrue,
      reason: '找不到 ${fixture.path} —— 判据用例表被挪走/删了, 两端就没法保证一致了',
    );
  });

  final table = jsonDecode(fixture.readAsStringSync()) as Map<String, dynamic>;
  for (final raw in (table['cases'] as List).cast<Map<String, dynamic>>()) {
    final name = raw['name'] as String;
    final agentMode = raw['agentMode'] as String?;
    final chatMode = raw['chatMode'] as bool?;
    final expected = raw['expected'] as bool;
    test('$name → $expected', () {
      expect(
        isChatSession(agentMode: agentMode, chatMode: chatMode),
        expected,
      );
    });
  }

  test('字段全缺省 = 不是 Chat (不猜)', () {
    expect(isChatSession(), isFalse);
  });
}
