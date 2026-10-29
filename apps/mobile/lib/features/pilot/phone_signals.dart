/// phone_signals.dart — 手机上发生的事交给 Pilot 判断 (2026-10-01, 10-03 改成交给云端的它)。
///
/// 新通知 (含短信、未接来电 —— 它们在安卓上都是通知) 由 NeoxNotificationListener 收到, 攒 3 秒一批
/// 交给 pilot_talk.dart: 广告 / 验证码 / 系统杂音丢掉, 要紧的叫醒云端的它。
///   · 没开通 Pilot 的账号什么都不发
///   · App 回到前台时按「上次交过的时间」补拉一遍 —— App 在后台被杀过也不漏
///   · 只在安卓、且用户给了「通知使用权」时有东西可发
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auto_ledger.dart';
import 'pilot_link.dart';
import 'pilot_talk.dart';

const _ch = MethodChannel('neox.phone/tools');
const _kLastSent = 'pilot_signals_last_sent_ms';
/* 太久以前的不补: 一周没开 App, 补推几百条旧通知只会让 Pilot 一顿乱报 */
const _maxBackfill = Duration(hours: 6);

class PhoneSignals with WidgetsBindingObserver {
  PhoneSignals(this._ref);
  final Ref _ref;

  final List<Map<String, Object?>> _queue = [];
  Timer? _debounce;
  bool _sending = false;
  int _lastSent = 0;

  Future<void> start() async {
    if (!Platform.isAndroid) return;
    final prefs = await SharedPreferences.getInstance();
    _lastSent = prefs.getInt(_kLastSent) ?? 0;
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'notificationPosted' && call.arguments is Map) {
        _queue.add(Map<String, Object?>.from(call.arguments as Map));
        _debounce?.cancel();
        _debounce = Timer(const Duration(seconds: 3), () => unawaited(flush()));
      }
      return null;
    });
    WidgetsBinding.instance.addObserver(this);
    unawaited(flush(backfill: true));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(flush(backfill: true));
      /* 从系统设置给完权限回来要认得; 银行短信补拉 (按时刻去重, 重复读不会记两遍) */
      final ledger = _ref.read(autoLedgerProvider.notifier);
      unawaited(ledger.refresh().then((_) => ledger.backfillSms(const Duration(days: 2))));
    }
  }

  /// 交出去; [backfill] = 先把 App 不在时漏掉的补拉进来
  Future<void> flush({bool backfill = false}) async {
    if (!Platform.isAndroid || _sending) return;
    _sending = true;
    try {
      if (!await _ref.read(pilotLinkProvider).available()) {
        _queue.clear();
        return;
      }
      if (backfill) {
        final floor = DateTime.now().subtract(_maxBackfill).millisecondsSinceEpoch;
        final since = _lastSent > floor ? _lastSent : floor;
        final missed = await _ch.invokeMethod<List>('notificationsSince', {'sinceMs': since}).catchError((_) => null);
        for (final m in missed ?? const []) {
          if (m is! Map) continue;
          final item = Map<String, Object?>.from(m);
          final dup = _queue.any((q) => q['at'] == item['at'] && q['title'] == item['title'] && q['package'] == item['package']);
          if (!dup) _queue.add(item);
        }
      }
      if (_queue.isEmpty) return;
      final batch = List<Map<String, Object?>>.from(_queue);
      _queue.clear();
      /* 支付 / 银行动账顺手记一笔 (自动记账开着才记) */
      unawaited(_ref.read(autoLedgerProvider.notifier).ingest(batch).catchError((_) => 0));
      _ref.read(pilotTalkProvider).onSignals(batch);
      final newest = batch.map((e) => (e['at'] as num?)?.toInt() ?? 0).fold<int>(_lastSent, (a, b) => b > a ? b : a);
      _lastSent = newest;
      await (await SharedPreferences.getInstance()).setInt(_kLastSent, newest);
    } catch (_) {
      if (_queue.length > 200) _queue.removeRange(0, _queue.length - 200);
    } finally {
      _sending = false;
    }
  }
}

/// App 壳上常驻 (app.dart 里 read 一次)
final phoneSignalsProvider = Provider<PhoneSignals>((ref) {
  final s = PhoneSignals(ref);
  unawaited(s.start());
  return s;
});
