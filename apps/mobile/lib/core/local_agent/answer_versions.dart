/// answer_versions.dart — 「重新生成」保留旧答案 (chat:C1-06).
///
/// 现在的重新生成是「删掉旧回答再问一遍」, 新答案一出来旧的就没有了 ——
/// 用户想比较两种回答、或新回答更差想切回去, 都没有入口。
///
/// 这里不新增事件类型, 也不改协议: 把旧答案挂在上一条 user_message 的
/// payload 里 (`answer_versions`: 按时间顺序的旧答案文本)。当前显示的答案
/// 仍然是普通 `agent_text` 事件; **切换版本 = 把当前答案和选中的旧答案对调**,
/// 两边各写回一次 payload。时间线事件本身不变, 打开会话照常回放。
library;

import 'dart:convert';

import '../storage/database.dart';

/// user_message payload 里存旧答案的键.
const String kAnswerVersionsKey = 'answer_versions';

/// 从 payload 里取旧答案列表 (坏数据 / 老事件返回空列表).
List<String> answerVersionsFromPayload(String payload) {
  try {
    final parsed = jsonDecode(payload);
    if (parsed is! Map) return <String>[];
    final raw = parsed[kAnswerVersionsKey];
    if (raw is! List) return <String>[];
    return [
      for (final v in raw)
        if (v is String && v.trim().isNotEmpty) v.trim(),
    ];
  } catch (_) {
    return <String>[];
  }
}

String _textOf(SessionEvent ev) {
  try {
    final parsed = jsonDecode(ev.payload);
    if (parsed is Map) {
      for (final key in const ['text', 'content', 'message']) {
        final v = parsed[key];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
  } catch (_) {}
  return '';
}

SessionEvent? _lastUser(List<SessionEvent> events) {
  for (final ev in events.reversed) {
    if (ev.kind == 'user_message') return ev;
  }
  return null;
}

Future<void> _writeVersions(
  AppDatabase db,
  SessionEvent user,
  List<String> versions,
) async {
  Map<String, Object?> payload;
  try {
    final parsed = jsonDecode(user.payload);
    payload = parsed is Map ? Map<String, Object?>.from(parsed) : {};
  } catch (_) {
    payload = {};
  }
  if (versions.isEmpty) {
    payload.remove(kAnswerVersionsKey);
  } else {
    payload[kAnswerVersionsKey] = versions;
  }
  await db.sessionEventsDao
      .updatePayload(user.sessionId, user.seq, jsonEncode(payload));
}

/// 重新生成前: 把这一轮当前的答案记进上一条提问的旧版本列表.
///
/// 返回被记下的旧答案 (调用方在失败时把它放回时间线); 没有旧答案返回 null。
Future<String?> captureAnswerVersionForRegenerate(
  AppDatabase db,
  String sessionId,
) async {
  final events = await db.sessionEventsDao.getBySessionId(sessionId);
  final user = _lastUser(events);
  if (user == null) return null;
  String? current;
  for (final ev in events) {
    if (ev.seq <= user.seq || ev.kind != 'agent_text') continue;
    final text = _textOf(ev);
    if (text.isNotEmpty) current = text;
  }
  if (current == null) return null;
  final versions = answerVersionsFromPayload(user.payload);
  /* 同一段答案被连点两次重新生成时别记两遍 */
  if (!versions.contains(current)) versions.add(current);
  await _writeVersions(db, user, versions);
  return current;
}

/// 重新生成失败: 刚记进去的旧答案又作为当前答案放回了时间线, 从列表里撤掉.
Future<void> revertCapturedAnswerVersion(
  AppDatabase db,
  String sessionId,
  String? restored,
) async {
  if (restored == null || restored.isEmpty) return;
  final events = await db.sessionEventsDao.getBySessionId(sessionId);
  final user = _lastUser(events);
  if (user == null) return;
  final versions = answerVersionsFromPayload(user.payload);
  if (versions.isEmpty) return;
  if (versions.last == restored.trim()) {
    versions.removeLast();
    await _writeVersions(db, user, versions);
  }
}

/// 切换版本: [index] 是 `answer_versions` 里的下标.
///
/// 把选中的旧答案换成当前答案 (显示出来), 当前答案写回旧版本列表 ——
/// 再点一次同一个位置就切回原来那版。返回是否真的换了。
Future<bool> selectAnswerVersionOn(
  AppDatabase db,
  String sessionId,
  int anchorSeq,
  int index,
) async {
  final events = await db.sessionEventsDao.getBySessionId(sessionId);
  SessionEvent? user;
  SessionEvent? answer;
  for (final ev in events) {
    if (ev.seq == anchorSeq && ev.kind == 'user_message') user = ev;
    if (user != null && ev.seq > anchorSeq && ev.kind == 'agent_text') {
      if (_textOf(ev).isNotEmpty) answer = ev;
    }
  }
  if (user == null || answer == null) return false;
  final versions = answerVersionsFromPayload(user.payload);
  if (index < 0 || index >= versions.length) return false;
  final current = _textOf(answer);
  final selected = versions[index];
  if (current.isEmpty || selected == current) return false;

  versions[index] = current;
  await _writeVersions(db, user, versions);

  Map<String, Object?> payload;
  try {
    final parsed = jsonDecode(answer.payload);
    payload = parsed is Map ? Map<String, Object?>.from(parsed) : {};
  } catch (_) {
    payload = {};
  }
  payload['text'] = selected;
  await db.sessionEventsDao
      .updatePayload(sessionId, answer.seq, jsonEncode(payload));
  return true;
}
