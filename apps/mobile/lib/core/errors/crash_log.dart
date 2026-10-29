/// crash_log.dart — 全局异常捕获 + 本地日志文件 (零外部服务依赖).
///
/// 为什么不接 Sentry (2026-07-20 决策): 发布前先要"用户手机上出了什么错能拿回来",
/// 本地文件 + 设置页导出就够; Sentry/Crashlytics 等有量后再接 (接口留在
/// [CrashLog.install] 一处, 换实现零调用方改动).
///
/// 捕获三层:
///   1. FlutterError.onError  — framework 层 (build/layout/gesture)
///   2. PlatformDispatcher.onError — 引擎层未捕获 async 异常
///   3. runZonedGuarded 由 main 包 (兜底 zone 逃逸)
///
/// 日志: 应用文档目录 crash.log, 512KB 滚动截断 (保尾部), 崩溃写入是同步 flush
/// (进程可能马上死, 不能 buffered).
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

class CrashLog {
  CrashLog._();

  static File? _file;
  static const int _maxBytes = 512 * 1024;

  /// main() 里 ensureInitialized 后调. 幂等.
  static Future<void> install() async {
    try {
      final dir = await getApplicationDocumentsDirectory();
      _file = File('${dir.path}/crash.log');
    } catch (_) {
      /* 拿不到目录就只打 console — 不能因日志装不上阻断启动 */
    }

    final prevFlutterHandler = FlutterError.onError;
    FlutterError.onError = (details) {
      record('flutter', details.exceptionAsString(), details.stack);
      prevFlutterHandler?.call(details);
    };

    PlatformDispatcher.instance.onError = (error, stack) {
      record('platform', '$error', stack);
      return true; /* 已记录, 不让引擎二次抛 (release 下抛了也没人看) */
    };
  }

  /// 写一条错误记录 — 崩溃路径同步写 (进程可能立刻死).
  static void record(String source, String message, StackTrace? stack) {
    final line = StringBuffer()
      ..write(DateTime.now().toIso8601String())
      ..write(' [')
      ..write(source)
      ..write('] ')
      ..writeln(message);
    if (stack != null) {
      /* 栈顶 12 帧够定位, 全栈会让日志迅速膨胀 */
      final frames = '$stack'.split('\n').take(12).join('\n');
      line.writeln(frames);
    }
    if (kDebugMode) debugPrint('[crash-log] $source: $message');
    final f = _file;
    if (f == null) return;
    try {
      /* 滚动: 超限截一半 (保尾部 — 最近的错误最有价值) */
      if (f.existsSync() && f.lengthSync() > _maxBytes) {
        final content = f.readAsStringSync();
        f.writeAsStringSync(content.substring(content.length ~/ 2));
      }
      f.writeAsStringSync(line.toString(), mode: FileMode.append, flush: true);
    } catch (_) {
      /* 写日志失败静默 — 不能递归抛 */
    }
  }

  /// 设置页「导出诊断日志」读取用. 无日志返回 null.
  static Future<String?> read() async {
    final f = _file;
    if (f == null || !f.existsSync()) return null;
    try {
      final s = await f.readAsString();
      return s.isEmpty ? null : s;
    } catch (_) {
      return null;
    }
  }

  static Future<void> clear() async {
    try {
      await _file?.writeAsString('');
    } catch (_) {}
  }
}
