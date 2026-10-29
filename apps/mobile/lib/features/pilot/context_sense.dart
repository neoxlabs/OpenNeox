/// context_sense.dart — 情境层的 Dart 一半 (2026-10-11, 设计见 docs/NEOX_PILOT_ASSISTANT_DESIGN_2026_10_11.md §4)。
///
/// 安卓原生 (ContextSense.kt) 在 App 没开时也看着: 车载蓝牙连上 / 断开、进出家和公司、17:00 有没有出过门,
/// 该响的当场响。这里做三件事:
///   设置   这是家 / 这是公司 (取当前位置) · 你的车 (从配对过的蓝牙里挑) · 后台定位权限
///   入库   原生攒的状态变化 → 个人记录 context.state (有起止的一段: 在家 9 小时、开车 40 分钟)
///   外地   打开 App 时看所在城市, 跟家不在一个城市就记一段 travel
/// 「到了 / 离开」类提醒 (trigger when=place) 同步给原生, 由围栏当场弹。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/pilot/pilot_cloud.dart';

const _ch = MethodChannel('neox.phone/context');
const _tools = MethodChannel('neox.phone/tools');
/* 还没结束的那一段 (最后一个状态): 下一个状态来了才知道它多长 */
const _kOpen = 'pilot_ctx_open_v1';
const _kHomeCity = 'pilot_ctx_home_city_v1';
const _kTravelDay = 'pilot_ctx_travel_day_v1';

class ContextSenseState {
  const ContextSenseState({this.state, this.since, this.place, this.home = false, this.work = false, this.car, this.parked, this.parkedTime, this.city, this.homeCity, this.bgLocation = false});
  /// 「始终允许」定位给了没: 没给, 进出家 / 公司 App 不开着就看不见
  final bool bgLocation;
  final String? state;
  final DateTime? since;
  final String? place;
  final bool home;
  final bool work;
  final String? car;
  /// 停车位置 (lat, lng)
  final (double, double)? parked;
  final DateTime? parkedTime;
  final String? city;
  final String? homeCity;

  bool get setUp => home || work || car != null;
  bool get away => city != null && homeCity != null && city != homeCity;
}

const ctxStateZh = {
  'home': '在家', 'work': '在公司', 'commute': '路上', 'driving': '开车中', 'parked': '刚停车',
  'outside': '在外面', 'travel': '在外地', 'sleep': '睡觉',
};

class ContextSense extends Notifier<ContextSenseState> {
  bool _flushing = false;

  @override
  ContextSenseState build() {
    if (Platform.isAndroid) {
      _ch.setMethodCallHandler((call) async {
        if (call.method == 'event') unawaited(refresh());
        return null;
      });
      unawaited(refresh());
    }
    return const ContextSenseState();
  }

  Future<void> refresh() async {
    if (!Platform.isAndroid) return;
    try {
      final s = await _ch.invokeMethod<Map>('status') ?? const {};
      final p = await SharedPreferences.getInstance();
      final parked = '${s['parkedAt'] ?? ''}'.split(',').map(double.tryParse).toList();
      final since = (s['since'] as num?)?.toInt() ?? 0;
      final pt = (s['parkedTime'] as num?)?.toInt() ?? 0;
      state = ContextSenseState(
        state: s['state'] as String?,
        since: since > 0 ? DateTime.fromMillisecondsSinceEpoch(since) : null,
        place: s['place'] as String?,
        home: s['home'] != null,
        work: s['work'] != null,
        car: s['car'] as String?,
        parked: parked.length == 2 && parked[0] != null && parked[1] != null ? (parked[0]!, parked[1]!) : null,
        parkedTime: pt > 0 ? DateTime.fromMillisecondsSinceEpoch(pt) : null,
        city: state.city,
        homeCity: p.getString(_kHomeCity),
        bgLocation: s['bgLocation'] == true,
      );
      await flush();
    } catch (_) {}
  }

