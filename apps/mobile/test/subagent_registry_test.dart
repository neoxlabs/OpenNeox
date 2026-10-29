/// subagent 投影 + ephemeral 子会话 timeline 的回归测试.
///
/// 覆盖的真实行为:
///   - subagent_started/progress/done 三个事件 → SubagentRef 列表的状态演化
///   - 跑完后 agentId 仍在列表里 (主 timeline 那条痕迹要能点开回看)
///   - duration_ms 只在桌面给了真值时才有 (手机不许自己相减造假数)
///   - ephemeral 控制器: 不落 drift、可重复灌同一批事件而不重复渲染
library;

import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/subagent_registry.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/subagent_page.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;
  late AppDatabase db;
  var sessionSeq = 0;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    container = ProviderContainer(
      overrides: [appDatabaseProvider.overrideWithValue(db)],
    );
  });

  tearDown(() async {
    container.dispose();
    await db.close();
  });

  String newSession() => 'sess${++sessionSeq}';

  void push(String sid, String kind, Map<String, dynamic> payload) {
    container
        .read(timelineStateProvider(sid).notifier)
        .applyStreaming(kind, payload);
  }

  /// flush 有 80ms 帧节流 — 断言前等过一个窗口.
  Future<List<SubagentRef>> agents(String sid) async {
    await Future<void>.delayed(const Duration(milliseconds: 120));
    return container.read(subagentsProvider(sid));
  }

  test('subagent 生命周期 → SubagentRef 状态演化', () async {
    final sid = newSession();
    push(sid, 'subagent_started', {
      'agent_id': 'agent-1',
      'task': '分析 backend 结构',
      'role_name': 'Explore',
      'is_background': false,
      'is_agent_tool': true,
    });

    var list = await agents(sid);
    expect(list, hasLength(1));
    expect(list.first.agentId, 'agent-1');
    expect(list.first.displayName, '分析 backend 结构');
    expect(list.first.role, 'Explore');
    expect(list.first.running, isTrue);
    expect(list.first.durationMs, isNull);
    expect(container.read(runningSubagentsProvider(sid)), hasLength(1));

    push(sid, 'subagent_progress', {
      'agent_id': 'agent-1',
      'tool_name': 'grep',
    });
    list = await agents(sid);
    expect(list.first.live, 'grep');
    expect(list.first.running, isTrue);

    push(sid, 'subagent_done', {
      'agent_id': 'agent-1',
      'success': true,
      'summary': '找到 3 个入口',
      'duration_ms': 27200,
    });
    list = await agents(sid);
    /* 跑完不删除 — 主 timeline 那条痕迹要能点开回看 */
    expect(list, hasLength(1));
    expect(list.first.running, isFalse);
    expect(list.first.success, isTrue);
    expect(list.first.summary, '找到 3 个入口');
    expect(list.first.live, isNull, reason: '跑完必须清掉 live 工具名');
    expect(list.first.durationMs, 27200);
    expect(list.first.elapsed(0), const Duration(milliseconds: 27200));
    /* 状态条: 没有在跑的 agent 就该整条消失 */
    expect(container.read(runningSubagentsProvider(sid)), isEmpty);
  });

  group('Explore worker vs 真子 agent (2026-07-29 明康指出的语义差)', () {
    test('is_agent_tool=false 的 Explore 不进状态条/菜单, 也不该点开会话', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {
        'agent_id': 'Explorer-3',
        'task': '并行探索 ×2',
        'role_name': 'Explore',
        'is_agent_tool': false,
      });
      push(sid, 'subagent_started', {
        'agent_id': 'real-child-session-id',
        'task': '分析 backend 结构',
        'role_name': 'general-purpose',
        'is_agent_tool': true,
      });
      final all = await agents(sid);
      expect(all, hasLength(2), reason: '主 timeline 两条痕迹都留');

      final explore = all.firstWhere((s) => s.agentId == 'Explorer-3');
      expect(explore.isRealSubagent, isFalse);
      expect(explore.hasSession, isFalse, reason: 'Explorer-N 是假 id, 查不到会话');

      final real = all.firstWhere((s) => s.agentId == 'real-child-session-id');
      expect(real.isRealSubagent, isTrue);
      expect(real.hasSession, isTrue);

      /* 状态条 / 菜单只认真子 agent */
      expect(
        container.read(realSubagentsProvider(sid)).map((s) => s.agentId),
        ['real-child-session-id'],
      );
      expect(
        container.read(runningSubagentsProvider(sid)).map((s) => s.agentId),
        ['real-child-session-id'],
      );
    });

    test('老桌面不带 is_agent_tool → 未知按"可能有会话"处理, 但不进状态条', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {'agent_id': 'legacy-1', 'task': '老桌面派的'});
      final s = (await agents(sid)).single;
      expect(s.isAgentTool, isNull);
      expect(s.hasSession, isTrue, reason: '未知时仍允许点开, 拉空由悬浮窗降级');
      expect(s.isRealSubagent, isFalse, reason: '没确证是真子 agent 就不占状态条');
      expect(container.read(runningSubagentsProvider(sid)), isEmpty);
    });
  });

  test('桌面没给 duration_ms 时不许伪造耗时', () async {
    final sid = newSession();
    push(sid, 'subagent_started', {'agent_id': 'a', 'task': 't'});
    push(sid, 'subagent_done', {'agent_id': 'a', 'success': false});
    final s = (await agents(sid)).first;
    expect(s.durationMs, isNull);
    expect(s.success, isFalse);
  });

  test('多 agent 并发: 各自独立演化, 状态条只数在跑的', () async {
    final sid = newSession();
    for (var i = 0; i < 3; i++) {
      push(sid, 'subagent_started', {
        'agent_id': 'a$i',
        'task': '任务$i',
        'is_agent_tool': true,
      });
    }
    expect(await agents(sid), hasLength(3));
    expect(container.read(runningSubagentsProvider(sid)), hasLength(3));
    push(sid, 'subagent_done', {'agent_id': 'a1', 'success': true});
    await agents(sid);
    final running = container.read(runningSubagentsProvider(sid));
    expect(running.map((e) => e.agentId), ['a0', 'a2']);
    expect(container.read(subagentsProvider(sid)), hasLength(3));
  });

  test('ui_state 快照恢复的 subagent 也进列表 (断线重连路径)', () async {
    final sid = newSession();
    container.read(timelineStateProvider(sid).notifier).applyUiStateSnapshot({
      'active_subagents': [
        {'agent_id': 'restored-1', 'task': '重连后恢复的任务'},
      ],
    });
    final list = await agents(sid);
    expect(list, hasLength(1));
    expect(list.first.agentId, 'restored-1');
    expect(list.first.running, isTrue);
  });

  group('ephemeral 子会话 timeline', () {
    SessionEvent ev(
      String childId,
      int seq,
      String kind,
      Map<String, dynamic> payload,
    ) =>
        SessionEvent(
          sessionId: childId,
          seq: seq,
          ts: 1000 + seq,
          kind: kind,
          payload: jsonEncode(payload),
        );

    test('重复灌同一批事件不重复渲染, 且不落 drift', () async {
      const childId = 'agent-ephemeral-1';
      /* autoDispose: 没订阅者会立刻回收并在下次 read 时重建 (悬浮窗里靠 build
       * 无条件 watch 锁住). 测试里用 listen 模拟那个订阅。 */
      final sub = container.listen(
        subagentTimelineProvider(childId),
        (_, __) {},
      );
      addTearDown(sub.close);
      final ctrl = container.read(subagentTimelineProvider(childId).notifier);

      final batch = [
        ev(childId, 1, 'user_message', {'text': '去查一下 backend'}),
        ev(childId, 2, 'agent_text', {'text': '查完了', 'turn_id': 't1'}),
      ];

      expect(ctrl.applyRemoteEvents(batch), 2);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(container.read(subagentTimelineProvider(childId)).entries,
          hasLength(2));

      /* 轮询整段重拉 — 已见过的 seq 必须跳过 */
      expect(ctrl.applyRemoteEvents(batch), 0);

      /* 新事件只加增量 */
      expect(
        ctrl.applyRemoteEvents([
          ...batch,
          ev(childId, 3, 'agent_text', {'text': '补充一句', 'turn_id': 't2'}),
        ]),
        1,
      );
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(container.read(subagentTimelineProvider(childId)).entries,
          hasLength(3));

      /* 性能红线: 子会话事件绝不能进本地 drift 表 */
      final persisted = await db.sessionEventsDao.getBySessionId(childId);
      expect(persisted, isEmpty);
    });

    test('running 标志由调用方置位 (ephemeral 没有 execution 通道)', () async {
      const childId = 'agent-ephemeral-2';
      final sub = container.listen(
        subagentTimelineProvider(childId),
        (_, __) {},
      );
      addTearDown(sub.close);
      final ctrl = container.read(subagentTimelineProvider(childId).notifier);
      expect(container.read(subagentTimelineProvider(childId)).agentRunning,
          isFalse);
      ctrl.setEphemeralRunning(true);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(container.read(subagentTimelineProvider(childId)).agentRunning,
          isTrue);
      ctrl.setEphemeralRunning(false);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(container.read(subagentTimelineProvider(childId)).agentRunning,
          isFalse);
    });
  });

  group('悬浮窗只显示本次派活 (agentId 跨轮次复用)', () {
    /* 桌面 agentId 是父会话内的 Agent-N 计数器, 第二次 dispatch 会拿到同一个
     * Agent-2 并往同一条子会话追加 —— 整段渲染会把上一次任务的输出也画出来
     * (2026-07-29 真机实锤: 点 "audit backend" 先看到上一次 "scan docs" 的总结)。 */
    SessionEvent ev(int seq, String kind, String text) => SessionEvent(
          sessionId: 'Agent-2',
          seq: seq,
          ts: 1000 + seq,
          kind: kind,
          payload: jsonEncode({'text': text}),
        );

    test('从最后一条 user_message 起算, 上一轮内容被裁掉', () {
      final all = [
        ev(1, 'user_message', '上一轮: scan docs'),
        ev(2, 'agent_text', '上一轮输出'),
        ev(3, 'user_message', '本轮: audit backend'),
        ev(4, 'agent_text', '本轮输出'),
      ];
      final scoped = currentDispatchOnly(all);
      expect(scoped.map((e) => e.seq), [3, 4]);
    });

    test('只有一轮时原样返回 (不能把唯一那条 user_message 之前的 seed 裁没)', () {
      final all = [
        ev(1, 'user_message', '唯一一轮'),
        ev(2, 'agent_text', '输出'),
      ];
      expect(currentDispatchOnly(all).map((e) => e.seq), [1, 2]);
    });

    test('没有 user_message 时原样返回', () {
      final all = [ev(1, 'agent_text', 'a'), ev(2, 'agent_text', 'b')];
      expect(currentDispatchOnly(all).map((e) => e.seq), [1, 2]);
    });
  });

  group('停掉单个子 agent (control:stop_agent)', () {
    /* 桌面 client.abortSubAgent 只 abort 那一个 AbortController; 主 agent 和
     * 其它子 agent 不受影响。停掉后桌面照常发 subagent_done(success=false),
     * 手机那条痕迹自然收口 —— 不做本地乐观置位, 免得桌面没停成手机却显示停了。 */
    test('停掉后收到 done(success=false) → 痕迹收口且不再占状态条', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {
        'agent_id': 'Agent-9',
        'task': '长任务',
        'is_agent_tool': true,
      });
      expect(container.read(runningSubagentsProvider(sid)), hasLength(1));

      /* 桌面 abort 后回来的事件 */
      push(sid, 'subagent_done', {
        'agent_id': 'Agent-9',
        'success': false,
        'summary': '已被用户终止',
      });
      final s = (await agents(sid)).single;
      expect(s.running, isFalse);
      expect(s.success, isFalse);
      expect(s.summary, '已被用户终止');
      expect(container.read(runningSubagentsProvider(sid)), isEmpty);
    });

    test('停掉一个不影响同会话其它在跑的子 agent', () async {
      final sid = newSession();
      for (final id in ['A', 'B']) {
        push(sid, 'subagent_started', {
          'agent_id': id,
          'task': '任务$id',
          'is_agent_tool': true,
        });
      }
      push(sid, 'subagent_done', {'agent_id': 'A', 'success': false});
      await agents(sid);
      expect(
        container.read(runningSubagentsProvider(sid)).map((e) => e.agentId),
        ['B'],
      );
    });
  });

  group('后台子 agent 跨主 turn 存活 (2026-07-29 真机实锤)', () {
    /* 主 agent 派完后台 agent 就回一句 OK 收工, 但那个 agent 还要跑几分钟。
     * 跟着主 turn 一起收口会让它秒变"已完成": spinner 停、状态条消失、
     * 长按菜单不给"停掉这个 agent"。 */
    test('主 turn 收口不得把后台子 agent 标记成已完成', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {
        'agent_id': 'Agent-1',
        'task': 'deep audit',
        'is_background': true,
        'is_agent_tool': true,
      });
      /* 主 agent 收工 */
      container.read(timelineStateProvider(sid).notifier).applyRunStateChange({
        'status': 'idle',
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      });
      final s = (await agents(sid)).single;
      expect(s.running, isTrue, reason: '后台 agent 只能由 subagent_done 收口');
      expect(container.read(runningSubagentsProvider(sid)), hasLength(1));
    });

    test('前台子 agent 仍随主 turn 收口 (它跟主 turn 同生共死)', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {
        'agent_id': 'Agent-2',
        'task': '前台任务',
        'is_background': false,
        'is_agent_tool': true,
      });
      container.read(timelineStateProvider(sid).notifier).applyRunStateChange({
        'status': 'idle',
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      });
      final s = (await agents(sid)).single;
      expect(s.running, isFalse);
    });

    test('后台 agent 收到 done 后正常收口', () async {
      final sid = newSession();
      push(sid, 'subagent_started', {
        'agent_id': 'Agent-3',
        'task': 'bg',
        'is_background': true,
        'is_agent_tool': true,
      });
      container.read(timelineStateProvider(sid).notifier).applyRunStateChange({
        'status': 'idle',
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      });
      push(sid, 'subagent_done', {'agent_id': 'Agent-3', 'success': true});
      final s = (await agents(sid)).single;
      expect(s.running, isFalse);
      expect(container.read(runningSubagentsProvider(sid)), isEmpty);
    });
  });
}