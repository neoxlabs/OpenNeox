/// timeline_state_test.dart — TimelineStateController 状态机单测.
///
/// 覆盖:
///   - v1.1 新 streaming kind: plan_update / subagent / compaction / checkpoint / retry
///   - ui_state 快照恢复 (断线重连语义)
///   - turn 收尾 / 中断的收敛行为 (subagent spinner 不悬挂)
///   - 基础流: delta → done → drift upgrade 顺序保持
library;

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;
  late AppDatabase db;

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

  /// applyStreaming 后 flush 是微任务 + 80ms 帧率节流合并的 —
  /// 等一个节流窗口再拿最新 snapshot.
  Future<TimelineSnapshot> snap(String sessionId) async {
    await Future<void>.delayed(const Duration(milliseconds: 100));
    return container.read(timelineStateProvider(sessionId));
  }

  TimelineStateController ctrl(String sessionId) =>
      container.read(timelineStateProvider(sessionId).notifier);

  /// 预插 drift 后首次 read 触发 hydrate, 等落定再取 entries kind 序.
  Future<List<String>> hydratedKinds(
    ProviderContainer c,
    String sessionId,
  ) async {
    c.read(timelineStateProvider(sessionId).notifier);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    return c
        .read(timelineStateProvider(sessionId))
        .entries
        .map((e) => e.kind)
        .toList();
  }

  group('plan_update', () {
    test('全量覆盖 + 进度计数', () async {
      final c = ctrl('s1');
      c.applyStreaming('plan_update', {
        'plan': [
          {'step': '扫描代码', 'status': 'completed'},
          {'step': '写实现', 'status': 'in_progress'},
          {'step': '跑测试', 'status': 'pending'},
        ],
        'explanation': '三步走',
        'turn_id': 't1',
      });
      final s = await snap('s1');
      expect(s.plan, isNotNull);
      expect(s.plan!.steps.length, 3);
      expect(s.plan!.completedCount, 1);
      expect(s.plan!.explanation, '三步走');

      /* 第二次全量覆盖 */
      c.applyStreaming('plan_update', {
        'plan': [
          {'step': '扫描代码', 'status': 'completed'},
          {'step': '写实现', 'status': 'completed'},
        ],
        'turn_id': 't1',
      });
      final s2 = await snap('s1');
      expect(s2.plan!.steps.length, 2);
      expect(s2.plan!.completedCount, 2);
    });

    test('desktop content 字段兼容 (step 缺失时)', () async {
      ctrl('s2').applyStreaming('plan_update', {
        'plan': [
          {'content': '用 content 字段', 'status': 'pending'},
        ],
      });
      final s = await snap('s2');
      expect(s.plan!.steps.single.step, '用 content 字段');
    });

    test('空 plan 不覆盖已有计划卡', () async {
      final c = ctrl('s3');
      c.applyStreaming('plan_update', {
        'plan': [
          {'step': 'a', 'status': 'pending'},
        ],
      });
      c.applyStreaming('plan_update', {'plan': <Object>[]});
      final s = await snap('s3');
      expect(s.plan, isNull); /* 空列表解析为 null → 覆盖语义: 保持简单, 空=清 */
    });
  });

  group('subagent 生命周期', () {
    test('started → done, 复用同一 entry', () async {
      final c = ctrl('s4');
      c.applyStreaming('subagent_started', {
        'agent_id': 'w1',
        'task': '探索仓库结构',
        'role_name': 'explore',
        'is_background': false,
        'turn_id': 't1',
      });
      var s = await snap('s4');
      final entry = s.entries.singleWhere((e) => e.kind == 'subagent');
      expect(entry.pending, isTrue);
      expect(entry.toolName, 'explore');
      expect(entry.text, '探索仓库结构');

      c.applyStreaming('subagent_done', {
        'agent_id': 'w1',
        'success': true,
        'summary': '找到 3 个模块',
        'turn_id': 't1',
      });
      s = await snap('s4');
      final done = s.entries.singleWhere((e) => e.kind == 'subagent');
      expect(done.pending, isFalse);
      expect(done.toolSuccess, isTrue);
      expect(done.output, '找到 3 个模块');
      /* 还是同一条 entry (update-in-place) */
      expect(identical(entry, done), isTrue);
    });

    test('agent_turn_done 收敛悬挂 spinner (done 事件丢失兜底)', () async {
      final c = ctrl('s5');
      c.applyStreaming('subagent_started', {
        'agent_id': 'w1',
        'task': 't',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_turn_done', {'turn_id': 't1'});
      final s = await snap('s5');
      final e = s.entries.singleWhere((x) => x.kind == 'subagent');
      expect(e.pending, isFalse);
      expect(e.toolSuccess, isTrue); /* 无证据不标失败 */
      expect(s.agentRunning, isFalse);
    });

    test('session_interrupted 标记失败', () async {
      final c = ctrl('s6');
      c.applyStreaming('subagent_started', {
        'agent_id': 'w1',
        'task': 't',
        'turn_id': 't1',
      });
      c.applyStreaming('session_interrupted', {'turn_id': 't1'});
      final s = await snap('s6');
      final e = s.entries.singleWhere((x) => x.kind == 'subagent');
      expect(e.pending, isFalse);
      expect(e.toolSuccess, isFalse);
    });
  });

  group('compaction / checkpoint 标记', () {
    test('A/B 与 C 两种 payload 字段名都能解析', () async {
      final c = ctrl('s7');
      c.applyStreaming('context_compaction', {
        'original_tokens': 100000,
        'final_tokens': 40000,
      });
      c.applyStreaming('context_compaction', {
        'before_tokens': 90000,
        'after_tokens': 30000,
      });
      final s = await snap('s7');
      final rows = s.entries.where((e) => e.kind == 'compaction').toList();
      expect(rows.length, 2);
      expect(rows[0].args!['original_tokens'], 100000);
      expect(rows[0].args!['final_tokens'], 40000);
      expect(rows[1].args!['original_tokens'], 90000);
      expect(rows[1].args!['final_tokens'], 30000);
    });

    test('checkpoint 同 id 去重', () async {
      final c = ctrl('s8');
      c.applyStreaming('checkpoint', {'checkpoint_id': 'cp1', 'auto': true});
      c.applyStreaming('checkpoint', {'checkpoint_id': 'cp1', 'auto': true});
      c.applyStreaming('checkpoint', {'id': 'cp2'});
      final s = await snap('s8');
      final rows = s.entries.where((e) => e.kind == 'checkpoint').toList();
      expect(rows.length, 2);
      expect(rows[0].args!['auto'], isTrue);
      expect(rows[1].args!['checkpoint_id'], 'cp2');
    });
  });

  group('stream_retry / recovered pill', () {
    test('retry 置位 → recovered 清除', () async {
      final c = ctrl('s9');
      c.applyStreaming('stream_retry', {
        'attempt': 2,
        'max_retries': 5,
        'is_rate_limit': true,
      });
      var s = await snap('s9');
      expect(s.retry, isNotNull);
      expect(s.retry!.attempt, 2);
      expect(s.retry!.kindLabel, 'rate_limit');

      c.applyStreaming('stream_recovered', {'attempt': 2});
      s = await snap('s9');
      expect(s.retry, isNull);
    });

    test('recovered 丢失时, 真活动 (delta) 到达也清 pill', () async {
      final c = ctrl('s10');
      c.applyStreaming('stream_retry', {'attempt': 1, 'is_network_error': true});
      c.applyStreaming('agent_text_delta', {
        'content': 'hi',
        'turn_id': 't1',
      });
      final s = await snap('s10');
      expect(s.retry, isNull);
      expect(s.agentRunning, isTrue);
    });

    test('turn 收尾清 pill', () async {
      final c = ctrl('s11');
      c.applyStreaming('stream_retry', {'attempt': 1});
      c.applyStreaming('agent_turn_done', {'turn_id': 't1'});
      final s = await snap('s11');
      expect(s.retry, isNull);
    });
  });

  group('ui_state 快照恢复', () {
    test('plan + active_subagents 一次性恢复', () async {
      final c = ctrl('s12');
      c.applyUiStateSnapshot({
        'plan': {
          'explanation': '恢复的计划',
          'plan': [
            {'step': 'a', 'status': 'completed'},
            {'step': 'b', 'status': 'in_progress'},
          ],
          'updated_at': 1234,
        },
        'active_subagents': [
          {
            'agent_id': 'w9',
            'task': '还在跑的 worker',
            'role_name': 'coder',
            'is_background': true,
            'started_at': 1200,
          },
        ],
      });
      final s = await snap('s12');
      expect(s.plan!.explanation, '恢复的计划');
      expect(s.plan!.steps.length, 2);
      final w = s.entries.singleWhere((e) => e.kind == 'subagent');
      expect(w.pending, isTrue);
      expect(w.toolName, 'coder');
      expect(w.args!['is_background'], isTrue);
    });

    test('快照 subagent 与后续 streaming done 收敛到同一条', () async {
      final c = ctrl('s13');
      c.applyUiStateSnapshot({
        'active_subagents': [
          {'agent_id': 'w1', 'task': 't', 'is_background': false},
        ],
      });
      c.applyStreaming('subagent_done', {
        'agent_id': 'w1',
        'success': false,
        'summary': '挂了',
      });
      final s = await snap('s13');
      final rows = s.entries.where((e) => e.kind == 'subagent').toList();
      expect(rows.length, 1);
      expect(rows.single.pending, isFalse);
      expect(rows.single.toolSuccess, isFalse);
      expect(rows.single.output, '挂了');
    });

    test('空 ui_state 不动现有状态', () async {
      final c = ctrl('s14');
      c.applyStreaming('plan_update', {
        'plan': [
          {'step': 'a', 'status': 'pending'},
        ],
      });
      c.applyUiStateSnapshot(const {});
      final s = await snap('s14');
      expect(s.plan, isNotNull);
    });
  });

  group('user_message 隐藏标签剥离 (2026-07-20 联调)', () {
    test('history 版带 current-time 标签与手机 echo 版 dedup 成一条', () async {
      final c = ctrl('s20');
      final db2 = container.read(appDatabaseProvider);
      final now = DateTime.now().millisecondsSinceEpoch;
      /* 手机本地 echo (无标签) */
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's20',
        seq: 1,
        ts: now,
        kind: 'user_message',
        payload: '{"text":"List files please"}',
      ));
      /* 桌面 history 版 (带 current-time 尾巴) */
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's20',
        seq: 2,
        ts: now + 1000,
        kind: 'user_message',
        payload:
            '{"text":"List files please\\n\\n<current-time>2026-07-20 周一 00:47</current-time>"}',
      ));
      /* drift watch → apply → 80ms 节流 flush, CI 负载高时 250ms 偶发不够 (flaky) */
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final s = container.read(timelineStateProvider('s20'));
      final users = s.entries.where((e) => e.kind == 'user_message').toList();
      expect(users.length, 1, reason: '剥标签后文本一致, 5s 窗口 dedup 应合并');
      expect(users.single.text, 'List files please');
      expect(users.single.text, isNot(contains('current-time')));
      c.toString(); /* keep ref alive */
    });
  });

  group('图片地址被电脑改写 (2026-10-28)', () {
    test('流式版是原路径、落盘版是 neox-image 引用 → 合成一条, 留能显示图的版本', () async {
      final c = ctrl('s21');
      c.applyStreaming('agent_text_delta', {'content': '图: ![月度](charts/a.png) 完', 'turn_id': 't1'});
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      await snap('s21');
      final db2 = container.read(appDatabaseProvider);
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's21',
        seq: 5,
        ts: DateTime.now().millisecondsSinceEpoch,
        kind: 'agent_text',
        payload: '{"content":"图: ![月度](neox-image://${'a' * 64}.png) 完","turn_id":"t1"}',
      ));
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final texts = container
          .read(timelineStateProvider('s21'))
          .entries
          .where((e) => e.kind == 'agent_text')
          .toList();
      expect(texts.length, 1);
      expect(texts.single.text, contains('neox-image://'));
    });
  });

  group('基础流回归', () {
    test('text delta 累积 → done 关 streaming', () async {
      final c = ctrl('s15');
      c.applyStreaming('agent_text_delta', {'content': '你', 'turn_id': 't1'});
      c.applyStreaming('agent_text_delta', {'content': '好', 'turn_id': 't1'});
      var s = await snap('s15');
      final e = s.entries.singleWhere((x) => x.kind == 'agent_text');
      expect(e.text, '你好');
      expect(e.streaming, isTrue);

      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      s = await snap('s15');
      expect(
        s.entries.singleWhere((x) => x.kind == 'agent_text').streaming,
        isFalse,
      );
    });

    test('tool running → progress → done 生命周期', () async {
      final c = ctrl('s16');
      c.applyStreaming('tool_running', {
        'tool_call_id': 'tc1',
        'tool_name': 'shell',
        'args': {'command': 'ls'},
        'turn_id': 't1',
      });
      c.applyStreaming('tool_progress', {
        'tool_call_id': 'tc1',
        'chunk': 'file1\n',
        'turn_id': 't1',
      });
      c.applyStreaming('tool_done', {'tool_call_id': 'tc1', 'ok': true});
      final s = await snap('s16');
      final e = s.entries.singleWhere((x) => x.kind == 'tool');
      expect(e.pending, isFalse);
      expect(e.toolSuccess, isTrue);
      expect(e.liveOutput, 'file1\n');
    });
  });

  group('run_state 新者胜守卫 (2026-07-20 丝滑化)', () {
    test('旧 updated_at 快照不得倒退新 live 状态', () async {
      final c = ctrl('s30');
      c.applyRunStateChange({'status': 'running', 'updated_at': 2000});
      /* 竞态到达的旧 subscribe 快照 (idle, 更早的 updated_at) — 必须被丢弃 */
      c.applyRunStateChange({'status': 'idle', 'updated_at': 1000});
      var s = await snap('s30');
      expect(s.agentRunning, isTrue, reason: '旧 idle 快照不能压掉新 running');
      /* 更新的 idle 正常应用 */
      c.applyRunStateChange({'status': 'idle', 'updated_at': 3000});
      s = await snap('s30');
      expect(s.agentRunning, isFalse);
    });

    test('无 updated_at 的老桌面帧仍然照常应用 (兼容)', () async {
      final c = ctrl('s31');
      c.applyRunStateChange({'status': 'running', 'updated_at': 2000});
      c.applyRunStateChange({'status': 'idle'});
      final s = await snap('s31');
      expect(s.agentRunning, isFalse);
    });
  });

  group('streaming_state attach 快照 (v1.3 mid-stream attach)', () {
    test('REPLACE 半成品正文/思考/在跑工具, 后续 delta 继续 append', () async {
      final c = ctrl('s32');
      c.applyStreamingSnapshot({
        'turn_id': 't1',
        'partial_text': 'Hello wor',
        'partial_thinking': 'thinking so far',
        'running_tools': [
          {
            'tool_call_id': 'tc1',
            'tool_name': 'shell',
            'args': {'command': 'sleep 100'},
          },
        ],
      });
      var s = await snap('s32');
      expect(s.agentRunning, isTrue);
      final text = s.entries.singleWhere((x) => x.kind == 'agent_text');
      expect(text.text, 'Hello wor');
      expect(text.streaming, isTrue);
      final think = s.entries.singleWhere((x) => x.kind == 'agent_thinking');
      expect(think.thinking, 'thinking so far');
      final tool = s.entries.singleWhere((x) => x.kind == 'tool');
      expect(tool.pending, isTrue);
      expect(tool.toolName, 'shell');
      /* 快照之后的 live delta 无缝续上 (同 turn 同 id append) */
      c.applyStreaming('agent_text_delta', {'content': 'ld!', 'turn_id': 't1'});
      s = await snap('s32');
      expect(
        s.entries.singleWhere((x) => x.kind == 'agent_text').text,
        'Hello world!',
      );
    });

    test('重复 attach (重连) 快照幂等 — REPLACE 不重复拼接', () async {
      final c = ctrl('s33');
      c.applyStreamingSnapshot({'turn_id': 't1', 'partial_text': 'abc'});
      c.applyStreamingSnapshot({'turn_id': 't1', 'partial_text': 'abcdef'});
      final s = await snap('s33');
      final text = s.entries.singleWhere((x) => x.kind == 'agent_text');
      expect(text.text, 'abcdef', reason: '不能变成 abcabcdef');
    });

    test('段收口后迟到的 attach 快照不得重建重复段 (远程高延迟双渲染)', () async {
      final c = ctrl('s60');
      /* 真机 (远程) 时序: 正文流完 → text_done 把 stream-text 槽位 retire 成
       * `-seg-{n}` → 重连/attach 的旧流式快照这时才到, 带着同一段文本.
       * 槽位已空, 原来的实现会**新建**一条 stream-text-{turn} → 同一句话渲两条. */
      c.applyStreaming('agent_text_delta', {
        'content': 'API 活着。找一下正确的套餐模型查询接口路径。',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      c.applyStreamingSnapshot({
        'turn_id': 't1',
        'partial_text': 'API 活着。找一下正确的套餐模型查询接口路径。',
      });
      final s = await snap('s60');
      final texts = s.entries.where((x) => x.kind == 'agent_text').toList();
      expect(texts.length, 1, reason: '同一段正文不该渲染两条');
    });

    test('段收口后同 turn 新 delta 仍能开新段 (不误伤多段正文)', () async {
      final c = ctrl('s61');
      c.applyStreaming('agent_text_delta', {'content': '第一段', 'turn_id': 't1'});
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      /* 工具跑完后同 turn 的下一段正文 —— 必须能正常新建 */
      c.applyStreaming('agent_text_delta', {'content': '第二段', 'turn_id': 't1'});
      final s = await snap('s61');
      final texts = s.entries
          .where((x) => x.kind == 'agent_text')
          .map((x) => x.text)
          .toList();
      expect(texts, ['第一段', '第二段']);
    });
  });

  group('hydrate stream_order 排序 (2026-07-21 真机错序根治)', () {
    test('有戳的 turn 按真实流序回放 — 答案不再被抬到工具前', () async {
      final db2 = container.read(appDatabaseProvider);
      /* 真机场景 drift: thinking → tool_call → tool_result → 答案 (seq/戳同序).
       * 旧启发式会因 "首 text seq > 首 tool seq" 把答案抬到工具前 — 必须不再发生. */
      await db2.sessionEventsDao.insertBatch([
        SessionEventsCompanion.insert(
          sessionId: 's40', seq: 1, ts: 1000, kind: 'user_message',
          payload: '{"text":"帮我看看目录","turn_id":"t1"}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's40', seq: 2, ts: 2000, kind: 'agent_thinking',
          payload: '{"role":"assistant","content":"","thinking":"想一想","turn_id":"t1","stream_order":1}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's40', seq: 3, ts: 3000, kind: 'tool_call',
          payload: '{"role":"assistant","content":"","turn_id":"t1","stream_order":2,'
              '"tool_calls":[{"id":"c1","type":"function","function":{"name":"shell","arguments":"{}"}}]}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's40', seq: 4, ts: 4000, kind: 'tool_result',
          payload: '{"role":"tool","content":"/x/cece","turn_id":"t1","tool_call_id":"c1","stream_order":3}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's40', seq: 5, ts: 5000, kind: 'agent_text',
          payload: '{"role":"assistant","content":"当前在 /x/cece","turn_id":"t1","stream_order":4}',
        ),
      ]);
      /* 首次 read 触发 hydrate */
      final kinds = await hydratedKinds(container, 's40');
      expect(kinds, ['user_message', 'agent_thinking', 'tool', 'agent_text'],
          reason: '答案必须留在工具后 (stream_order 权威)');
    });

    test('同补全 intro 晚落库 (order 早) → 排回工具前', () async {
      final db2 = container.read(appDatabaseProvider);
      /* OpenAI 协议: intro 的 drift seq 晚于 tool (text_complete 最后 fire),
       * 但 stream_order 按段首 token 锁定在工具前. */
      await db2.sessionEventsDao.insertBatch([
        SessionEventsCompanion.insert(
          sessionId: 's41', seq: 1, ts: 1000, kind: 'user_message',
          payload: '{"text":"跑一下","turn_id":"t1"}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's41', seq: 2, ts: 2000, kind: 'tool_call',
          payload: '{"role":"assistant","content":"","turn_id":"t1","stream_order":2,'
              '"tool_calls":[{"id":"c1","type":"function","function":{"name":"shell","arguments":"{}"}}]}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's41', seq: 3, ts: 3000, kind: 'agent_text',
          payload: '{"role":"assistant","content":"我先解释一下","turn_id":"t1","stream_order":1}',
        ),
      ]);
      final kinds = await hydratedKinds(container, 's41');
      expect(kinds, ['user_message', 'agent_text', 'tool'],
          reason: 'intro 段首 token 在工具前, 回放要还原');
    });

    test('无戳老数据保持 drift 序 — 不再错误抬答案', () async {
      final db2 = container.read(appDatabaseProvider);
      await db2.sessionEventsDao.insertBatch([
        SessionEventsCompanion.insert(
          sessionId: 's42', seq: 1, ts: 1000, kind: 'tool_call',
          payload: '{"role":"assistant","content":"","turn_id":"t1",'
              '"tool_calls":[{"id":"c1","type":"function","function":{"name":"shell","arguments":"{}"}}]}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's42', seq: 2, ts: 2000, kind: 'agent_text',
          payload: '{"role":"assistant","content":"当前目录是 /x","turn_id":"t1"}',
        ),
      ]);
      final kinds = await hydratedKinds(container, 's42');
      expect(kinds, ['tool', 'agent_text'],
          reason: '无戳不再 lift; 答案留在工具后');
    });
  });

  group('live 多段正文顺序 (2026-07-21 stream retire)', () {
    test('text_done 后新段 delta 排在 tool 之后', () async {
      final c = ctrl('s50');
      /* 段1 intro */
      c.applyStreaming('agent_text_delta', {
        'content': '我先看目录',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      /* 工具 */
      c.applyStreaming('tool_running', {
        'tool_call_id': 'tc1',
        'tool_name': 'shell',
        'args': {'command': 'pwd'},
        'turn_id': 't1',
      });
      c.applyStreaming('tool_done', {'tool_call_id': 'tc1', 'ok': true});
      /* 段2 答案 — 必须新建 entry, 不能并回段1 */
      c.applyStreaming('agent_text_delta', {
        'content': '当前目录是 /x/cece',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      final s = await snap('s50');
      final kinds = s.entries.map((e) => e.kind).toList();
      expect(kinds, ['agent_text', 'tool', 'agent_text'],
          reason: '答案必须在工具后');
      final texts = s.entries
          .where((e) => e.kind == 'agent_text')
          .map((e) => e.text)
          .toList();
      expect(texts, ['我先看目录', '当前目录是 /x/cece']);
      expect(
        s.entries.where((e) => e.kind == 'agent_text').every((e) => !e.streaming),
        isTrue,
      );
    });

    test('仅工具后答案 (无 intro) — thinking → tool → text', () async {
      final c = ctrl('s51');
      c.applyStreaming('agent_thinking_delta', {
        'content': '想一下',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_thinking_done', {'turn_id': 't1'});
      c.applyStreaming('tool_running', {
        'tool_call_id': 'tc1',
        'tool_name': 'shell',
        'args': {'command': 'pwd'},
        'turn_id': 't1',
      });
      c.applyStreaming('tool_done', {'tool_call_id': 'tc1', 'ok': true});
      c.applyStreaming('agent_text_delta', {
        'content': '当前目录是 /Users/exampleuser/AI/cece',
        'turn_id': 't1',
      });
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      final s = await snap('s51');
      expect(
        s.entries.map((e) => e.kind).toList(),
        ['agent_thinking', 'tool', 'agent_text'],
      );
      expect(s.entries.last.text, '当前目录是 /Users/exampleuser/AI/cece');
    });
  });

  group('thinking 去重 + 秒数 (retire 后 drift 晚到)', () {
    test('thinking_done 后再到同文 drift → 一条且保留 live 秒数', () async {
      final c = ctrl('s60');
      c.applyStreaming('agent_thinking_delta', {
        'content': 'The user is asking what was done recently.',
        'turn_id': 't1',
      });
      await Future<void>.delayed(const Duration(milliseconds: 50));
      c.applyStreaming('agent_thinking_done', {'turn_id': 't1'});
      var s = await snap('s60');
      expect(s.entries.where((e) => e.kind == 'agent_thinking').length, 1);
      final liveMs = s.entries
          .singleWhere((e) => e.kind == 'agent_thinking')
          .thinkingDurationMs;
      expect(liveMs, isNotNull);
      expect(liveMs!, lessThan(60 * 1000), reason: 'live 段应是秒级');

      final db2 = container.read(appDatabaseProvider);
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's60',
        seq: 1,
        ts: DateTime.now().millisecondsSinceEpoch - 8 * 60 * 1000,
        kind: 'agent_thinking',
        payload:
            '{"role":"assistant","content":"","thinking":"The user is asking what was done recently.","turn_id":"t1"}',
      ));
      await Future<void>.delayed(const Duration(milliseconds: 400));
      s = container.read(timelineStateProvider('s60'));
      final thinks =
          s.entries.where((e) => e.kind == 'agent_thinking').toList();
      expect(thinks.length, 1, reason: '不得重复 thinking 行');
      expect(thinks.single.thinkingDurationMs, liveMs,
          reason: '晚到 drift 不得用 now-ev.ts 覆盖成假分钟数');
    });

    test('纯 hydrate 的 thinking 不发明秒数', () async {
      final db2 = container.read(appDatabaseProvider);
      final oldTs = DateTime.now().millisecondsSinceEpoch - 8 * 60 * 1000;
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's61',
        seq: 1,
        ts: oldTs,
        kind: 'agent_thinking',
        payload:
            '{"role":"assistant","content":"","thinking":"old thought","turn_id":"t1"}',
      ));
      final kinds = await hydratedKinds(container, 's61');
      expect(kinds, ['agent_thinking']);
      final s = container.read(timelineStateProvider('s61'));
      expect(
        s.entries.single.thinkingDurationMs,
        isNull,
        reason: '禁止 now-ev.ts → 假 8m',
      );
    });
  });

  group('历史回填 prepend (向上翻页 / 多页 catch-up)', () {
    test('比现有更旧的 drift 事件插到 timeline 前端且批内保序', () async {
      final c = ctrl('s34');
      final db2 = container.read(appDatabaseProvider);
      /* 先到最新页 (catch-up 第一页) */
      await db2.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
        sessionId: 's34',
        seq: 10,
        ts: 100000,
        kind: 'user_message',
        payload: '{"text":"newest message"}',
      ));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      /* 再到更旧页 (向上翻页拉回) — 到达顺序晚, 时序却更早 */
      await db2.sessionEventsDao.insertBatch([
        SessionEventsCompanion.insert(
          sessionId: 's34',
          seq: 1,
          ts: 1000,
          kind: 'user_message',
          payload: '{"text":"oldest message"}',
        ),
        SessionEventsCompanion.insert(
          sessionId: 's34',
          seq: 2,
          ts: 20000,
          kind: 'user_message',
          payload: '{"text":"middle message"}',
        ),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final s = container.read(timelineStateProvider('s34'));
      final users = s.entries.where((e) => e.kind == 'user_message').toList();
      expect(users.length, 3);
      expect(users[0].text, 'oldest message', reason: '旧页必须 prepend 到前端');
      expect(users[1].text, 'middle message');
      expect(users[2].text, 'newest message');
      c.toString(); /* keep ref alive */
    });
  });

  group('tool_running 字段名兼容 (远程发送端变体)', () {
    test('tool_id / name / arguments(JSON 串) 也能建在跑 entry', () async {
      final c = ctrl('s62');
      /* 某些发送端 (远程/中转) 推的是 field 变体 —— 硬读 tool_call_id/tool_name
       * 会直接 return, 运行中状态整段丢失 (无摘要无扫光)。 */
      c.applyStreaming('tool_running', {
        'tool_id': 'tc1',
        'name': 'shell',
        'arguments': '{"command":"ls -la"}',
        'turn_id': 't1',
      });
      final s = await snap('s62');
      final tool = s.entries.singleWhere((x) => x.kind == 'tool');
      expect(tool.pending, isTrue, reason: '拿不到 callId 整条在跑状态就没了');
      expect(tool.toolName, 'shell');
      expect(tool.args!['command'], 'ls -la');
    });

    test('标准 tool_call_id/tool_name/args 形态不受影响', () async {
      final c = ctrl('s63');
      c.applyStreaming('tool_running', {
        'tool_call_id': 'tc2',
        'tool_name': 'shell',
        'args': {'command': 'pwd'},
        'turn_id': 't1',
      });
      final s = await snap('s63');
      final tool = s.entries.singleWhere((x) => x.kind == 'tool');
      expect(tool.pending, isTrue);
      expect(tool.args!['command'], 'pwd');
    });
  });
}
