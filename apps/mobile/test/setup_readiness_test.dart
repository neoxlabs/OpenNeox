/// setup_readiness_test.dart — 「这台手机能不能干活」的判据.
///
/// 为什么值得锁住 (2026-08-08):
///   这个 provider 现在是**发送拦截的唯一开关**。判错两个方向都很贵:
///     · 该拦没拦 → 用户撞回原来那条死胡同 (建了空会话 + 一条没按钮的
///       "请先登录账户后使用手机模式")
///     · 不该拦却拦了 → 已经配好 Key / 配好电脑的人被一个引导面板挡住发不出消息,
///       比原来的 bug 更糟
///   所以三条路各自的通断、以及"任一条通即放行"必须逐个钉死。
library;

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/byok/byok_models.dart';
import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/byok/byok_store.dart';
import 'package:neox_app/core/startup/setup_readiness.dart';
import 'package:neox_app/core/storage/database.dart';

/// 只读 stub — 让 byokStoreProvider 返回固定列表, 不碰 secure storage.
class _StubByokStore extends StateNotifier<List<ByokProviderConfig>>
    implements ByokStore {
  _StubByokStore(super.state);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

ByokProviderConfig _provider({
  required String id,
  bool enabled = true,
  List<String> models = const ['gpt-4o'],
}) =>
    ByokProviderConfig(
      id: id,
      name: id,
      protocol: ByokProtocol.openaiCompat,
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      models: models,
      enabled: enabled,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppDatabase db;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
  });
  tearDown(() async => db.close());

  /// 造一个容器: [loggedIn] 决定账号路, [byok] 决定自带 Key 路,
  /// 电脑路由调用方自己往 db 里插行.
  ///
  /// 账号路直接覆盖发行版给出的登录态 (accountStatusProvider) —— "登录凭证 →
  /// signedIn" 这一段映射由商业版自己的测试守 (test/commercial/commercial_edition_test.dart)。
  ProviderContainer makeContainer({
    bool loggedIn = false,
    List<ByokProviderConfig> byok = const [],
  }) {
    return ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(db),
        accountStatusProvider.overrideWithValue(
          loggedIn
              ? const AccountStatus(signedIn: true)
              : AccountStatus.signedOut,
        ),
        byokStoreProvider.overrideWith((ref) => _StubByokStore(byok)),
      ],
    );
  }

  /// 真电脑要有 deviceToken —— isCloudAgentPairedDesktop 正是靠
  /// `deviceToken == null && deviceName 以 '☁' 开头` 区分云端虚拟 chip 的.
  Future<void> addDesktop(
    String deviceId, {
    String? name,
    String? deviceToken = 'tok',
  }) async {
    await db.pairedDesktopsDao.upsert(
      PairedDesktopsCompanion(
        deviceId: Value(deviceId),
        deviceName: Value(name ?? deviceId),
        deviceToken: Value(deviceToken),
        pairedAt: Value(DateTime.now().millisecondsSinceEpoch),
      ),
    );
  }

  /// stream provider 首帧是异步的 — 等它落地再断言, 否则测的是初始 0.
  Future<SetupReadiness> settled(ProviderContainer c) async {
    c.listen(setupReadinessProvider, (_, _) {}, fireImmediately: true);
    await Future<void>.delayed(const Duration(milliseconds: 60));
    return c.read(setupReadinessProvider);
  }

  group('全新用户 — 一条路都没有', () {
    test('三条全断 → isBlank, 发送必须被拦', () async {
      final c = makeContainer();
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasAccount, isFalse);
      expect(r.hasOwnKey, isFalse);
      expect(r.hasDesktop, isFalse);
      expect(r.isBlank, isTrue);
      expect(r.isReady, isFalse);
      expect(r.readyCount, 0);
    });
  });

  group('任一条通就放行 — 三条各自单独验', () {
    test('只登录了账号', () async {
      final c = makeContainer(loggedIn: true);
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasAccount, isTrue);
      expect(r.isReady, isTrue);
      expect(r.isBlank, isFalse);
    });

    test('只配了自己的 Key (零账号 BYOK — 产品的核心主张)', () async {
      final c = makeContainer(byok: [_provider(id: 'p1')]);
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasOwnKey, isTrue);
      expect(r.hasAccount, isFalse, reason: 'BYOK 不该要求登录');
      expect(r.isReady, isTrue);
    });

    test('只配对了电脑', () async {
      final c = makeContainer();
      addTearDown(c.dispose);
      await addDesktop('desk-1');
      final r = await settled(c);

      expect(r.hasDesktop, isTrue);
      expect(r.isReady, isTrue);
    });
  });

  group('BYOK 的边界 — 半配好的不算通', () {
    test('provider 被禁用 → 不算', () async {
      final c = makeContainer(byok: [_provider(id: 'p1', enabled: false)]);
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasOwnKey, isFalse);
      expect(r.isBlank, isTrue);
    });

    test('启用了但一个模型都没勾 → 不算', () async {
      // 探活成功但用户没勾模型就退出去了 — 模型选择器里依然是空的,
      // 放行的话他发送时照样撞墙, 只是换了个错误。
      final c = makeContainer(byok: [_provider(id: 'p1', models: const [])]);
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasOwnKey, isFalse);
      expect(r.isBlank, isTrue);
    });

    test('多个 provider 里只要有一个配全了就算通', () async {
      final c = makeContainer(byok: [
        _provider(id: 'p1', models: const []),
        _provider(id: 'p2', enabled: false),
        _provider(id: 'p3'),
      ]);
      addTearDown(c.dispose);
      final r = await settled(c);

      expect(r.hasOwnKey, isTrue);
    });
  });

  group('电脑那条路的口径', () {
    test('云端虚拟 chip 不算真电脑', () async {
      // cloud agent 在 paired_desktops 里也占一行, 但它不是"我的电脑";
      // 把它算进来的话, 开过一次云端任务的人就再也看不到配对引导了。
      final c = makeContainer();
      addTearDown(c.dispose);
      await addDesktop('cloud-1', name: '☁ Neox 云端', deviceToken: null);
      final r = await settled(c);

      expect(r.hasDesktop, isFalse);
      expect(r.isBlank, isTrue);
    });

    test('电脑关机 (没连上过) 仍算已配对 — 不该被当成全新用户重新引导', () async {
      final c = makeContainer();
      addTearDown(c.dispose);
      // lastConnectedAt 留空 = 从没连上过
      await addDesktop('desk-offline');
      final r = await settled(c);

      expect(r.hasDesktop, isTrue,
          reason: '判的是"配没配过", 不是"此刻连不连得上"');
    });
  });

  test('三条都通 → readyCount 3', () async {
    final c = makeContainer(loggedIn: true, byok: [_provider(id: 'p1')]);
    addTearDown(c.dispose);
    await addDesktop('desk-1');
    final r = await settled(c);

    expect(r.readyCount, 3);
    expect(r.isReady, isTrue);
  });
}
