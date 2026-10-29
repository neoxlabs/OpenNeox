/// cloud_relay_client.dart — Mode B (中继) WSS 客户端.
///
/// 商业版 NeoxCloud 中继和自托管中继 (cloud/relay) 说同一套协议, 区别只在地址和
/// bearer (账号 JWT / 部署令牌), 所以这个客户端放在 core, 两边共用。
///
/// 协议规范 `docs/NEOX_MOBILE_PROTOCOL.md` §4:
///   - WSS to `{serverUrl}/relay/api/v1/relay` (生产: https://relay.neox.dev/...)
///   - Headers: Authorization Bearer JWT + X-Neox-Device-Id + X-Neox-Device-Type
///   - 发: RpcMessage → JSON → AES-256-GCM encrypt → envelope {to_device_id, from_device_id,
///        nonce, ciphertext, ts, bytes} → JSON → ws.send
///   - 收: ws → JSON.parse → envelope → AES-256-GCM decrypt → RpcMessage.fromJsonString
///        → events stream
///
/// **密钥**: paired_desktops.relaySessionKey (32-byte AES key), 配对时算好.
///         同一对 (mobile, desktop) 永久共享, 一对多 desktop 时每对独立 key.
///
/// 跟 [WsClient] (Mode A LAN) 暴露同款 API: connect / events / sendRequest / dispose,
/// 让上层 [WsClientController] 透明切换 transport.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../crypto/aes_gcm.dart';
import 'json_rpc.dart';
import 'relay_channel.dart';
import 'relay_frame.dart';
import 'ws_client.dart'
    show WsEvent, WsEventMessage, WsEventStateChanged, WsState;
import 'package:neox_app/core/i18n/tr.dart';

class CloudRelayConfig {
  const CloudRelayConfig({
    required this.serverBaseUrl,
    required this.bearerJwt,
    required this.phoneDeviceId,
    required this.desktopDeviceId,
    required this.relaySessionKey,
    this.reconnect = true,
    this.maxReconnectAttempts = 3,
    this.peerVerifyTimeout = const Duration(seconds: 10),
    this.targetEndpoint,
    this.ownEndpoint,
  });

  /// 对端是电脑上的哪个入口 (2026-10-17): null = 客户端 (主入口); `cli:<id>` = 某个 CLI 终端。
  /// 发的 envelope 带 to_endpoint, 收的只认 from_endpoint 对得上的。
  final String? targetEndpoint;

  /// 自己这条连接的入口: null = 手机主连接; `app:<id>` = 看终端用的那条轻连接。
  final String? ownEndpoint;

  /// 完整 server base url, e.g. `https://relay.example.com` 或自托管的 `http://<host>:8089`.
  /// 实际 WSS 路径会拼 `${serverBaseUrl}/relay/api/v1/relay`. http→ws / https→wss 自动转.
  final String serverBaseUrl;
  final String bearerJwt;
  final String phoneDeviceId;
  final String desktopDeviceId;
  final Uint8List relaySessionKey;
  final bool reconnect;

  /// fast-fail: 最多 N 次连失败后就停下来, 把错误暴露给用户, 不死循环 reconnect.
  /// 用户看到错误自己决定切回 LAN 或重试; 自动 reconnect 只在 connected 后掉线场景启动.
  final int maxReconnectAttempts;

  /// relay WS 连上后, 等对端 desktop/cloud agent 回一个轻量 RPC 的最长时间.
  /// 真实 desktop 需要快失败回到智能选路; cloud agent 冷启动可以更宽松.
  final Duration peerVerifyTimeout;
}

class CloudRelayClient implements RelayChannel {
  CloudRelayClient(this.config);
  final CloudRelayConfig config;

  final StreamController<WsEvent> _events = StreamController.broadcast();
  final Map<String, Completer<RpcMessage>> _pendingRequests = {};
  final Random _rng = Random.secure();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _channelSub;
  WsState _state = WsState.disconnected;
  bool _disposed = false;

  /// 验证期: handshake 完但还没确认 desktop online 时是 true, 允许探测 RPC 发送.
  /// 不进入 authenticated 状态 — 不让 UI 看到绿色, 直到对端真的回包.
  bool _verifying = false;
  Timer? _reconnectTimer;
  int _reconnectDelayMs = 1000;

