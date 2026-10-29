/// 切标签时会话归属 (chat:C1-03)
///
/// 规则: 当前会话属于别的模式 → 新开一条对话 (返回被留下的模式, 调用方提示一声);
/// 会话模式和目标模式一致 / 模式未知 → 保持当前会话不动。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/home/state/current_session_provider.dart';
import 'package:neox_app/features/home/state/home_mode_provider.dart';
import 'package:neox_app/features/home/state/home_mode_switch.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;

import 'support/mobile_test_support.dart';

void main() {
  test('工作会话里切到对话 → 新开对话, 返回「工作」用于提示', () {
    expect(
      modeSwitchLeavesSession(sessionMode: HomeMode.work, next: HomeMode.chat),
      HomeMode.work,
    );
  });

  test('对话会话里切到编码 → 新开编码对话', () {
    expect(
      modeSwitchLeavesSession(sessionMode: HomeMode.chat, next: HomeMode.code),
      HomeMode.chat,
    );
  });

  test('同模式的会话跟着切, 不新开', () {
    expect(
      modeSwitchLeavesSession(sessionMode: HomeMode.work, next: HomeMode.work),
      isNull,
    );
  });

  test('模式未知 (电脑会话没同步 agentMode) 不拦, 按老行为走', () {
    expect(modeSwitchLeavesSession(sessionMode: null, next: HomeMode.chat), isNull);
  });

  test('没有当前会话时切标签 → 什么都不用做', () {
    expect(modeSwitchLeavesSession(sessionMode: null, next: HomeMode.work), isNull);
  });

  group('switchHomeMode · 真的清会话', () {
    Future<(ProviderContainer, AppDatabase)> setUp(String agentMode) async {
      final db = newTestDb();
      addTearDown(db.close);
      await seedSession(db, id: 's1', agentMode: agentMode, desktopDeviceId: '__neox_phone_local__');
      final prefs = await testPrefs();
      final container = ProviderContainer(overrides: [
        appDatabaseProvider.overrideWithValue(db),
        sharedPreferencesProvider.overrideWithValue(prefs),
      ]);
      addTearDown(container.dispose);
      container.read(currentSessionProvider.notifier).set('s1');
      return (container, db);
    }

    test('工作会话里切对话: 当前会话清掉, 模式换成对话', () async {
      final (container, _) = await setUp('work');
      final left = await switchHomeModeWith(container.read, HomeMode.chat);
      expect(left, HomeMode.work);
      expect(container.read(currentSessionProvider), isNull);
      expect(container.read(homeModeProvider), HomeMode.chat);
    });

    test('同模式切换: 会话不动 (接着在那条会话里聊)', () async {
      final (container, _) = await setUp('work');
      final left = await switchHomeModeWith(container.read, HomeMode.work);
      expect(left, isNull);
      expect(container.read(currentSessionProvider), 's1');
      expect(container.read(homeModeProvider), HomeMode.work);
    });

    test('手机本地对话会话切工作: 也新开 (不留一条对话会话在工作标签下)', () async {
      final (container, _) = await setUp('chat');
      final left = await switchHomeModeWith(container.read, HomeMode.work);
      expect(left, HomeMode.chat);
      expect(container.read(currentSessionProvider), isNull);
      expect(container.read(homeModeProvider), HomeMode.work);
    });
  });
}
