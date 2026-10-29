/// message_row.dart — drift event → 具体 widget 的派发器 + TimelineItem 模型 +
/// coalesce 算法.
///
/// coalesce 规则 (跟 Desktop mapTimeline 对齐):
///   - tool_call 紧随 tool_result → 配对成 toolPair 一卡
///   - 同 turn 同 file 的多次 edit_file → 显示首条 + coalescedCount 角标
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import '../../../core/session_routing/send_failure_note.dart'
    show kClientErrorKind;
import '../../../core/storage/database.dart';
import '../models/payload_utils.dart';
import '../models/system_injected_turn.dart';
import '../state/timeline_state.dart';
import 'agent_activity_rows.dart';
import 'artifact_card.dart';
import 'common.dart';
import 'direct_image_card.dart';
import 'remote_image.dart';
import 'error_view.dart';
import 'message_widgets.dart';
import 'system_turn_card.dart';
import 'tool_block.dart';
import 'tool_image_seen_card.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// TimelineItem — 时间轴上的一个单元.
///
/// 简单模型 (跟 Desktop 对齐):
///   - 普通 event (user_message / agent_text / agent_thinking / ...)
///   - tool pair: tool_call + 对应 tool_result (按 tool_call_id 锚定) 合成一行渲染
///   每个 tool 占一行, 严格按 tool_call 的 seq 排, 不分组、不批量。
class TimelineItem {
  TimelineItem._({this.event, this.pair});

  /// 普通单 event.
  factory TimelineItem.single(SessionEvent ev) => TimelineItem._(event: ev);

  /// tool 行 (call + result, 或仅 call 待结果 = running).
  factory TimelineItem.toolPair(ToolPair p) => TimelineItem._(pair: p);

  final SessionEvent? event;
  final ToolPair? pair;
}

/// tool_call event + 对应 tool_result event (可能尚未到达).
class ToolPair {
  ToolPair({required this.call, this.result});
  final SessionEvent call;
  final SessionEvent? result;
}

/// drift events → TimelineItem[]:
///   - tool_call ↔ tool_result 按 tool_call_id 配对成 ToolPair
///   - 每对(或孤儿 tool_call)单独成一行 (TimelineItem.toolPair) — 不分组
///   - 其它 event 单独成 TimelineItem.single
///   - 顺序由 TimelineState 保证; 此处不再把正文抬到 tool 前
List<TimelineItem> coalesceEvents(List<SessionEvent> events) {
  /* 第一遍: 配对. tool_result 反向找匹配的 unpaired tool_call. */
  final paired = <bool>[for (var i = 0; i < events.length; i++) false];
  final pairs = <int, int>{};

  for (var i = 0; i < events.length; i++) {
    if (events[i].kind != 'tool_result') continue;
    final resPayload = safeDecode(events[i].payload);
    final tcid = resPayload is Map
        ? resPayload['tool_call_id'] as String?
        : null;
    if (tcid == null || tcid.isEmpty) continue;
    for (var j = i - 1; j >= 0; j--) {
      if (events[j].kind != 'tool_call' || paired[j]) continue;
      final callTcid = _extractToolCallId(safeDecode(events[j].payload));
      if (callTcid == tcid) {
        pairs[j] = i;
        paired[j] = true;
        paired[i] = true;
        break;
      }
    }
  }

  /* 第二遍: 直接输出 — 每 tool_call 一行 (不 batch), 已配对 tool_result 跳过 */
  final raw = <TimelineItem>[];
  for (var i = 0; i < events.length; i++) {
    final ev = events[i];
    if (ev.kind == 'tool_call') {
      final resIdx = pairs[i];
      raw.add(
        TimelineItem.toolPair(
          ToolPair(call: ev, result: resIdx != null ? events[resIdx] : null),
        ),
      );
    } else if (ev.kind == 'tool_result' && paired[i]) {
      continue;
    } else {
      raw.add(TimelineItem.single(ev));
    }
  }
  return raw; /* 序靠 TimelineState; 不再「首正文提前」 */
}