  /// 已尝试连接次数 (含首次). 一旦认证成功就清零, 之后再失败属于"半路掉线"循环.
  int _connectAttempts = 0;

  /// 自上次成功是否曾经 authenticated — 决定 fast-fail 还是允许长重连.
  bool _everAuthenticated = false;

  /// 协议 v2 (relay_frame.dart): 中转认 + 对端认才发二进制帧; 每次重连都重新确认
  bool _relayV2 = false;
  bool _peerV2 = false;
  final FrameAssembler _assembler = FrameAssembler();

  @override
  bool get framesActive => _relayV2 && _peerV2;

  /// 最近一次失败的 human-readable reason — UI 显示用.
  String? _lastFailureReason;
  @override
  String? get lastFailureReason => _lastFailureReason;

  @override
  Stream<WsEvent> get events => _events.stream;
  @override
  WsState get state => _state;

  @override
  Future<void> connect() async {
    if (_disposed) return;
    if (_state == WsState.connecting || _state == WsState.authenticated) return;
    _connectAttempts += 1;
    _setState(WsState.connecting);
    try {
      await _doConnect();
      /* 探测对端 desktop 是否真的 online — relay 接受我的 WS 不代表 desktop 在.
       * 必须先 session.list 拿到响应才确认链路真通, 否则 UI 不该看到绿色. */
      _verifying = true;
      try {
        await _verifyPeerOnline();
      } finally {
        _verifying = false;
      }
      _reconnectDelayMs = 1000;
      _connectAttempts = 0;
      _everAuthenticated = true;
      _lastFailureReason = null;
      _setState(WsState.authenticated);
      debugPrint('[cloud-relay] authenticated');
    } catch (e) {
      final reason = _humanizeError(e);
      _lastFailureReason = reason;
      debugPrint(
        '[cloud-relay] connect failed (attempt $_connectAttempts/${config.maxReconnectAttempts}): $reason',
      );
      /* 验证失败可能已 listen 了 channel, 不清掉的话下次 connect 还看到旧 channel. */
      await _channelSub?.cancel();
      _channelSub = null;
      try {
        await _channel?.sink.close();
      } catch (_) {}
      _channel = null;
      _setState(WsState.failed, errorMessage: reason);
      /* fast-fail: 从未 authenticated 过 + 已尝试 maxReconnectAttempts 次 → 停, 不再 reconnect.
       *   认证过的 (掉线重连) 走宽松策略, 一直重试. */
      final exhausted =
          !_everAuthenticated &&
          _connectAttempts >= config.maxReconnectAttempts;
      if (exhausted) {
        debugPrint(
          '[cloud-relay] fast-fail: gave up after $_connectAttempts attempts',
        );
        return;
      }
      if (config.reconnect && !_disposed) _scheduleReconnect();
    }
  }

  /// 握手后做一次真实 RPC, 让 relay 把消息转给对端.
  /// relay 接受我的 WS 不代表 desktop/cloud agent 真的在线.
  Future<void> _verifyPeerOnline() async {
    try {
      await sendRequest('session.list', const {
        'limit': 1,
      }, config.peerVerifyTimeout);
    } on TimeoutException {
      throw StateError(tr('电脑暂时没有响应，请确认电脑端 Neox 已打开'));
    }
  }

  /// 失败原因人类可读化 — UI 直接显示.
  String _humanizeError(Object e) {
    final raw = e.toString();
    if (e is TimeoutException) return tr('远程连接超时，请重试');
    if (raw.contains('电脑暂时没有响应')) return tr('电脑暂时没有响应，请确认电脑端 Neox 已打开');
    if (raw.contains('401') || raw.toLowerCase().contains('unauthorized')) {
      return tr('登录已过期，请重新登录');
    }
    if (raw.contains('403')) return tr('当前账户暂不能使用远程连接');
    if (raw.contains('502') || raw.contains('503') || raw.contains('504')) {
      return tr('远程连接服务暂不可用');
    }
    if (raw.toLowerCase().contains('socketexception') ||
        raw.toLowerCase().contains('connection refused') ||
        raw.toLowerCase().contains('failed host lookup')) {
      return tr('网络异常，远程连接暂不可用');
    }
    /* 截断超长堆栈, 只留前 80 字 */
    final cleaned = raw
        .replaceFirst(RegExp(r'^(Exception|StateError|Bad state):\s*'), '')
        .trim();
    if (RegExp(r'[\u4e00-\u9fff]').hasMatch(cleaned)) {
      return cleaned.length > 80 ? cleaned.substring(0, 80) : cleaned;
    }
    return tr('远程连接暂不可用，请稍后重试');
  }

