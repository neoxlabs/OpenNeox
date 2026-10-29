/// 时间线按模式分 (陶土稿 v5): 一轮的工具 / 思考 / 中间话收成一行「过程」, 回答留在外面;
/// 编码模式跑完在回答后面挂改动文件签. 摘要行的一句话按模式说.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';
import 'package:neox_app/features/timeline/widgets/process_row.dart';
import 'package:neox_app/features/timeline/widgets/tool_group_row.dart';

TimelineEntry _e(int seq, String kind, {String? text, String? tool, Map<String, dynamic>? args, String? output, bool ok = true, bool pending = false}) =>
    TimelineEntry(
      id: '$kind-$seq',
      kind: kind,
      sequence: seq,
      timestamp: 1000 + seq * 1000,
      text: text,
      toolName: tool,
      args: args,
      output: output,
      toolSuccess: ok,
      pending: pending,
    );

List<TimelineEntry> _codeTurn() => [
      _e(1, 'user_message', text: 'write fib and test it'),
      _e(2, 'agent_text', text: "I'll create the files."),
      _e(3, 'tool', tool: 'workspace_files', args: {'op': 'write', 'path': 'fib.py', 'content': 'a\nb\nc\n'}),
      _e(4, 'tool', tool: 'execute_shell', args: {'command': 'cd /workspace && python3 -m unittest'}, output: 'Ran 4 tests in 0.001s\n\nOK'),
      _e(5, 'agent_text', text: 'Done, all 4 tests pass.'),
    ];

void main() {
  test('编码: 跟桌面一样一段话 / 一行工具交替, 跑完也不整轮折起, 不挂文件签 (2026-10-21)', () {
    final items = buildTurnItems(_codeTurn(), running: false, mode: TimelineMode.code);
    expect(items.map((i) => i.runtimeType.toString()).toList(),
        ['SingleRenderItem', 'SingleRenderItem', 'ProcessRenderItem', 'SingleRenderItem']);
    expect((items[1] as SingleRenderItem).entry.text, "I'll create the files.");
    final p = items[2] as ProcessRenderItem;
    expect(p.entries.map((e) => e.id), ['tool-3', 'tool-4']);
    expect(p.running, isFalse);
    expect((items[3] as SingleRenderItem).entry.text, 'Done, all 4 tests pass.');
  });

  test('跑着时只有最末一段算在跑: 前面那段挂着没收到 done 的工具不再扫光 / 画计划卡 (2026-10-22 真机)', () {
    final items = buildTurnItems([
      _e(1, 'user_message', text: '按设计稿还原'),
      _e(2, 'tool', tool: 'edit_file', args: {'path': 'a.css'}, pending: true),
      _e(3, 'agent_text', text: '命令面板的输入框不该出现描边'),
      _e(4, 'tool', tool: 'edit_file', args: {'path': 'b.css'}, pending: true),
    ], running: true, mode: TimelineMode.work);
    final ps = items.whereType<ProcessRenderItem>().toList();
    expect(ps.length, 2);
    expect(ps.first.anyRunning, isFalse);
    expect(ps.last.anyRunning, isTrue);
  });

  test('编码: 跑完的空思考不单出一行', () {
    final items = buildTurnItems([..._codeTurn(), _e(6, 'agent_thinking', text: '')], running: false, mode: TimelineMode.code);
    expect(items.whereType<ProcessRenderItem>().length, 1);
  });

  test('回答后面跟一截收尾思考: 回答仍留在外面, 思考收进过程 (2026-10-15 远程会话「OK」被折走)', () {
    final items = buildTurnItems([
      _e(1, 'user_message', text: 'Reply OK'),
      _e(2, 'agent_thinking', text: ''),
      _e(3, 'agent_text', text: 'OK'),
      _e(4, 'agent_thinking', text: ''),
    ], running: false, mode: TimelineMode.work);
    final answers = items.whereType<SingleRenderItem>().where((i) => i.entry.kind == 'agent_text').toList();
    expect(answers.single.entry.text, 'OK');
    final p = items.whereType<ProcessRenderItem>().single;
    expect(p.entries.map((e) => e.id), ['agent_thinking-2', 'agent_thinking-4']);
  });

  test('编码摘要对齐桌面: 编辑 fib.py · 运行 1 条命令; Windows 路径只留文件名', () {
    final p = buildTurnItems(_codeTurn(), running: false, mode: TimelineMode.code)[2] as ProcessRenderItem;
    expect(codeDigest(p), '编辑 fib.py · 运行 1 条命令');
    final win = ProcessRenderItem([
      _e(1, 'tool', tool: 'edit_file', args: {'path': r'e:\code\ltoa\src\a.ts', 'old_string': 'x', 'new_string': 'y'}),
      _e(2, 'tool', tool: 'edit_file', args: {'path': r'e:\code\ltoa\src\b.ts', 'old_string': 'x', 'new_string': 'y'}),
    ], running: false, isLatestTurn: true);
    expect(codeDigest(win), '编辑 a.ts 等 2 个');
  });

  test('跑着的一轮不挂改动签, 摘要说已做几步', () {
    final turn = _codeTurn().sublist(0, 4)..add(_e(5, 'tool', tool: 'execute_shell', args: {'command': 'ls'}, pending: true));
    final items = buildTurnItems(turn, running: true, mode: TimelineMode.code);
    expect(items.whereType<FilesFooterRenderItem>(), isEmpty);
    final p = items.whereType<ProcessRenderItem>().single;
    expect(processSummary(p, TimelineMode.code), startsWith('已做 3 步'));
  });

  test('一步怎么说: 新建带 +N, 命令去掉 cd 前缀、跑过的测试是绿签', () {
    final t = _codeTurn();
    final write = stepViewOf(t[2]);
    expect(write.prefix, '新建');
    expect(write.result, '+3');
    final shell = stepViewOf(t[3]);
    expect(shell.target, 'python3 -m unittest');
    expect(shell.result, '4 通过');
  });

  test('失败的命令: exit 签 + 一行错误', () {
    final v = stepViewOf(_e(9, 'tool', tool: 'execute_shell', args: {'command': 'npm test'}, output: 'Error: cannot find module\nexit code 1', ok: false));
    expect(v.result, 'exit 1');
    expect(v.error, 'Error: cannot find module');
  });
}
