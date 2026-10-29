/// timeline_ordering_test.dart — timeline 卡片"顺序 / 时序 / 收敛"的成体系回归.
///
/// 与已有的 `timeline_state_test.dart` 分工:
///   · 那份按**功能点**组织 (plan_update / subagent / checkpoint 各自的语义)
///   · 这份按**时序形态**组织 —— 同一批事件用不同到达顺序、不同丢失组合、不同
///     重复次数灌进去, 断言最终渲染序列始终正确。
///
/// 为什么要单独一份: 真机上翻车的从来不是"某个 kind 解析错了", 而是
///   - 工具比正文先落库 → 答案被抬到工具前面
///   - `*_done` 丢了 → spinner 永远转
///   - 重连时 attach 快照与后续 delta 重复拼接 → 正文出现两遍
///   - 同一 turn 多段正文 → 第二段挂回第一段的 entry
/// 这些都只在"事件序列"这个维度上才暴露得出来。
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

  /// 每个用例用独立 sessionId, 避免 provider 缓存串味.
  String newSession() => 's${++sessionSeq}';

  TimelineStateController ctrl(String s) =>
      container.read(timelineStateProvider(s).notifier);

  /// applyStreaming 的 flush 走微任务 + 80ms 帧节流, 等过一个窗口再断言.
  Future<TimelineSnapshot> snap(String s) async {
    await Future<void>.delayed(const Duration(milliseconds: 120));
    return container.read(timelineStateProvider(s));
  }

  Future<List<String>> kinds(String s) async =>
      (await snap(s)).entries.map((e) => e.kind).toList();

  /// 把一串 (kind, payload) 顺序灌进去 —— 描述"桌面推了什么".
  void feed(String s, List<(String, Map<String, dynamic>)> events) {
    final c = ctrl(s);
    for (final (k, p) in events) {
      c.applyStreaming(k, p);
    }
  }

  Map<String, dynamic> textDelta(String t, {String turn = 't1'}) =>
      {'content': t, 'turn_id': turn};
  Map<String, dynamic> thinkDelta(String t, {String turn = 't1'}) =>
      {'content': t, 'turn_id': turn};
  Map<String, dynamic> toolRun(
    String id,
    String name, {
    String turn = 't1',
    Map<String, dynamic>? args,
  }) =>
      {
        'tool_call_id': id,
        'tool_name': name,
        'turn_id': turn,
        if (args != null) 'args': args,
      };
  Map<String, dynamic> toolDone(
    String id, {
    String turn = 't1',
    bool ok = true,
    String? output,
  }) =>
      {
        'tool_call_id': id,
        'turn_id': turn,
        'ok': ok,
        if (output != null) 'output': output,
      };

  // ══════════════════════════════════════════════════════════════
  group('单 turn 内的基本顺序', () {
    test('thinking → tool → text: 三种卡片各出现一次且顺序正确', () async {
      final s = newSession();
      feed(s, [
        ('agent_thinking_delta', thinkDelta('我先看看')),
        ('agent_thinking_done', {'turn_id': 't1'}),
        ('tool_running', toolRun('c1', 'read_file')),
        ('tool_done', toolDone('c1', output: 'ok')),
        ('agent_text_delta', textDelta('结论是 42')),
        ('agent_text_done', {'turn_id': 't1'}),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      expect(await kinds(s), ['agent_thinking', 'tool', 'agent_text']);
    });

    test('先说话再干活再总结: text → tool → text 产生两条独立正文', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('我来查一下。')),
        ('agent_text_done', {'turn_id': 't1'}),
        ('tool_running', toolRun('c1', 'http_fetch')),
        ('tool_done', toolDone('c1')),
        ('agent_text_delta', textDelta('查到了。')),
        ('agent_text_done', {'turn_id': 't1'}),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      /* 第二段正文必须是**新的一条**且排在 tool 之后 —— 不 retire 的话会拼回
       * 第一条, 渲染成 "我来查一下。查到了。" 挂在工具上方。 */
      final s1 = await snap(s);
      expect(s1.entries.map((e) => e.kind), ['agent_text', 'tool', 'agent_text']);
      expect(s1.entries.first.text, '我来查一下。');
      expect(s1.entries.last.text, '查到了。');
    });

    test('同 turn 多个工具按调用顺序排列', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'ls')),
        ('tool_done', toolDone('c1')),
        ('tool_running', toolRun('c2', 'cat')),
        ('tool_done', toolDone('c2')),
        ('tool_running', toolRun('c3', 'grep')),
        ('tool_done', toolDone('c3')),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.map((e) => e.toolName), ['ls', 'cat', 'grep']);
    });

    test('并行工具: 三个 running 先到, done 乱序回来 — 顺序仍按 running 顺序', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('a', 'alpha')),
        ('tool_running', toolRun('b', 'beta')),
        ('tool_running', toolRun('c', 'gamma')),
        ('tool_done', toolDone('c')),
        ('tool_done', toolDone('a')),
        ('tool_done', toolDone('b')),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.map((e) => e.toolName), ['alpha', 'beta', 'gamma']);
      expect(s1.entries.every((e) => !e.pending), isTrue, reason: '全部应收敛为 done');
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('流式增量的累积与幂等', () {
    test('多个 text delta 累积成一条完整正文', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('杭')),
        ('agent_text_delta', textDelta('州')),
        ('agent_text_delta', textDelta('很美')),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.single.text, '杭州很美');
      expect(s1.entries.single.streaming, isTrue);
    });

    test('thinking 与 text 各自累积, 互不串台', () async {
      final s = newSession();
      feed(s, [
        ('agent_thinking_delta', thinkDelta('嗯')),
        ('agent_text_delta', textDelta('答案')),
        ('agent_thinking_delta', thinkDelta('...让我想')),
        ('agent_text_delta', textDelta('是 42')),
      ]);
      final s1 = await snap(s);
      final think = s1.entries.firstWhere((e) => e.kind == 'agent_thinking');
      final text = s1.entries.firstWhere((e) => e.kind == 'agent_text');
      expect(think.thinking, '嗯...让我想');
      expect(text.text, '答案是 42');
    });

    test('空 content 的 delta 被忽略, 不产生空卡片', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('')),
        ('agent_thinking_delta', thinkDelta('')),
      ]);
      expect(await kinds(s), isEmpty);
    });

    test('done 之后再来同 turn 的 delta → 开新的一条, 不追加到已收口的那条', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('第一段')),
        ('agent_text_done', {'turn_id': 't1'}),
        ('agent_text_delta', textDelta('第二段')),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.length, 2);
      expect(s1.entries.map((e) => e.text), ['第一段', '第二段']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('缺失事件的兜底收敛 (真机丢帧)', () {
    test('tool_done 丢失 + agent_turn_done 到达 → 工具不能永远转圈', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'slow_tool')),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      final tool = s1.entries.firstWhere((e) => e.kind == 'tool');
      expect(tool.pending, isFalse,
          reason: 'turn 收尾必须收敛悬挂的 tool spinner');
    });

    test('agent_text_done 丢失 + turn_done 到达 → 正文停止 streaming', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('没有收口的正文')),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.single.streaming, isFalse);
    });

    test('session_interrupted 同样收敛悬挂状态', () async {
      final s = newSession();
      feed(s, [
        ('agent_thinking_delta', thinkDelta('想到一半')),
        ('tool_running', toolRun('c1', 'x')),
        ('session_interrupted', {'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.firstWhere((e) => e.kind == 'tool').pending, isFalse);
      expect(s1.agentRunning, isFalse);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('重复事件幂等 (重连 / 重放)', () {
    test('同一 tool_running 重复到达 → 只有一条 tool 卡', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'ls')),
        ('tool_running', toolRun('c1', 'ls')),
        ('tool_running', toolRun('c1', 'ls')),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.where((e) => e.kind == 'tool').length, 1);
    });

    test('同一 tool_done 重复到达不翻转成功状态', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'ls')),
        ('tool_done', toolDone('c1', ok: false)),
        ('tool_done', toolDone('c1', ok: false)),
      ]);
      final s1 = await snap(s);
      final tool = s1.entries.single;
      expect(tool.toolSuccess, isFalse);
      expect(tool.pending, isFalse);
    });

    test('完成之后又来一条「开始」(重放 / 两路先后不定) 不把工具改回运行中 (2026-10-22 真机「正在改文件 69s」)', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'edit')),
        ('tool_done', toolDone('c1')),
        ('tool_running', toolRun('c1', 'edit')),
      ]);
      final tool = (await snap(s)).entries.single;
      expect(tool.pending, isFalse);
    });

    test('agent_turn_done 重复到达不产生额外卡片', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('hi')),
        ('agent_turn_done', {'turn_id': 't1'}),
        ('agent_turn_done', {'turn_id': 't1'}),
        ('agent_turn_done', {'turn_id': 't1'}),
      ]);
      expect(await kinds(s), ['agent_text']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('跨 turn 隔离', () {
    test('两个 turn 的正文互不合并', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('第一轮', turn: 't1')),
        ('agent_text_done', {'turn_id': 't1'}),
        ('agent_turn_done', {'turn_id': 't1'}),
        ('agent_text_delta', textDelta('第二轮', turn: 't2')),
        ('agent_text_done', {'turn_id': 't2'}),
        ('agent_turn_done', {'turn_id': 't2'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.map((e) => e.text), ['第一轮', '第二轮']);
    });

    test('turn2 的 turn_done 不会收敛 turn1 遗留的 pending tool', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'a', turn: 't1')),
        ('agent_turn_done', {'turn_id': 't1'}),
        ('tool_running', toolRun('c2', 'b', turn: 't2')),
      ]);
      final s1 = await snap(s);
      final t1 = s1.entries.firstWhere((e) => e.toolName == 'a');
      final t2 = s1.entries.firstWhere((e) => e.toolName == 'b');
      expect(t1.pending, isFalse, reason: 't1 已收尾');
      expect(t2.pending, isTrue, reason: 't2 还在跑');
    });

    test('缺 turn_id 的事件落到 default turn, 不与显式 turn 混淆', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', {'content': '无 turn'}),
        ('agent_text_delta', textDelta('有 turn', turn: 't9')),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.length, 2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('工具卡内容正确性', () {
    test('失败工具标记 toolSuccess=false; 输出走 drift 不走流式 done', () async {
      /* 契约确认 (别再写成"流式 done 带 output"): `tool_done` 只翻转
       * pending/toolSuccess, 工具正文由持久化的 drift 事件补齐 —— 真机上工具卡
       * 里那段 hostname/pwd 输出就是这条路径来的。这里锁住这个分工。 */
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'bad', args: {'path': '/nope'})),
        ('tool_done', toolDone('c1', ok: false, output: 'ENOENT')),
      ]);
      final tool = (await snap(s)).entries.single;
      expect(tool.toolSuccess, isFalse);
      expect(tool.pending, isFalse);
      expect(tool.args, isNotNull, reason: 'args 在 running 时就该带上');
      expect(tool.output, isNull, reason: '流式 done 不负责 output');
    });

    test('tool_progress 更新 liveOutput 但不改变卡片数量', () async {
      final s = newSession();
      feed(s, [
        ('tool_running', toolRun('c1', 'build')),
        ('tool_progress', {'tool_call_id': 'c1', 'output': 'step 1', 'turn_id': 't1'}),
        ('tool_progress', {'tool_call_id': 'c1', 'output': 'step 2', 'turn_id': 't1'}),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.length, 1);
      expect(s1.entries.single.pending, isTrue);
    });

    test('没有 running 直接来 done — 不凭空造出半截卡片就崩', () async {
      final s = newSession();
      feed(s, [
        ('tool_done', toolDone('orphan', output: 'x')),
      ]);
      /* 断言的是"不抛异常且状态自洽", 具体是补一条还是忽略都可接受 */
      final s1 = await snap(s);
      expect(s1.entries.every((e) => !e.pending), isTrue);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('agentRunning 状态机', () {
    test('delta 到达置 running, turn_done 清除', () async {
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('x'));
      expect((await snap(s)).agentRunning, isTrue);
      c.applyStreaming('agent_turn_done', {'turn_id': 't1'});
      expect((await snap(s)).agentRunning, isFalse);
    });

    test('turn_done 之后迟到的 agent_text_done 不把 running 重新点亮', () async {
      /* 真机实锤过的"思考中永不消失": desktop 在 agent_turn_done 之后还会补推
       * agent_text_done, 早期实现把它当"活动"又把 running 开回 true。 */
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('x'));
      c.applyStreaming('agent_turn_done', {'turn_id': 't1'});
      c.applyStreaming('agent_text_done', {'turn_id': 't1'});
      c.applyStreaming('tool_done', toolDone('c1'));
      expect((await snap(s)).agentRunning, isFalse);
    });

    test('tool_running 也算活动, 会点亮 running', () async {
      final s = newSession();
      ctrl(s).applyStreaming('tool_running', toolRun('c1', 'x'));
      expect((await snap(s)).agentRunning, isTrue);
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('压力 / 边界', () {
    test('单 turn 500 个 delta 全部累积且只有一条卡', () async {
      final s = newSession();
      final c = ctrl(s);
      for (var i = 0; i < 500; i++) {
        c.applyStreaming('agent_text_delta', textDelta('$i,'));
      }
      final s1 = await snap(s);
      expect(s1.entries.length, 1);
      expect(s1.entries.single.text!.endsWith('499,'), isTrue);
    });

    test('50 个工具连续跑完, 顺序与数量都对', () async {
      final s = newSession();
      final c = ctrl(s);
      for (var i = 0; i < 50; i++) {
        c.applyStreaming('tool_running', toolRun('c$i', 'tool$i'));
        c.applyStreaming('tool_done', toolDone('c$i'));
      }
      final s1 = await snap(s);
      expect(s1.entries.length, 50);
      expect(s1.entries.first.toolName, 'tool0');
      expect(s1.entries.last.toolName, 'tool49');
    });

    test('未知 kind 被安全忽略, 不影响既有 timeline', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('正常')),
        ('some_future_kind_from_newer_desktop', {'whatever': 1}),
        ('agent_text_done', {'turn_id': 't1'}),
      ]);
      expect(await kinds(s), ['agent_text']);
    });

    test('payload 字段类型错误 (int 当 string) 不炸, 且按字面量渲染', () async {
      /* 两端独立发版, 桌面把 content 换成非字符串是迟早的事。applyStreaming 是在
       * WS 回调里同步调的, 抛出去会打断订阅循环 —— 表现为"聊到一半整个会话卡死"。 */
      final s = newSession();
      final c = ctrl(s);
      expect(
        () => c.applyStreaming('agent_text_delta', {'content': 123, 'turn_id': 't1'}),
        returnsNormally,
      );
      expect((await snap(s)).entries.single.text, '123');
    });

    test('彻底畸形的 payload 被吞掉, 已渲染内容不受影响, 后续事件继续处理', () async {
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('前面正常'));
      /* turn_id 给个 Map — 任何 as String? 路径都会炸 */
      expect(
        () => c.applyStreaming('tool_running', {
          'tool_call_id': <String, Object>{'nope': 1},
          'tool_name': 'x',
        }),
        returnsNormally,
      );
      c.applyStreaming('agent_text_delta', textDelta('后面也正常'));
      final s1 = await snap(s);
      expect(s1.entries.first.text, '前面正常后面也正常');
    });
  });

  // ══════════════════════════════════════════════════════════════
  group('用户真机反馈 (2026-07-28)', () {
    test('工具开跑时收口在途正文 — 光标不再一直闪', () async {
      /* 桌面不保证 tool_running 之前先发 agent_text_done。缺了它, 那条 text entry
       * 会永远 streaming=true, 末尾的 CursorBlink 一直闪, 而正文其实早写完了。 */
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('先扫一下有没有服务在跑。')),
        ('tool_running', toolRun('c1', 'shell')),
      ]);
      final s1 = await snap(s);
      final text = s1.entries.firstWhere((e) => e.kind == 'agent_text');
      expect(text.streaming, isFalse,
          reason: '工具已开跑 = agent 明显进入下一步, 正文该收口');
      expect(text.text, '先扫一下有没有服务在跑。');
    });

    test('收口后本轮下一段正文排在工具之后 (顺带修的错序)', () async {
      final s = newSession();
      feed(s, [
        ('agent_text_delta', textDelta('我看看。')),
        ('tool_running', toolRun('c1', 'shell')),
        ('tool_done', toolDone('c1')),
        ('agent_text_delta', textDelta('结果如下。')),
      ]);
      final s1 = await snap(s);
      expect(s1.entries.map((e) => e.kind),
          ['agent_text', 'tool', 'agent_text']);
      expect(s1.entries.first.text, '我看看。');
      expect(s1.entries.last.text, '结果如下。');
    });

    test('思考同样在工具开跑时收口', () async {
      final s = newSession();
      feed(s, [
        ('agent_thinking_delta', thinkDelta('想一下')),
        ('tool_running', toolRun('c1', 'x')),
      ]);
      final s1 = await snap(s);
      final think = s1.entries.firstWhere((e) => e.kind == 'agent_thinking');
      expect(think.streaming, isFalse);
    });

    test('请求取消后, 在途事件不得把 running 顶回来 (暂停按两次)', () async {
      /* _stop() 乐观 markCancelRequested(); cancel 要一个 RTT 才生效, 这期间
       * 在途 delta/tool_running 若把 agentRunning 点回 true, 停止按钮会闪回去,
       * 用户以为没按上就再按一次。 */
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('跑着呢'));
      expect((await snap(s)).agentRunning, isTrue);

      c.markCancelRequested();
      expect((await snap(s)).agentRunning, isFalse);

      /* 模拟在途事件继续到达 */
      c.applyStreaming('agent_text_delta', textDelta('还在吐'));
      c.applyStreaming('tool_running', toolRun('c9', 'shell'));
      expect((await snap(s)).agentRunning, isFalse,
          reason: '取消挂起期间不许回到运行中');
    });

    test('停止后残留内容不再上屏 (chat:C9-08), 已产出的保留', () async {
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('前半段'));
      c.markCancelRequested();
      c.applyStreaming('agent_text_delta', textDelta('后半段'));
      final s1 = await snap(s);
      /* 2026-10-18 chat:C9-08: 点停止后 200ms 内画面不许再有新字符。
       * cancel 到桌面 / 网关生效之间还会到一批增量 —— 这些不上屏;
       * 停止前已经写出来的字保留, 不截断。 */
      expect(s1.entries.first.text, '前半段',
          reason: '冻结打字机: 停止后的增量丢弃, 已产出的内容保留');
      expect(s1.streamFrozen, isTrue);
    });

    test('桌面确认收口后闩解除, 新一轮能正常回到运行中', () async {
      final s = newSession();
      final c = ctrl(s);
      c.applyStreaming('agent_text_delta', textDelta('x'));
      c.markCancelRequested();
      c.applyStreaming('session_interrupted', {'turn_id': 't1'});
      expect((await snap(s)).agentRunning, isFalse);

      c.applyStreaming('agent_text_delta', textDelta('新一轮', turn: 't2'));
      expect((await snap(s)).agentRunning, isTrue,
          reason: '收口事件到达后闩必须解除, 否则下一轮永远显示"已停止"');
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  用户消息迟到 (2026-09-17 真机: 「我发的消息钉在最底下, 新回复长在它上面」)
  //
  //  user_message 走 落库 → drift watch 的慢路, agent 的 delta 走内存快路。
  //  回显比第一批 delta 晚到时, 按"到达顺序"排它就被追加到回复下面, 再也不挪回来。
  // ══════════════════════════════════════════════════════════════
  group('user_message 迟到仍排在本轮回复之前', () {
    Future<void> put(String s, int seq, String kind, String payload) =>
        db.sessionEventsDao.insertEvent(SessionEventsCompanion.insert(
          sessionId: s,
          seq: seq,
          ts: DateTime.now().millisecondsSinceEpoch,
          kind: kind,
          payload: payload,
        ));

    Future<List<String>> rows(String s) async {
      /* drift watch → apply → 节流 flush */
      await Future<void>.delayed(const Duration(milliseconds: 400));
      return container
          .read(timelineStateProvider(s))
          .entries
          .map((e) => '${e.kind}:${e.text ?? e.toolName ?? ''}')
          .toList();
    }

    test('实时: 本轮 delta 先到, 回显后到 → 用户消息插回本轮最前', () async {
      final s = newSession();
      await put(s, 1, 'user_message', '{"text":"第一句"}');
      await put(s, 2, 'agent_text', '{"text":"第一答","turn_id":"t1"}');
      ctrl(s);
      await rows(s);
      ctrl(s).applyStreaming('agent_turn_done', {'turn_id': 't1'});

      /* 第二轮: 回复先到 */
      ctrl(s).applyStreaming('agent_text_delta', textDelta('我来查', turn: 't2'));
      ctrl(s).applyStreaming('tool_running', toolRun('c1', 'read_file', turn: 't2'));
      await rows(s);
      /* 用户消息回显后到 */
      await put(s, 3, 'user_message', '{"text":"第二句"}');

      expect(await rows(s), [
        'user_message:第一句',
        'agent_text:第一答',
        'user_message:第二句',
        'agent_text:我来查',
        'tool:read_file',
      ]);
    });

    test('回显在本轮落库之后才到 → 按服务端 seq 排在本轮回复之前', () async {
      final s = newSession();
      await put(s, 1, 'user_message', '{"text":"第一句"}');
      await put(s, 2, 'agent_text', '{"text":"第一答","turn_id":"t1"}');
      ctrl(s);
      await rows(s);
      ctrl(s).applyStreaming('agent_turn_done', {'turn_id': 't1'});

      ctrl(s).applyStreaming('agent_text_delta', textDelta('第二答', turn: 't2'));
      ctrl(s).applyStreaming('agent_text_done', {'turn_id': 't2'});
      await put(s, 4, 'agent_text', '{"text":"第二答","turn_id":"t2"}');
      ctrl(s).applyStreaming('agent_turn_done', {'turn_id': 't2'});
      await rows(s);
      await put(s, 3, 'user_message', '{"text":"第二句"}');

      final r = await rows(s);
      expect(r.indexOf('user_message:第二句'), lessThan(r.indexOf('agent_text:第二答')));
      expect(r.first, 'user_message:第一句', reason: '补回来的消息不许被甩到整个会话最顶上');
    });

    test('断线补缺: 夹在已显示事件之间的旧 seq 插回原位, 不 prepend 到顶', () async {
      final s = newSession();
      await put(s, 1, 'user_message', '{"text":"A"}');
      await put(s, 2, 'agent_text', '{"text":"a","turn_id":"t1"}');
      await put(s, 6, 'agent_text', '{"text":"c","turn_id":"t3"}');
      ctrl(s);
      await rows(s);
      /* 补拉回来的中间一轮 */
      await put(s, 5, 'user_message', '{"text":"C"}');

      expect(await rows(s), [
        'user_message:A',
        'agent_text:a',
        'user_message:C',
        'agent_text:c',
      ]);
    });

    test('上一轮的消息之后开新一轮: 回显先到 → 正常追加, 不插到上一轮回复前面', () async {
      final s = newSession();
      await put(s, 1, 'user_message', '{"text":"第一句"}');
      await put(s, 2, 'agent_text', '{"text":"第一答","turn_id":"t1"}');
      ctrl(s);
      await rows(s);
      ctrl(s).applyStreaming('agent_turn_done', {'turn_id': 't1'});
      await put(s, 3, 'user_message', '{"text":"第二句"}');
      ctrl(s).applyStreaming('agent_text_delta', textDelta('第二答', turn: 't2'));

      expect(await rows(s), [
        'user_message:第一句',
        'agent_text:第一答',
        'user_message:第二句',
        'agent_text:第二答',
      ]);
    });
  });
}
