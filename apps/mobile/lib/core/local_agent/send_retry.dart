/// send_retry.dart — 发送失败后一键重发 (chat:C1-07).
///
/// 失败卡上的「重发」走 `control:retry`: 取这个会话最后一条用户消息的原文
/// 再发一次, 不新建气泡 (phone_local_agent 的发送去重会复用那条)。
/// 这里只负责从事件里找出该重发的那句话 —— 跳过 session_meta 和失败卡,
/// 纯函数式, 不碰网络, 便于回归。
library;

import 'dart:convert';

import '../storage/database.dart';
import '../session_routing/send_failure_note.dart' show kClientErrorKind;

String _textOf(String payload) {
  try {
    final parsed = jsonDecode(payload);
    if (parsed is Map) {
      for (final key in const ['text', 'content']) {
        final v = parsed[key];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
  } catch (_) {}
  return '';
}

/// 该重发的原话; 没有可重发的用户消息时返回 null.
///
/// 失败卡 (`client_error`) 和 `session_meta` 不算"最后一条" —— 它们正是
/// 失败之后才写进去的, 挡住它们才能看到底下那条 user_message。
Future<String?> retryTextFor(AppDatabase db, String sessionId) async {
  final events = await db.sessionEventsDao.getBySessionId(sessionId);
  for (final ev in events.reversed) {
    if (ev.kind == 'session_meta' || ev.kind == kClientErrorKind) continue;
    if (ev.kind != 'user_message') return null;
    final text = _textOf(ev.payload);
    return text.isEmpty ? null : text;
  }
  return null;
}
