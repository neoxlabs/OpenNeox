/// stream_coalesce_test.dart — 流式增量必须合流, 不能一个 token 一次重建.
///
/// 2026-09-18 用户: 「apk 的 60fps 120hz 等要丝滑 丝滑 性能必须优异」。
///
/// 原来 onTextDelta 每条都 _notify() 一次: 模型一秒几十个 token = 一秒几十次
/// 整列重建, 而正在流的那条消息每次重建都要把**整段**文本重新解析一遍 markdown
/// —— 越长越慢, 总代价 O(n²)。屏幕上到 120Hz 后每帧只有 8.3ms, 更顶不住。
///
/// 这里数的是"重建次数", 不是时间: 时间在 CI/不同机器上不可比, 次数是确定的。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/stream_buffer_provider.dart';

void main() {
  testWidgets('100 个 token delta 只引起个位数重建', (t) async {
    var builds = 0;
    late ProviderContainer container;

    await t.pumpWidget(
      ProviderScope(
        child: Consumer(
          builder: (ctx, ref, _) {
            ref.watch(streamBufferProvider);
            builds++;
            return const SizedBox();
          },
        ),
      ),
    );
    container = ProviderScope.containerOf(
      t.element(find.byType(SizedBox)),
      listen: false,
    );
    final buffer = container.read(streamBufferProvider.notifier);
    builds = 0;

    /* 一口气来 100 个 delta —— 模型吐字就是这个形状 */
    for (var i = 0; i < 100; i++) {
      buffer.onTextDelta('s1', 'turn-1', '字');
    }
    await t.pump(); // 这一帧内已经发生的重建
    await t.pump(const Duration(milliseconds: 80)); // 合流窗口过去

    expect(
      builds,
      lessThanOrEqualTo(3),
      reason: '一个 token 一次重建 = 这里会是 ~100 次; 那正是流式卡顿的来源',
    );
    /* 内容一个字都不能少 —— 合流是少通知, 不是少数据 */
    final turn = container
        .read(streamBufferProvider)['s1']!
        .turns['turn-1']!;
    expect(turn.textBuffer.length, 100);
  });

  testWidgets('状态跳变仍然立刻生效 (不被合流拖慢)', (t) async {
    var builds = 0;
    await t.pumpWidget(
      ProviderScope(
        child: Consumer(
          builder: (ctx, ref, _) {
            ref.watch(streamBufferProvider);
            builds++;
            return const SizedBox();
          },
        ),
      ),
    );
    final container = ProviderScope.containerOf(
      t.element(find.byType(SizedBox)),
      listen: false,
    );
    final buffer = container.read(streamBufferProvider.notifier);
    builds = 0;

    /* 「我发出去了」这种反馈晚 50ms 是看得出来的, 必须同帧 */
    buffer.setPendingUserText('s1', '在吗');
    await t.pump();
    expect(builds, greaterThanOrEqualTo(1));

    builds = 0;
    buffer.ensureWaitingTurn('s1');
    await t.pump();
    expect(builds, greaterThanOrEqualTo(1), reason: '思考中占位也要立刻出现');
  });

  testWidgets('合流窗口内的 delta 之后跟一个立刻通知 → 不丢那批内容', (t) async {
    var builds = 0;
    await t.pumpWidget(
      ProviderScope(
        child: Consumer(
          builder: (ctx, ref, _) {
            ref.watch(streamBufferProvider);
            builds++;
            return const SizedBox();
          },
        ),
      ),
    );
    final container = ProviderScope.containerOf(
      t.element(find.byType(SizedBox)),
      listen: false,
    );
    final buffer = container.read(streamBufferProvider.notifier);

    buffer.onTextDelta('s1', 'turn-1', '半句话');
    /* 紧接着一个立刻通知的事件 (工具起跑) —— 它必须把上面那批一起带出去,
     * 否则"半句话"要等下一个 delta 才显示。 */
    buffer.onToolRunning('s1', 'turn-1', 'tool-1', 'shell', const {});
    builds = 0;
    await t.pump();

    expect(builds, greaterThanOrEqualTo(1));
    final turn = container.read(streamBufferProvider)['s1']!.turns['turn-1']!;
    expect(turn.textBuffer.toString(), '半句话');
  });
}
