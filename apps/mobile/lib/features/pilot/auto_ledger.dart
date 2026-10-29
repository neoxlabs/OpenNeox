/// auto_ledger.dart — 自动记账 + 每晚问一句 (2026-10-11)。
///
/// 用户: 「老式记账太难用 …… 一般来源是读取短信、读取通知, 做好弹窗让用户授予权限, 这是最自动的方式;
/// 另外每天提醒用户, 或者用户自己跟它说今天花了多少, 或者截图」。
///
///   自动    通知使用权 (支付宝 / 微信支付 / 银行 App) 实时 + 读短信 (银行短信, 开通时补最近 7 天)
///           → payment_parser 在手机上识别 → 一笔 finance.expense / income, source = device:phone:auto
///   去重    同一笔常常来两遍 (银行短信 + 支付宝通知): 3 分钟内同金额只记一次
///   每晚    21:30 本地通知「今天花了多少? 跟我说一句」, 点开进 Pilot
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/llm/llm_http.dart';
import '../../core/local_agent/model_gateway_client.dart';
import '../../core/notifications/local_notifications.dart';
import '../../core/pilot/payment_parser.dart';
import '../../core/pilot/pilot_cloud.dart';

const _ch = MethodChannel('neox.phone/tools');
const _kOn = 'pilot_auto_ledger_on_v1';
const _kSeen = 'pilot_auto_ledger_seen_v1';
const _kCheckin = 'pilot_checkin_on_v1';
const _kCheckinId = 0x5049_4c54; // 'PILT', 固定 id: 重排覆盖同一条
const _sameWindow = Duration(minutes: 3);
/* 看截图: 平台目录里能看图又便宜的 (一张截图约 1~2 千 token, 不到一分钱) */
const _visionModel = 'gemini-3.6-flash';
const _screenCats = {'吃饭', '交通', '居家', '衣着', '购物', '其它'};

class AutoLedgerState {
  const AutoLedgerState({this.on = false, this.notif = false, this.sms = false, this.checkin = false, this.added = 0});
  /// 用户开了自动记账 (开关), 不等于权限都在
  final bool on;
  final bool notif;
  final bool sms;
  final bool checkin;
  /// 这次打开 App 以来自动记了几笔 —— 记录页据此掉金币
  final int added;
  bool get working => on && (notif || sms);

  AutoLedgerState copyWith({bool? on, bool? notif, bool? sms, bool? checkin, int? added}) => AutoLedgerState(
        on: on ?? this.on, notif: notif ?? this.notif, sms: sms ?? this.sms, checkin: checkin ?? this.checkin, added: added ?? this.added);
}

class AutoLedger extends Notifier<AutoLedgerState> {
  /* 最近记过的 (金额, 时刻): 去重用, 存 300 条 */
  List<(double, int)> _seen = [];
  bool _loaded = false;

  @override
  AutoLedgerState build() {
    unawaited(refresh());
    return const AutoLedgerState();
  }

  Future<void> _load(SharedPreferences p) async {
    if (_loaded) return;
    _loaded = true;
    try {
      _seen = [for (final x in jsonDecode(p.getString(_kSeen) ?? '[]') as List) ((x[0] as num).toDouble(), (x[1] as num).toInt())];
    } catch (_) {}
  }

  /// 读开关 + 系统权限 (从系统设置回来时再调一次)
  Future<void> refresh() async {
    final p = await SharedPreferences.getInstance();
    await _load(p);
    var notif = false, sms = false;
    if (Platform.isAndroid) {
      try {
        final s = await _ch.invokeMethod<Map>('status');
        notif = s?['notifications'] == true;
        sms = s?['readSms'] == true;
      } catch (_) {}
    }
    state = state.copyWith(on: p.getBool(_kOn) ?? false, notif: notif, sms: sms, checkin: p.getBool(_kCheckin) ?? false);
  }

