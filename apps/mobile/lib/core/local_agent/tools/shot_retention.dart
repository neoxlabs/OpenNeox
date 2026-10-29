/// shot_retention.dart — 截图生命周期 (pilot:D-08, 2026-10-18).
///
/// 操控时每截一张图就在手机 cacheDir 写一个 `pilot-screen-<毫秒>.jpg`。原生侧已经有两道清理:
/// 服务启动时清上一轮残留、每次截图顺手清 30 分钟前的旧图 (ScreenshotCache)。
/// 这里补上最后一道: **任务一结束就删掉这一轮截的图**, 不用在 cacheDir 里躺半小时。
///
/// 失败一律按 0 算 —— 删图是收尾动作, 不能反过来把任务搞挂。
library;

import 'dart:io';

import 'package:flutter/services.dart';

const _ch = MethodChannel('neox.phone/tools');

/// 任务结束: 删掉这一轮在手机上截的图。返回删掉几张。
/// [android] 只为测试注入 (真机上就是 `Platform.isAndroid`)。
Future<int> endRoundShots({bool? android}) async {
  final isAndroid = android ?? Platform.isAndroid;
  if (!isAndroid) return 0;
  try {
    final r = await _ch.invokeMethod<Map>('uiRoundEnd');
    return (r?['deleted'] as num?)?.toInt() ?? 0;
  } catch (_) {
    /* 通道不通 (服务没开 / 老版本 App): 不管它, 下次启动清扫会处理 */
    return 0;
  }
}
