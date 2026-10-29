/// connection_guard.dart — 电脑断开 / 换了电脑时, 首页该不该离开当前会话.
///
/// **为什么** (2026-09-22 用户原话)
/// 「电脑如果断开连接或者切换, 默认进来编码页面也应该是处理好, 不应该默认显示
///  timeline。如果断开连接其实还显示不合理。」
///
/// 原来连接怎么变, 首页都不动: 断了, 旧 timeline 照样摊着, 输入框照样能打字,
/// 发出去才报错; 换到另一台电脑, 屏幕上还是上一台的对话 (缓存), 选中的项目还是
/// 上一台上的路径, 下一条会话会拿着它去新电脑上建。
///
/// 判定只看**变化**, 不看静态状态: 用户在断网时自己从抽屉点开一条会话看历史,
/// 那是他的选择, 不该被踢出来。
///
/// 断线给宽限期: 切后台回来、Wi-Fi 抖一下, 重连通常几秒内就回来了 ——
/// 每次抖动都把人踢回首页比显示旧内容更糟。宽限期内连回来就什么都不做。
library;

import '../../../core/network/ws_client_provider.dart';

/// 断线多久还没连回来才离开会话
const Duration kLeaveSessionGrace = Duration(seconds: 10);

enum ConnectionGuardAction {
  /// 什么都不做 (已有的宽限计时继续走)
  none,

  /// 立刻离开会话 (换了电脑 / 用户主动断开)
  leaveNow,

  /// 开始宽限计时, 到点还没连回来就离开 (已在计时就别重置)
  startGrace,

  /// 连回来了, 取消宽限计时
  cancelGrace,
}

/// [sessionDesktopId] = 当前会话所在电脑; 没有会话 / 手机本地 / 云端 / 画布传 null.
ConnectionGuardAction decideConnectionGuard({
  required WsClientState? prev,
  required WsClientState next,
  required String? sessionDesktopId,
}) {
  if (sessionDesktopId == null) return ConnectionGuardAction.cancelGrace;
  /* 云端 agent 那条连接跟电脑会话无关 */
  if (next.transport == WsTransport.cloudAgent) return ConnectionGuardAction.none;

  final prevDesktop = prev?.activeDesktopDeviceId;
  final nextDesktop = next.activeDesktopDeviceId;

  /* 换了电脑: 这条会话不在当前电脑上了 */
  if (nextDesktop != null &&
      nextDesktop != prevDesktop &&
      nextDesktop != sessionDesktopId) {
    return ConnectionGuardAction.leaveNow;
  }
  /* 用户主动断开 (disconnect() 把状态重置成 initial, 设备 id 清空) */
  if (prevDesktop != null && nextDesktop == null) {
    return ConnectionGuardAction.leaveNow;
  }
  if (nextDesktop != sessionDesktopId) return ConnectionGuardAction.none;

  switch (next.connection) {
    case WsConnectionState.connected:
      return ConnectionGuardAction.cancelGrace;
    case WsConnectionState.connecting:
      /* 正在重连 —— 不开始也不取消 */
      return ConnectionGuardAction.none;
    case WsConnectionState.disconnected:
    case WsConnectionState.error:
      /* 只有"从连着变成没连着"才算断线; 本来就没连着的 (用户断网时自己点开看历史)
       * 不管。connecting → error 也算: 重连失败的那一跳。 */
      final wasUp = prev != null &&
          prev.activeDesktopDeviceId == sessionDesktopId &&
          (prev.connection == WsConnectionState.connected ||
              prev.connection == WsConnectionState.connecting);
      return wasUp ? ConnectionGuardAction.startGrace : ConnectionGuardAction.none;
  }
}

/// 当前项目是不是另一台电脑上的 (老数据没记电脑 = 不知道, 不算)
bool projectBelongsToOtherDesktop({
  required String? projectDesktopId,
  required WsClientState ws,
}) {
  final active = ws.activeDesktopDeviceId;
  if (projectDesktopId == null || active == null) return false;
  if (ws.transport == WsTransport.cloudAgent) return false;
  return projectDesktopId != active;
}