String? _extractToolCallId(Object? callPayload) {
  if (callPayload is! Map) return null;
  final tc = callPayload['tool_calls'];
  if (tc is List && tc.isNotEmpty && tc.first is Map) {
    final id = (tc.first as Map)['id'];
    if (id is String && id.isNotEmpty) return id;
  }
  final tcid = callPayload['tool_call_id'];
  if (tcid is String && tcid.isNotEmpty) return tcid;
  return null;
}

/// 单个 TimelineEntry / TimelineItem 派发到对应 widget.
///
/// 新建议入口: `MessageRow.fromEntry(entry, onPickModel:..., onRetry:...)` — 走架构对齐后的
/// TimelineState 路径, item 是 null。旧 item 路径保留兼容 (仅 streaming/legacy 调用)。
class MessageRow extends StatelessWidget {
  const MessageRow({
    super.key,
    this.item,
    this.entry,
    this.onPickModel,
    this.onRetry,
    this.sessionId,
    this.showActions = false,
    this.onRegenerate,
    this.showDisclaimer = false,
    this.onSelectVersion,
    this.streamFrozen = false,
  });

  factory MessageRow.fromEntry(
    TimelineEntry entry, {
    Key? key,
    VoidCallback? onPickModel,
    VoidCallback? onRetry,
    String? sessionId,
    bool showActions = false,
    VoidCallback? onRegenerate,
    bool showDisclaimer = false,
    void Function(int anchorSeq, int index)? onSelectVersion,
    bool streamFrozen = false,
  }) => MessageRow(
        key: key,
        entry: entry,
        onPickModel: onPickModel,
        onRetry: onRetry,
        sessionId: sessionId,
        showActions: showActions,
        onRegenerate: onRegenerate,
        showDisclaimer: showDisclaimer,
        onSelectVersion: onSelectVersion,
        streamFrozen: streamFrozen,
      );

  /// 见 AgentMessage.onRegenerate / showDisclaimer (只有手机上的对话给).
  final VoidCallback? onRegenerate;
  final bool showDisclaimer;

  /// 切回旧版回答 (chat:C1-06) — 参数是 user_message 的 seq 和版本下标.
  final void Function(int anchorSeq, int index)? onSelectVersion;

  /// 用户已点停止 —— 正文打字机立即停帧 (chat:C9-08)。
  final bool streamFrozen;

  final TimelineItem? item;
  final TimelineEntry? entry;

  /// checkpoint 回滚等需要会话 id 的行操作用.
  final String? sessionId;

  /// agent 正文底下是否挂「复制 / 分享 / 举报」—— 只有对话最后那条挂.
  /// 见 AgentMessage.showActions 的说明 (2026-09-22).
  final bool showActions;

  /// 错误卡 "换一个模型" 按钮回调 — timeline_page 注入.
  final VoidCallback? onPickModel;

  /// 错误卡 "重试" — 对齐桌面 ErrorView, 走 control:retry.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    /* 新路径: TimelineEntry — 由 TimelineState 喂的统一模型 */
    if (entry != null) {
      return _buildFromEntry(entry!);
    }
    /* 旧路径兼容: TimelineItem (legacy) */
    if (item == null) return const SizedBox.shrink();
    if (item!.pair != null) {
      return ToolBlock(call: item!.pair!.call, result: item!.pair!.result);
    }
    final ev = item!.event!;
    final payload = safeDecode(ev.payload);

