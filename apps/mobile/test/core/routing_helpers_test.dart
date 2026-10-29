/// routing_helpers_test.dart — 纯逻辑: 会话路由 / 选电脑 / 并列状态 / 标题.
///
/// 这些函数决定了「这条活在哪台机器上跑」「侧栏里显示啥」。
/// 用户看不到函数, 只会看到「消息发去了错的那台电脑」或者「找不到会话」——
/// 所以这里直接用函数钉, 不绕 UI。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/execution/run_target.dart' show kPhoneLocalDeviceId;
import 'package:neox_app/core/execution/run_target_provider.dart';
import 'package:neox_app/core/network/cli_endpoint_id.dart';
import 'package:neox_app/core/network/desktop_presence.dart';
import 'package:neox_app/core/network/ws_client_provider.dart';
import 'package:neox_app/core/session_routing/session_router.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/home/state/home_mode_provider.dart';
import 'package:neox_app/features/home/state/selected_model_provider.dart';
import 'package:neox_app/features/home/widgets/where_sheet.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';
import 'package:neox_app/shared/widgets/neox_drawer.dart';

import '../support/mobile_test_support.dart';

PairedDesktop _desk(
  String id, {
  String? name,
  int? lastConnectedAt,
  String? token = 'token',
  String? deviceNamePrefix,
}) =>
    PairedDesktop(
      id: id.hashCode,
      deviceId: id,
      deviceName: name ?? deviceNamePrefix,
      pairedAt: 0,
      lastConnectedAt: lastConnectedAt,
      deviceToken: token,
    );

