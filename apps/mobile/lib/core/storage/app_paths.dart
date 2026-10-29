/// app_paths.dart — 存下来的本地绝对路径, 读出来时换成当前容器.
///
/// iOS 每次更新 / 重装 App, 沙盒容器目录的 UUID 都会变
/// (…/Containers/Data/Application/<UUID>/Documents/…), 而出图结果、附件这些在事件
/// payload 里存的是**绝对路径**: 文件其实还在新容器里, 拿旧路径去找就"不见了" ——
/// 画过的图、聊天里的图片在升级后全部消失 (2026-10-08 模拟器重装实测)。
/// 安卓的应用目录是固定的, 不受影响。
library;

import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

class AppPaths {
  AppPaths._();

  /// 当前容器根 (Documents 的上一级); 没 init 时为 null, [rebase] 原样返回
  static String? _home;

  @visibleForTesting
  static set debugHome(String? home) => _home = home;

  static Future<void> init() async {
    if (!Platform.isIOS) return;
    try {
      _home = p.dirname((await getApplicationDocumentsDirectory()).path);
    } catch (_) {/* 拿不到就不改写 */}
  }

  /// 旧容器前缀 → 当前容器; 本来就在当前容器 / 不是沙盒路径的原样返回
  static String rebase(String stored) {
    final home = _home;
    if (home == null || stored.startsWith(home)) return stored;
    for (final seg in const ['/Documents/', '/Library/', '/tmp/']) {
      final i = stored.indexOf(seg);
      if (i > 0 && stored.contains('/Containers/Data/Application/')) {
        return '$home${stored.substring(i)}';
      }
    }
    return stored;
  }
}
