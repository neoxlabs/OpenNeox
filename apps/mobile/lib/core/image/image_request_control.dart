/// image_request_control.dart — 出图请求的统一超时与取消 (chat:C4-05).
///
/// 以前只有 BYOK 分支挂了 120 秒超时, 云端完全靠 `hosted.request` 自己的行为;
/// 两条路都没有取消 —— 弱网下用户只能看着骨架无限转圈, 想重发也发不出去。
///
/// 现在两条路共用同一份控制:
///   · [ImageRequestControl] 由调用方持有 (图片页 / 对话工具), 取消时立刻返回;
///     云端轮询看到它也会停下来, 不再继续打网关;
///   · [imageSlowThreshold] 是「慢」的分界 —— 超过它界面就明说网络慢并把取消按钮
///     摆出来, 用户不必猜是不是卡死了;
///   · [imageSubmitTimeout] / [imageByokTimeout] / [imageRequestTimeout] 是三个
///     硬上限, 全部只在这一处定义, 两条出图路径共用。
///
/// **为什么不把提交上限直接压到 30 秒**: 老网关不认 `Prefer: respond-async`,
/// 会同步出完图再回 200 (一张常要 40~60 秒); BYOK 更是同步接口, 厂商一次就要
/// 30~60 秒。把它们砍到 30 秒等于把本来能出的图判成失败 —— 钱照扣、图没有。
/// 所以 30 秒只用来「告诉用户慢」, 真正的硬上限留在够用的位置。
library;

import 'dart:async';

/// 超过这么久还没出结果 = 网络慢: 界面要说清楚, 并把取消摆出来.
const imageSlowThreshold = Duration(seconds: 30);

/// 「请求发出去 → 网关受理」的上限 (弱网下这一段最容易无限等).
const imageSubmitTimeout = Duration(seconds: 60);

/// BYOK 同步出图的上限 (厂商一次就要 30~60 秒, 留足余量).
const imageByokTimeout = Duration(seconds: 120);

/// 整次出图的总上限 —— 网关任务预算 10 分钟 + 2 分钟收尾, 跟
/// `neox_cloud_image_backend._waitForJob` 的 deadline 同一个数.
const imageRequestTimeout = Duration(minutes: 12);

/// 用户取消时给的话 —— 已经提交的任务在服务器上照跑, 钱不退, 所以不能只说「已取消」.
const imageCancelledMessage = '已取消等待。图可能仍在生成，稍后可在「我画过的」里找回';

/// 超时给的话.
const imageTimeoutMessage = '等太久了, 请检查网络后重试';

/// 一次出图请求的取消开关.
///
/// 取消**不会**把钱要回来 (已经提交的任务照跑, 结果网关留 30 分钟);
/// 它只是让这一侧立刻停下, 不再转圈、不再继续轮询。
class ImageRequestControl {
  final Completer<void> _cancelled = Completer<void>();

  bool get isCancelled => _cancelled.isCompleted;

  /// 取消时完成的 future —— 调用方 race 用.
  Future<void> get whenCancelled => _cancelled.future;

  void cancel() {
    if (!_cancelled.isCompleted) _cancelled.complete();
  }
}

/// 用户点了取消.
class ImageRequestCancelled implements Exception {
  const ImageRequestCancelled();
  @override
  String toString() => imageCancelledMessage;
}

/// 出图超过 [deadline] 还没回来.
class ImageRequestTimedOut implements Exception {
  const ImageRequestTimedOut();
  @override
  String toString() => imageTimeoutMessage;
}

/// 把 [work] 跟「取消」和 [deadline] 赛跑; 取消优先于超时 (用户主动点的就说取消).
///
/// 输掉的那条 future 之后自己结束时异常就地消化, 不冒成未捕获异常。
Future<T> guardImageRequest<T>(
  Future<T> work, {
  required ImageRequestControl? control,
  required Duration deadline,
}) async {
  final racers = <Future<T>>[
    work,
    Future<T>.delayed(deadline, () => throw const ImageRequestTimedOut()),
    if (control != null)
      control.whenCancelled.then<T>((_) => throw const ImageRequestCancelled()),
  ];
  try {
    return await Future.any(racers);
  } finally {
    /* 已经有人赢了 —— 剩下那条的异常在这里吃掉 */
    work.ignore();
  }
}
