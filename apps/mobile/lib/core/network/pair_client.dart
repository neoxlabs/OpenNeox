/// pair_client.dart — Phone → Desktop 配对 HTTP 客户端.
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §2.3:
///   - POST http://{host}:{port}/api/v1/pair        (扫码)
///   - POST http://{host}:{port}/api/v1/pair-by-code (备份码)
///
/// 流程:
///   1. 解析 QR (base64url(JSON)) → PairingQrPayload
///   2. POST 提交 phone_pubkey + device_id + device_name
///   3. 解析 response (device_token + desktop_pubkey + relay_session_key_fingerprint)
///   4. 本地算 X25519 共享密钥 + HKDF 派生 relay_session_key
///   5. 自检 fingerprint 跟 response 一致
///   6. 写 drift `paired_desktops` 表
///
/// 不一致即抛 PairingException (errorCode 区分).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;
import 'package:dio/dio.dart';
import 'package:drift/drift.dart' show Value;

import '../crypto/fingerprint.dart';
import '../crypto/x25519_hkdf.dart';
import '../storage/database.dart';
import 'self_hosted_relay.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// QR 内容 (Desktop 端 `mobile-bridge/types.ts` PairingQRPayload 1:1).
class PairingQrPayload {
  const PairingQrPayload({
    required this.protocolVersion,
    required this.host,
    this.hosts = const [],
    required this.port,
    required this.deviceId,
    required this.deviceName,
    required this.pubkeyBase64Url,
    required this.pubkeyFingerprint,
    required this.pairingToken,
    required this.expiresAt,
  });

  final int protocolVersion;
  final String host;

  /// Desktop 多网卡候选 IP (v1.1+ 加, 没有就 fallback 只用 host) — Phone 逐个 try.
  final List<String> hosts;
  final int port;
  final String deviceId;
  final String deviceName;
  final String pubkeyBase64Url;
  final String pubkeyFingerprint;
  final String pairingToken;
  final int expiresAt;

  /// 拿待 try 的 host 列表 (hosts 优先, fallback host 单元素).
  List<String> get hostsToTry => hosts.isNotEmpty ? hosts : [host];

  /// QR 文本格式 (兼容两种):
  ///   1. 纯 base64url(JSON.stringify(payload)) — 协议规范默认
  ///   2. `neox://pair?data=<base64url>` — Desktop QR 用的 URI scheme
  ///      (deep link 兼容: 浏览器点链接也能开 app)
  static PairingQrPayload decodeFromQrText(String qrText) {
    String trimmed = qrText.trim();
    // 剥 neox:// URI prefix
    if (trimmed.startsWith('neox://')) {
      try {
        final uri = Uri.parse(trimmed);
        if (uri.host == 'pair') {
          final data = uri.queryParameters['data'];
          if (data == null || data.isEmpty) {
            throw PairingException(
              code: PairingErrorCode.qrInvalid,
              message: tr('neox:// URI 缺 data 参数'),
            );
          }
          trimmed = data;
        }
      } on PairingException {
        rethrow;
      } catch (e) {
        throw PairingException(
          code: PairingErrorCode.qrInvalid,
          message: tr('neox:// URI 解析失败: $e'),
        );
      }
    }
    final padded = _padBase64(trimmed);
    Uint8List bytes;
    try {
      bytes = base64Url.decode(padded);
    } catch (e) {
      throw PairingException(
        code: PairingErrorCode.qrInvalid,
        message: tr('QR 内容不是合法 base64url (长度 ${trimmed.length}): $e'),
      );
    }
    Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    } catch (e) {
      throw PairingException(
        code: PairingErrorCode.qrInvalid,
        message: tr('QR 内不是合法 JSON: $e'),
      );
    }
    return PairingQrPayload(
      protocolVersion: json['v'] as int? ?? 0,
      host: json['host'] as String? ?? '',
      hosts: (json['hosts'] is List)
          ? (json['hosts'] as List).whereType<String>().toList()
          : const [],
      port: json['port'] as int? ?? 0,
      deviceId: json['device_id'] as String? ?? '',
      deviceName: json['device_name'] as String? ?? '',
      pubkeyBase64Url: json['pubkey'] as String? ?? '',
      pubkeyFingerprint: json['pubkey_fingerprint'] as String? ?? '',
      pairingToken: json['pairing_token'] as String? ?? '',
      expiresAt: json['expires_at'] as int? ?? 0,
    );
  }
}

enum PairingErrorCode {
  qrInvalid,
  qrExpired,
  network,
  serverRejected,
  cryptoFailed,
  fingerprintMismatch,
  storageFailed,
}