  /// 打开自动记账。通知使用权只能去系统设置页给 (回来由 refresh 确认); 短信是运行时弹框, 给了就补最近 7 天。
  Future<void> enable({required bool notif, required bool sms}) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kOn, true);
    state = state.copyWith(on: true);
    if (sms && !state.sms) {
      final r = await _ch.invokeMethod<Map>('ensure', {'permissions': ['android.permission.READ_SMS']}).catchError((_) => null);
      if (r?['android.permission.READ_SMS'] == true) {
        state = state.copyWith(sms: true);
        unawaited(backfillSms(const Duration(days: 7)));
      }
    } else if (state.sms) {
      unawaited(backfillSms(const Duration(days: 2)));
    }
    if (notif && !state.notif) await _ch.invokeMethod('openNotificationAccess').catchError((_) => null);
  }

  Future<void> disable() async {
    await (await SharedPreferences.getInstance()).setBool(_kOn, false);
    state = state.copyWith(on: false);
  }

  /// 短信里的银行动账补进来 (开通时 / 回到前台时)
  Future<int> backfillSms(Duration back) async {
    if (!Platform.isAndroid || !state.on || !state.sms) return 0;
    try {
      final list = await _ch.invokeMethod<List>('readSms', {
        'limit': 300,
        'sinceMs': DateTime.now().subtract(back).millisecondsSinceEpoch,
      });
      return ingest([
        for (final m in list ?? const [])
          if (m is Map) {'package': 'sms', 'title': m['from'], 'text': m['text'], 'at': m['at']},
      ]);
    } catch (e) {
      debugPrint('[auto-ledger] 读短信失败: $e');
      return 0;
    }
  }

  /// 一批通知 / 短信 → 认得出的记一笔。返回记了几笔。
  Future<int> ingest(List<Map<String, Object?>> items) async {
    if (!state.on) return 0;
    final api = ref.read(pilotCloudProvider)?.records;
    if (api == null) return 0;
    final p = await SharedPreferences.getInstance();
    await _load(p);
    final out = <Map<String, Object?>>[];
    for (final it in items) {
      final pay = parsePayment(pkg: '${it['package'] ?? ''}', title: '${it['title'] ?? ''}', text: '${it['text'] ?? ''}');
      if (pay == null) continue;
      final at = (it['at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
      final dup = _seen.any((s) => s.$1 == pay.amount && (s.$2 - at).abs() < _sameWindow.inMilliseconds);
      if (dup) continue;
      _seen.add((pay.amount, at));
      out.add(pay.toRecord(DateTime.fromMillisecondsSinceEpoch(at)));
    }
    if (out.isEmpty) return 0;
    if (_seen.length > 300) _seen = _seen.sublist(_seen.length - 300);
    await p.setString(_kSeen, jsonEncode([for (final s in _seen) [s.$1, s.$2]]));
    await api.log(out);
    state = state.copyWith(added: state.added + out.length);
    return out.length;
  }

  /// 截图 (账单页 / 小票 / 转账记录) → 识别出的几笔, 给用户勾完再记。看图用便宜的视觉模型, 走网关计费。
  Future<List<({ParsedPayment pay, DateTime at})>> readScreenshot(Uint8List bytes, {String mime = 'image/jpeg'}) async {
    final auth = await ref.read(modelGatewayClientProvider).streamAuth();
    final now = DateTime.now();
    final today = '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    final body = jsonEncode({
      'model': _visionModel,
      'stream': false,
      'max_tokens': 1200,
      'messages': [
        {
          'role': 'user',
          'content': [
            {
              'type': 'text',
              'text': '从这张截图里找出真实发生的每一笔收支 (账单列表、小票、转账、订单都算; 广告、优惠、余额、待付款不算)。'
                  '今天是 $today。只回 JSON 数组, 不要别的字:\n'
                  '[{"amount":35.5,"income":false,"merchant":"商户或用途","category":"吃饭|交通|居家|衣着|购物|其它","time":"YYYY-MM-DD HH:mm 或 null"}]\n'
                  '一笔都没有就回 []。',
            },
            {'type': 'image_url', 'image_url': {'url': 'data:$mime;base64,${base64Encode(bytes)}'}},
          ],
        },
      ],
    });
    final r = await ref
        .read(llmHttpClientProvider)
        .post(Uri.parse(auth.url), headers: {...auth.headers, 'Accept': 'application/json'}, body: body)
        .timeout(const Duration(seconds: 90));
    if (r.statusCode >= 400) throw StateError('识别失败 (${r.statusCode})');
    final j = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
    final text = '${((j['choices'] as List).first as Map)['message']?['content'] ?? ''}';
    final m = RegExp(r'\[[\s\S]*\]').firstMatch(text);
    if (m == null) return const [];
    final out = <({ParsedPayment pay, DateTime at})>[];
    for (final x in jsonDecode(m.group(0)!) as List) {
      if (x is! Map) continue;
      final amount = (x['amount'] as num?)?.toDouble().abs();
      if (amount == null || amount <= 0 || amount >= 1000000) continue;
      final income = x['income'] == true;
      final merchant = '${x['merchant'] ?? ''}'.trim();
      final cat = '${x['category'] ?? ''}';
      final at = DateTime.tryParse('${x['time'] ?? ''}'.replaceFirst(' ', 'T'));
      out.add((
        pay: ParsedPayment(
          amount: amount,
          income: income,
          via: '截图',
          merchant: merchant.isEmpty ? null : merchant,
          category: income ? '收入' : (_screenCats.contains(cat) ? cat : guessCategory(merchant)),
        ),
        at: at == null || at.isAfter(now) ? now : at,
      ));
    }
    return out;
  }

  /// 勾选完的截图账目记下
  Future<void> logScreenshot(List<({ParsedPayment pay, DateTime at})> items) async {
    final api = ref.read(pilotCloudProvider)?.records;
    if (api == null || items.isEmpty) return;
    await api.log([
      for (final it in items) {...it.pay.toRecord(it.at), 'source': 'device:phone:screenshot', 'tags': const ['screenshot']},
    ]);
    state = state.copyWith(added: state.added + items.length);
  }

  /// 每晚 21:30 问一句
  Future<void> setCheckin(bool on) async {
    await (await SharedPreferences.getInstance()).setBool(_kCheckin, on);
    state = state.copyWith(checkin: on);
    if (on) {
      await _scheduleCheckin(null);
    } else {
      await LocalNotifications.cancelReminder(_kCheckinId);
    }
  }

  /// 每次看到新的洞察就把今晚那条换成最要紧的一件 (「42 天没和妈妈联系了」比「今天花了多少」更值得一看)
  Future<void> refreshCheckin(String? topHint) async {
    if (!state.checkin) return;
    await _scheduleCheckin(topHint);
  }

  Future<void> _scheduleCheckin(String? hint) => LocalNotifications.scheduleDaily(
        id: _kCheckinId, hour: 21, minute: 30,
        title: '今天过得怎么样？',
        body: hint == null ? '花了多少、心情如何，跟我说一句就记好了' : '$hint · 点开跟我说说今天',
        payload: 'pilot:checkin',
      );
}

final autoLedgerProvider = NotifierProvider<AutoLedger, AutoLedgerState>(AutoLedger.new);
