/// ws_client.dart — Mode A WebSocket 客户端 (Phone → Desktop LAN).
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §3.2 (握手) + §3.3 (JSON-RPC).
///
/// 职责:
///   - 跟 Desktop `ws://{host}:{port}/api/v1/socket` 建 WS 连接
///   - 握手 headers (x-neox-device-id / token / version / signature / timestamp / nonce)
///   - 双向 JSON-RPC 消息
///     - Phone → Desktop: session.subscribe / session.input / session.list / session.history / system.pong
///     - Desktop → Phone: session.snapshot / session.event / system.ping
///   - WS 协议层 ping/pong (web_socket_channel 自动处理底层 ping; 应用层 system.ping 也响)
///   - 重连 (network drop + 指数退避, 上限 30s)
///   - 事件流 (`Stream<RpcMessage>`) 供 UI 订阅
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../crypto/hmac.dart';
import 'json_rpc.dart';
import 'package:neox_app/core/i18n/tr.dart';

const int _kProtocolVersion = 1;
const Duration _kLanSocketConnectTimeout = Duration(milliseconds: 900);
/* verify 是真 RPC (session.list limit=1), 桌面冷启动时首个 dynamic import +
 * SQLite 打开可能 >1s — 700ms 会把活桌面误判成死连接. 3s 仍够快识别死端. */
const Duration _kPeerVerifyTimeout = Duration(seconds: 3);

/// 连接生命周期状态
enum WsState { disconnected, connecting, authenticated, reconnecting, failed }

/// WS 客户端事件 — 上层 UI 直接消费此 stream
sealed class WsEvent {
  const WsEvent();
}

class WsEventStateChanged extends WsEvent {
  const WsEventStateChanged(this.state, {this.errorMessage});
  final WsState state;
  final String? errorMessage;
}

class WsEventMessage extends WsEvent {
  const WsEventMessage(this.message);
  final RpcMessage message;
}

/// 桌面活着但拒绝 WS 升级 (401) — 配对失效, 重试无意义, 需要用户重新配对.
class WsPairingRejected implements Exception {
  const WsPairingRejected(this.message);
  final String message;
  @override
  String toString() => message;
}

class WsClientConfig {
  const WsClientConfig({
    required this.host,
    required this.port,
    required this.deviceId,
    required this.deviceToken,
    this.relaySessionKey,
    this.reconnect = true,
  });
  final String host;
  final int port;
  final String deviceId;
  final String deviceToken;

  /// X25519 ECDH + HKDF 派生的共享密钥 (配对时算好, 本地存, 从不上网).
  ///
  /// 账号自动配对 (deviceToken == `account:<phoneId>`) 时**必须**有值 —— 那条
  /// 路径的 token 是公开值, 身份证明全靠这把密钥的 HMAC. 扫码配对时可以为 null.
  final List<int>? relaySessionKey;
  final bool reconnect;

  /// 这条配对是不是账号自动配对 (对应桌面 `deviceToken.startsWith('account:')`).
  bool get isAccountPaired => deviceToken.startsWith('account:');
}

/// 单连接 WS 客户端. 一个 PairedDesktop 配一个实例.
class WsClient {
  WsClient(this.config);

  final WsClientConfig config;
  final StreamController<WsEvent> _events = StreamController.broadcast();
  final Map<String, Completer<RpcMessage>> _pendingRequests = {};
  final _Backoff _backoff = _Backoff();
  final _Random _rng = _Random();

  WebSocketChannel? _channel;

  /* ── 心跳节流 (2026-08-08) ──────────────────────────────────────────────
   * 原来 pingInterval 固定 8s。方向没错 —— 半开连接要靠它才发现得快 —— 但常连
   * 状态下每 8s 一个控制帧会反复把移动网络的射频从空闲态拉起来, 是纯耗电。
   * 前台保持灵敏, 后台放松到 40s: 没人看屏幕的时候, 晚几十秒发现断线没有代价。 */
  static const Duration _kPingForeground = Duration(seconds: 8);
  static const Duration _kPingBackground = Duration(seconds: 40);

  WebSocket? _socket;
  bool _foreground = true;

