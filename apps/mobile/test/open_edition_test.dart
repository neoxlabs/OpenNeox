/// open_edition_test.dart — 没有装发行版时 (开源版 / 测试 / 预览入口) 的默认值.
///
/// 每项托管能力都必须是"没有", 而且是**如实的没有**: 远程/云端/托管出图为 null,
/// 模型网关报错让手机本地模式退到自己的 Key。任何一项默认成"有", 开源包就会去连
/// 一个它没有的服务。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/edition/edition.dart';
import 'package:neox_app/core/execution/cloud_agent_access.dart';
import 'package:neox_app/core/image/hosted_image_backend.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart';
import 'package:neox_app/core/network/remote_link.dart';

void main() {
  test('默认发行版是开源版, 每项托管能力都是"没有"', () async {
    final c = ProviderContainer();
    addTearDown(c.dispose);
    expect(c.read(editionProvider), isA<OpenEdition>());
    expect(c.read(editionProvider).hasAccounts, isFalse);
    expect(c.read(accountStatusProvider), AccountStatus.signedOut);
    expect(c.read(remoteLinkProvider), isNull);
    expect(c.read(cloudAgentAccessProvider), isNull);
    expect(c.read(hostedImageBackendProvider), isNull);
    expect(c.read(cloudEntriesVisibleProvider), isFalse);
    expect(c.read(cloudTakeoverVisibleProvider), isFalse);
    expect(c.read(desktopPresenceProvider).isOnline('any'), isFalse);
    expect(c.read(desktopPresenceProvider).relayOnline('any'), isNull);

    final gateway = c.read(modelGatewayClientProvider);
    expect(gateway, isA<UnavailableModelGateway>());
    await expectLater(gateway.listModels(), throwsStateError);
  });

  test('开源版路由守卫只剩核心判定 (应用锁)', () {
    final refProvider = Provider<Ref>((ref) => ref);
    final c = ProviderContainer();
    addTearDown(c.dispose);
    const edition = OpenEdition();
    String? redirect(String loc, String? lock) => edition.redirect(
      c.read(refProvider),
      loc,
      isCorePublic: false,
      coreRedirect: () => lock,
    );
    expect(redirect('/settings', null), isNull);
    expect(redirect('/settings', '/locked'), '/locked');
    expect(edition.routes(), isEmpty);
  });
}
