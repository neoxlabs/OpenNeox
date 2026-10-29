/// self_hosted_relay.dart — 自托管中继 (cloud/relay): 不要账号, 部署令牌鉴权.
///
/// 地址和令牌从电脑来: 扫码配对的回包里带, 之后每次在同一个 Wi-Fi 连上电脑时
/// 再问一次 (`relay.config`), 电脑那边改了地址或换了令牌, 手机下次回家就跟上。
/// 配了它, [remoteLinkProvider] 就用它出门远程 —— 两个发行版都一样; 商业版没配时
/// 照旧走账号那条。内容仍由配对时派生的端到端密钥加密, 中继看不到。
library;

import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'cloud_relay_client.dart';
import 'relay_channel.dart';
import 'remote_link.dart';

const _kKey = 'neox_self_hosted_relay';

class SelfHostedRelay {
  const SelfHostedRelay({required this.url, required this.token});
  final String url;
  final String token;

  /// 电脑发来的 `{url, token}`; 不合法返回 null (当作没配)。
  static SelfHostedRelay? fromJson(Object? json) {
    if (json is! Map) return null;
    final url = json['url'];
    final token = json['token'];
    if (url is! String || token is! String || token.length < 16) return null;
    final uri = Uri.tryParse(url);
    if (uri == null || (uri.scheme != 'https' && uri.scheme != 'http') || uri.host.isEmpty) return null;
    return SelfHostedRelay(url: url, token: token);
  }

  Map<String, String> toJson() => {'url': url, 'token': token};

  @override
  bool operator ==(Object other) =>
      other is SelfHostedRelay && other.url == url && other.token == token;

  @override
  int get hashCode => Object.hash(url, token);
}

class SelfHostedRelayController extends StateNotifier<SelfHostedRelay?> {
  SelfHostedRelayController(this._storage) : super(null) {
    _hydrate();
  }
  final FlutterSecureStorage _storage;

  Future<void> _hydrate() async {
    try {
      final raw = await _storage.read(key: _kKey);
      final v = raw == null ? null : SelfHostedRelay.fromJson(jsonDecode(raw));
      if (mounted && state == null) state = v;
    } catch (e) {
      debugPrint('[self-relay] 读取失败: $e');
    }
  }

  /// 电脑说了算: 给了就存, 明确说没有 (null) 就清。
  Future<void> apply(SelfHostedRelay? next) async {
    if (next == state) return;
    state = next;
    if (next == null) {
      await _storage.delete(key: _kKey);
    } else {
      await _storage.write(key: _kKey, value: jsonEncode(next.toJson()));
    }
    debugPrint('[self-relay] ${next == null ? '已清除' : '已更新 ${next.url}'}');
  }
}

final selfHostedRelayProvider =
    StateNotifierProvider<SelfHostedRelayController, SelfHostedRelay?>(
      (ref) => SelfHostedRelayController(const FlutterSecureStorage()),
    );

/// 自托管中继的 [RemoteLink]: bearer 就是部署令牌, 没有账号、没有在线信号服务。
class SelfHostedRemoteLink implements RemoteLink {
  SelfHostedRemoteLink(this._relay);
  final SelfHostedRelay _relay;

  @override
  bool get signedIn => true;

  @override
  Future<({String? jwt, String? error})> bearerToken({
    required bool Function() alive,
  }) async => (jwt: _relay.token, error: null);

  @override
  RelayChannel openRelay(RelayDialConfig config) => CloudRelayClient(
    CloudRelayConfig(
      serverBaseUrl: _relay.url,
      bearerJwt: config.bearerJwt,
      phoneDeviceId: config.phoneDeviceId,
      desktopDeviceId: config.desktopDeviceId,
      relaySessionKey: config.relaySessionKey,
      reconnect: config.reconnect,
      maxReconnectAttempts: config.maxReconnectAttempts,
      peerVerifyTimeout: config.peerVerifyTimeout,
      targetEndpoint: config.targetEndpoint,
    ),
  );

  /// 没有在线信号服务能去叫醒电脑 —— 电脑自己会重连中继。
  @override
  Future<bool> wakeRelayAndWait(String desktopDeviceId) async => false;

  /// 没有账号下的设备列表可对; 配对只靠扫码。
  @override
  Future<int> syncDesktops() async => 0;

  @override
  Future<void> initialPair() async {}
}
