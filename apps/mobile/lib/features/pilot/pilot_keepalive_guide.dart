/// pilot_keepalive_guide.dart — 「让 Pilot 一直在线」的数据 (2026-10-18)。
///
/// 手机节点被国产 ROM 杀后台, Pilot 的所有场景都会失效: 读不到屏幕、收不到消息、
/// 熄屏一会儿就断。这一页逐项列出要开的系统开关, 每项给一句该厂商的手动路径,
/// 原生侧 (PilotKeepAliveBridge.kt) 负责真检测和跳转, 这里只管文案和状态解析。
///
/// 本文件不 import flutter, 纯逻辑跑单测 (test/features/pilot_keepalive_guide_test.dart)。
library;

import 'package:shared_preferences/shared_preferences.dart';

const kPilotKeepAliveChannel = 'neox.phone/keepalive';

/// 首次开 Pilot 时引导过一次
const kPilotKeepAliveDonePref = 'pilot_keepalive_done_v1';

enum PilotVendor { xiaomi, huawei, oppo, vivo, samsung, stock }

/// Build.MANUFACTURER / Build.BRAND → 厂商 (与原生 PilotKeepAlivePlan.vendorOf 同一套判定)
PilotVendor pilotVendorOf(String manufacturer, {String brand = ''}) {
  final m = manufacturer.toLowerCase();
  final b = brand.toLowerCase();
  bool any(List<String> names) => names.any((n) => m.contains(n) || b.contains(n));
  if (any(const ['xiaomi', 'redmi', 'poco'])) return PilotVendor.xiaomi;
  if (any(const ['huawei', 'honor', 'hihonor'])) return PilotVendor.huawei;
  if (any(const ['oppo', 'oneplus', 'realme', 'oplus'])) return PilotVendor.oppo;
  if (any(const ['vivo', 'iqoo'])) return PilotVendor.vivo;
  if (any(const ['samsung'])) return PilotVendor.samsung;
  return PilotVendor.stock;
}

class KeepAliveItem {
  const KeepAliveItem({
    required this.id,
    required this.title,
    required this.why,
    required this.manualPath,
    required this.detectable,
  });

  /// 与原生 status / open 的 item 一致
  final String id;
  final String title;

  /// 没开时会怎样 (一句话)
  final String why;

  /// 跳不到时页面显示 / 提示的手动路径
  final String manualPath;

  /// 系统能不能查出来 (自启动 / 后台弹出 / 锁屏显示 查不了)
  final bool detectable;
}

/// 这页对该厂商要列哪几项 (小米多两项 MIUI 独有开关)
List<KeepAliveItem> pilotKeepAliveItems(PilotVendor vendor) {
  final ids = vendor == PilotVendor.xiaomi
      ? const ['accessibility', 'notifications', 'battery', 'autostart', 'background_popup', 'lockscreen']
      : const ['accessibility', 'notifications', 'battery', 'autostart'];
  return [for (final id in ids) keepAliveItem(vendor, id)];
}

KeepAliveItem keepAliveItem(PilotVendor vendor, String id) {
  final (title, why, detectable) = switch (id) {
    'accessibility' => ('无障碍 (读屏和点按)', '没开: 读不了屏幕, 也点不了别的 App', true),
    'notifications' => ('通知使用权 (实时收消息)', '没开: 新消息来了 Pilot 不知道', true),
    'battery' => ('电池不限制 (省电白名单)', '没开: 熄屏一会儿就会被系统掐掉', true),
    'autostart' => ('自启动', '没开: 重启后不会自己回来', false),
    'background_popup' => ('后台弹出界面', '没开: 叫不出浮层, 也点不了别的 App', false),
    'lockscreen' => ('锁屏显示', '没开: 锁屏时收不到提醒', false),
    _ => (id, '', false),
  };
  return KeepAliveItem(
    id: id,
    title: title,
    why: why,
    manualPath: pilotKeepAliveManualPath(vendor, id),
    detectable: detectable,
  );
}

