/// pilot_chat_merge_test.dart — live 与账本回读并成一条时间线 (pilot:U-08).
///
/// 验收: 连续 20 轮, 每轮都说一句、账本再回读一遍, 屏幕上每句话只有一个气泡。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/pilot/pilot_chat_merge.dart';

class _Row {
  _Row(this.id, this.role, this.text, this.at);
  int? id;
  final String role;
  final String text;
  final DateTime at;
}

List<_Row> _merge(List<_Row> local, List<_Row> ledger) => mergePilotChatLines<_Row>(
      local: local,
      ledger: ledger,
      idOf: (r) => r.id,
      roleOf: (r) => r.role,
      textOf: (r) => r.text,
      atOf: (r) => r.at,
      matched: (mine, row) {
        mine.id = row.id;
        return mine;
      },
    );

void main() {
  test('20 轮 live + 账本回读: 每句只有一个气泡', () {
    final t0 = DateTime(2026, 10, 18, 9);
    final local = <_Row>[];
    final ledger = <_Row>[];
    var id = 0;
    for (var i = 0; i < 20; i++) {
      final at = t0.add(Duration(minutes: i));
      local.add(_Row(null, 'user', '第 $i 句', at));
      ledger.add(_Row(++id, 'user', '第 $i 句', at.add(const Duration(seconds: 1))));
      local.add(_Row(null, 'assistant', '回第 $i 句', at.add(const Duration(seconds: 5))));
      ledger.add(_Row(++id, 'assistant', '回第 $i 句', at.add(const Duration(seconds: 7))));
    }
    final merged = _merge(local, ledger);

    expect(merged.length, 40, reason: '不是 80: live 和账本说的是同一句');
    expect(merged.map((r) => '${r.role}|${r.text}').toSet().length, 40, reason: '没有重复气泡');
    expect(merged.first.text, '第 0 句');
    expect(merged.last.text, '回第 19 句');
    expect(merged.every((r) => r.id != null), isTrue, reason: '并进去的本地行拿回了账本 id');
  });

  test('还没落账的本地行留着, 而且只留一次', () {
    final at = DateTime(2026, 10, 18, 9);
    final merged = _merge(
      [_Row(null, 'user', '刚发出去的一句', at)],
      [_Row(1, 'assistant', '之前的回话', at.subtract(const Duration(minutes: 1)))],
    );
    expect(merged.map((r) => r.text), ['之前的回话', '刚发出去的一句']);
  });

  test('同一句话隔了很久真的说两次, 是两条', () {
    final at = DateTime(2026, 10, 18, 9);
    final merged = _merge(
      [_Row(null, 'assistant', '好', at)],
      [
        _Row(1, 'assistant', '好', at.subtract(const Duration(minutes: 30))),
        _Row(2, 'assistant', '好', at.add(const Duration(seconds: 3))),
      ],
    );
    expect(merged.length, 2);
  });

  test('账本里同一个 id 重复出现只留一条', () {
    final at = DateTime(2026, 10, 18, 9);
    final merged = _merge([], [_Row(7, 'assistant', '你好', at), _Row(7, 'assistant', '你好', at)]);
    expect(merged.length, 1);
  });
}
