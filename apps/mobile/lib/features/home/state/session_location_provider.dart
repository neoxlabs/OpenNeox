/// session_location_provider.dart — 一条会话**实际**跑在哪 (手机 / 电脑 / 云端 / 画布).
///
/// 会话建好之后运行位置就定了, 跟「运行位置」偏好 (runTargetPrefProvider) 无关。
/// 2026-09-17 走查: 会话里输入框的位置 chip 显示的是偏好「自动」, 而这条会话其实
/// 跑在某台电脑上 —— 显示的不是这条会话的事实。首页顶栏和输入框都从这里取。
library;

import 'package:flutter/material.dart' show IconData, Icons;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/device/device_display_name.dart';
import '../../../core/network/cli_endpoint_id.dart';
import '../../../core/execution/run_target.dart';
import '../../../core/storage/database.dart';
import '../../../core/storage/paired_desktop_kind.dart';
import 'package:neox_app/core/i18n/tr.dart';

enum SessionLocationKind { phone, desktop, cloud, image }

class SessionLocation {
  const SessionLocation({
    required this.kind,
    this.deviceName,
    this.workspaceName,
    this.terminal = false,
  });

  /// 这条会话在那台电脑的 CLI 终端里跑 (/rc), 不在客户端里
  final bool terminal;

  final SessionLocationKind kind;
  final String? deviceName;
  final String? workspaceName;

  bool get isRemote =>
      kind == SessionLocationKind.desktop || kind == SessionLocationKind.cloud;

  /// chip 上的短名: 手机 / 电脑名 / 云端.
  ///
  /// 2026-09-22: **机器码不是名字**。真机上这条显示的是 `JDMCVMPHIYKSSVX` —— 那是
  /// 桌面端的 deviceId, 而配对记录里的 deviceName 就是它 (服务端上报的那一份)。
  /// 多台电脑时用户确实想知道"是哪台", 但机器码给不了这个信息, 只会让人以为坏了。
  /// 认不出人话的名字就退回「电脑」—— 是什么就说什么, 编不出来就别编。
  String get shortLabel => switch (kind) {
    SessionLocationKind.phone => tr('手机'),
    SessionLocationKind.cloud => tr('云端'),
    SessionLocationKind.image => tr('图片'),
    SessionLocationKind.desktop => terminal
        /* 「终端」放前面: 顶栏副标题窄, 放后面会被省略号吃掉 (模拟器实测) */
        ? '${tr('终端')} · ${friendlyDeviceName(deviceName) ?? tr('电脑')}'
        : friendlyDeviceName(deviceName) ?? tr('电脑'),
  };

  IconData get icon => switch (kind) {
    SessionLocationKind.phone => Icons.smartphone_outlined,
    SessionLocationKind.cloud => Icons.cloud_outlined,
    SessionLocationKind.image => Icons.image_outlined,
    SessionLocationKind.desktop => terminal ? Icons.terminal_rounded : Icons.computer_outlined,
  };
}

/// 设备名是不是"人话" —— 机器码 (全大写字母/数字/下划线连字符, 8 位以上) 不算.
///
/// 判据刻意保守: 宁可把某台真叫 `ABC12345` 的电脑退回「电脑」, 也不要把
/// `JDMCVMPHIYKSSVX` 这种东西摆到用户脸上。带空格、小写、中文的名字都能过。
///
/// 2026-09-22 移到 core/device/ —— 设置页「连接」格是另一处独立实现, 同一个毛病
/// 在那里又犯了一次。现在谁要显示设备名都走这一个。

final sessionLocationProvider = StreamProvider.family<SessionLocation?, String>(
  (ref, sessionId) {
    final db = ref.watch(appDatabaseProvider);
    return db.sessionMirrorDao.watchById(sessionId).asyncMap((m) async {
      if (m == null) return null;
      if (m.kind == 'image') {
        return const SessionLocation(kind: SessionLocationKind.image);
      }
      if (isPhoneLocalDeviceId(m.desktopDeviceId)) {
        return const SessionLocation(kind: SessionLocationKind.phone);
      }
      /* 终端会话 (<电脑 id>#cli:<id>) 算那台电脑的 —— 名字取电脑的, 后面标「终端」 */
      final desktop = await db.pairedDesktopsDao.findByDeviceId(
        computerOfSession(m.desktopDeviceId),
      );
      final isCloud = desktop != null && isCloudAgentPairedDesktop(desktop);
      return SessionLocation(
        kind: isCloud ? SessionLocationKind.cloud : SessionLocationKind.desktop,
        deviceName: desktop?.deviceName,
        workspaceName: m.workspaceName,
        terminal: isCliEndpointId(m.desktopDeviceId),
      );
    });
  },
);
