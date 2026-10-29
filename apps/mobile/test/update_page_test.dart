/// update_page_test.dart — 更新页在三种状态下都要能渲染出来.
///
/// 这一页是 2026-09-17 新拆出来的 (原来只有首页顶部那条横幅)。它平时看不见 ——
/// 只有真有新版时用户才会进来, 而那一刻恰恰不能白屏/报错。三种状态各钉一条:
/// 已是最新 / 有新版待下载 / 正在下载 (进度+速度+剩余)。
///
/// 分段下载的区间划分也在这里钉死: 算错偏移写出来的 APK 装不上, 而"装不上"
/// 这种失败要等用户点了安装才暴露。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/startup/apk_updater.dart';
import 'package:neox_app/core/startup/app_update.dart';
import 'package:neox_app/features/settings/update_page.dart';

class _FakeUpdater extends ApkUpdater {
  _FakeUpdater(ApkUpdateState initial) {
    state = initial;
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required AppUpdateStatus status,
  ApkUpdateState updater = const ApkUpdateState(),
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        appUpdateStatusProvider.overrideWith((ref) async => status),
        apkUpdaterProvider.overrideWith((ref) => _FakeUpdater(updater)),
      ],
      child: const MaterialApp(home: UpdatePage()),
    ),
  );
  /* pumpAndSettle 而不是单次 pump: 页面 initState 会按窗口 invalidate 清单
   * (2026-09-22 起), override 的 async provider 要多一帧才落定. */
  await tester.pumpAndSettle();
}

/// 造一个"进页面之前缓存里已经有清单"的容器, 用来钉"进页面必须重拉"。
({ProviderContainer container, int Function() calls}) _counting() {
  var calls = 0;
  final container = ProviderContainer(
    overrides: [
      appUpdateStatusProvider.overrideWith((ref) async {
        calls++;
        return const AppUpdateStatus(currentVersion: '3.3.3');
      }),
      apkUpdaterProvider.overrideWith(
        (ref) => _FakeUpdater(const ApkUpdateState()),
      ),
    ],
  );
  return (container: container, calls: () => calls);
}

void main() {
  const current = AppUpdateStatus(currentVersion: '3.3.3');
  const available = AppUpdateStatus(
    currentVersion: '3.3.3',
    latestVersion: '3.3.4',
    downloadUrl: 'https://dl.example.test/neox-3.3.4.apk',
    sizeBytes: 99165528,
  );

  testWidgets('已是最新 — 不给下载按钮', (tester) async {
    await _pump(tester, status: current);
    expect(find.text('已是最新'), findsOneWidget);
    expect(find.text('下载并安装'), findsNothing);
  });

  /* 2026-09-22「app 端怎么更新 404??」: 清单缓存整个进程不释放 (首页强更闸门
   * 常驻 watch), 页面不主动重检就一直在看过期清单 —— 里面的下载直链指向的 APK
   * 早被发包脚本清掉了, 用户点更新直接 404。 */
  testWidgets('进页面时清单过期就必须重拉 — 不吃缓存', (tester) async {
    final c = _counting();
    addTearDown(c.container.dispose);

    /* 先在别处读一次 —— 模拟"缓存里已经有一份清单了" */
    await c.container.read(appUpdateStatusProvider.future);
    expect(c.calls(), 1);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c.container,
        child: const MaterialApp(home: UpdatePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      c.calls(),
      greaterThan(1),
      reason: '进更新页必须重新拉清单, 否则界面一直显示过期版本, 点更新就是 404',
    );
  });

  testWidgets('重检后界面仍按最新结果渲染', (tester) async {
    final c = _counting();
    addTearDown(c.container.dispose);
    await c.container.read(appUpdateStatusProvider.future);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c.container,
        child: const MaterialApp(home: UpdatePage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('已是最新'), findsOneWidget);
  });

  testWidgets('有新版 — 报版本号和大小, 给一个下载按钮', (tester) async {
    await _pump(tester, status: available);
    /* 陶土稿 v5: 大字「Neox 3.3.4」, 下面一行「当前 → 新版 · 大小」 */
    expect(find.text('Neox 3.3.4'), findsOneWidget);
    expect(find.textContaining('94.6 MB'), findsOneWidget);
    expect(find.text('下载并安装'), findsOneWidget);
  });

  testWidgets('下载中 — 进度/速度/剩余都在, 不再显示按钮', (tester) async {
    await _pump(
      tester,
      status: available,
      updater: const ApkUpdateState(
        phase: ApkUpdatePhase.downloading,
        receivedBytes: 20 * 1048576,
        totalBytes: 100 * 1048576,
        bytesPerSecond: 4 * 1048576,
      ),
    );
    expect(find.textContaining('20.0 / 100.0 MB'), findsOneWidget);
    expect(find.textContaining('4.0 MB/s'), findsOneWidget);
    expect(find.textContaining('约 20 秒'), findsOneWidget);
    expect(find.text('下载并安装'), findsNothing);
  });

  group('速度 / 剩余时间的文案', () {
    test('没有样本时不写速度, 也不编剩余时间', () {
      const s = ApkUpdateState(receivedBytes: 1, totalBytes: 100);
      expect(s.speedLabel, '');
      expect(s.etaLabel, '');
    });

    test('不足 1MB/s 用 KB/s', () {
      const s = ApkUpdateState(bytesPerSecond: 512 * 1024);
      expect(s.speedLabel, '512 KB/s');
    });

    test('超过一分钟按分钟报', () {
      const s = ApkUpdateState(
        receivedBytes: 0,
        totalBytes: 100 * 1048576,
        bytesPerSecond: 1048576,
      );
      expect(s.etaLabel, '约 2 分钟');
    });
  });

  group('分段下载的区间 — 错一个字节, 装的时候才会发现', () {
    final updater = ApkUpdater();

    test('首段从 0 开始, 末段刚好收在 total-1, 中间不重不漏', () {
      for (final total in [
        8 * 1024 * 1024 + 1,
        99165528,
        4 * 1024 * 1024 * 7,
      ]) {
        final segs = updater.debugPlanSegments(total);
        expect(segs.first.$1, 0, reason: 'total=$total 首段起点');
        expect(segs.last.$2, total - 1, reason: 'total=$total 末段终点');
        for (var i = 1; i < segs.length; i++) {
          expect(
            segs[i].$1,
            segs[i - 1].$2 + 1,
            reason: 'total=$total 第 $i 段要紧接上一段',
          );
        }
        final covered = segs.fold<int>(0, (a, s) => a + (s.$2 - s.$1 + 1));
        expect(covered, total, reason: 'total=$total 覆盖总长');
      }
    });

    test('并发上限不超过 4 段', () {
      expect(updater.debugPlanSegments(2 * 1024 * 1024 * 1024).length, 4);
    });

    test('小包不分段', () {
      expect(updater.debugPlanSegments(1024).length, 1);
    });
  });
}