  static Duration _pingIntervalFor(bool foreground) =>
      foreground ? _kPingForeground : _kPingBackground;

  /// app 前后台切换时调 —— 立即作用于当前这条连接, 不必等重连.
  void setForeground(bool foreground) {
    if (_foreground == foreground) return;
    _foreground = foreground;
    try {
      _socket?.pingInterval = _pingIntervalFor(foreground);
    } catch (_) {
      /* socket 已关 / 底层不支持 — 下次 connect 时按新值生效即可 */
    }
  }

  StreamSubscription<dynamic>? _channelSub;
  WsState _state = WsState.disconnected;
  bool _disposed = false;
  bool _hasAuthenticated = false;
  Timer? _reconnectTimer;

  /// 最近一次 connect 失败原因 (caller 判定错误类型用, e.g. 配对失效不重试).
  Object? lastConnectError;

  Stream<WsEvent> get events => _events.stream;
  WsState get state => _state;

  /// 连接 (异步, 不抛). 状态变化通过 events stream 推.
  Future<void> connect() async {
    if (_disposed) return;
    if (_state == WsState.connecting || _state == WsState.authenticated) return;
    debugPrint('[ws] connect() target=${config.host}:${config.port}');
    _setState(WsState.connecting);
    lastConnectError = null;
    try {
      await _doConnect();
      _backoff.reset();
      _hasAuthenticated = true;
      _setState(WsState.authenticated);
      debugPrint('[ws] authenticated');
    } catch (e, st) {
      debugPrint('[ws] connect failed: $e\n$st');
      lastConnectError = e;
      _setState(WsState.failed, errorMessage: '$e');
      if (config.reconnect && !_disposed && _hasAuthenticated) {
        _scheduleReconnect();
      }
    }
  }

  Future<void> _doConnect() async {
    final url = Uri.parse('ws://${config.host}:${config.port}/api/v1/socket');
    debugPrint('[ws] dialing $url');
    final ts = DateTime.now().millisecondsSinceEpoch;
    final nonce = _genNonce();
    /* 签名密钥按配对方式选 —— 必须跟桌面 wsServer.authenticateWsUpgrade 一致:
     *   账号自动配对 → relay_session_key (ECDH 派生, 从不上网)
     *   扫码配对     → device_token 本身 */
    final String signature;
    if (config.isAccountPaired) {
      final key = config.relaySessionKey;
      if (key == null || key.isEmpty) {
        /* 账号配对却没派生出密钥 = 配对记录不完整, 签不出桌面认得的签名。
         * 这里给确定的错误, 而不是让它连出去挨一个语焉不详的 401。 */
        throw WsPairingRejected(
          tr('这台电脑的配对信息不完整，请到「我的设备」重新配对'),
        );
      }
      signature = await WsSignature.instance.signWithKey(
        key: key,
        timestampMs: ts,
        nonce: nonce,
      );
    } else {
      signature = await WsSignature.instance.sign(
        deviceToken: config.deviceToken,
        timestampMs: ts,
        nonce: nonce,
      );
    }
    final headers = {
      'x-neox-device-id': config.deviceId,
      'x-neox-device-token': config.deviceToken,
      'x-neox-protocol-version': _kProtocolVersion.toString(),
      'x-neox-signature': signature,
      'x-neox-timestamp': ts.toString(),
      'x-neox-nonce': nonce,
    };
    // web_socket_channel IOWebSocketChannel 直接拿 dart:io WebSocket — 支持自定义 headers
    final WebSocket ws;
    try {
      ws = await WebSocket.connect(
        url.toString(),
        headers: headers,
      ).timeout(_kLanSocketConnectTimeout);
    } on WebSocketException catch (e) {
      /* dart:io 不透出 HTTP status — upgrade 被拒 (桌面回 401) 时只有
       * "was not upgraded". 用免认证 health 端点二次判定: 桌面活着但拒绝
       * 升级 = 配对失效 (桌面重装/配对记录丢失), 给用户明确动作指引,
       * 而不是无限重试 "连不上". */
      if (e.message.contains('not upgraded') &&
          await _desktopAliveViaHealth()) {
        throw WsPairingRejected(
          tr('这台电脑不再认识本手机（配对可能已失效），请到「我的设备」重新配对'),
        );
      }
      rethrow;
    }
    /* 主动 ping — RFC 6455 control frame. dart:io 自动以 pingInterval 当
     * pongTimeout, 死端最长 ~2×interval 被发现, 而不是默认 TCP keepalive 2h.
     *
     * 2026-08-08 改成按前后台分档: 原来固定 8s, 方向没错 (要快速发现半开连接),
     * 但常连状态下 8s 一个控制帧对移动网络的省电策略不友好 —— 每一帧都会把
     * 射频从空闲态拉起来。
     *   前台: 用户正盯着屏幕, 断了要马上知道 → 保持 8s
     *   后台: 没人在看, 晚几十秒发现无所谓 → 40s, 射频能真正歇下来
     * 切换由 setForeground() 在 app 生命周期变化时调。 */
    /* 拨号期间被 dispose (赛跑输了 / 这一轮作废) —— 刚建好的 socket 必须关掉,
     * 否则没人持有它, 泄漏到对端超时为止 (2026-09-17)。 */
    if (_disposed) {
      try {
        await ws.close(1000, 'disposed during connect');
      } catch (_) {}
      throw StateError('ws client disposed during connect');
    }
    _socket = ws;
    ws.pingInterval = _pingIntervalFor(_foreground);
    final channel = IOWebSocketChannel(ws);
    _channel = channel;
    _channelSub = channel.stream.listen(
      _onData,
      onError: _onError,
      onDone: _onDone,
      cancelOnError: false,
    );
    /* 验证 peer 是真 Neox desktop, 不是缓存的死连接 / 随便 accept TCP 的设备.
     * 发轻量 RPC, 1s 内必须响应, 否则 throw → caller 标 failed → chip 不变绿.
     * 失败时要主动 tear down 已 listen 的 channel, 否则下次 connect 撞 leak. */
    try {
      await _verifyPeer();
    } catch (e) {
      await _channelSub?.cancel();
      _channelSub = null;
      try {
        await ws.close(1011, 'verify failed');
      } catch (_) {}
      _channel = null;
      rethrow;
    }
  }

