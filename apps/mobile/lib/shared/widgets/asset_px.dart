/// 小图按显示尺寸解码 (2026-10-12)。
///
/// 用户: 「刚进来侧边栏展开就卡」。profile 抓帧: 抽屉第一次滑出时 UI 线程每帧都很轻,
/// 卡在 7 张图**现场**解码 + 上传 GPU (每张最多 6~7ms), 正压在滑出动画上 —— 真机 CPU 慢几倍就是一顿。
/// 而这些图都是按原图解码的: 字标 1518×260 只显示 14 高, 陶土图标 192~256 只显示 26, Pilot 头像 480×397 只显示 26。
///
/// 两件事: ① 解码到显示尺寸 (cacheWidth / cacheHeight), 解码和上传的量小一个数量级;
/// ② 启动后空闲时提前解好 (precacheDrawerImages), 第一次打开就直接从缓存画。
/// 预热用的 ResizeImage 参数必须跟 Image.asset 的 cacheWidth / cacheHeight 完全一致, 缓存才命中。
library;

import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';

/// 逻辑尺寸 → 物理像素 (按主屏的像素比)
int assetPx(double logical) {
  final views = ui.PlatformDispatcher.instance.views;
  final dpr = views.isEmpty ? 3.0 : views.first.devicePixelRatio;
  return (logical * dpr).ceil();
}

/// 跟 `Image.asset(path, cacheWidth: assetPx(w))` 同一个缓存键
ImageProvider assetAtWidth(String path, double logicalWidth) =>
    ResizeImage(AssetImage(path), width: assetPx(logicalWidth));

/// 跟 `Image.asset(path, cacheHeight: assetPx(h))` 同一个缓存键
ImageProvider assetAtHeight(String path, double logicalHeight) =>
    ResizeImage(AssetImage(path), height: assetPx(logicalHeight));
