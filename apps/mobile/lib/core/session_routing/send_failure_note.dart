/// send_failure_note.dart — 把"这条消息没发出去"写进 timeline, 而不是只弹个 toast.
///
/// 起因 (2026-08-11 模拟器实录): Life 模式发一句话, 屏幕上只剩自己那条气泡孤零零
/// 挂在底部 —— 没有思考中占位、没有回复、没有错误、没有重试。真实原因是服务端把
/// 当前模型下线了 (`该模型已停用, 请选择其他模型`), 但那句话只走了一个 4 秒 SnackBar,
/// 而且第一次发送时还被网络层的 toast ("已回到同 Wi-Fi 直连") 抢占, 于是用户在最
/// 常见的情况下**完全无从得知失败原因**。
///
/// 修法: 失败在 drift 落一条 `client_error` 事件 —— 持久、可滚回去看、带
/// 「重试」/「换个模型」两个按钮 (渲染见 message_row → ErrorEnvelopeCard)。
///
/// 为什么是新 kind 而不是复用 `agent_text` 的 ❌ 信封 (桌面 forwarder 那套):
///   - `agent_text` 会被 phone_local_agent._buildMessages 当成 assistant 历史喂回
///     模型, 错误信封会污染下一轮上下文;
///   - `_lastNonMetaEvent` 的"失败重发去重"要能看穿它, 找到底下那条 user_message。
/// 独立 kind 让这两件事都是显式的, 不靠字符串前缀猜。
library;

import 'dart:convert';

import 'package:drift/drift.dart' show Value;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/timeline/state/timeline_state.dart';
import '../network/stream_buffer_provider.dart';
import '../storage/database.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// timeline 事件 kind — 客户端侧发送失败.
const String kClientErrorKind = 'client_error';

/// 这条错误是不是"模型不可用"类 —— 决定错误卡要不要给「换个模型」按钮.
///
/// 服务端网关的文案不是结构化的 (`_gatewayError` 直接透传 `err.message`), 所以
/// 只能按关键词判。宁可多给一个按钮也不要让用户卡在死路上。
bool looksLikeModelUnavailable(String message) {
  final m = message.toLowerCase();
  return message.contains('模型') ||
      m.contains('model') ||
      m.contains('unavailable') ||
      m.contains('not found') ||
      m.contains('deprecated');
}

/// 往 [sessionId] 的 timeline 追加一条持久的发送失败记录.
///
/// [message] 直接用 friendlyError 出来的那句人话 (网关文案已经是中文)。
/// [suggestion] 给一句"接下来怎么办"; null 时按 message 自动挑一句。
///
/// 本身 try/catch 兜住: 写失败不能再抛, 否则会把调用方 catch 块里的原始错误
/// 顶掉, 用户连 toast 都看不到了。
Future<void> writeSendFailureNote(
  WidgetRef ref, {
  required String sessionId,
  required String message,
  String? suggestion,
}) async {
  final seq = await writeSendFailureNoteOn(
    ref.read(appDatabaseProvider),
    sessionId,
    message: message,
    suggestion: suggestion,
  );
  if (seq == null) return;
  ref.read(streamBufferProvider.notifier).updateLatestDriftSeq(sessionId, seq);
}

/// [writeSendFailureNote] 的 db 级核心 — 不碰 riverpod, 可单测.
///
/// 返回写入的 seq; 写失败返回 null (不抛: 调用方正在 catch 块里处理真正的
/// 那个错误, 这里再抛会把原错误顶掉, 用户连 toast 都看不到)。
Future<int?> writeSendFailureNoteOn(
  AppDatabase db,
  String sessionId, {
  required String message,
  String? suggestion,
}) async {
  try {
    final nextSeq = (await db.sessionEventsDao.getMaxSeq(sessionId) ?? 0) + 1;
    final now = DateTime.now().millisecondsSinceEpoch;
    final hint = suggestion ??
        (looksLikeModelUnavailable(message)
            ? tr('换一个模型再试；如果一直失败，去「我的模型 → 云端 Key」接入自己的 Key。')
            : tr('检查网络后点「重试」；也可以在 [+] 里换个运行位置。'));

    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(nextSeq),
        ts: Value(now),
        kind: const Value(kClientErrorKind),
        payload: Value(
          jsonEncode({
            'text': '❌ $message',
            'suggestion': hint,
            'model_unavailable': looksLikeModelUnavailable(message),
          }),
        ),
      ),
    );
    await db.sessionMirrorDao.updateLastSeq(sessionId, nextSeq, now);
    return nextSeq;
  } catch (_) {
    /* 落库失败就算了 — 调用方的 toast 仍然会弹, 不能因为记日志把原错误吃掉 */
    return null;
  }
}

/// 清掉 [sessionId] 末尾的失败记录 —— 重试/重发成功前先擦掉旧的那条.
///
/// 不清的话 timeline 会变成「失败卡 → 用户气泡 → 失败卡 → …」的堆叠, 而用户
/// 关心的只有最后一次的结果。只删末尾连续的那几条, 历史上更早的失败保留
/// (那是真实发生过的事, 属于会话记录)。
///
/// 删掉了就重建这条会话的 timeline 投影: 内存投影只跟着 drift 的新增走, 不认删除 ——
/// 只删库, 错误卡会一直挂在重试成功的答案上面 (2026-10-05 模拟器实测)。
/// 所以调用方要在 markAgentStarting **之前**调它, 否则「思考中」会随投影一起被重置。
Future<void> clearTrailingFailureNotes(WidgetRef ref, String sessionId) async {
  if (await clearTrailingFailureNotesOn(ref.read(appDatabaseProvider), sessionId)) {
    ref.invalidate(timelineStateProvider(sessionId));
  }
}

/// [clearTrailingFailureNotes] 的 db 级核心 — 不碰 riverpod, 可单测. 返回是否删了东西。
Future<bool> clearTrailingFailureNotesOn(
  AppDatabase db,
  String sessionId,
) async {
  try {
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    final doomed = <int>[];
    /* 往回扫到最近一条真内容 (用户消息 / 回复 / 工具) 为止; 中间夹着的状态类事件
     * (中断标记、会话元信息…) 跳过 —— 原来遇到非错误卡就停, 失败轮末尾多落一条中断标记,
     * 错误卡就清不掉, 重试成功后还挂在答案上面 (2026-10-05 模拟器实测)。 */
    const content = {'user_message', 'agent_text', 'agent_thinking', 'tool_call', 'tool_result'};
    for (final ev in events.reversed) {
      if (content.contains(ev.kind)) break;
      if (ev.kind == kClientErrorKind) doomed.add(ev.seq);
    }
    if (doomed.isEmpty) return false;
    await db.sessionEventsDao.deleteSeqs(sessionId, doomed);
    return true;
  } catch (_) {
    /* 清不掉就多显一条, 不影响发送 */
    return false;
  }
}
