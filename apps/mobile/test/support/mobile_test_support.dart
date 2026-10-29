/// mobile_test_support.dart — 手机端测试的公共底座.
///
/// 只放「每次都要写、写错就全体红」的那几件: 内存 DB、假的 prefs、
/// 电脑 / 会话种子数据、断网、安卓保活状态。不包自动化 magic。
library;

import 'package:drift/drift.dart' show InsertMode, Value;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/network/desktop_presence.dart';
import 'package:neox_app/core/notifications/inbox.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/core/storage/tables.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

AppDatabase newTestDb() => AppDatabase.forTesting(NativeDatabase.memory());

/// 假的 SharedPreferences; 传进来的键先放好 (比如已经同意的 AI 数据告知).
Future<SharedPreferences> testPrefs([Map<String, Object> values = const {}]) async {
  SharedPreferences.setMockInitialValues(values);
  return SharedPreferences.getInstance();
}

/// 已配对的一台电脑. 默认 1 小时前连过 = 「能连」.
Future<void> seedDesktop(
  AppDatabase db, {
  required String deviceId,
  String? name,
  int? lastConnectedAt,
  int? pairedAt,
}) async {
  final now = DateTime.now().millisecondsSinceEpoch;
  await db.into(db.pairedDesktops).insert(
        PairedDesktopsCompanion.insert(
          deviceId: deviceId,
          deviceName: Value(name ?? deviceId),
          pairedAt: pairedAt ?? now - 3600 * 1000,
          lastConnectedAt: Value(lastConnectedAt ?? now - 3600 * 1000),
        ),
        mode: InsertMode.insertOrReplace,
      );
}

/// 电脑上的一条会话镜像.
Future<void> seedSession(
  AppDatabase db, {
  required String id,
  String desktopDeviceId = 'mac-1',
  String? title,
  String? workspaceName,
  int? lastMessageAt,
  String agentMode = 'work',
  String kind = 'chat',
  String? parentSessionId,
  int? createdAt,
}) async {
  final now = DateTime.now().millisecondsSinceEpoch;
  await db.into(db.sessionMirror).insert(
        SessionMirrorCompanion.insert(
          id: id,
          desktopDeviceId: desktopDeviceId,
          title: Value(title),
          workspaceName: Value(workspaceName),
          lastMessageAt: Value(lastMessageAt ?? now - 60 * 1000),
          createdAt: createdAt ?? now - 3600 * 1000,
          agentMode: Value(agentMode),
          kind: Value(kind),
          parentSessionId: Value(parentSessionId),
        ),
        mode: InsertMode.insertOrReplace,
      );
}

/// 服务端说有哪几台在线 (open edition 默认什么都不知道, 全部显示不在线).
/// 商业版那一面 (有 Pilot / 连官方服务 / 产品名 Neox), 测这些入口时覆盖 editionProvider 用。
/// 测试树不能 import lib/commercial (开源导出会删掉它), 所以在这里仿一个。
class PilotEdition extends NeoxEdition {
  const PilotEdition();

  @override
  String get id => 'test-commercial-face';

  @override
  bool get pilotAvailable => true;

  @override
  bool get officialServices => true;

  @override
  String get productName => 'Neox';
}

class FakePresence implements DesktopPresenceView {
  FakePresence({this.online = const {}, this.live = true});
  final Set<String> online;
  @override
  final bool live;
  @override
  bool isOnline(String deviceId) => online.contains(deviceId);
  @override
  bool? relayOnline(String deviceId) => online.contains(deviceId);
}

/// 把组件放进最普通的一层 MaterialApp (测试不需要真的路由表).
Widget plainApp(Widget home) => MaterialApp(home: home);

/// 手机尺寸的视口: 抽屉 / 列表都按竖屏排版, 用默认 800x600 会碰到真机上
/// 不会出现的意外换行.
void phoneViewport(WidgetTester t) {
  t.view.physicalSize = const Size(412 * 2, 915 * 2);
  t.view.devicePixelRatio = 2.0;
  addTearDown(t.view.reset);
}

/// 手机有没有网. online=false → 平台报 [none].
void mockConnectivity({required bool online}) {
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(
    const MethodChannel('dev.fluttercommunity.plus/connectivity'),
    (call) async => online ? ['wifi'] : ['none'],
  );
  messenger.setMockMethodCallHandler(
    const MethodChannel('dev.fluttercommunity.plus/connectivity_status'),
    (call) async => null,
  );
  addTearDown(() {
    messenger.setMockMethodCallHandler(
      const MethodChannel('dev.fluttercommunity.plus/connectivity'),
      null,
    );
    messenger.setMockMethodCallHandler(
      const MethodChannel('dev.fluttercommunity.plus/connectivity_status'),
      null,
    );
  });
}

/// 安卓保活开 / 关. 不 mock 时返回 null = 「不知道」, 横幅不出现.
void mockKeepAlive({required bool accessibility}) {
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(
    const MethodChannel('neox.phone/keepalive'),
    (call) async => call.method == 'status' ? {'accessibility': accessibility} : null,
  );
  addTearDown(() => messenger.setMockMethodCallHandler(
        const MethodChannel('neox.phone/keepalive'),
        null,
      ));
}

/// 已经同意「发给 AI 模型」的告知 (Pilot 聊天页的闸).
const aiConsentGiven = {'neox.ai_data_consent.v1': true};

/// 消息铃用的 store.
///
/// 真的 [InboxStore] 是进程级单例, 数据会在测试之间串 (见 inbox_provider_test.dart:
/// 单例已经不会被 Provider 销毁了)。这里给一个独立的空 store: 只实现页面读的那两个 getter,
/// 别的调用走 noSuchMethod 直接报错 (测试里不该真的往消息页写数据)。
class FakeInboxStore extends ChangeNotifier implements InboxStore {
  @override
  List<InboxItem> get items => const [];

  @override
  int get unread => 0;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
