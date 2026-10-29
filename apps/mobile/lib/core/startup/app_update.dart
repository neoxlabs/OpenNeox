/// app_update.dart — App 内更新 (R2 自建分发, 不走应用商店).
///
/// 为什么必须有 (2026-08-08):
///   手机端此前**完全没有**版本检查: 没有版本查询、没有更新提示、没有安装通道。
///   装上之后就是一座孤岛。
///
///   代价不是"用户用不上新功能", 而是: 手机协议按 mobile-bridge v1.1 对齐, 服务端
///   或桌面端一改协议, 旧版手机就**静默坏掉** —— 用户看到"发出去没反应", 跟 app
///   故障一模一样, 而我们没有任何通道告诉他该更新。
///
/// 数据源 = **网站已有的下载清单**, 不新造接口 (2026-08-09):
///   `https://neox-dev.com/download/latest.json`  (schema `neox.download.v1`)
///   ```json
///   { "available": true,
///     "notice": null,
///     "mobile": { "android": { "url": "https://dl.neox-dev.com/mobile/3.1.20/neox-3.1.20.apk",
///                              "version": "3.1.20", "sizeBytes": 92870285 },
///                 "ios": null } }
///   ```
///   这份清单是下载页 (SSR) 和机器可读 JSON 的**同一个源** (见 NeoxCloud
///   apps/web/src/modules/site/download-manifest.ts 顶部注释: "这两处必须永远说
///   同一件事")。手机端跟着它走, 就自动跟官网、跟 R2 上的实际产物保持一致,
///   不会出现"App 说有新版但下载页还是旧的"这种自相矛盾。
///
///   `available: false` 是运维的总开关 (下载页也认它) —— 关掉时手机端一并噤声,
///   不去引导用户下载一个已经被撤下的包。
///
/// 强更:
///   这份清单目前没有"最低兼容版本"字段。留了 `minSupported` 的读取 —— 服务端
///   哪天在 `mobile.android` 里加上, 手机端立刻生效; 没有就永不强更。
///   宁可漏判也不能误判: 把用户锁在一个出不去的页面里, 比让他多用几天旧版严重得多。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import '../edition/edition.dart';
import '../neox_constants.dart';
import '../notifications/local_notifications.dart';

/// 下载清单地址 — 跟官网下载页同源.
///
/// 单独一个 dart-define: 清单挂在**站点**上而不是 API 网关上, 私有化部署时这两个
/// 地址可能不同源, 不能想当然拿 kNeoxCloudBaseUrl 拼。
const String kNeoxDownloadManifestUrl = String.fromEnvironment(
  'NEOX_DOWNLOAD_MANIFEST',
  defaultValue: '$kNeoxProductionApiBase/download/latest.json',
);