String pilotKeepAliveManualPath(PilotVendor vendor, String id) {
  String? a11y, notif, battery, autostart, popup, lock;
  switch (vendor) {
    case PilotVendor.xiaomi:
      a11y = '设置 → 更多设置 → 无障碍 → 已下载的应用 → Neox Pilot';
      notif = '设置 → 应用设置 → 应用管理 → Neox → 通知使用权（读取通知）';
      battery = '设置 → 省电与电池 → 应用智能省电 → Neox 选「不限制」';
      autostart = '设置 → 应用设置 → 应用管理 → Neox → 自启动';
      popup = '设置 → 应用设置 → 应用管理 → Neox → 权限管理 → 后台弹出界面';
      lock = '设置 → 应用设置 → 应用管理 → Neox → 权限管理 → 锁屏显示';
    case PilotVendor.huawei:
      a11y = '设置 → 辅助功能 → 无障碍 → 已下载的应用 → Neox Pilot';
      notif = '设置 → 通知和状态栏 → 通知使用权 → Neox';
      battery = '设置 → 电池 → 更多电池设置 → 允许后台活动';
      autostart = '设置 → 应用 → 应用启动管理 → Neox 关掉「自动管理」，三项都允许';
    case PilotVendor.oppo:
      a11y = '设置 → 系统设置 → 无障碍 → 已下载的应用 → Neox Pilot';
      notif = '设置 → 通知与状态栏 → 通知使用权 → Neox';
      battery = '设置 → 电池 → 更多 → 应用耗电管理 → Neox：允许后台活动';
      autostart = '设置 → 应用 → 自启动管理 → 打开 Neox';
    case PilotVendor.vivo:
      a11y = '设置 → 快捷与辅助 → 无障碍 → 已下载的应用 → Neox Pilot';
      notif = '设置 → 通知与状态栏 → 通知使用权 → Neox';
      battery = '设置 → 电池 → 后台耗电管理 → Neox：允许后台高耗电';
      autostart = '设置 → 应用与权限 → 权限管理 → 自启动 → Neox';
    case PilotVendor.samsung:
      a11y = '设置 → 辅助功能 → 已安装的应用 → Neox Pilot';
      notif = '设置 → 通知 → 高级设置 → 通知使用权 → Neox';
      battery = '设置 → 电池和设备维护 → 电池 → 后台使用限制，把 Neox 移出休眠应用';
      autostart = '设置 → 电池和设备维护 → 电池 → 后台使用限制';
    case PilotVendor.stock:
      a11y = '设置 → 无障碍 → 已下载的应用 → Neox Pilot';
      notif = '设置 → 通知 → 通知使用权 → Neox';
      battery = '设置 → 电池 → 电池优化 → Neox 选「不优化」';
      autostart = '设置 → 应用 → Neox → 应用的电池使用情况 → 不受限制';
  }
  return switch (id) {
    'accessibility' => a11y,
    'notifications' => notif,
    'battery' => battery,
    'autostart' => autostart,
    'background_popup' => popup ?? '',
    'lockscreen' => lock ?? '',
    _ => '',
  };
}

/// 原生 status 的回执。items 以原生为准 (它知道这台机器是哪个 ROM)
class PilotKeepAliveStatus {
  const PilotKeepAliveStatus({
    required this.vendor,
    required this.manufacturer,
    required this.accessibility,
    required this.notifications,
    required this.battery,
    required this.items,
  });

  final PilotVendor vendor;
  final String manufacturer;
  final bool accessibility;
  final bool notifications;
  final bool battery;
  final List<KeepAliveItem> items;

  factory PilotKeepAliveStatus.from(Map<dynamic, dynamic> m) {
    final vendor = pilotVendorOf(
      '${m['manufacturer'] ?? ''}',
      brand: '${m['brand'] ?? ''}',
    );
    final rawItems = (m['items'] as List?)?.whereType<String>().toList() ?? const <String>[];
    return PilotKeepAliveStatus(
      vendor: vendor,
      manufacturer: '${m['manufacturer'] ?? ''}',
      accessibility: m['accessibility'] == true,
      notifications: m['notifications'] == true,
      battery: m['battery'] == true,
      items: rawItems.isEmpty
          ? pilotKeepAliveItems(vendor)
          : [for (final id in rawItems) keepAliveItem(vendor, id)],
    );
  }

  /// 能检测的项里开了几项 / 共几项
  int get readyCount => [
        for (final it in items)
          if (it.detectable && stateOf(it.id) == true) it,
      ].length;

  int get detectableCount => items.where((it) => it.detectable).length;

  /// null = 查不了, 要用户自己确认
  bool? stateOf(String id) => switch (id) {
        'accessibility' => accessibility,
        'notifications' => notifications,
        'battery' => battery,
        _ => null,
      };
}

/// 首次开 Pilot 时引导一次; 已经引导过 / 非安卓就直接进
Future<void> markPilotKeepAliveSeen() async {
  try {
    await (await SharedPreferences.getInstance()).setBool(kPilotKeepAliveDonePref, true);
  } catch (_) {}
}

Future<bool> pilotKeepAliveSeen() async {
  try {
    return (await SharedPreferences.getInstance()).getBool(kPilotKeepAliveDonePref) == true;
  } catch (_) {
    return false;
  }
}
