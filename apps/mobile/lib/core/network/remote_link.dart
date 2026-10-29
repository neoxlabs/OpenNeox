/// remote_link.dart — "不在同一个 Wi-Fi 也能连上电脑" 这件事的契约.
///
/// 同 Wi-Fi 直连是核心能力, 永远在; 跨网络要一个中继和一套身份 (谁有资格往
/// 那台电脑发东西), 这两样由发行版提供。没有提供时 [remoteLinkProvider] 是 null,
/// [WsClientController] 的选路自然退化成"只走同 Wi-Fi" (planRoute 的 loggedIn=false)。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';
import 'relay_channel.dart';
import 'self_hosted_relay.dart';

abstract class RemoteLink {
  /// 本地持有远程连接所需的身份凭证 (不看服务端是否已作废)。
  bool get signedIn;

  /// 拨远程之前拿一个可用的 bearer。
  ///
  /// jwt 为 null 表示这次不该发 —— error 是给用户看的原因 (null = 不必说)。
  /// [alive] 由调用方给出: 等刷新的这段时间里调用方可能已经不在了。
  Future<({String? jwt, String? error})> bearerToken({
    required bool Function() alive,
  });

  /// 造一条还没连的远程通道。
  RelayChannel openRelay(RelayDialConfig config);

  /// 电脑在线但中继没接上时, 让服务端叫它重拨, 并等它接回来。
  Future<bool> wakeRelayAndWait(String desktopDeviceId);

  /// 跟服务端对一遍同账号的电脑 (补 LAN token / relay key)。返回有变化的条数。
  Future<int> syncDesktops();

  /// 用双方已公布的公钥重新派生配对密钥 (配对失效时的自愈)。
  Future<void> initialPair();
}

/// 电脑配了自托管中继就用它 (两个发行版一样), 否则问发行版要。
final remoteLinkProvider = Provider<RemoteLink?>((ref) {
  final selfHosted = ref.watch(selfHostedRelayProvider);
  if (selfHosted != null) return SelfHostedRemoteLink(selfHosted);
  return ref.watch(editionProvider).remoteLink(ref);
});