  Future<void> _doConnect() async {
    /* http(s) → ws(s) URL 自动转 */
    final base = config.serverBaseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    final scheme = base.startsWith('https://') ? 'wss' : 'ws';
    final hostPath = base.replaceFirst(RegExp(r'^https?://'), '');
    final url = '$scheme://$hostPath/relay/api/v1/relay';
    debugPrint('[cloud-relay] dialing $url');
    _relayV2 = false;
    _peerV2 = false;
    final headers = <String, dynamic>{
      'Authorization': 'Bearer ${config.bearerJwt}',
      'X-Neox-Device-Id': config.phoneDeviceId,
      'X-Neox-Device-Type': 'mobile',
      if (config.ownEndpoint != null) 'X-Neox-Endpoint': config.ownEndpoint!,
    };
    final ws = await WebSocket.connect(
      url,
      headers: headers,
    ).timeout(const Duration(seconds: 6));
    /* 拨号期间被 dispose (赛跑输了 / 这一轮作废) —— 关掉刚建好的 socket 再退出。 */
    if (_disposed) {
      try {
        await ws.close(1000, 'disposed during connect');
      } catch (_) {}
      throw StateError('cloud-relay disposed during connect');
    }
    /* 主动 ping 让死端 (relay 或 desktop) 在 ~16s 内被发现, 而不是默认 TCP 2h. */
    ws.pingInterval = const Duration(seconds: 8);
    final channel = IOWebSocketChannel(ws);
    _channel = channel;
    _channelSub = channel.stream.listen(
      _onData,
      onError: _onError,
      onDone: _onDone,
      cancelOnError: false,
    );
  }

  void _onData(dynamic raw) async {
    /* v2 二进制帧: 拼齐了再解 */
    if (isBinaryFrame(raw)) {
      final f = decodeFrame(raw as List<int>);
      if (f == null) return;
      if (!_fromOurPeer(f.hdr.from, f.hdr.fromEp)) return;
      final whole = _assembler.push(f.hdr, f.body);
      if (whole == null || whole.length <= kNonceLen) return;
      _peerV2 = true;
      await _handleSealed(
        Uint8List.sublistView(whole, 0, kNonceLen),
        Uint8List.sublistView(whole, kNonceLen),
      );
      return;
    }
    String text;
    if (raw is String) {
      text = raw;
    } else if (raw is List<int>) {
      try {
        text = utf8.decode(raw);
      } catch (_) {
        return;
      }
    } else {
      return;
    }
    final outer = jsonDecode(text);
    if (outer is! Map<String, dynamic>) return;
    /* relay control frames (relay_error / device_offline 等) 是顶层明文 type 字段, 不加密 */
    final outerType = outer['type'];
    if (outerType == 'relay_hello') {
      final v = outer['v'];
      _relayV2 = v is num && v >= kFrameVersion;
      return;
    }
    if (outerType is String) {
      debugPrint(
        '[cloud-relay] control frame: $outerType ${outer['message'] ?? ''}',
      );
      /* device_offline: 对端 desktop 掉线 — 我跟 relay 还连着, 但发任何 envelope 都到不了对端.
       *  把 client state 标失败, 让上层 ws_client_provider 收到 failed event → chip 转红. */
      /* 连的是终端: 只有「这个终端下线」才算对端没了 (客户端在不在跟它无关) */
      final targetEp = config.targetEndpoint;
      final isOurTerminalGone = targetEp != null &&
          outerType == 'endpoint_offline' &&
          outer['device_id'] == config.desktopDeviceId &&
          outer['endpoint'] == targetEp;
      if (isOurTerminalGone ||
          (targetEp == null && (outerType == 'device_offline' || outerType == 'relay_error'))) {
        final offlineDevice = outer['device_id'] as String?;
        final msg = outer['message'] as String? ?? outerType;
        if (isOurTerminalGone || offlineDevice == null || offlineDevice == config.desktopDeviceId) {
          /* 2026-09-17: 中继已明确告诉我们对端不在, 在途请求 (尤其是连接时那发
           * session.list 验证) 立刻失败, 不再白等满超时 (原来要等 2.8s/5s)。
           * StateError 会被 connect() 的 catch 人话化成「电脑已离线」。 */
          _failPendingRequests(StateError(tr('电脑已离线')));
          if (_verifying) {
            /* 验证期由 connect() 的 catch 统一翻 failed, 这里不重复发事件 */
            debugPrint('[cloud-relay] peer offline during verify: $msg');
            return;
          }
          _setState(WsState.failed, errorMessage: tr('电脑已离线'));
          /* 不主动 reconnect — 跟 relay 已连, 是对端 desktop 没启用云中转 / 死. 让用户决定. */
        }
        debugPrint('[cloud-relay] peer offline: $msg');
      }
      return;
    }
    /* envelope: {to_device_id, from_device_id, nonce, ciphertext, ts, bytes} */
    final fromDevice = outer['from_device_id'] as String?;
    final nonceB64 = outer['nonce'] as String?;
    final ctB64 = outer['ciphertext'] as String?;
    if (fromDevice == null || nonceB64 == null || ctB64 == null) {
      debugPrint('[cloud-relay] envelope schema invalid, drop');
      return;
    }
    if (!_fromOurPeer(fromDevice, outer['from_endpoint'] as String?)) return;
    final cap = outer['cap'];
    if (cap is num && cap >= kFrameVersion) _peerV2 = true;
    final Uint8List nonce, ct;
    try {
      nonce = base64Decode(nonceB64);
      ct = base64Decode(ctB64);
    } catch (_) {
      return;
    }
    await _handleSealed(nonce, ct);
  }

