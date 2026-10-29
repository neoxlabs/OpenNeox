/// context_gauge_test.dart — 上下文占用换算 + 阈值配色.
///
/// 这块直接影响用户"还能不能接着聊"的判断, 数字算错比不显示更坏。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/session_context_provider.dart';
import 'package:neox_app/features/home/widgets/context_gauge.dart';
import 'package:neox_app/shared/theme/neox_tokens.dart';

SessionContextInfo info({int? window, int used = 0}) => SessionContextInfo(
      contextWindow: window,
      modelId: 'm',
      modelName: 'M',
      contextTokens: used,
    );

void main() {
  const scheme = ColorScheme.light();

  group('ContextUsage.from — 没数据就不显示 (宁可不画, 不能画错)', () {
    test('info 为 null', () => expect(ContextUsage.from(null), isNull));
    test('还没跑过 turn (used=0) — window 已知也不显示', () {
      expect(ContextUsage.from(info(window: 200000, used: 0)), isNull);
    });

    test('window 为 0 不能除零', () {
      final u = ContextUsage.from(info(window: 0, used: 100))!;
      expect(u.ratio, 0);
      expect(u.totalKnown, isFalse);
    });
  });

  group('窗口未知但已用已知 — 仍要显示 (真机: 桌面 used=22808 手机全空)', () {
    test('contextWindow 为 null 时不返回 null', () {
      final u = ContextUsage.from(info(window: null, used: 22808));
      expect(u, isNotNull);
      expect(u!.totalKnown, isFalse);
      expect(u.label, '已用 22.8k');
    });

    test('窗口未知时颜色保持安静 (算不出比例就不该报警)', () {
      final u = ContextUsage.from(info(window: null, used: 999999))!;
      expect(u.color(scheme), scheme.onSurfaceVariant);
    });

    testWidgets('窗口未知时不画环 (画满圈或空圈都是撒谎)', (tester) async {
      final u = ContextUsage.from(info(window: null, used: 22808));
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: ContextRing(usage: u)),
      ));
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });
  });

  test('比例与百分比', () {
    final u = ContextUsage.from(info(window: 200000, used: 45200))!;
    expect(u.ratio, closeTo(0.226, 0.001));
    expect(u.percent, 23);
    expect(u.totalKnown, isTrue);
  });

  test('超出 window 时钳到 100% — 环不能画超过一圈', () {
    final u = ContextUsage.from(info(window: 1000, used: 5000))!;
    expect(u.ratio, 1.0);
    expect(u.percent, 100);
  });

  group('label 数字格式', () {
    String label(int used, int total) =>
        ContextUsage.from(info(window: total, used: used))!.label;

    test('k 级别保留一位小数', () {
      expect(label(45200, 200000), '45.2k / 200k · 23%');
    });
    test('≥100k 不要小数点 (省宽度)', () {
      expect(label(128000, 200000), '128k / 200k · 64%');
    });
    test('小于 1000 直接显示原值', () {
      expect(label(512, 8000), '512 / 8.0k · 6%');
    });
    test('M 级别', () {
      expect(label(1500000, 2000000), '1.5M / 2.0M · 75%');
    });
  });

  group('阈值配色 — 60% 提醒, 80% 警示', () {
    Color colorAt(double ratio) {
      final total = 100000;
      return ContextUsage.from(
        info(window: total, used: (total * ratio).round()),
      )!
          .color(scheme);
    }

    test('低占用保持安静 (不抢注意力)', () {
      expect(colorAt(0.1), scheme.onSurfaceVariant);
      expect(colorAt(0.59), scheme.onSurfaceVariant);
    });
    test('60% 起转提醒色', () {
      expect(colorAt(0.60), NeoxClaudePalette.warning);
      expect(colorAt(0.79), NeoxClaudePalette.warning);
    });
    test('80% 起转警示色', () {
      expect(colorAt(0.80), scheme.error);
      expect(colorAt(1.0), scheme.error);
    });
  });

  testWidgets('ContextRing 无数据时不占位', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: ContextRing(usage: null)),
    ));
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('ContextRing 有数据时画环, 且不吃点击 (点击穿到底下的 [+])',
      (tester) async {
    var tapped = 0;
    final u = ContextUsage.from(info(window: 1000, used: 500));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Stack(
          alignment: Alignment.center,
          children: [
            ContextRing(usage: u),
            GestureDetector(
              /* 空 SizedBox 在 deferToChild 下没有命中区 —— 显式 opaque,
               * 这样这条断言测的才是"环不挡点击", 而不是测试自己的布局 */
              behavior: HitTestBehavior.opaque,
              onTap: () => tapped++,
              child: const SizedBox(width: 24, height: 24),
            ),
          ],
        ),
      ),
    ));
    final ring = tester.widget<CircularProgressIndicator>(
      find.byType(CircularProgressIndicator),
    );
    expect(ring.value, 0.5);
    await tester.tap(find.byType(GestureDetector));
    expect(tapped, 1, reason: '环必须 IgnorePointer, 否则挡住 [+] 按钮');
  });
}
