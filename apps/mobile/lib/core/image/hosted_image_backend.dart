/// hosted_image_backend.dart — 托管出图 (不用自己的 Key) 的契约.
///
/// 有它且 [HostedImageBackend.available] 时, [ImageDirectService] 先走它:
/// 受理前就拒掉的 4xx (肯定没扣费) 允许原路重试一次、再退到用户自己的 Key;
/// 5xx / 超时 / 已提交任务的失败一律如实报错, 不再扣第二次钱 (chat:C4-02)。
/// 没有它时才直接走自己的 Key。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';
import 'image_direct_models.dart';

abstract class HostedImageBackend {
  /// 现在能不能用 (通常 = 已登录)。
  bool get available;

  /// 发一次出图请求, 原样交回响应 —— 落盘与错误文案由调用方统一处理,
  /// 两条路径 (托管 / 自己的 Key) 的产物因此长得一样。
  Future<({int status, String body, String model})> request(
    ImageDirectRequest req,
  );

  /// 按任务号接着等一个已提交的出图任务 (App 被杀 / 切后台后重开)。
  /// 返回跟 [request] 同形的结果; 任务已过期 (网关只留 30 分钟) 回 404。
  Future<({int status, String body})> resumeJob(String jobId);
}

final hostedImageBackendProvider = Provider<HostedImageBackend?>(
  (ref) => ref.watch(editionProvider).hostedImages(ref),
);