  /// 只收当前这台电脑、当前这个入口发来的
  bool _fromOurPeer(String fromDevice, String? fromEndpoint) {
    if (fromDevice != config.desktopDeviceId) {
      /* 多 desktop 配对场景: 来自非当前 active desktop 的 envelope 暂 ignore.
       * Phase 3 多端同时连改成按 fromDevice 分发. */
      debugPrint(
        '[cloud-relay] envelope from non-active desktop $fromDevice, drop',
      );
      return false;
    }
    /* 同一台电脑的不同入口 (客户端 / 各个终端) 各走各的连接, 不串 */
    return (fromEndpoint ?? '') == (config.targetEndpoint ?? '');
  }

  Future<void> _handleSealed(Uint8List nonce, Uint8List ciphertext) async {
    try {
      final plaintextBytes = await AesGcmCipher.instance.decrypt(
        key: config.relaySessionKey,
        nonce: nonce,
        ciphertext: ciphertext,
      );
      final pt = decodeRpcPlaintext(Uint8List.fromList(plaintextBytes));
      var msg = pt == null ? null : RpcMessage.fromJsonString(pt.json);
      /* 带原始字节的回包 (文件块): 字节放进 result['data_bytes'], 不经 base64 */
      final bin = pt?.bin;
      final res = msg?.result;
      if (msg != null && bin != null && res is Map<String, dynamic>) {
        msg = msg.copyWith(result: {...res, 'data_bytes': bin});
      }
      if (msg == null) {
        debugPrint('[cloud-relay] decrypted plaintext not valid RpcMessage');
        return;
      }
      if (msg.isResponse && msg.id != null) {
        final pending = _pendingRequests.remove(msg.id);
        if (pending != null) {
          if (msg.error != null) {
            pending.completeError(msg.error!);
          } else {
            pending.complete(msg);
          }
          return;
        }
      }
      if (_events.isClosed) return;
      _events.add(WsEventMessage(msg));
    } catch (e) {
      debugPrint('[cloud-relay] decrypt failed: $e');
    }
  }

  void _onError(Object error) {
    final reason = _humanizeError(error);
    _lastFailureReason = reason;
    debugPrint('[cloud-relay] socket error: $reason');
    _setState(WsState.failed, errorMessage: reason);
    /* 同 connect: 没 authenticated 过 + 重试到上限 → 停. */
    final exhausted =
        !_everAuthenticated && _connectAttempts >= config.maxReconnectAttempts;
    if (!exhausted && config.reconnect && !_disposed) _scheduleReconnect();
  }

