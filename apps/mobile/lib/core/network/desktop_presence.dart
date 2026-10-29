/// desktop_presence.dart — "哪台电脑此刻在线" 的只读视图.
///
/// 在线信号来自服务端的 presence 推送 —— 有没有这条通道由发行版决定
/// (见 core/edition/edition.dart)。没有时一律按"不知道"处理: 界面上不说在线,
/// 连接逻辑也不因此拒绝去连。
library;

abstract interface class DesktopPresenceView {
  /// 服务端说它在线。不知道 = false。
  bool isOnline(String deviceId);

  /// 那台电脑有没有接入中继。null = 服务端没说 (按能连处理)。
  bool? relayOnline(String deviceId);

  /// 在线通道此刻通不通。false 时 [isOnline] 的 false 只是"不知道", 不能显示成"不在线"。
  bool get live;
}

/// 没有在线信号 —— 什么都不知道。
class NoDesktopPresence implements DesktopPresenceView {
  const NoDesktopPresence();

  @override
  bool isOnline(String deviceId) => false;

  @override
  bool? relayOnline(String deviceId) => null;

  @override
  bool get live => false;
}
