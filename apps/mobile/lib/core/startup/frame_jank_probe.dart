/// frame_jank_probe.dart — 帧耗时探针 (只在 profile 包里开).
///
/// **为什么要自带探针** (2026-09-18「丝滑 性能必须优异」)
///
/// `adb shell dumpsys gfxinfo` 对 Flutter app **一律报 0 帧** —— Flutter 在自己的
/// surface 上渲, 不喂 HWUI 那套统计。拿它量等于没量 (这次实测踩到: 滑了几十下,
/// Total frames rendered: 0)。模拟器的 raster 时间也不代表真机。
///
/// 能信的只有引擎自己给的 [FrameTiming]: 每帧的 build (UI 线程) 和 raster
/// (GPU 线程) 耗时。这里把它按窗口聚合成一行能读的日志:
///
///   [frame] 300 帧 · 120Hz(8.3ms) · build p50/p95/p99 1.2/3.4/9.8ms ·
///           raster p50/p95 2.1/5.0ms · 掉帧 4 (1.3%) · 最差 21ms
///
/// 判据是**当前刷新率对应的预算**, 不是写死 16.7ms: 120Hz 上 10ms 的帧就是掉帧,
/// 而 60Hz 上不是 —— 用固定阈值量高刷设备会把问题量没了
/// (同类教训见 memory「动效性能指标别有偏」)。
///
/// release 包里完全不装: 探针本身每帧有回调开销, 不该让用户付。
library;

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

class FrameJankProbe {
  FrameJankProbe._();

  static Timer? _reportTimer;
  static final List<int> _buildUs = <int>[];
  static final List<int> _rasterUs = <int>[];

  /// 每多久汇报一次.
  static const _window = Duration(seconds: 10);

  /// 装上探针. profile 包才会真的装 (debug 包的 UI 耗时没有参考价值 ——
  /// 没有 AOT, 一帧几十毫秒是常态, 会把人往错的地方带)。
  static void install() {
    if (!kProfileMode) return;
    SchedulerBinding.instance.addTimingsCallback(_onTimings);
    _reportTimer = Timer.periodic(_window, (_) => _report());
  }

  static void _onTimings(List<FrameTiming> timings) {
    for (final t in timings) {
      _buildUs.add(t.buildDuration.inMicroseconds);
      _rasterUs.add(t.rasterDuration.inMicroseconds);
    }
    /* 别让样本无限长: 只看最近一个窗口的形状 */
    const cap = 2000;
    if (_buildUs.length > cap) {
      _buildUs.removeRange(0, _buildUs.length - cap);
      _rasterUs.removeRange(0, _rasterUs.length - cap);
    }
  }

  static double _pct(List<int> sorted, double p) {
    if (sorted.isEmpty) return 0;
    final i = ((sorted.length - 1) * p).round();
    return sorted[i] / 1000.0;
  }

  static void _report() {
    if (_buildUs.isEmpty) return;
    final build = [..._buildUs]..sort();
    final raster = [..._rasterUs]..sort();

    /* 预算 = 1 / 当前刷新率。拿不到就按 60Hz 算 (保守, 不会虚报优秀)。 */
    /* 取主 view 的刷新率 —— 高刷切换之后这个值会变, 每次汇报都重新读 */
    final views = SchedulerBinding.instance.platformDispatcher.views;
    final hz = views.isEmpty ? 0.0 : views.first.display.refreshRate;
    final budgetMs = (hz > 0 ? 1000.0 / hz : 16.7);

    var janky = 0;
    var worstMs = 0.0;
    for (var i = 0; i < _buildUs.length; i++) {
      final totalMs = (_buildUs[i] + _rasterUs[i]) / 1000.0;
      if (totalMs > budgetMs) janky++;
      if (totalMs > worstMs) worstMs = totalMs;
    }
    final n = _buildUs.length;
    debugPrint(
      '[frame] $n 帧 · ${hz.toStringAsFixed(0)}Hz(${budgetMs.toStringAsFixed(1)}ms) · '
      'build p50/p95/p99 ${_pct(build, .5).toStringAsFixed(1)}/'
      '${_pct(build, .95).toStringAsFixed(1)}/'
      '${_pct(build, .99).toStringAsFixed(1)}ms · '
      'raster p50/p95 ${_pct(raster, .5).toStringAsFixed(1)}/'
      '${_pct(raster, .95).toStringAsFixed(1)}ms · '
      '掉帧 $janky (${(janky * 100 / n).toStringAsFixed(1)}%) · '
      '最差 ${worstMs.toStringAsFixed(1)}ms',
    );
    _buildUs.clear();
    _rasterUs.clear();
  }

  static void dispose() {
    _reportTimer?.cancel();
    _reportTimer = null;
  }
}
