import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// 手机发往云端的 User-Agent —— 跟桌面 / CLI 同一格式 (packages/kernel/src/utils/neoxUserAgent.ts):
///
///     Neox-Android/3.10.18 (Android 15; arm64-v8a; Dart/3.8)
///     Neox-iOS/3.10.18 (iOS 26.0; arm64; Dart/3.8)
///
/// 之前手机一律是 dart:io 的默认值 `Dart/3.8 (dart:io)`, 后台请求日志认不出是手机发的、
/// 哪个版本、安卓还是 iOS (2026-10-12 用户实拍)。服务端按「产品/版本 (平台; ...」解析, 前两段位置不能动。
///
/// 用 HttpOverrides 一处装好: Dio / package:http / 手写 HttpClient 都从 dart:io 的 HttpClient 起,
/// 全部带上; 显式设了 UA 的请求 (测速探针) 不受影响。
class NeoxUserAgent {
  NeoxUserAgent._();

  static String _value = _initial();
  static String get value => _value;

  static String get _product => Platform.isIOS ? 'iOS' : (Platform.isAndroid ? 'Android' : 'Mobile');

  static String get _dart {
    final m = RegExp(r'^(\d+\.\d+)').firstMatch(Platform.version);
    return 'Dart/${m?.group(1) ?? '?'}';
  }

  static String _initial() => 'Neox-$_product/0 ($_product; ${Platform.isIOS ? 'arm64' : '?'}; $_dart)';

  /// 同步装上 (首个请求就带产品名), 版本号 / 系统版本 / 架构异步补齐。
  static void install() {
    HttpOverrides.global = _UaOverrides(HttpOverrides.current);
    _refine();
  }

  static Future<void> _refine() async {
    var ver = '0';
    var os = _product;
    var arch = Platform.isIOS ? 'arm64' : '?';
    try {
      ver = (await PackageInfo.fromPlatform()).version;
    } catch (_) {}
    try {
      final info = DeviceInfoPlugin();
      if (Platform.isAndroid) {
        final a = await info.androidInfo;
        os = 'Android ${a.version.release}';
        if (a.supportedAbis.isNotEmpty) arch = a.supportedAbis.first;
      } else if (Platform.isIOS) {
        final i = await info.iosInfo;
        os = 'iOS ${i.systemVersion}';
      }
    } catch (_) {}
    _value = 'Neox-$_product/$ver ($os; $arch; $_dart)';
  }
}

class _UaOverrides extends HttpOverrides {
  _UaOverrides(this._prev);
  final HttpOverrides? _prev;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final c = _prev?.createHttpClient(context) ?? super.createHttpClient(context);
    c.userAgent = NeoxUserAgent.value;
    return c;
  }
}