/// 版本比较 — 纯函数, 单独拎出来是因为它是更新/强更判定的唯一依据, 必须可测.
///
/// 只比数字段, 忽略 `-beta.1` 这类后缀 (我们不发预发布版)。
/// 段数不齐时短的一方补 0: `3.2` == `3.2.0`。
/// 解析不出来的一律当 0 —— 宁可判成"不需要更新", 也不要因为版本号里多了个字符
/// 就把用户锁在强更页出不来。
int compareVersions(String a, String b) {
  List<int> parse(String v) {
    final core = v.trim().split(RegExp(r'[-+ ]')).first;
    return core
        .split('.')
        .map((p) => int.tryParse(p.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0)
        .toList();
  }

  final x = parse(a);
  final y = parse(b);
  final len = x.length > y.length ? x.length : y.length;
  for (var i = 0; i < len; i++) {
    final xi = i < x.length ? x[i] : 0;
    final yi = i < y.length ? y[i] : 0;
    if (xi != yi) return xi < yi ? -1 : 1;
  }
  return 0;
}

/// 检查结果.
class AppUpdateStatus {
  const AppUpdateStatus({
    required this.currentVersion,
    this.latestVersion,
    this.downloadUrl,
    this.sizeBytes,
    this.notes,
    this.mandatory = false,
  });

  final String currentVersion;

  /// 服务端说的最新版; null = 没查到 (清单拉不到 / 该平台没发包 / 下载被关).
  final String? latestVersion;

  /// APK 直链 (R2).
  final String? downloadUrl;

  /// 包大小 —— 下载前先告诉用户要花多少流量, 92MB 不是小数目.
  final int? sizeBytes;

  /// 清单里的公告 (`notice`), 有就原样展示.
  final String? notes;

  /// 当前版本低于 minSupported —— 协议已不兼容, 必须更新才能继续用.
  final bool mandatory;

  /// 有更新可装 (不一定强制).
  bool get hasUpdate =>
      latestVersion != null &&
      downloadUrl != null &&
      compareVersions(currentVersion, latestVersion!) < 0;

  /// 人类可读的包大小.
  String get sizeLabel {
    final b = sizeBytes;
    if (b == null || b <= 0) return '';
    final mb = b / (1024 * 1024);
    return mb >= 1 ? '${mb.toStringAsFixed(1)} MB' : '${(b / 1024).round()} KB';
  }

  /// 什么都不知道 —— 清单拉不到时的常态, UI 一律当无事发生.
  static const unknown = AppUpdateStatus(currentVersion: '');
}

/// 页面进入时的重检节流窗口 (2026-09-22).
///
/// 取 30s: 连续切页 (进更新页 → 返回 → 再进) 不该重复打服务端, 而只要隔了一会儿
/// 再进来, 拿到的就必须是当下的清单 —— 版本信息不允许"看着新、其实旧"。
const Duration kAppUpdateRecheckAfter = Duration(seconds: 30);

/// 距上次检查是否已过重检窗口 —— 纯函数, 拎出来是为了可测.
///
/// 判反了的代价是单向的: 判成"不用重检"会让用户一直看过期清单 (下载直链指向
/// 已清理的包 → 404); 判成"要重检"最坏只是多打一次几 KB 的清单。
bool isUpdateCheckStale(DateTime? lastCheckAt, {DateTime? now}) {
  if (lastCheckAt == null) return true;
  return (now ?? DateTime.now()).difference(lastCheckAt) >= kAppUpdateRecheckAfter;
}

class AppUpdateService {
  AppUpdateService(this._ref);
  // ignore: unused_field — 留给后续按登录态做灰度分发
  final Ref _ref;

  /// 上一次**真实**拉清单的时刻 (null = 本进程还没拉过).
  DateTime? _lastCheckAt;

  /// 该不该重检 —— 页面进入时据此决定要不要 invalidate。
  ///
  /// 为什么需要它 (2026-09-22 明康报「app 端怎么更新 404??」):
  ///   [appUpdateStatusProvider] 是普通 FutureProvider —— 首次 watch 之后结果
  ///   **在本进程内一直缓存**, 而首页根部的 ForcedUpdateGate 常驻 watch 它,
  ///   所以那份缓存永远等不到释放。服务端发了新版、甚至上一版的包已经按流程
  ///   从 R2 清掉之后 (发包脚本每次都只保留当前版本), 界面还在拿几小时前那份
  ///   清单: 里面的下载直链指向已删除的 APK, 用户点更新直接 404。
  ///   每进一次更新相关页面就按窗口重检一次, 用户看到的就是当下的真相。
  bool get isStale => isUpdateCheckStale(_lastCheckAt);

  Future<AppUpdateStatus> check() async {
    /* 发起前就记时间: 网络差时也别让页面每次进入都重打 (有「重新检查」按钮
     * 可以显式绕过节流)。 */
    _lastCheckAt = DateTime.now();
    final info = await PackageInfo.fromPlatform();
    final current = info.version;

    /* iOS 走 App Store, 不在这条通道里 (清单的 mobile.ios 目前是 null).
     * 装不了 APK 的平台直接不查, 省一次请求也避免误导。 */
    if (!Platform.isAndroid) return AppUpdateStatus(currentVersion: current);

    final http.Response resp;
    try {
      resp = await http
          .get(Uri.parse(kNeoxDownloadManifestUrl))
          .timeout(const Duration(seconds: 8));
    } catch (e) {
      /* 网络不好 / 清单没发布 —— 静默。更新检查永远不该打扰用户。 */
      if (kDebugMode) debugPrint('[app-update] manifest unreachable: $e');
      return AppUpdateStatus(currentVersion: current);
    }
    if (resp.statusCode != 200) {
      if (kDebugMode) debugPrint('[app-update] manifest ${resp.statusCode}');
      return AppUpdateStatus(currentVersion: current);
    }

    try {
      final data = jsonDecode(resp.body);
      if (data is! Map) return AppUpdateStatus(currentVersion: current);

      /* 运维总开关: 下载页关掉时手机端一并噤声, 不引导下载一个已撤下的包 */
      if (data['available'] == false) {
        return AppUpdateStatus(currentVersion: current);
      }

      final android = (data['mobile'] as Map?)?['android'];
      if (android is! Map) return AppUpdateStatus(currentVersion: current);

      final latest = (android['version'] as String?)?.trim();
      final url = (android['url'] as String?)?.trim();
      final minSupported = (android['minSupported'] as String?)?.trim();
      final notice = (data['notice'] as String?)?.trim();

      return AppUpdateStatus(
        currentVersion: current,
        latestVersion: (latest != null && latest.isNotEmpty) ? latest : null,
        downloadUrl: (url != null && url.isNotEmpty) ? url : null,
        sizeBytes: (android['sizeBytes'] as num?)?.toInt(),
        notes: (notice != null && notice.isNotEmpty) ? notice : null,
        /* 强更只在清单明确给了 minSupported 且当前确实低于它时才成立。
         * 字段缺失/解析失败一律不强更。 */
        mandatory: minSupported != null &&
            minSupported.isNotEmpty &&
            compareVersions(current, minSupported) < 0,
      );
    } catch (e) {
      if (kDebugMode) debugPrint('[app-update] bad manifest: $e');
      return AppUpdateStatus(currentVersion: current);
    }
  }
}

final appUpdateServiceProvider =
    Provider<AppUpdateService>((ref) => AppUpdateService(ref));

/// 冷启动查一次的结果 — UI 直接 watch.
final appUpdateStatusProvider = FutureProvider<AppUpdateStatus>((ref) async {
  /* 开源版没有官方下载源: 不去问官网有没有新版 (那是商业版的安装包) */
  if (!ref.read(editionProvider).officialServices) {
    final info = await PackageInfo.fromPlatform();
    return AppUpdateStatus(currentVersion: info.version);
  }
  final s = await ref.read(appUpdateServiceProvider).check();
  /* 有新版说一声 (每版一次; 设置 → 通知 →「更新」管它) */
  if (s.hasUpdate && s.latestVersion != null) unawaited(LocalNotifications.showUpdate(s.latestVersion!));
  return s;
});
