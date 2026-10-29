/// phone_identity.dart — Phone 自身永久身份 (device_id + X25519 keypair).
///
/// 对应 Desktop `mobile-bridge/deviceStore.ts` 的 Phone 端等价物.
///
/// 存储分级 (隐私关键):
///   - device_id (UUID v4)                    → SharedPreferences (非敏感)
///   - device_name                            → SharedPreferences (用户可改, 非敏感)
///   - X25519 raw private key (32 bytes)      → FlutterSecureStorage (Keychain/Keystore)
///   - X25519 raw public key (32 bytes)       → SharedPreferences (base64url, 非敏感)
///
/// 启动时如不存在, 自动生成并落盘. 永远不重生 (重生则旧配对全失效).
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../crypto/x25519_hkdf.dart';

const String _kDeviceIdKey = 'neox.phone.device_id';
const String _kDeviceNameKey = 'neox.phone.device_name';
const String _kPubkeyB64Key = 'neox.phone.x25519_pub_b64';
const String _kPrivkeyB64SecureKey = 'neox.phone.x25519_priv_b64';

class PhoneIdentity {
  PhoneIdentity({
    required this.deviceId,
    required this.deviceName,
    required this.rawPublicKey,
    required this.rawPrivateKey,
  });

  final String deviceId;
  final String deviceName;
  final Uint8List rawPublicKey;
  final Uint8List rawPrivateKey;

  String get pubkeyBase64Url =>
      base64Url.encode(rawPublicKey).replaceAll('=', '');
}

class PhoneIdentityStore {
  PhoneIdentityStore({
    SharedPreferences? prefs,
    FlutterSecureStorage? secure,
  }) : _prefs = prefs,
       _secure = secure ?? const FlutterSecureStorage();

  SharedPreferences? _prefs;
  final FlutterSecureStorage _secure;

  Future<SharedPreferences> _getPrefs() async {
    return _prefs ??= await SharedPreferences.getInstance();
  }

  /// 加载或新建. 幂等 — 多次调返同一身份.
  Future<PhoneIdentity> loadOrCreate() async {
    final prefs = await _getPrefs();
    final existingId = await _readDeviceId(prefs);
    final existingPubB64 = prefs.getString(_kPubkeyB64Key);
    final existingPrivB64 = await _secure.read(key: _kPrivkeyB64SecureKey);

    if (existingId != null &&
        existingPubB64 != null &&
        existingPrivB64 != null) {
      try {
        final pub = base64Url.decode(_padBase64(existingPubB64));
        final priv = base64Url.decode(_padBase64(existingPrivB64));
        if (pub.length == 32 && priv.length == 32) {
          /* 用户没改过名时, 每次都用最新真机型 (e.g. PLK110 → Pixel 8) — 防默认名固化 */
          var deviceName = prefs.getString(_kDeviceNameKey);
          if (deviceName == null || deviceName.isEmpty) {
            deviceName = await _resolveDeviceName();
          }
          return PhoneIdentity(
            deviceId: existingId,
            deviceName: deviceName,
            rawPublicKey: Uint8List.fromList(pub),
            rawPrivateKey: Uint8List.fromList(priv),
          );
        }
      } catch (_) {
        /* fallthrough to regen */
      }
    }

    // 首次或损坏 → 新建
    final kp = await X25519Hkdf.instance.generateKeypair();
    final pub = await X25519Hkdf.instance.extractRawPublicKey(kp);
    final priv = await X25519Hkdf.instance.extractRawPrivateKey(kp);
    final deviceId = const Uuid().v4();
    final deviceName = prefs.getString(_kDeviceNameKey) ?? await _resolveDeviceName();

    await _writeDeviceId(prefs, deviceId);
    await prefs.setString(_kDeviceNameKey, deviceName);
    await prefs.setString(
      _kPubkeyB64Key,
      base64Url.encode(pub).replaceAll('=', ''),
    );
    await _secure.write(
      key: _kPrivkeyB64SecureKey,
      value: base64Url.encode(priv).replaceAll('=', ''),
    );

    return PhoneIdentity(
      deviceId: deviceId,
      deviceName: deviceName,
      rawPublicKey: pub,
      rawPrivateKey: priv,
    );
  }

