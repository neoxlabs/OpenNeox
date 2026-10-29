/// cli_endpoint_id.dart — 电脑上 CLI 终端会话的「伪设备 id」(2026-10-17)。
///
/// 一台电脑 = 一个设备; 电脑上每个开了 /rc 的 CLI 窗口是这台电脑的一个「入口」(`cli:<id>`)。
/// 手机这边把终端会话记成 `<电脑 device_id>#cli:<id>`, 当作一台伪电脑走现有的整套连接 / 聊天界面
/// (云端 Pilot 也是这么接进来的), 不用改库表。连的时候拆回 (电脑 id, 入口), 用电脑那把配对密钥
/// 派生出的子密钥加解密。
library;

import '../i18n/tr.dart';

const String kCliEndpointSep = '#';

bool isCliEndpointId(String id) => id.contains('$kCliEndpointSep' 'cli:');

String makeCliEndpointId(String desktopDeviceId, String endpoint) =>
    '$desktopDeviceId$kCliEndpointSep$endpoint';

/// 这条会话属于哪台电脑 (终端会话拆回电脑 id, 别的原样)
String computerOfSession(String desktopDeviceId) =>
    parseCliEndpointId(desktopDeviceId)?.desktopDeviceId ?? desktopDeviceId;

/// 会话列表上的来源标签。只在这台电脑同时有终端会话时才标 (调用方给 [computersWithCli]),
/// 平时只有客户端会话的列表不多出一个字。
String? sessionSourceLabel(String desktopDeviceId, Set<String> computersWithCli) {
  if (isCliEndpointId(desktopDeviceId)) return tr('终端');
  return computersWithCli.contains(desktopDeviceId) ? tr('客户端') : null;
}

/// (电脑 device_id, 入口); 不是终端 id 返 null
({String desktopDeviceId, String endpoint})? parseCliEndpointId(String id) {
  final i = id.indexOf('$kCliEndpointSep' 'cli:');
  if (i <= 0) return null;
  return (desktopDeviceId: id.substring(0, i), endpoint: id.substring(i + 1));
}