class PairingException implements Exception {
  PairingException({
    required this.code,
    required this.message,
    this.statusCode,
  });
  final PairingErrorCode code;
  final String message;
  final int? statusCode;

  @override
  String toString() => 'PairingException($code, $message)';
}

/// 配对成功结果 (UI 用)
class PairingResult {
  const PairingResult({
    required this.desktopDeviceId,
    required this.desktopDeviceName,
    required this.relaySessionKeyFingerprint,
    this.relay,
  });
  final String desktopDeviceId;
  final String desktopDeviceName;
  final String relaySessionKeyFingerprint;

  /// 电脑配了自托管中继时随回包给的地址和令牌 (没配 = null)
  final SelfHostedRelay? relay;
}

/// 实时进度回调 — Mobile UI 用来更新 busy overlay 上的状态文字.
typedef PairProgressCallback = void Function(String message);

class PairClient {
  PairClient({Dio? dio, required this.db, this.onProgress})
    : _dio = dio ?? _defaultDio();

  final Dio _dio;
  final AppDatabase db;
  final PairProgressCallback? onProgress;

  void _progress(String msg) {
    onProgress?.call(msg);
  }

  static Dio _defaultDio() {
    return Dio(
      BaseOptions(
        /* 换 WiFi / 慢网时 5s 经常不够, 提到 8s; receive 也对应提.
         * 25s 总配对 timeout 在 UI 侧兜底, 单次请求别太短. */
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 10),
        sendTimeout: const Duration(seconds: 8),
        // Desktop server 是明文 HTTP (LAN), 不强制 https
        // HTTPS Phase 1.D 加自签证书后再升级
      ),
    );
  }

  /// 扫码路径 — QR text → 配对完成.
  Future<PairingResult> pairWithQR({
    required String qrText,
    required String phoneDeviceId,
    required String phoneDeviceName,
    required List<int> phonePublicKeyRaw,
    required List<int> phonePrivateKeyRaw,
  }) async {
    final qr = PairingQrPayload.decodeFromQrText(qrText);
    if (qr.protocolVersion != 1) {
      throw PairingException(
        code: PairingErrorCode.qrInvalid,
        message: tr('二维码版本不兼容，请升级电脑端后重试'),
      );
    }
    if (DateTime.now().millisecondsSinceEpoch >= qr.expiresAt) {
      throw PairingException(
        code: PairingErrorCode.qrExpired,
        message: tr('二维码已过期，请在电脑端重新生成'),
      );
    }
    /* multi-host try — Desktop 多网卡 (有线+WiFi+Hotspot) 时挨个试到通. */
    final body = {
      'pairing_token': qr.pairingToken,
      'phone_pubkey': _b64UrlNoPad(phonePublicKeyRaw),
      'phone_device_id': phoneDeviceId,
      'phone_device_name': phoneDeviceName,
    };
    final hosts = qr.hostsToTry;
    PairingException? lastNetErr;
    for (var i = 0; i < hosts.length; i++) {
      final h = hosts[i];
      _progress(tr('正在连接电脑 ${i + 1}/${hosts.length}'));
      try {
        return await _pair(
          host: h,
          port: qr.port,
          endpoint: '/api/v1/pair',
          body: body,
          qr: qr,
          phonePrivateKeyRaw: phonePrivateKeyRaw,
        );
      } on PairingException catch (e) {
        if (e.code == PairingErrorCode.network) {
          lastNetErr = e;
          _progress(tr('正在尝试另一个连接方式…'));
          continue;
        }
        rethrow; // 其它错 (serverRejected / cryptoFailed) 不重试
      }
    }
    throw lastNetErr ??
        PairingException(
          code: PairingErrorCode.network,
          message: tr('无法连接到电脑，请确认手机和电脑在同一 Wi-Fi'),
        );
  }

  /// 备份码路径 — 用户手输 6 位 (ABCD-1234 或 ABCD1234), 需先选了目标 Desktop (host/port).
  Future<PairingResult> pairWithBackupCode({
    required String host,
    required int port,
    required String desktopDeviceId,
    required String desktopDeviceName,
    required String desktopPubkeyBase64Url,
    required String backupCode,
    required String phoneDeviceId,
    required String phoneDeviceName,
    required List<int> phonePublicKeyRaw,
    required List<int> phonePrivateKeyRaw,
  }) async {
    final normalized = backupCode.toUpperCase().replaceAll('-', '').trim();
    if (normalized.length != 8) {
      throw PairingException(
        code: PairingErrorCode.qrInvalid,
        message: tr('备份码必须是 8 位 (例: ABCD-1234)'),
      );
    }
    // 构造 fake QR 给 fingerprint 自检用 (pubkey 来自 mDNS 或用户事先得知)
    final fakeQr = PairingQrPayload(
      protocolVersion: 1,
      host: host,
      port: port,
      deviceId: desktopDeviceId,
      deviceName: desktopDeviceName,
      pubkeyBase64Url: desktopPubkeyBase64Url,
      pubkeyFingerprint: '',
      pairingToken: '',
      expiresAt: 0,
    );
    return _pair(
      host: host,
      port: port,
      endpoint: '/api/v1/pair-by-code',
      body: {
        'backup_code':
            '${normalized.substring(0, 4)}-${normalized.substring(4)}',
        'phone_pubkey': _b64UrlNoPad(phonePublicKeyRaw),
        'phone_device_id': phoneDeviceId,
        'phone_device_name': phoneDeviceName,
      },
      qr: fakeQr,
      phonePrivateKeyRaw: phonePrivateKeyRaw,
    );
  }

  /// 同一 Wi-Fi 点一下: 不用码, 电脑上弹窗点「允许」(desktop mobile-bridge/pairRequest.ts)。
  /// 请求会一直挂到电脑上有人点 (最多 60 秒), [cancel] 用来在手机上放弃。
  Future<PairingResult> pairByRequest({
    required String host,
    required int port,
    required String desktopDeviceId,
    required String desktopDeviceName,
    required String desktopPubkeyFingerprint,
    required String phoneDeviceId,
    required String phoneDeviceName,
    required List<int> phonePublicKeyRaw,
    required List<int> phonePrivateKeyRaw,
    CancelToken? cancel,
  }) async {
    final target = PairingQrPayload(
      protocolVersion: 1,
      host: host,
      port: port,
      deviceId: desktopDeviceId,
      deviceName: desktopDeviceName,
      pubkeyBase64Url: '',
      pubkeyFingerprint: desktopPubkeyFingerprint,
      pairingToken: '',
      expiresAt: 0,
    );
    try {
      return await _pair(
        host: host,
        port: port,
        endpoint: '/api/v1/pair-request',
        body: {
          'phone_pubkey': _b64UrlNoPad(phonePublicKeyRaw),
          'phone_device_id': phoneDeviceId,
          'phone_device_name': phoneDeviceName,
        },
        qr: target,
        phonePrivateKeyRaw: phonePrivateKeyRaw,
        receiveTimeout: const Duration(seconds: 75),
        cancel: cancel,
      );
    } on PairingException catch (e) {
      final message = switch (e.statusCode) {
        403 => tr('电脑上没有允许这次连接'),
        408 => tr('电脑上一直没人确认, 这次请求已取消'),
        429 => tr('电脑上还有一个连接请求没处理完, 稍后再试'),
        404 => tr('电脑端版本较旧, 不支持点一下连接, 请用二维码或备份码'),
        _ => null,
      };
      if (message == null) rethrow;
      throw PairingException(code: e.code, statusCode: e.statusCode, message: message);
    }
  }

  Future<PairingResult> _pair({
    required String host,
    required int port,
    required String endpoint,
    required Map<String, Object?> body,
    required PairingQrPayload qr,
    required List<int> phonePrivateKeyRaw,
    Duration? receiveTimeout,
    CancelToken? cancel,
  }) async {
    final url = 'http://$host:$port$endpoint';
    Response<dynamic> resp;
    try {
      resp = await _dio.post<dynamic>(
        url,
        data: body,
        cancelToken: cancel,
        options: Options(
          contentType: Headers.jsonContentType,
          responseType: ResponseType.json,
          validateStatus: (_) => true,
          receiveTimeout: receiveTimeout,
        ),
      );
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) rethrow;
      throw PairingException(
        code: PairingErrorCode.network,
        message: tr('无法连接到电脑，请确认同一 Wi-Fi、防火墙和电脑端远程访问状态'),
      );
    }
    if (resp.statusCode != 200) {
      final errMsg = (resp.data is Map && (resp.data as Map)['error'] is String)
          ? (resp.data as Map)['error'] as String
          : 'HTTP ${resp.statusCode}';
      throw PairingException(
        code: PairingErrorCode.serverRejected,
        statusCode: resp.statusCode,
        message: tr('电脑端拒绝连接: $errMsg'),
      );
    }

    final data = resp.data;
    if (data is! Map<String, dynamic>) {
      throw PairingException(
        code: PairingErrorCode.serverRejected,
        message: tr('电脑端响应异常，请升级电脑端后重试'),
      );
    }
    final deviceToken = data['device_token'] as String?;
    final desktopPubkeyB64u = data['desktop_pubkey'] as String?;
    final remoteFingerprint = data['relay_session_key_fingerprint'] as String?;
    if (deviceToken == null ||
        desktopPubkeyB64u == null ||
        remoteFingerprint == null) {
      throw PairingException(
        code: PairingErrorCode.serverRejected,
        message: tr('电脑端响应不完整，请升级电脑端后重试'),
      );
    }

    // 本地算 relay_session_key 并自检 fingerprint
    Uint8List relayKey;
    Uint8List desktopPubRaw;
    try {
      desktopPubRaw = Uint8List.fromList(
        base64Url.decode(_padBase64(desktopPubkeyB64u)),
      );
      if (desktopPubRaw.length != 32) {
        throw FormatException(tr('desktop_pubkey 不是 32 bytes'));
      }
      final kp = await X25519Hkdf.instance.keypairFromRawPrivate(
        phonePrivateKeyRaw,
      );
      relayKey = await X25519Hkdf.instance.deriveRelaySessionKey(
        selfKeypair: kp,
        peerPublicKeyRaw: desktopPubRaw,
      );
    } catch (e) {
      throw PairingException(
        code: PairingErrorCode.cryptoFailed,
        message: tr('安全连接建立失败，请重新生成二维码后再试'),
      );
    }

    final localFingerprint = await Fingerprint.instance.compute(relayKey);
    /* 知道这台电脑广播的公钥指纹时 (mDNS), 回包里的公钥必须对得上 —— 防局域网里有人冒充 */
    final pubkeyMismatch = qr.pubkeyFingerprint.isNotEmpty &&
        await Fingerprint.instance.compute(desktopPubRaw) != qr.pubkeyFingerprint;
    if (localFingerprint != remoteFingerprint || pubkeyMismatch) {
      throw PairingException(
        code: PairingErrorCode.fingerprintMismatch,
        message: tr('连接校验不一致，已拒绝连接'),
      );
    }

    // 落 drift — host 必须用 *实际配对通的 IP* (而非 qr.host 默认主 IP),
    // 否则 Desktop 多网卡时 WS 重连会用错 IP 永远连不上.
    try {
      /* 2026-06-24 自动去重: 同 device_name = 同台桌面 (用户视角).
       *   桌面端 reinstall / mobile-bridge.json 重建 / machineId 拿不到时,
       *   device_id 会重新 generate, 同台 Mac 在 mobile DB 攒多个 entries.
       *   pair 时主动删除所有同 name 但不同 device_id 的旧 entries → 1 台桌面永远 1 个 entry.
       *
       *   trade-off: 真有 2 台 hostname 完全相同的 Mac 时会合并, 但极少见 — hostname 一般含
       *   "someone-MacBook-Air" 这种唯一性较强的字符. 利大于弊. */
      final desktopName = qr.deviceName.trim();
      if (desktopName.isNotEmpty) {
        final existing = await db.pairedDesktopsDao.findByDeviceName(desktopName);
        for (final old in existing) {
          if (old.deviceId != qr.deviceId) {
            await db.pairedDesktopsDao.deleteByDeviceId(old.deviceId);
          }
        }
      }
      await db.pairedDesktopsDao.upsert(
        PairedDesktopsCompanion(
          deviceId: Value(qr.deviceId),
          deviceName: Value(qr.deviceName),
          lastSeenLanIp: Value(host),
          lastSeenLanPort: Value(port),
          desktopPubkey: Value(desktopPubRaw),
          relaySessionKey: Value(relayKey),
          deviceToken: Value(deviceToken),
          pairedAt: Value(DateTime.now().millisecondsSinceEpoch),
        ),
      );
    } catch (e) {
      throw PairingException(
        code: PairingErrorCode.storageFailed,
        message: tr('本地存储失败: $e'),
      );
    }

    return PairingResult(
      desktopDeviceId: qr.deviceId,
      desktopDeviceName: qr.deviceName,
      relaySessionKeyFingerprint: remoteFingerprint,
      relay: SelfHostedRelay.fromJson(data['relay']),
    );
  }
}

/// 「点一下连接」两边对照的 6 位核对码: sha256(手机公钥) 前 4 字节 (大端) mod 1e6。
/// 电脑端同一算法: desktop mobile-bridge/pairRequest.ts pairCheckCode。
String pairCheckCode(List<int> phonePublicKeyRaw) {
  final h = sha256.convert(phonePublicKeyRaw).bytes;
  final n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) % 1000000;
  return n.toString().padLeft(6, '0');
}

String _b64UrlNoPad(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

String _padBase64(String s) {
  final mod = s.length % 4;
  if (mod == 0) return s;
  return s + ('=' * (4 - mod));
}
