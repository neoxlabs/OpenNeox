import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/pilot/pilot_patrol_filter.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

var _seq = 0;
TimelineEntry _e(String kind, [String? text]) =>
    TimelineEntry(id: '$kind-${_seq++}', kind: kind, sequence: _seq, timestamp: _seq, text: text);

List<String> _show(List<TimelineEntry> l) => [for (final e in l) e.text ?? e.kind];

void main() {
  test('没事的巡检整轮不显示 (触发 + 工具步骤 + [quiet])', () {
    final out = dropPilotPatrolNoise([
      _e('user_message', '帮我看看日程'), _e('agent_text', '好的'),
      _e('user_message', '<pilot-patrol>按分工看一眼</pilot-patrol>'), _e('tool'), _e('agent_text', '[quiet]'),
      _e('user_message', '明天呢'),
    ]);
    expect(_show(out), ['帮我看看日程', '好的', '明天呢']);
  });

  test('有事: 只藏触发那条, 回复和步骤照常显示', () {
    final out = dropPilotPatrolNoise([
      _e('user_message', '<pilot-patrol>x</pilot-patrol>'), _e('tool'), _e('agent_text', '下午三点的会改到四点了。'),
    ]);
    expect(_show(out), ['tool', '下午三点的会改到四点了。']);
  });

  test('还在跑 (没回复) 先藏着', () {
    final out = dropPilotPatrolNoise([_e('user_message', '你好'), _e('user_message', '<pilot-patrol>x</pilot-patrol>'), _e('tool')]);
    expect(_show(out), ['你好']);
  });

  test('没有巡检的会话原样返回 (同一个 List)', () {
    final list = [_e('user_message', 'a'), _e('agent_text', 'b')];
    expect(identical(dropPilotPatrolNoise(list), list), isTrue);
  });
}
