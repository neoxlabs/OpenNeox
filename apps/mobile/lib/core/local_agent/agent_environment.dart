/// agent_environment.dart — 手机本地 Agent 的环境上下文构建.
///
/// 尽力而为原则 (用户拍板 "获取不到拉倒"): 每一项独立 try, 拿不到就跳过,
/// 绝不因为环境采集失败阻塞发消息. 总耗时上限 ~1.5s (device_info 有缓存).
///
/// 注入内容 (拼进 SDK system prompt 的 environment 段):
///   日期/星期 · 设备型号/系统版本 · 网络类型 · 系统语言 ·
///   登录用户 · 当前模型 · 工作区用量 · 电池状态(Android dumpsys 不可用, 跳过)
///
/// 注意: 这里**不放分钟级时间** —— 精确时刻走消息尾的 `<current-time>`
/// (见 current_time_tag.dart)。这一段同一天内逐字不变, 前缀缓存才命得中。
library;

import 'dart:io';
import 'dart:ui' show PlatformDispatcher;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../edition/edition.dart';
import 'current_time_tag.dart';
import 'linux_env.dart';

/// device_info 全局缓存 — 型号不会变, 只查一次.
String? _cachedDeviceLine;

Future<String> buildAgentEnvironment({
  required Ref ref,
  required String modelId,
  sdk.WorkspaceFilesTool? workspace,
  bool withWorkTools = true,
}) async {
  final lines = <String>[];

  /* 日期 + 星期 — 只到天级, 同一天内逐字不变 (环境段要字节稳定, 分钟级时间会
   * 打穿前缀缓存)。精确到分钟的时刻由 current_time_tag.dart 追加在本轮用户消息
   * 末尾的 <current-time> 里, 跟桌面同一个范式, 两边不一致以标签为准。 */
  lines.add(formatEnvironmentDateLine(DateTime.now()));

  /* 设备型号 + 系统 (缓存) */
  try {
    if (_cachedDeviceLine == null && Platform.isAndroid) {
      final info = await DeviceInfoPlugin()
          .androidInfo
          .timeout(const Duration(milliseconds: 1200));
      _cachedDeviceLine =
          '设备: ${info.brand} ${info.model} (Android ${info.version.release})';
    } else if (_cachedDeviceLine == null && Platform.isIOS) {
      final info = await DeviceInfoPlugin()
          .iosInfo
          .timeout(const Duration(milliseconds: 1200));
      _cachedDeviceLine =
          '设备: ${info.utsname.machine} (iOS ${info.systemVersion})';
    }
    if (_cachedDeviceLine != null) lines.add(_cachedDeviceLine!);
  } catch (_) {/* 拉倒 */}

  /* 网络类型 */
  try {
    final conns = await Connectivity()
        .checkConnectivity()
        .timeout(const Duration(milliseconds: 800));
    final label = conns.contains(ConnectivityResult.wifi)
        ? 'Wi-Fi'
        : conns.contains(ConnectivityResult.mobile)
            ? '蜂窝数据'
            : conns.contains(ConnectivityResult.none)
                ? '离线'
                : null;
    if (label != null) lines.add('网络: $label');
  } catch (_) {/* 拉倒 */}

  /* 系统语言 */
  try {
    final locale = PlatformDispatcher.instance.locale;
    lines.add('系统语言: ${locale.toLanguageTag()}');
  } catch (_) {/* 拉倒 */}

  /* 登录用户 (未登录不写) */
  try {
    final name = ref.read(accountStatusProvider).promptName;
    if (name != null && name.isNotEmpty) lines.add('用户: $name');
  } catch (_) {/* 拉倒 */}

  /* 自身配置感知 */
  lines.add('运行位置: 手机本地 (你运行在用户手机上, 无桌面/云端工具)');
  lines.add('当前模型: $modelId');

  /* 工作区用量 — agent 有清理意识 */
  try {
    if (workspace != null) {
      final u = await workspace
          .usage()
          .timeout(const Duration(milliseconds: 1000));
      final mb = (u.bytes / 1024 / 1024).toStringAsFixed(1);
      lines.add('工作区 (workspace_files): 已用 ${mb}MB / 50MB, ${u.files} 个文件'
          '${u.bytes > 40 * 1024 * 1024 ? ' — 接近限额, 建议主动清理旧文件' : ''}');
    }
  } catch (_) {/* 拉倒 */}

  /* 工具包装没装 + 办公文件走哪条路。2026-10-16 实测: 模型不知道没装, 先 python3 -c import openpyxl /
   * pip install 连撞两次才回头用 office_edit, 用户看着一串红色失败。 */
  if (!withWorkTools) return lines.join('\n');
  try {
    if (Platform.isAndroid) {
      final st = await LinuxEnv.status().timeout(const Duration(milliseconds: 800));
      lines.add(st.installed
          ? '工具包 (execute_shell 的本地 Linux): 已装'
          : '工具包 (execute_shell 的本地 Linux): ${st.supported ? '没装 —— 别调 execute_shell' : '这台手机不支持'}');
    }
  } catch (_) {/* 拉倒 */}
  lines.add('做 Excel / Word / PPT: 一律先用 office_edit (内置, 不用装东西; Excel 支持真公式 / 百分比金额格式 / 多表 / 原生图表), '
      '只有它做不到的 (几万行数据清洗、透视、复杂统计) 才用 execute_shell 里的 Python。回复里只说回执里真写进去的东西。');

  return lines.join('\n');
}