final _offlineWs = WsClientState.initial;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  group('desktopStatusOf — 一台电脑此刻能不能派活', () {
    test('ws 连着且是同一台, 走 LAN → 「在线 · 同 Wi-Fi」', () {
      final st = desktopStatusOf(
        _desk('mac-1'),
        FakePresence(),
        const WsClientState(
          connection: WsConnectionState.connected,
          transport: WsTransport.lan,
          activeDesktopDeviceId: 'mac-1',
        ),
      );
      expect(st.online, isTrue);
      expect(st.text, '在线 · 同 Wi-Fi');
    });

    test('ws 连着但走中继 → 「在线 · 远程」', () {
      final st = desktopStatusOf(
        _desk('mac-1'),
        FakePresence(),
        const WsClientState(
          connection: WsConnectionState.connected,
          transport: WsTransport.cloudRelay,
          activeDesktopDeviceId: 'mac-1',
        ),
      );
      expect(st.text, '在线 · 远程');
    });

    test('ws 连的是另一台: 不算这台在线', () {
      final st = desktopStatusOf(
        _desk('mac-1'),
        FakePresence(),
        const WsClientState(
          connection: WsConnectionState.connected,
          transport: WsTransport.lan,
          activeDesktopDeviceId: 'win-1',
        ),
      );
      expect(st.online, isFalse);
    });

    test('服务端说在线 → 「在线」', () {
      final st = desktopStatusOf(_desk('mac-1'), FakePresence(online: {'mac-1'}), _offlineWs);
      expect(st.online, isTrue);
      expect(st.text, '在线');
    });

    test('完全没连过 → 只有「不在线」, 不说多久以前', () {
      final st = desktopStatusOf(_desk('mac-1'), FakePresence(), _offlineWs);
      expect(st.online, isFalse);
      expect(st.text, '不在线');
    });

    test('连过但现在不在 → 「不在线 · 多久以前」', () {
      final st = desktopStatusOf(
        _desk('mac-1', lastConnectedAt: DateTime.now().millisecondsSinceEpoch - 3600 * 1000),
        FakePresence(),
        _offlineWs,
      );
      expect(st.text, startsWith('不在线 · '));
      expect(st.text, contains('小时'));
    });
  });

  group('orderDesktops — 列表顺序', () {
    test('在线的排前面, 即使最近连得更晚', () {
      final a = _desk('a', lastConnectedAt: 100);
      final b = _desk('b', lastConnectedAt: 50);
      final out = orderDesktops([a, b], FakePresence(online: {'b'}), _offlineWs);
      expect(out.map((d) => d.deviceId), ['b', 'a']);
    });

    test('都在离线时按最近连过倒序', () {
      final a = _desk('a', lastConnectedAt: 100);
      final b = _desk('b', lastConnectedAt: 300);
      final out = orderDesktops([a, b], FakePresence(), _offlineWs);
      expect(out.map((d) => d.deviceId), ['b', 'a']);
    });

    test('从没连过的排最后', () {
      final a = _desk('a');
      final b = _desk('b', lastConnectedAt: 1);
      final out = orderDesktops([a, b], FakePresence(), _offlineWs);
      expect(out.map((d) => d.deviceId), ['b', 'a']);
    });

    test('cloud agent 那条假电脑不进列表', () {
      final cloud = _desk('cloud', deviceNamePrefix: '☁ 云端', token: null);
      final real = _desk('mac');
      final out = orderDesktops([cloud, real], FakePresence(), _offlineWs);
      expect(out.map((d) => d.deviceId), ['mac']);
    });
  });

  group('cli_endpoint_id — 终端会话挂在哪台电脑上', () {
    test('合成的 id 能被解析回电脑和终端', () {
      final id = makeCliEndpointId('mac-1', 'cli:abc');
      final parsed = parseCliEndpointId(id)!;
      expect(parsed.desktopDeviceId, 'mac-1');
      expect(parsed.endpoint, 'cli:abc');
    });

    test('普通电脑 id 不是终端', () {
      expect(isCliEndpointId('mac-1'), isFalse);
      expect(parseCliEndpointId('mac-1'), isNull);
    });

    test('电脑 id 里带 #cli: 的怪值只认最后一段', () {
      final parsed = parseCliEndpointId('a#b#cli:c')!;
      expect(parsed.desktopDeviceId, 'a#b');
      expect(parsed.endpoint, 'cli:c');
    });

    test('空串 / 只有前缀不算', () {
      expect(parseCliEndpointId(''), isNull);
      expect(parseCliEndpointId('#cli:x'), isNull);
    });

    test('会话归属: 终端会话算它那台电脑', () {
      expect(computerOfSession(makeCliEndpointId('mac-1', 'cli:abc')), 'mac-1');
      expect(computerOfSession('mac-1'), 'mac-1');
    });

    test('来源签: 终端会话标终端; 客户端只在同机有终端时才标', () {
      expect(sessionSourceLabel(makeCliEndpointId('mac-1', 'cli:abc'), const {}), '终端');
      expect(sessionSourceLabel('mac-1', {'mac-1'}), '客户端');
      expect(sessionSourceLabel('mac-1', const {}), isNull);
    });
  });

  group('可见会话与标题', () {
    SessionMirrorData s(String id, {String? title, String kind = 'chat', String? parent, int at = 0}) =>
        SessionMirrorData(
          id: id,
          desktopDeviceId: 'mac-1',
          title: title,
          lastMessageAt: at,
          isSensitive: false,
          createdAt: 0,
          kind: kind,
          parentSessionId: parent,
        );

    test('画布 (image) 不进列表', () {
      final out = visibleTopLevelSessions([s('a'), s('b', kind: 'image')]);
      expect(out.map((e) => e.id), ['a']);
    });

    test('子 agent 不进列表 (不管是 parent 还是标题前缀)', () {
      final out = visibleTopLevelSessions([
        s('a'),
        s('b', parent: 'a'),
        s('c', title: '子 Agent 研究'),
      ]);
      expect(out.map((e) => e.id), ['a']);
    });

    test('按最近活动倒序 (没 lastMessageAt 用 createdAt)', () {
      final out = visibleTopLevelSessions([s('a', at: 10), s('b', at: 30)]);
      expect(out.map((e) => e.id), ['b', 'a']);
    });

    test('标题: 空 / 「新会话」都显示占位, 别的原样', () {
      expect(sessionDisplayTitle(s('a')), '新会话');
      expect(sessionDisplayTitle(s('a', title: '   ')), '新会话');
      expect(sessionDisplayTitle(s('a', title: '新会话')), '新会话');
      expect(sessionDisplayTitle(s('a', title: '改登录页')), '改登录页');
    });
  });

  group('会话属于哪个 home 模式', () {
    test('wire 值: chat / work / assistant / code', () {
      expect(homeModeFromWire('chat'), HomeMode.chat);
      expect(homeModeFromWire('work'), HomeMode.work);
      expect(homeModeFromWire('assistant'), HomeMode.work);
      expect(homeModeFromWire('code'), HomeMode.code);
    });

    test('未知 / 空 wire 值 = 不知道', () {
      expect(homeModeFromWire(null), isNull);
      expect(homeModeFromWire(''), isNull);
      expect(homeModeFromWire('weird'), isNull);
    });

    test('手机本地会话自己映射 (不漏 code)', () {
      expect(homeModeOfSession(agentMode: 'work', desktopDeviceId: kPhoneLocalDeviceId), HomeMode.work);
      expect(homeModeOfSession(agentMode: 'code', desktopDeviceId: kPhoneLocalDeviceId), HomeMode.code);
      expect(homeModeOfSession(agentMode: null, desktopDeviceId: kPhoneLocalDeviceId), HomeMode.chat);
    });

    test('电脑会话按 wire 值', () {
      expect(homeModeOfSession(agentMode: 'code', desktopDeviceId: 'mac-1'), HomeMode.code);
      expect(homeModeOfSession(agentMode: null, desktopDeviceId: 'mac-1'), isNull);
    });
  });

  group('首选电脑 / 运行位置的持久化', () {
    test('没存过首选 → null; 存了读得回来; 清掉又变 null', () async {
      final prefs = await testPrefs();
      final c = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);

      expect(c.read(preferredDesktopProvider), isNull);
      c.read(preferredDesktopProvider.notifier).set('mac-2');
      expect(c.read(preferredDesktopProvider), 'mac-2');
      expect(prefs.getString('neox_preferred_desktop_device_id'), 'mac-2');

      c.read(preferredDesktopProvider.notifier).set(null);
      expect(c.read(preferredDesktopProvider), isNull);
      expect(prefs.getString('neox_preferred_desktop_device_id'), isNull);
    });

    test('首选带空格会 trim; 全空白等于没选', () async {
      final prefs = await testPrefs();
      final c = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);

      c.read(preferredDesktopProvider.notifier).set('  mac-1  ');
      expect(c.read(preferredDesktopProvider), 'mac-1');
      c.read(preferredDesktopProvider.notifier).set('   ');
      expect(c.read(preferredDesktopProvider), isNull);
    });

    test('运行位置: 没选过默认在本机跑', () async {
      final prefs = await testPrefs();
      final c = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);
      expect(c.read(runTargetPrefProvider), RunTargetPref.phone);
    });

    test('运行位置: 选了电脑就存下来, 新开的容器读得到', () async {
      final prefs = await testPrefs();
      final c = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);
      c.read(runTargetPrefProvider.notifier).set(RunTargetPref.desktop);

      final c2 = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c2.dispose);
      expect(c2.read(runTargetPrefProvider), RunTargetPref.desktop);
    });

    test('运行位置: 老键存着 desktop 不再算数 (回到本机)', () async {
      final prefs = await testPrefs({'neox_run_target_pref': 'desktop'});
      final c = ProviderContainer(overrides: [sharedPreferencesProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);
      expect(c.read(runTargetPrefProvider), RunTargetPref.phone);
    });
  });

  group('SessionRouter — 不可用时给诚实的错误', () {
    Future<ProviderContainer> container() async {
      final prefs = await testPrefs();
      final db = newTestDb();
      addTearDown(db.close);
      final c = ProviderContainer(overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        appDatabaseProvider.overrideWithValue(db),
        availableModelsProvider.overrideWith((ref) async => const []),
      ]);
      addTearDown(c.dispose);
      return c;
    }

    test('选了电脑但一台都没配对: 说「还没配对电脑」', () async {
      final c = await container();
      await expectLater(
        c.read(sessionRouterProvider).createBestSession(target: RunTargetPref.desktop),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('还没配对电脑'))),
      );
    });

    test('云端没登录 / 没套餐: 说清楚要去哪看', () async {
      final c = await container();
      await expectLater(
        c.read(sessionRouterProvider).createBestSession(target: RunTargetPref.cloud),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('云端 Agent'))),
      );
    });

    test('编码模式锁本机: 在电脑上才能跑', () async {
      final c = await container();
      await expectLater(
        c.read(sessionRouterProvider).createBestSession(target: RunTargetPref.phone, agentMode: 'code'),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('编码要在电脑上跑'),
        )),
      );
    });

    test('自动 + 编码 + 没有电脑: 也明确拒绝, 不静默降级', () async {
      final c = await container();
      await expectLater(
        c.read(sessionRouterProvider).createBestSession(target: RunTargetPref.auto, agentMode: 'code'),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('编码要在电脑上跑'),
        )),
      );
    });
  });
}
