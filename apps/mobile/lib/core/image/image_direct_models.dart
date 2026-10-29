/// image_direct_models.dart — 手机本机直连生图的请求/结果契约.
///
/// 对齐桌面 ImageDirectResult 心智, 但不走 Electron IPC —
/// 手机自己打 NeoxCloud /n1/images/* 或 BYOK OpenAI 兼容 /images.
library;
import 'image_request_control.dart';

class ImageDirectRequest {
  const ImageDirectRequest({
    required this.prompt,
    this.model,
    this.n = 1,
    this.size = '1024x1024',
    this.quality = 'high',
    this.referenceImages = const [],
    this.onJobSubmitted,
    this.control,
  });

  /// 托管出图提交成功、拿到网关任务号时回调 —— 调用方落库, 进程没了也能按号取回结果。
  final void Function(String jobId)? onJobSubmitted;

  /// 取消开关 (chat:C4-05) — 云端轮询也认它, 取消后不再继续打网关。
  final ImageRequestControl? control;

  final String prompt;
  final String? model;
  final int n;
  final String size;
  final String quality;

  /// data URL (data:image/...;base64,...) 参考图 — 有则走 edits / 图生图.
  final List<String> referenceImages;

  bool get isImg2Img => referenceImages.isNotEmpty;
}

class ImageDirectResult {
  const ImageDirectResult({
    required this.ok,
    this.paths = const [],
    this.count = 0,
    this.mode,
    this.model,
    this.error,
    this.latencyMs,
  });

  final bool ok;
  final List<String> paths;
  final int count;

  /// 'neoxcloud' | 'byok'
  final String? mode;
  final String? model;
  final String? error;
  final int? latencyMs;

  factory ImageDirectResult.fail(String error) => ImageDirectResult(
        ok: false,
        error: error,
      );
}