  /// WS upgrade 被拒后, 用免认证 GET /api/v1/health 判定桌面是否活着.
  Future<bool> _desktopAliveViaHealth() async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(milliseconds: 1200);
    try {
      final req = await client
          .getUrl(Uri.parse('http://${config.host}:${config.port}/api/v1/health'))
          .timeout(const Duration(milliseconds: 1500));
      final resp = await req.close().timeout(const Duration(milliseconds: 1500));
      await resp.drain<void>();
      return resp.statusCode == 200;
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  /// 握手后做一次真实 RPC 来确认对端是活的 Neox desktop. 不通过则 throw.
  Future<void> _verifyPeer() async {
    try {
      await sendRequest('session.list', const {
        'limit': 1,
      }, _kPeerVerifyTimeout);
    } on TimeoutException {
      throw StateError(tr('电脑暂时没有响应，请确认电脑端 Neox 已打开'));
    }
  }

  String _genNonce() {
    final b = Uint8List(16);
    for (var i = 0; i < b.length; i++) {
      b[i] = _rng.nextByte();
    }
    return base64Url.encode(b).replaceAll('=', '');
  }

  void _onData(dynamic raw) {
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
    final msg = RpcMessage.fromJsonString(text);
    if (msg == null) return;

    // 服务端 → 客户端 response (匹配 pending request)
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

    // system.ping → 立即 system.pong (协议 §3.3.1)
    if (msg.method == 'system.ping') {
      _sendRaw(
        makeNotification('system.pong', {
          'ts': DateTime.now().millisecondsSinceEpoch,
        }),
      );
    }

    if (_events.isClosed) return;
    _events.add(WsEventMessage(msg));
  }

  void _onError(Object error, [StackTrace? st]) {
    debugPrint('[ws] socket error: $error');
    _setState(WsState.failed, errorMessage: '$error');
    if (_hasAuthenticated) _scheduleReconnect();
  }

  void _onDone() {
    debugPrint(
      '[ws] socket closed state=$_state authenticated=$_hasAuthenticated',
    );
    _channelSub?.cancel();
    _channelSub = null;
    _channel = null;
    if (_disposed) return;
    if (_state == WsState.authenticated || _state == WsState.connecting) {
      _setState(WsState.disconnected);
      if (config.reconnect && _hasAuthenticated) _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_disposed || !config.reconnect) return;
    _reconnectTimer?.cancel();
    final delay = _backoff.next();
    _setState(WsState.reconnecting);
    _reconnectTimer = Timer(delay, () {
      if (_disposed) return;
      connect();
    });
  }

  void _setState(WsState s, {String? errorMessage}) {
    if (_state == s && errorMessage == null) return;
    _state = s;
    /* 2026-09-17: LAN/远程赛跑时输家会在 connect() 半路被 dispose, 之后 connect
     * 的 catch 还会走到这里 —— 往已关闭的 controller 里 add 会抛, 变成未处理异常。 */
    if (_events.isClosed) return;
    _events.add(WsEventStateChanged(s, errorMessage: errorMessage));
  }

  /// 发 notification (不等响应)
  void sendNotification(String method, [Object? params]) {
    _sendRaw(makeNotification(method, params));
  }

  /// 发 request, 返 Future<响应> (超时 10s 抛 TimeoutException).
  /// 10s 是 UI 可接受的等待上限 — 超过用户会觉得"卡住"以为 app 死了.
  Future<RpcMessage> sendRequest(
    String method, [
    Object? params,
    Duration timeout = const Duration(seconds: 10),
  ]) {
    final id = _genRequestId();
    final completer = Completer<RpcMessage>();
    _pendingRequests[id] = completer;
    _sendRaw(makeRequest(id, method, params));
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pendingRequests.remove(id);
        throw TimeoutException(
          'JSON-RPC request "$method" timed out after ${_formatTimeout(timeout)}',
        );
      },
    );
  }

  String _formatTimeout(Duration timeout) {
    if (timeout.inMilliseconds % 1000 == 0) {
      return '${timeout.inSeconds}s';
    }
    return '${timeout.inMilliseconds}ms';
  }

  void _sendRaw(RpcMessage msg) {
    final ch = _channel;
    if (ch == null) return;
    try {
      ch.sink.add(msg.toJsonString());
    } catch (_) {
      // 写失败 → 触发 reconnect
      _onDone();
    }
  }

  String _genRequestId() {
    // 32-bit 时间戳 + 16-bit random 足以避碰
    final ts = DateTime.now().microsecondsSinceEpoch & 0xffffffff;
    final r = _rng.nextByte() << 8 | _rng.nextByte();
    return 'p-${ts.toRadixString(36)}-${r.toRadixString(36)}';
  }

  /// 主动断开 — UI 切设备 / 退出页面时调.
  Future<void> disconnect({
    int code = 1000,
    String reason = 'client disconnect',
  }) async {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final sub = _channelSub;
    final ch = _channel;
    _channelSub = null;
    _channel = null;
    try {
      await sub?.cancel();
    } catch (_) {}
    try {
      await ch?.sink.close(code, reason);
    } catch (_) {}
    for (final c in _pendingRequests.values) {
      if (!c.isCompleted) {
        c.completeError(StateError('connection closed'));
      }
    }
    _pendingRequests.clear();
    _setState(WsState.disconnected);
  }

  Future<void> dispose() async {
    _disposed = true;
    await disconnect();
    await _events.close();
  }
}

/// 指数退避: 1s, 2s, 4s, 8s, 16s, 30s (上限). 重置则归零.
class _Backoff {
  Duration _current = const Duration(seconds: 1);
  static const Duration _cap = Duration(seconds: 30);

  void reset() {
    _current = const Duration(seconds: 1);
  }

  Duration next() {
    final out = _current;
    final nextSeconds = (_current.inSeconds * 2).clamp(1, _cap.inSeconds);
    _current = Duration(seconds: nextSeconds);
    return out;
  }
}

class _Random {
  final Random _r = Random.secure();
  int nextByte() => _r.nextInt(256);
}
