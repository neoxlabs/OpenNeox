import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/desktop_run_status.dart';
import 'package:neox_app/features/timeline/state/running_sessions_provider.dart';

void main() {
  test('电脑上报的运行态: 列表整页 + 单条推送; idle 拿掉; 老电脑不带字段时不动', () {
    final c = ProviderContainer();
    addTearDown(c.dispose);
    final n = c.read(desktopRunStatusProvider.notifier);
    n.ingest([
      {'id': 'a', 'run_status': 'running'},
      {'id': 'b', 'run_status': 'awaiting_approval'},
      {'id': 'c', 'run_status': 'idle'},
    ]);
    expect(c.read(desktopRunStatusProvider), {'a': 'running', 'b': 'awaiting_approval'});
    n.ingest([{'id': 'a'}]); // 老电脑: 没有 run_status
    expect(c.read(desktopRunStatusProvider)['a'], 'running');
    n.set('a', 'idle');
    expect(c.read(desktopRunStatusProvider).containsKey('a'), isFalse);
  });

  test('在跑 / 等你 合并: 手机看过的 + 电脑上报的', () {
    final c = ProviderContainer();
    addTearDown(c.dispose);
    c.read(runningSessionsProvider.notifier).set('local', true);
    c.read(desktopRunStatusProvider.notifier)
      ..set('r', 'running')
      ..set('w', 'awaiting_user')
      ..set('p', 'paused');
    final live = c.read(liveSessionsProvider);
    expect(live.running, {'local', 'r'});
    expect(live.waiting, {'w'});
  });
}