    switch (ev.kind) {
      case 'user_message':
        {
          /* 系统注入的 turn (<agent-completion> 等) 不是用户说的话 —— 折成小卡,
           * 不当 user 气泡铺开。详见 models/system_injected_turn.dart。 */
          final raw = stringFromPayload(payload, ev.payload);
          final sys = parseSystemInjectedTurn(raw);
          if (sys != null) return SystemTurnCard(turn: sys, sessionId: sessionId);
          if (isPlanNudge(raw)) return const SizedBox.shrink();
          final seen = parseToolImageInjection(raw);
          if (seen != null) return ToolImageSeenCard(count: seen.count, labels: seen.labels, images: seen.images, attachments: const []);
          return UserMessage(text: raw, ts: ev.ts);
        }
      case 'agent_text':
        {
          final raw = stringFromPayload(payload, ev.payload);
          if (raw.startsWith('❌')) {
            return ErrorEnvelopeCard(raw: raw, onPickModel: onPickModel, onRetry: onRetry);
          }
          final clean = stripStandaloneJson(raw);
          return AgentMessage(text: clean.isEmpty ? raw : clean, ts: ev.ts);
        }
      case 'agent_thinking':
        return ThinkingFold(
          text: _extractThinking(payload, ev.payload),
          ts: ev.ts,
        );
      case 'tool_call':
      case 'tool_result':
        return ToolBlock(
          call: ev,
          result: null,
          soloResult: ev.kind == 'tool_result',
        );
      case 'progress':
        return ProgressLine(text: stringFromPayload(payload, ev.payload));
      case 'session_done':
        return DividerLine(text: tr('任务结束'));
      case 'session_error':
        return ErrorLine(
          text: stringFromPayload(payload, ev.payload, fallback2: tr('错误')),
        );
      case kClientErrorKind:
        return _clientErrorCard(
          payload is Map ? Map<String, dynamic>.from(payload) : null,
          stringFromPayload(payload, ev.payload, fallback2: tr('发送失败')),
        );
      case 'direct_image':
        return DirectImageCard(
          entry: TimelineEntry(
            id: 'direct-${ev.seq}',
            kind: 'direct_image',
            sequence: ev.seq,
            timestamp: ev.ts,
            pending: payload is Map && payload['status'] == 'pending',
            args: payload is Map<String, dynamic>
                ? payload
                : (payload is Map
                    ? Map<String, dynamic>.from(payload)
                    : null),
            toolSuccess: payload is Map && payload['status'] != 'error',
            output: payload is Map ? payload['error'] as String? : null,
          ),
        );
      case 'session_meta':
        return const SizedBox.shrink();
      default:
        /* 不认识的事件**不渲染**, 而不是把事件名打给用户看.
         *
         * 2026-09-04 实拍: 一条 `agent_turn_done` 在对话里渲染成一行居中粗体的
         * 「agent_turn_done:」—— 内部事件名直接泄漏到界面上。这类兜底把"我们
         * 没处理这个事件"变成了用户要读的一句乱码, 比什么都不显示糟得多。
         *
         * 想排查未知事件走 debugPrint, 不走界面。 */
        assert(() {
          debugPrint('[timeline] 未处理的事件 kind=${ev.kind}');
          return true;
        }());
        return const SizedBox.shrink();
    }
  }

  Widget _buildFromEntry(TimelineEntry e) {
    switch (e.kind) {
      case 'user_message':
        {
          final raw = e.text ?? '';
          final sys = parseSystemInjectedTurn(raw);
          if (sys != null) return SystemTurnCard(turn: sys, sessionId: sessionId);
          /* 工具截图回灌 (「[系统注入] 以下 N 张图片是工具 X 的返回内容」) —— 不是用户说的话, 靠左摆图 */
          if (isPlanNudge(raw)) return const SizedBox.shrink();
          final seen = parseToolImageInjection(raw);
          if (seen != null) {
            return ToolImageSeenCard(count: seen.count, labels: seen.labels, images: seen.images, attachments: e.attachments ?? const []);
          }
          return UserMessage(text: raw, ts: e.timestamp, attachments: e.attachments ?? const []);
        }
      case 'agent_text':
        {
          final raw = e.text ?? '';
          if (raw.startsWith('❌')) {
            return ErrorEnvelopeCard(raw: raw, onPickModel: onPickModel, onRetry: onRetry);
          }
          final clean = stripStandaloneJson(raw);
          return AgentMessage(
            text: clean.isEmpty ? raw : clean,
            ts: e.timestamp,
            streaming: e.streaming, /* 2026-06-24: 透传 streaming 让末尾闪 cursor */
            streamFrozen: streamFrozen,
            showActions: showActions,
            onRegenerate: onRegenerate,
            showDisclaimer: showDisclaimer,
            versions: e.answerVersions,
            onSelectVersion: onSelectVersion == null
                ? null
                : (index) => onSelectVersion!(e.answerAnchorSeq ?? 0, index),
          );
        }
      case 'agent_thinking':
        {
          final body = (e.thinking ?? e.text ?? '').trim();
          /* 空且已结束的 thinking 不渲染 — 跟桌面收口一致, 防 ghost 行 */
          if (body.isEmpty && !e.streaming) return const SizedBox.shrink();
          return ThinkingFold(
            text: body.isEmpty ? '…' : body,
            ts: e.timestamp,
            streaming: e.streaming,
            durationMs: e.thinkingDurationMs,
          );
        }
      case 'tool':
        /* 工具卡下面挂它做出来的文件 —— 用户点一下就能保存/分享.
         * 挂在工具下面而不是单独一行: "这个文件是哪一步做出来的" 本身就是信息,
         * 而且 agent 改一版导出一次时, 卡片跟着对应那次导出走。 */
        /* 工具输出里的图 (截图 / 生成的图 / 看过的图) 同理, 默认就露出来, 不藏在折叠的输出里 */
        final toolImages = neoxImageNamesIn(e.output);
        final hasArtifacts = e.artifacts != null && e.artifacts!.isNotEmpty;
        if (hasArtifacts || toolImages.isNotEmpty) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ToolBlock.fromEntry(e),
              if (toolImages.isNotEmpty) NeoxImageStrip(names: toolImages),
              if (hasArtifacts) ArtifactStrip(entry: e),
            ],
          );
        }
        return ToolBlock.fromEntry(e);
      case 'direct_image':
        return DirectImageCard(entry: e);
      case 'subagent':
        return SubagentBlock(entry: e, sessionId: sessionId);
      case 'compaction':
        return CompactionDivider(entry: e);
      case 'checkpoint':
        return CheckpointDivider(entry: e, sessionId: sessionId ?? '');
      case 'progress':
        return ProgressLine(text: e.text ?? '');
      case 'session_done':
        return DividerLine(text: tr('任务结束'));
      case 'session_error':
        return ErrorLine(text: e.text ?? tr('错误'));
      case kClientErrorKind:
        return _clientErrorCard(e.args, e.text ?? tr('发送失败'));
      case 'session_meta':
        return const SizedBox.shrink();
      default:
        /* 同上: 未知 entry 不渲染, 别把 kind 打给用户看 */
        assert(() {
          debugPrint('[timeline] 未处理的 entry kind=${e.kind}');
          return true;
        }());
        return const SizedBox.shrink();
    }
  }

  /// 客户端发送失败卡 — 按钮无条件给足, 不走关键词嗅探.
  ///
  /// 这条记录是我们自己写的 (send_failure_note.dart), 语义确定: 消息没送出去。
  /// 所以「重试」总是有意义; 「换个模型」由写入时判定好的 model_unavailable 决定。
  Widget _clientErrorCard(Map<String, dynamic>? args, String fallbackText) {
    final text = (args?['text'] as String?)?.trim();
    final suggestion = (args?['suggestion'] as String?)?.trim();
    final modelUnavailable = args?['model_unavailable'] == true;
    final body = (text != null && text.isNotEmpty) ? text : fallbackText;
    return ErrorEnvelopeCard(
      raw: suggestion == null || suggestion.isEmpty
          ? body
          : '$body\n\n💡 Suggestion: $suggestion',
      onPickModel: onPickModel,
      onRetry: onRetry,
      alwaysOfferRetry: true,
      alwaysOfferModelSwitch: modelUnavailable,
      /* chat:C1-07: 没有换一条消息 —— 原话还在, 点一下把同一句话再发一次 */
      retryLabel: tr('重发'),
    );
  }

  /// agent_thinking payload 优先从 `thinking` 字段取 (forwarder 写法),
  /// 没有则 fallback content 或原 raw string.
  String _extractThinking(Object? payload, String raw) {
    if (payload is Map<String, dynamic>) {
      final t = payload['thinking'];
      if (t is String && t.isNotEmpty) return t;
      final c = payload['content'];
      if (c is String && c.isNotEmpty) return c;
    }
    /* 兜底 — drift 老格式 / payload 不是 Map */
    return raw.isEmpty ? tr('(空 thinking)') : _safeJsonShort(raw);
  }

  String _safeJsonShort(String s) {
    try {
      final decoded = jsonDecode(s);
      if (decoded is Map && decoded['thinking'] is String) {
        return decoded['thinking'] as String;
      }
    } catch (_) {}
    return s;
  }
}
