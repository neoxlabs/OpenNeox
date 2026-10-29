/// pilot_patrol_filter.dart — Pilot 巡检在对话里怎么显示 (2026-10-01, 跟桌面 pilotPatrolFilter.ts 同一条规矩).
///
/// 巡检 = 容器定时往 Pilot 会话里投一条 `<pilot-patrol>`, Pilot 按分工看一眼:
///   · 没事 → 它只回 [quiet]: 这一整轮 (触发 + 中间翻邮箱日历的步骤 + [quiet]) 都不显示
///   · 有事 → 只藏触发那条 (你没说过这句话), 它的回复和步骤照常显示
library;

import '../timeline/state/timeline_state.dart';

const kPilotPatrolTag = '<pilot-patrol';
/// 手机来了通知 / 短信 / 未接来电, 容器叫醒它看一眼 —— 跟巡检同一个显示规矩
const kPilotSignalTag = '<phone-signal';
/// 电脑离线期间手机上的它办过的事, 电脑回来时交回主脑 (pilot_local.dart)
const kPilotOfflineTag = '<phone-offline';
const kPilotQuiet = '[quiet]';

bool _isPatrolTrigger(TimelineEntry e) {
  if (e.kind != 'user_message') return false;
  final t = (e.text ?? '').trimLeft();
  return t.startsWith(kPilotPatrolTag) || t.startsWith(kPilotSignalTag) || t.startsWith(kPilotOfflineTag);
}

/// 没有巡检的会话原样返回 (同一个 List)
List<TimelineEntry> dropPilotPatrolNoise(List<TimelineEntry> entries) {
  if (!entries.any(_isPatrolTrigger)) return entries;
  final out = <TimelineEntry>[];
  var i = 0;
  while (i < entries.length) {
    final e = entries[i];
    if (!_isPatrolTrigger(e)) {
      out.add(e);
      i += 1;
      continue;
    }
    /* 这一轮 = 触发之后到下一条用户消息之前 */
    var end = i + 1;
    while (end < entries.length && entries[end].kind != 'user_message') {
      end += 1;
    }
    final turn = entries.sublist(i + 1, end);
    final replies = turn
        .where((r) => r.kind == 'agent_text')
        .map((r) => (r.text ?? '').trim())
        .where((t) => t.isNotEmpty)
        .toList();
    final quiet = replies.isEmpty || replies.every((r) => r == kPilotQuiet || r.endsWith(kPilotQuiet));
    /* 还在跑 (没回复) 也先藏着: 多半是 [quiet], 真有事回复一到就会整轮出现 */
    if (!quiet) {
      out.addAll(turn.where((r) => !(r.kind == 'agent_text' && (r.text ?? '').trim() == kPilotQuiet)));
    }
    i = end;
  }
  return out;
}