  /// 原生攒的状态变化 → context.state 一段一段记进去 (最后一段留着, 等下一个状态来了再记)
  Future<void> flush() async {
    if (_flushing) return;
    final api = ref.read(pilotCloudProvider)?.records;
    if (api == null) return;
    _flushing = true;
    try {
      final evs = [for (final e in await _ch.invokeMethod<List>('drain') ?? const []) Map<String, Object?>.from(e as Map)];
      if (evs.isEmpty) return;
      final p = await SharedPreferences.getInstance();
      final open = p.getString(_kOpen);
      final all = [if (open != null) Map<String, Object?>.from(jsonDecode(open) as Map), ...evs];
      final out = <Map<String, Object?>>[];
      for (var i = 0; i + 1 < all.length; i++) {
        final a = all[i], b = all[i + 1];
        final start = (a['at'] as num).toInt(), end = (b['at'] as num).toInt();
        /* 不到 2 分钟的一段是围栏边上抖动, 不记 */
        if (end - start < 2 * 60 * 1000) continue;
        out.add({
          'type': 'context.state',
          'occurred_at': start,
          'ended_at': end,
          'source': 'device:phone:context',
          'data': {
            'state': a['state'],
            if (a['place'] != null) 'place': a['place'],
            if (a['lat'] != null) 'lat': a['lat'],
            if (a['lng'] != null) 'lng': a['lng'],
            if (a['city'] != null) 'city': a['city'],
          },
        });
      }
      await p.setString(_kOpen, jsonEncode(all.last));
      if (out.isNotEmpty) await api.log(out);
    } catch (_) {
      // 没网就下次再记: 原生队列已取走, 但最后一段还在 _kOpen 里; 丢几段状态无伤大雅
    } finally {
      _flushing = false;
    }
  }

  Future<(double, double)?> _here() async {
    final ok = await _tools.invokeMethod<Map>('ensure', {'permissions': ['android.permission.ACCESS_FINE_LOCATION']}).catchError((_) => null);
    if (ok?['android.permission.ACCESS_FINE_LOCATION'] != true) return null;
    final m = await _tools.invokeMethod<Map>('location').catchError((_) => null);
    final lat = (m?['lat'] as num?)?.toDouble(), lng = (m?['lng'] as num?)?.toDouble();
    return lat == null || lng == null ? null : (lat, lng);
  }

  /// 此刻大概在哪 (查天气用): 有定位权限取当前位置, 没有就用设过的家; 不弹权限框
  Future<(double, double)?> whereNow() async {
    if (!Platform.isAndroid) return null;
    final perm = await _tools.invokeMethod<Map>('status').catchError((_) => null);
    if (perm?['location'] == true) {
      final m = await _tools.invokeMethod<Map>('location').catchError((_) => null);
      final lat = (m?['lat'] as num?)?.toDouble(), lng = (m?['lng'] as num?)?.toDouble();
      if (lat != null && lng != null) return (lat, lng);
    }
    final s = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    final p = '${s?['home'] ?? ''}'.split(',').map(double.tryParse).toList();
    return p.length == 2 && p[0] != null && p[1] != null ? (p[0]!, p[1]!) : null;
  }

  /// 「这是家」/「这是公司」: 取当前位置; 返回 null = 没拿到位置
  Future<String?> markHere(String which) async {
    final here = await _here();
    if (here == null) return null;
    await _ch.invokeMethod('setPlace', {'name': which, 'lat': here.$1, 'lng': here.$2});
    if (which == 'home') {
      /* 家的坐标进档案: 足迹地图以它为中心 */
      unawaited(ref.read(pilotCloudProvider)?.records.log([{'type': 'fact.assert', 'data': {'key': 'home.geo', 'value': '${here.$1.toStringAsFixed(4)},${here.$2.toStringAsFixed(4)}'}}]));
      final city = await _ch.invokeMethod<String>('city', {'lat': here.$1, 'lng': here.$2}).catchError((_) => null);
      if (city != null) {
        await (await SharedPreferences.getInstance()).setString(_kHomeCity, city);
        await ref.read(pilotCloudProvider)?.records.log([{'type': 'fact.assert', 'data': {'key': 'home.city', 'value': city}}]);
      }
    }
    if (!state.bgLocation) await askBackground();
    await syncPlaceReminders();
    await _ch.invokeMethod('start');
    await refresh();
    return which == 'home' ? '家' : '公司';
  }

  Future<void> clearPlace(String which) async {
    await _ch.invokeMethod('setPlace', {'name': which});
    await refresh();
  }

  /// 进出家 / 公司要「始终允许」定位; 安卓 11 起这一步只能去系统页选
  Future<void> askBackground() async {
    await _tools.invokeMethod('ensure', {'permissions': ['android.permission.ACCESS_BACKGROUND_LOCATION']}).catchError((_) => null);
  }

  /// 配对过的蓝牙设备, 车载的排前面
  Future<List<({String name, String address, bool car})>> bondedDevices() async {
    final ok = await _tools.invokeMethod<Map>('ensure', {'permissions': ['android.permission.BLUETOOTH_CONNECT']}).catchError((_) => null);
    if (ok != null && ok['android.permission.BLUETOOTH_CONNECT'] == false) return const [];
    final list = await _ch.invokeMethod<List>('bondedDevices').catchError((_) => null) ?? const [];
    final out = [
      for (final d in list)
        if (d is Map) (name: '${d['name']}', address: '${d['address']}', car: d['car'] == true),
    ];
    out.sort((a, b) => (b.car ? 1 : 0) - (a.car ? 1 : 0));
    return out;
  }

