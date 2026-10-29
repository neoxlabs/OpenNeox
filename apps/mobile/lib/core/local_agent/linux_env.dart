/// 手机里的 Linux (「完全体」, 2026-10-12) —— Dart 这边的门面, 实现在 LinuxEnv.kt。
///
/// 用户点「补全本地能力」才下载 (装好约 200MB): Alpine 系统 + python3 / pip / node / npm / bash / git / curl …
/// 装好后 Agent 多一个 execute_shell 工具, 工作区挂在 /workspace。
library;

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const _ch = MethodChannel('neox.phone/linux');

class LinuxStatus {
  const LinuxStatus({
    required this.supported,
    required this.installed,
    required this.phase,
    required this.percent,
    this.error,
    this.log = '',
    this.bytes = 0,
    this.tools = const {},
  });

  /// 装了哪些: python / node / git → true/false
  final Map<String, bool> tools;
  bool has(String tool) => tools[tool] == true;

  /// 这台手机能装 (安卓 + arm64)
  final bool supported;
  final bool installed;

  /// idle | downloading | extracting | packages | done | error
  final String phase;
  final int percent;
  final String? error;
  final String log;
  final int bytes;

  bool get busy => const {'downloading', 'extracting', 'packages'}.contains(phase);

  static const none = LinuxStatus(supported: false, installed: false, phase: 'idle', percent: 0);

  factory LinuxStatus.fromMap(Map m) => LinuxStatus(
        supported: m['supported'] == true,
        installed: m['installed'] == true,
        phase: '${m['phase'] ?? 'idle'}',
        percent: (m['percent'] as num?)?.toInt() ?? 0,
        error: m['error'] as String?,
        log: '${m['log'] ?? ''}',
        bytes: (m['bytes'] as num?)?.toInt() ?? 0,
        tools: {
          for (final e in ((m['tools'] as Map?) ?? const {}).entries) '${e.key}': e.value == true,
        },
      );
}

class LinuxEnv {
  static Future<LinuxStatus> status() async {
    if (!Platform.isAndroid) return LinuxStatus.none;
    try {
      final m = await _ch.invokeMethod<Map>('status');
      return m == null ? LinuxStatus.none : LinuxStatus.fromMap(m);
    } catch (_) {
      return LinuxStatus.none;
    }
  }

  /// 最近一次发起安装 / 加装的时间 —— 原生那边是起个后台线程就返回, 紧接着读状态可能还是 idle;
  /// 状态页据此在这之后多盯一会儿, 不然停在「下载」按钮上, 看着像没反应 (2026-10-16 实测)
  static DateTime? lastRequestAt;

  static Future<void> install() {
    lastRequestAt = DateTime.now();
    return _ch.invokeMethod('install');
  }

  /// 已装好的再加装几个包 (老用户补 Node.js)
  static Future<void> add(List<String> packages) {
    lastRequestAt = DateTime.now();
    return _ch.invokeMethod('add', {'packages': packages});
  }

  static Future<bool> uninstall() async => await _ch.invokeMethod<bool>('uninstall') ?? false;

  /// 跑一条命令; workspace = Agent 工作区的绝对路径 (挂到 /workspace)
  static Future<Map> exec(String command, {String? workspace, int timeoutSec = 120}) async =>
      await _ch.invokeMethod<Map>('exec', {'command': command, 'workspace': workspace, 'timeoutSec': timeoutSec}) ?? const {};
}

/// 安装状态: 装的时候 (以及刚点了安装的 15 秒内) 每秒刷一次, 平时只取一次
final linuxStatusProvider = StreamProvider.autoDispose<LinuxStatus>((ref) async* {
  bool justRequested() {
    final t = LinuxEnv.lastRequestAt;
    return t != null && DateTime.now().difference(t) < const Duration(seconds: 15);
  }

  var s = await LinuxEnv.status();
  yield s;
  while (s.busy || (justRequested() && !s.installed && s.phase != 'error')) {
    await Future<void>.delayed(const Duration(seconds: 1));
    s = await LinuxEnv.status();
    yield s;
  }
});
