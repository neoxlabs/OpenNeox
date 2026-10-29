library;

import 'dart:async';
import 'dart:io';

import '../network/json_rpc.dart';
import 'package:neox_app/core/i18n/tr.dart';

/* fallback / action 可空: 默认文案要走 tr() 按界面语言取, 而参数默认值必须是编译期常量 */
/// 有没有账号体系 —— 启动时由发行版设置 (bootstrap)。默认按开源版 (没有)。
bool friendlyErrorHasAccounts = false;

String friendlyError(Object error, {String? fallback}) {
  fallback ??= tr('操作暂时失败，请稍后重试');
  if (error is RpcError) return _friendlyText(error.message, fallback);
  if (error is TimeoutException) return tr('网络超时，请检查网络后重试');
  if (error is SocketException) return tr('网络连接异常，请检查网络后重试');

  final text = _friendlyText(error.toString(), fallback);
  return text.isEmpty ? fallback : text;
}

/// 原始错误的短文本 (去掉异常类名前缀, 压成一行, 最多 140 字) —— 放在失败卡的小字里。
/// 友好文案只说「是哪一类」, 真出问题时要靠这一行知道具体是哪一步 (2026-09-30: 一次
/// 「任务已不可用」查不出是哪个 not found, 手机没连 adb, 电脑日志里也没有)。
String errorDetail(Object error) {
  final s = _stripPrefixes(error.toString()).replaceAll(RegExp(r'\s+'), ' ').trim();
  return s.length > 140 ? '${s.substring(0, 140)}…' : s;
}

String friendlyActionError(Object error, {String? action}) {
  action ??= tr('操作');
  return friendlyError(error, fallback: tr('$action暂时失败，请稍后重试'));
}

String _friendlyText(String raw, String fallback) {
  var text = _stripPrefixes(raw).trim();
  if (text.isEmpty) return fallback;

  final lower = text.toLowerCase();
  if (lower.contains('agent_busy') ||
      lower.contains('still working') ||
      lower.contains('too many requests') ||
      lower.contains('rate limit') ||
      lower.contains('429')) {
    return tr('Agent 正在处理上一条消息，请稍等');
  }
  if (lower.contains('timeout') || lower.contains('timed out')) {
    return tr('网络超时，请检查网络后重试');
  }
  if (lower.contains('socket') ||
      lower.contains('connection refused') ||
      lower.contains('failed host lookup') ||
      lower.contains('websocket') ||
      lower.contains('handshake') ||
      lower.contains('network') ||
      lower.contains('connection closed')) {
    return tr('连接暂时不可用，请稍后重试');
  }
  if (lower.contains('unauthorized') ||
      lower.contains('invalid token') ||
      lower.contains('token expired') ||
      lower.contains('login required') ||
      lower.contains('401')) {
    /* 没有账号体系的构建 (开源版): 401 只可能是用户自己服务商的 Key 不对, 不是"登录过期" */
    return friendlyErrorHasAccounts ? tr('登录已过期，请重新登录') : tr('API Key 被拒绝，请到设置里检查服务商的 Key');
  }
  if (lower.contains('forbidden') ||
      lower.contains('permission denied') ||
      lower.contains('403')) {
    return tr('当前账户暂无权限');
  }
  /* 放在 not found 之前: 「Method not found」原来被下面那条吃掉, 说成任务没了 */
  if (lower.contains('unknown control action') ||
      lower.contains('method not supported') ||
      lower.contains('method not found') ||
      lower.contains('not implemented')) {
    return tr('当前操作暂时不支持，请更新后重试');
  }
  /* 附件传输出错 (上传没封口 / 分片乱序 / 太大) —— 会话本身好好的, 重发就行 */
  if (lower.contains('upload') ||
      lower.contains('attachment') ||
      lower.contains('chunk')) {
    return lower.contains('too large') ? tr('附件太大，发不过去') : tr('附件没传上去，请重发');
  }
  /* 只有**会话**找不到才是「任务已不可用」。原来任何带 not found / 404 的错误
   * (附件、文件、模型…) 都被说成这句, 连着电脑、会话好好的也让人去新建 (2026-09-30 真机) */
  if (lower.contains('session not found') ||
      lower.contains('session_not_found') ||
      RegExp(r'session\s+\S+\s+not found').hasMatch(lower)) {
    return tr('任务已不可用，请新建');
  }
  if (lower.contains('no warm pod') ||
      lower.contains('service unavailable') ||
      lower.contains('unavailable') ||
      lower.contains('503')) {
    return tr('服务暂时不可用，请稍后重试');
  }
  if (lower.contains('message text or attachment required')) {
    return tr('请输入内容后再发送');
  }
  if (lower.contains('没有返回任务 id') || lower.contains('没有返回任务ID'.toLowerCase())) {
    return tr('电脑暂时没有返回任务信息，请重试');
  }

  text = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final hasCjk = RegExp(r'[\u4e00-\u9fff]').hasMatch(text);
  final looksTechnical = RegExp(
    r'(stack trace|rpcerror|jsonrpc|http|ws://|wss://|exception|stateerror|format|traceback)',
    caseSensitive: false,
  ).hasMatch(text);
  if (hasCjk && !looksTechnical) {
    /* 中文原文直接透出来的那些 (服务端/底层抛的) 在英文界面下能翻就翻, 对照表里没有的原样 */
    text = tr(text);
    return text.length > 80 ? '${text.substring(0, 77)}...' : text;
  }
  return fallback;
}

String _stripPrefixes(String value) {
  var text = value.trim();
  final rpc = RegExp(r'^RpcError\((-?\d+),\s*(.*?)\)$').firstMatch(text);
  if (rpc != null) return rpc.group(2)?.trim() ?? '';

  var changed = true;
  while (changed) {
    changed = false;
    final stripped = text
        .replaceFirst(
          RegExp(r'^(Exception|StateError|Bad state|FormatException):\s*'),
          '',
        )
        .replaceFirst(
          RegExp(
            r'^(TimeoutException|SocketException|HandshakeException|WebSocketException|ClientException):\s*',
          ),
          '',
        );
    if (stripped != text) {
      text = stripped.trim();
      changed = true;
    }
  }
  return text;
}