  Future<void> setCar(String? address, String? name) async {
    await _ch.invokeMethod('setCar', {'address': address, 'name': name});
    await refresh();
  }

  /// trigger(when=place) 里「出门 / 到公司」那几条交给原生: 围栏一响当场弹
  Future<void> syncPlaceReminders() async {
    final api = ref.read(pilotCloudProvider)?.records;
    if (api == null || !Platform.isAndroid) return;
    try {
      final ts = await api.query(types: const ['trigger'], limit: 100);
      final leave = <String>[], arrive = <String>[];
      for (final t in ts) {
        if (t.data['when'] != 'place') continue;
        final place = '${t.data['place'] ?? ''}';
        final text = '${t.data['text'] ?? t.title}';
        final on = t.data['on'] ?? 'enter';
        if (RegExp(r'家|home', caseSensitive: false).hasMatch(place) && on == 'leave') leave.add(text);
        if (RegExp(r'公司|单位|办公室|work', caseSensitive: false).hasMatch(place) && on == 'enter') arrive.add(text);
      }
      await _ch.invokeMethod('setPlaceTexts', {'leaveHome': leave.join('\n'), 'arriveWork': arrive.join('\n')});
    } catch (_) {}
  }

  /// 系统围栏靠系统按它的节奏取位置, 实测能拖几十分钟: 打开 App 时拿到的位置再对一遍家 / 公司
  Future<void> _reconcile(double lat, double lng) async {
    final s = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    if (s == null) return;
    double? dist(Object? v) {
      final p = '${v ?? ''}'.split(',').map(double.tryParse).toList();
      if (p.length != 2 || p[0] == null || p[1] == null) return null;
      return _meters(lat, lng, p[0]!, p[1]!);
    }
    final dh = dist(s['home']), dw = dist(s['work']);
    final cur = s['state'] as String?;
    String? next;
    String? place;
    if (dh != null && dh < 150) {
      (next, place) = ('home', '家');
    } else if (dw != null && dw < 150) {
      (next, place) = ('work', '公司');
    } else if ((cur == 'home' && (dh ?? 0) > 400) || (cur == 'work' && (dw ?? 0) > 400)) {
      next = 'outside';
    }
    if (next != null && next != cur) {
      await _ch.invokeMethod('setState', {'state': next, 'place': place});
      await refresh();
    }
  }

  static double _meters(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = (lat2 - lat1) * math.pi / 180, dLng = (lng2 - lng1) * math.pi / 180;
    final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) * math.sin(dLng / 2) * math.sin(dLng / 2);
    return 2 * r * math.asin(math.sqrt(a));
  }

  /// 打开 App 时: 在哪个城市? 跟家不在一个城市 → 记 travel (一天一次)
  Future<void> checkCity() async {
    if (!Platform.isAndroid) return;
    final perm = await _tools.invokeMethod<Map>('status').catchError((_) => null);
    if (perm?['location'] != true) return;
    final m = await _tools.invokeMethod<Map>('location').catchError((_) => null);
    final lat = (m?['lat'] as num?)?.toDouble(), lng = (m?['lng'] as num?)?.toDouble();
    if (lat == null || lng == null) return;
    await _reconcile(lat, lng);
    final city = await _ch.invokeMethod<String>('city', {'lat': lat, 'lng': lng}).catchError((_) => null);
    if (city == null) return;
    final p = await SharedPreferences.getInstance();
    state = ContextSenseState(
      state: state.state, since: state.since, place: state.place, home: state.home, work: state.work, car: state.car,
      parked: state.parked, parkedTime: state.parkedTime, city: city, homeCity: p.getString(_kHomeCity), bgLocation: state.bgLocation,
    );
    if (!state.away) return;
    final now = DateTime.now();
    final day = '${now.year}-${now.month}-${now.day}:$city';
    if (p.getString(_kTravelDay) == day) return;
    await p.setString(_kTravelDay, day);
    await _ch.invokeMethod('setState', {'state': 'travel', 'place': city});
    await refresh();
  }
}

final contextSenseProvider = NotifierProvider<ContextSense, ContextSenseState>(ContextSense.new);

/// 跟着 App 前后台: 回到前台入库 + 看城市
class ContextSenseLifecycle with WidgetsBindingObserver {
  ContextSenseLifecycle(this._ref) {
    WidgetsBinding.instance.addObserver(this);
    unawaited(_ref.read(contextSenseProvider.notifier).checkCity());
    unawaited(_ref.read(contextSenseProvider.notifier).syncPlaceReminders());
  }
  final Ref _ref;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final n = _ref.read(contextSenseProvider.notifier);
    unawaited(n.refresh());
    unawaited(n.checkCity());
  }
}

final contextSenseLifecycleProvider = Provider<ContextSenseLifecycle>((ref) => ContextSenseLifecycle(ref));
