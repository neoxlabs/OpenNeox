/// error_pill.dart — 输入框上方那颗错误药丸的「唯一真相」.
///
/// 明康 2026-08-12 提的:「对于错误等异常, 我们输入框上方可以有一个药丸一样的
/// 提示, 显示当前有错误, 是服务器问题还是什么问题」。
///
/// 为什么需要它:
///   今天这一整轮暴露的问题几乎全是同一个形状 —— **出了错, 但用户看不见, 或者
///   看见了也不知道该干什么**:
///     · 模型被停用 → 只弹一个 4 秒 toast, 还被别的 toast 抢占
///     · 登录失效 → 界面只说"电脑连不上", 真因藏在日志里
///     · 生图失败 → 永远转圈
///     · 会员拉不到 → 显示成"Free", 把"我不知道"说成"你没有"
///   而且这些信息散落在顶部三条横幅 + timeline 深处的错误卡里, 用户的视线却
///   一直在**输入框**上 —— 他下一步动作从那里发起。
///
/// 所以这颗药丸的职责很窄, 不要往上堆功能:
///   1. 一眼看出**现在能不能用**;
///   2. 一眼看出**是谁的问题** (服务器 / 网络 / 登录 / 额度 / 模型);
///   3. 给**一个**最有用的动作, 没有就不给 —— 给一个点了没用的按钮比不给更糟。
library;
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/feature_flags.dart';

/// 出问题的是哪一层 —— 决定文案口径和该给什么动作.
enum ErrorKind {
  /// 服务端自己的错 (5xx / 网关挂了) —— 用户做什么都没用, 只能等
  server,

  /// 网络/连不上 —— 用户可以换个网、检查 Wi-Fi
  network,

  /// 登录态坏了 —— 唯一有用的动作是重新登录
  auth,

  /// 额度/套餐用尽 —— 升级或等窗口重置
  quota,

  /// 模型不可用 (停用/无权限) —— 换个模型
  model,

  /// 电脑没连上 —— 去连接
  desktop,
}

extension ErrorKindX on ErrorKind {
  /// 药丸上那句话 —— 说**是什么问题**, 不说技术细节.
  String get label {
    switch (this) {
      case ErrorKind.server:
        return tr('服务器出问题了');
      case ErrorKind.network:
        return tr('网络连不上');
      case ErrorKind.auth:
        return tr('登录已失效');
      case ErrorKind.quota:
        return tr('额度已用尽');
      case ErrorKind.model:
        return tr('这个模型用不了');
      case ErrorKind.desktop:
        return tr('电脑没连上');
    }
  }

  /// 那**一个**动作的名字; null = 用户做什么都没用, 别给假按钮.
  String? get actionLabel {
    switch (this) {
      case ErrorKind.server:
        return null; /* 服务端挂了, 给"重试"是骗人 —— 只能等 */
      case ErrorKind.network:
        return tr('重试');
      case ErrorKind.auth:
        return tr('重新登录');
      case ErrorKind.quota:
        /* 跳的是会员页; iOS 上那一页只有额度, 没有套餐可看 (feature_flags.dart) */
        return purchaseUiAllowed ? tr('看套餐') : tr('看额度');
      case ErrorKind.model:
        return tr('换模型');
      case ErrorKind.desktop:
        return tr('去连接');
    }
  }

  /// 是不是"用户此刻根本发不出消息"的硬故障 —— 药丸用红底, 否则用黄底.
  bool get blocking {
    switch (this) {
      case ErrorKind.auth:
      case ErrorKind.quota:
      case ErrorKind.model:
        return true;
      case ErrorKind.server:
      case ErrorKind.network:
      case ErrorKind.desktop:
        return false;
    }
  }
}

/// 从一条错误里判断它属于哪一层.
///
/// 判据只认**服务端给的状态码和错误码**, 不猜自由文本 —— 文案会变, 状态码不会。
/// 认不出来一律当 server: 用户此刻确实做不了什么, 让他去查网络/改设置更浪费时间。
ErrorKind classifyError({int? statusCode, String? code, String? message}) {
  final c = (code ?? '').toUpperCase();
  final m = (message ?? '');

  /* 1. 明确的错误码优先 */
  if (c.startsWith('AUTH_') ||
      c == 'SESSION_EXPIRED' ||
      c == 'NOT_AUTHENTICATED') {
    return ErrorKind.auth;
  }
  if (c.startsWith('NETWORK_')) return ErrorKind.network;

  /* 2. 状态码 */
  switch (statusCode) {
    case 401:
      return ErrorKind.auth;
    case 402:
      return ErrorKind.quota;
    case 403:
      /* 403 有两种: 套餐不含这个模型 / 没权限。都归"模型用不了"更可操作 */
      return ErrorKind.model;
    case 429:
      return ErrorKind.quota;
  }
  if (statusCode != null && statusCode >= 500) return ErrorKind.server;

  /* 3. 兜底看几个**服务端固定文案**的关键词.
   *   只认这几条是因为它们是网关直接返回的原话 (见 model_gateway_client
   *   _gatewayError), 不是我们自己拼的 —— 别的一律不猜。 */
  /* 英文关键词对应的是 en_strings 里这几条的译文 —— 本地拼的文案在英文界面下已经翻译过了 */
  final lower = m.toLowerCase();
  if (m.contains('额度') || m.contains('用尽') || lower.contains('allowance')) {
    return ErrorKind.quota;
  }
  if (m.contains('模型') && (m.contains('停用') || m.contains('不可用'))) {
    return ErrorKind.model;
  }
  if ((m.contains('登录') && (m.contains('过期') || m.contains('失效'))) ||
      lower.contains('sign-in expired') ||
      lower.contains('sign-in has expired')) {
    return ErrorKind.auth;
  }
  if ((m.contains('电脑') && (m.contains('没连') || m.contains('连不上'))) ||
      lower.contains('computer not connected') ||
      lower.contains('not connected to a computer')) {
    return ErrorKind.desktop;
  }

  return ErrorKind.server;
}
