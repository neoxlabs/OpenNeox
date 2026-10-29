/// tool_group_test.dart — 活动收拢分组逻辑单测.
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/timeline/models/payload_utils.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/tool_group_row.dart';

TimelineEntry _e(
  String kind,
  String id, {
  bool pending = false,
  bool ok = true,
  String? toolName,
  Map<String, dynamic>? args,
  String? text,
}) {
  return TimelineEntry(
    id: id,
    kind: kind,
    sequence: 0,
    timestamp: 0,
    pending: pending,
    toolSuccess: ok,
    toolName: kind == 'tool' ? (toolName ?? 'read_file') : null,
    args: args,
    text: text,
    thinking: kind == 'agent_thinking' ? (text ?? '…') : null,
  );
}

void main() {
  group('groupToolEntries', () {
    test('连续 tool 收成一组, agent_text 打断', () {
      final items = groupToolEntries([
        _e('user_message', 'u1'),
        _e('tool', 't1'),
        _e('tool', 't2'),
        _e('tool', 't3'),
        _e('agent_text', 'a1'),
        _e('tool', 't4'),
        _e('agent_text', 'a2'),
      ]);
      expect(items.length, 5);
      expect(items[0], isA<SingleRenderItem>());
      expect(items[1], isA<ToolGroupRenderItem>());
      expect((items[1] as ToolGroupRenderItem).tools.length, 3);
      expect(items[2], isA<SingleRenderItem>());
      /* 单个 tool 也走组行 (digest 一行) */
      expect(items[3], isA<ToolGroupRenderItem>());
      expect((items[3] as ToolGroupRenderItem).tools.length, 1);
      expect(items[4], isA<SingleRenderItem>());
    });

    test('thinking 不打断 — 与 tool 合成一行 digest', () {
      final items = groupToolEntries([
        _e('agent_thinking', 'th1', text: 'hmm'),
        _e('tool', 't1', toolName: 'execute_shell'),
        _e('agent_thinking', 'th2', text: 'ok'),
        _e('tool', 't2', toolName: 'read_file'),
        _e('tool', 't3', toolName: 'edit_file'),
        _e('agent_text', 'a1'),
      ]);
      expect(items.length, 2);
      expect(items[0], isA<ToolGroupRenderItem>());
      final g = items[0] as ToolGroupRenderItem;
      expect(g.tools.length, 3);
      expect(g.thinkings.length, 2);
      expect(items[1], isA<SingleRenderItem>());
    });

    test('edit/write 进组', () {
      final items = groupToolEntries([
        _e('tool', 'r1'),
        _e('tool', 'e1', toolName: 'edit_file'),
        _e('tool', 'r2'),
      ]);
      expect(items.length, 1);
      expect((items.single as ToolGroupRenderItem).tools.length, 3);
    });

    test('anyRunning / anyFailed', () {
      final g1 = ToolGroupRenderItem([
        _e('tool', 't1'),
        _e('tool', 't2', pending: true),
      ]);
      expect(g1.anyRunning, isTrue);
      expect(g1.anyFailed, isFalse);

      final g2 = ToolGroupRenderItem([
        _e('tool', 't1'),
        _e('tool', 't2', ok: false),
      ]);
      expect(g2.anyRunning, isFalse);
      expect(g2.anyFailed, isTrue);
    });

    test('组 key 稳定', () {
      final base = [_e('tool', 't1'), _e('tool', 't2')];
      final k1 = groupToolEntries(base).single.key;
      final k2 = groupToolEntries([...base, _e('tool', 't3')]).single.key;
      expect(k1, k2);
    });
  });

  group('buildTurnItems · 看图回灌不分轮', () {
    final inj = '[系统注入] 以下 1 张图片是工具 view_image 的返回内容, 不是用户的新消息:\n![](neox-image://${'a' * 64}.png)';
    test('完成的轮: 看图那条不把一轮拆成两轮, 最后只有一条真用户消息', () {
      final items = buildTurnItems([
        _e('user_message', 'u1', text: '看看这张截图哪里不对'),
        _e('tool', 't1', toolName: 'view_image'),
        _e('user_message', 'inj', text: inj),
        _e('tool', 't2', toolName: 'edit'),
        _e('agent_text', 'a1', text: '改好了'),
      ], running: false, mode: TimelineMode.work);
      final users = items.whereType<SingleRenderItem>().where((i) => i.entry.kind == 'user_message' && i.entry.id == 'u1');
      expect(users.length, 1);
      final procs = items.whereType<ProcessRenderItem>().toList();
      expect(procs.length, 1, reason: '一轮只有一个过程行');
      expect(procs.single.tools.map((e) => e.id), ['t1', 't2']);
      expect(items.whereType<SingleRenderItem>().any((i) => i.entry.id == 'inj'), isTrue, reason: '看图卡照常单列');
    });
    test('编码模式: 看图卡夹在两段过程行之间', () {
      final items = buildTurnItems([
        _e('user_message', 'u1', text: 'fix the layout'),
        _e('tool', 't1', toolName: 'view_image'),
        _e('user_message', 'inj', text: inj),
        _e('tool', 't2', toolName: 'edit'),
        _e('agent_text', 'a1', text: 'done'),
      ], running: false, mode: TimelineMode.code);
      expect(items.map((i) => i is ProcessRenderItem ? 'P' : (i as SingleRenderItem).entry.id).toList(), ['u1', 'P', 'inj', 'P', 'a1']);
    });
    test('计划提醒不显示也不分段', () {
      final items = buildTurnItems([
        _e('user_message', 'u1', text: 'go'),
        _e('tool', 't1'),
        _e('user_message', 'nudge', text: '[计划 · 已完成 1/3] 当前步骤: 写测试'),
        _e('tool', 't2'),
      ], running: false, mode: TimelineMode.code);
      expect(items.map((i) => i is ProcessRenderItem ? 'P${i.tools.length}' : (i as SingleRenderItem).entry.id).toList(), ['u1', 'P2']);
    });
  });

  group('diffLineStats / summarizeToolOps', () {
    test('edit old/new 行数', () {
      final s = diffLineStats('edit_file', {
        'old_string': 'a\nb\nc',
        'new_string': 'a\nb\nc\nd',
      });
      expect(s.dels, 3);
      expect(s.adds, 4);
    });

    test('ops 摘要', () {
      expect(
        summarizeToolOps(['edit_file', 'read_file', 'read_file', 'execute_shell']),
        '编辑 · 读取 ×2 · 命令',
      );
    });

    test('收起行一句话: 按种类计数, 顺序固定', () {
      expect(
        toolGroupSentence(['execute_shell', 'edit_file', 'execute_shell', 'write_file', 'read_file', 'grep']),
        '编辑了 2 个文件，读取了 1 个文件，搜索了 1 次，运行了 2 条命令',
      );
      expect(toolGroupSentence(['mcp_calendar_list']), '执行了 1 步操作');
      expect(toolGroupSentence(const []), '思考');
    });
  });
}