  void _onDone() {
    debugPrint('[cloud-relay] socket closed');
    _setState(WsState.disconnected);
    final exhausted =
        !_everAuthenticated && _connectAttempts >= config.maxReconnectAttempts;
    if (!exhausted && config.reconnect && !_disposed) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    final jitter = _rng.nextInt(500);
    final delay = Duration(milliseconds: _reconnectDelayMs + jitter);
    debugPrint('[cloud-relay] reconnect in ${delay.inMilliseconds}ms');
    _reconnectTimer = Timer(delay, () {
      _reconnectDelayMs = (_reconnectDelayMs * 2).clamp(1000, 30000);
      if (!_disposed) unawaited(connect());
    });
  }

  /// 发请求等响应 — request/response 走 RpcMessage.id 配对 (跟 Mode A 同款语义).
  Future<RpcMessage> sendRequest(
    String method, [
    Object? params,
    Duration timeout = const Duration(seconds: 10),
  ]) async {
    final id =
        'req-${DateTime.now().microsecondsSinceEpoch}-${_rng.nextInt(0xFFFFFF)}';
    final msg = makeRequest(id, method, params);
    final completer = Completer<RpcMessage>();
    _pendingRequests[id] = completer;
    await _sendEncrypted(msg);
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pendingRequests.remove(id);
        throw TimeoutException('cloud-relay request timeout: $method');
      },
    );
  }

  /// 发 notification — 不等响应.
  Future<void> sendNotification(String method, [Object? params]) async {
    await _sendEncrypted(makeNotification(method, params));
  }

  Future<void> _sendEncrypted(RpcMessage msg) async {
    final channel = _channel;
    /* _verifying 期间 state 还是 connecting, 但 channel 已 listen, 允许探测 RPC 发出.
     * 否则 _verifyPeerOnline 永远拿不到响应, 死循环验证失败. */
    if (channel == null || (!_verifying && _state != WsState.authenticated)) {
      throw StateError('cloud-relay not connected');
    }
    final plaintext = utf8.encode(msg.toJsonString());
    final enc = await AesGcmCipher.instance.encrypt(
      key: config.relaySessionKey,
      plaintext: plaintext,
    );
    if (framesActive) {
      final route = FrameHeader(
        to: config.desktopDeviceId,
        from: config.phoneDeviceId,
        toEp: config.targetEndpoint,
        fromEp: config.ownEndpoint,
      );
      for (final f in encodeFrames(route, enc.nonce, enc.ciphertext)) {
        channel.sink.add(f);
      }
      return;
    }
    final envelope = {
      /* 告诉电脑「我认 v2 帧」, 它也认就会改发 v2 */
      'cap': kFrameVersion,
      'to_device_id': config.desktopDeviceId,
      'from_device_id': config.phoneDeviceId,
      if (config.targetEndpoint != null) 'to_endpoint': config.targetEndpoint,
      if (config.ownEndpoint != null) 'from_endpoint': config.ownEndpoint,
      'nonce': base64Encode(enc.nonce),
      'ciphertext': base64Encode(enc.ciphertext),
      'ts': DateTime.now().millisecondsSinceEpoch,
      'bytes': enc.ciphertext.length,
    };
    channel.sink.add(jsonEncode(envelope));
  }

  void _failPendingRequests(Object error) {
    final pending = List.of(_pendingRequests.values);
    _pendingRequests.clear();
    for (final c in pending) {
      if (!c.isCompleted) c.completeError(error);
    }
  }

  void _setState(WsState s, {String? errorMessage}) {
    _state = s;
    /* 2026-09-17: 赛跑输家会在 connect() 半路被 dispose, catch 里再 add 会抛。 */
    if (_events.isClosed) return;
    _events.add(WsEventStateChanged(s, errorMessage: errorMessage));
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _channelSub?.cancel();
    _channelSub = null;
    try {
      await _channel?.sink.close();
    } catch (_) {}
    _channel = null;
    await _events.close();
    for (final c in _pendingRequests.values) {
      if (!c.isCompleted) c.completeError(StateError('cloud-relay disposed'));
    }
    _pendingRequests.clear();
  }
}
