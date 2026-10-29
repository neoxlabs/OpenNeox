/// relay_channel.dart — 远程通道 (手机 ↔ 中继 ↔ 电脑) 的最小契约.
///
/// [WsClientController] 只认这个形状, 不认具体实现: 谁来提供中继 (托管服务 /
/// 自建 / 没有) 由发行版决定 (见 core/edition/edition.dart 的 remoteLink)。
///
/// 除了下面声明的成员, 实现还必须提供跟 [WsClient] **同签名**的
///   `Future<RpcMessage> sendRequest(String method, [Object? params, Duration timeout])`
///   `Future<void> sendNotification(String method, [Object? params])`
/// —— 控制器按 `dynamic` 统一调 LAN / 远程两种客户端 (见 `_activeClient`),
/// 带默认值的可选参数没法在抽象接口里声明成同一个签名, 所以写在这里而不是写进类型。
library;

import 'dart:typed_data';

import 'ws_client.dart' show WsEvent, WsState;

abstract interface class RelayChannel {
  Stream<WsEvent> get events;
  WsState get state;

  /// 最近一次失败的人话原因 —— UI 显示用。
  String? get lastFailureReason;

  /// 已跟对端协商到 v2 二进制帧 (relay_frame.dart): 大回包由传输层分片, 可以要大块
  bool get framesActive;

  Future<void> connect();
  Future<void> dispose();
}

/// 拨一条远程通道需要的全部参数 (中继地址由实现方自己决定).
class RelayDialConfig {
  const RelayDialConfig({
    required this.bearerJwt,
    required this.phoneDeviceId,
    required this.desktopDeviceId,
    required this.relaySessionKey,
    required this.reconnect,
    required this.maxReconnectAttempts,
    required this.peerVerifyTimeout,
    this.targetEndpoint,
  });

  /// 对端是电脑上的哪个入口 (2026-10-17): null = 客户端; `cli:<id>` = 那台电脑上开了 /rc 的 CLI 终端
  final String? targetEndpoint;

  final String bearerJwt;
  final String phoneDeviceId;
  final String desktopDeviceId;
  final Uint8List relaySessionKey;
  final bool reconnect;
  final int maxReconnectAttempts;
  final Duration peerVerifyTimeout;
}