  /// device_id 优先从安全存储读, SharedPreferences 只是镜像。
  ///
  /// 2026-09-03: 线上同一台 OnePlus 在 device_presence 里有 3 行 —— device_id 原来只存
  /// SharedPreferences, 而"清除应用数据"、prefs 损坏、系统清理都会把它抹掉, 一抹掉就是
  /// 一台新手机, 用户的设备列表里全是自己。安全存储 (iOS Keychain / Android Keystore)
  /// 不会被"清除数据"顺手带走, 而且 X25519 私钥本来就存在那里 —— 身份的两半本来就该
  /// 同生共死, 分开存才是 bug。
  ///
  /// 老用户: prefs 里已有 id 就迁进安全存储, 保持原 id 不变 (换 id = 所有配对失效)。
  Future<String?> _readDeviceId(SharedPreferences prefs) async {
    try {
      final secure = await _secure.read(key: _kDeviceIdKey);
      if (secure != null && secure.isNotEmpty) return secure;
    } catch (_) {
      /* 安全存储读不了 (极少数机型) → 退回 prefs, 总比现造一个新身份强 */
    }
    final legacy = prefs.getString(_kDeviceIdKey);
    if (legacy != null && legacy.isNotEmpty) {
      try {
        await _secure.write(key: _kDeviceIdKey, value: legacy);
      } catch (_) { /* 迁移失败不影响本次使用 */ }
      return legacy;
    }
    return null;
  }

  Future<void> _writeDeviceId(SharedPreferences prefs, String deviceId) async {
    try {
      await _secure.write(key: _kDeviceIdKey, value: deviceId);
    } catch (_) { /* 写不进安全存储也要让 prefs 那份生效 */ }
    await prefs.setString(_kDeviceIdKey, deviceId);
  }

  Future<void> setDeviceName(String name) async {
    final prefs = await _getPrefs();
    final trimmed = name.trim();
    if (trimmed.isEmpty) return;
    await prefs.setString(_kDeviceNameKey, trimmed);
  }
}

/// 真机型/真用户起的设备名:
///   Android: marketing-name (e.g. "PLK110") + brand (e.g. "OPPO") — 拼成 "OPPO PLK110"
///   iOS: UIDevice.name — 用户在系统设置里起的名 (e.g. "示例用户的 iPhone")
/// 拿不到时回落到平台默认 (iPhone / Android Phone).
Future<String> _resolveDeviceName() async {
  try {
    final info = DeviceInfoPlugin();
    if (Platform.isIOS) {
      final ios = await info.iosInfo;
      final raw = ios.name;
      if (raw.isNotEmpty) return raw;
      final model = ios.utsname.machine;
      return model.isNotEmpty ? model : 'iPhone';
    }
    if (Platform.isAndroid) {
      final a = await info.androidInfo;
      final parts = <String>[
        if (a.brand.isNotEmpty) _capitalize(a.brand),
        if (a.model.isNotEmpty) a.model,
      ];
      if (parts.isNotEmpty) return parts.join(' ').trim();
      return 'Android Phone';
    }
  } catch (_) {
    /* device_info plugin 偶发失败, fall through */
  }
  if (Platform.isIOS) return 'iPhone';
  if (Platform.isAndroid) return 'Android Phone';
  return 'Neox Mobile';
}

String _capitalize(String s) {
  if (s.isEmpty) return s;
  return s[0].toUpperCase() + s.substring(1).toLowerCase();
}

/// base64Url 解码前手动补 '=' padding (Dart base64Url.decode 要 padding).
String _padBase64(String s) {
  final mod = s.length % 4;
  if (mod == 0) return s;
  return s + ('=' * (4 - mod));
}

/// Riverpod provider — 全局单例 PhoneIdentity (异步首次加载, 后续缓存).
final phoneIdentityStoreProvider = Provider<PhoneIdentityStore>((ref) {
  return PhoneIdentityStore();
});

final phoneIdentityProvider = FutureProvider<PhoneIdentity>((ref) async {
  final store = ref.watch(phoneIdentityStoreProvider);
  return store.loadOrCreate();
});
