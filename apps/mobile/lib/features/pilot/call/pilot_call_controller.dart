/// pilot_call_controller.dart — Pilot 的通话能力在手机上的调度 (2026-10-01).
///
/// 两个方向:
///   它打给你: 云端的它经推送打来 (NeoxPushService → PilotCallBridge.kt 系统级来电, 锁屏全屏 / 横幅),
///            推送里带齐来电的一切 (call_id / 名字 / 原因 / 开场白); 接 → 进通话页, 挂 → 撤铃声
///   你打给它: Pilot 页头部的通话键 → 直接进通话页
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/notifications/notify_prefs.dart';
import '../../../core/router.dart' show rootNavigatorKey;
import '../pilot_link.dart';
import 'pilot_call_page.dart';

const _ch = MethodChannel('neox.pilot/call');

/// 一通电话 —— 来电带 id (要回报给容器); 你打出去的没有
class PilotCall {
  PilotCall.incoming(Map<String, dynamic> j)
      : id = j['call_id'] as String? ?? '',
        sessionId = j['session_id'] as String?,
        pilotName = j['pilot_name'] as String? ?? 'Pilot',
        look = j['avatar'] == 'corgi' ? PilotLook.corgi : PilotLook.cat,
        reason = j['reason'] as String? ?? '',
        opening = j['opening'] as String? ?? '',
        ringSeconds = (j['ring_seconds'] is String ? int.tryParse(j['ring_seconds'] as String) : (j['ring_seconds'] as num?)?.toInt()) ?? 25,
        cloud = j['cloud'] == true,
        incoming = true;

  /// 云端的 Pilot 经推送打来的 (2026-10-03): 字段都在推送里, 没有电脑那边的通话状态机
  PilotCall.fromCloudPush(Map<String, dynamic> d)
      : this.incoming({
          'call_id': d['call_id'],
          'session_id': d['pilot_id'],
          'pilot_name': d['pilot_name'] ?? d['title'],
          'avatar': d['avatar'],
          'reason': d['reason'] ?? d['body'],
          'opening': d['opening'],
          'ring_seconds': d['ring_seconds'],
          'cloud': true,
        });

  PilotCall.outgoing(PilotContact c)
      : id = 'out-${DateTime.now().millisecondsSinceEpoch}',
        sessionId = c.sessionId,
        pilotName = c.name,
        look = c.avatar,
        reason = '',
        opening = '',
        ringSeconds = 0,
        cloud = false,
        incoming = false;

  /// 云端的 Pilot 打来的: 接 / 挂不用回报电脑 (云端那边按推送的语义处理)
  final bool cloud;

  final String id;
  final String? sessionId;
  final String pilotName;
  final PilotLook look;
  final String reason;
  final String opening;
  final int ringSeconds;
  final bool incoming;
}

class PilotCallController {
  PilotCallController() {
    _ch.setMethodCallHandler(_onNative);
    /* 用户点通知时 Dart 还没准备好, 原生先记着 */
    unawaited(_ch.invokeMethod<Map>('takePending').then((p) {
      if (p != null) _onAction('${p['callId']}', '${p['action']}', p['desktopId'] as String?, p['cloud'] as String?);
    }).catchError((_) => null));
  }

  PilotCall? _ringing;
  PilotCall? _active;

  /// 通话页听它: 容器那边结束了 (id) → 页面自己关
  final ValueNotifier<String?> endedCallId = ValueNotifier<String?>(null);

  /// 来电页听它: 在通知上接通了 (id) → 来电页就地转成通话
  final ValueNotifier<String?> answeredCallId = ValueNotifier<String?>(null);

  // ───────── 它打给你 ─────────

  void onIncoming(Map<String, dynamic> params) {
    final call = PilotCall.incoming(params);
    debugPrint('[pilot] incoming call ${call.id} from ${call.pilotName}');
    if (call.id.isEmpty) return;
    /* 正在跟 Pilot 通话 —— 不响第二个, 容器那边按没接处理 */
    if (_active != null) return;
    /* 设置 → 通知 → 关了「允许 Pilot 打电话给你」: 不响 —— 电脑那边响满 ringSeconds 按没接处理 */
    if (!NotifyPrefs.allowCall) return;
    _ringing = call;
    /* 推送叫醒的: 你在系统来电上已经点了接 / 挂, App 刚连回电脑, 这通是电脑补发来的 —— 照你点的办, 不再响第二遍 */
    final early = _early;
    _early = null;
    if (early != null && early.callId == call.id && DateTime.now().difference(early.at) < const Duration(minutes: 1)) {
      _onAction(call.id, early.action);
      if (early.action != 'open') return;
    }
    /* 响到点自己停: 「来电结束」是电脑发的, 电脑半路睡了 / 关了就永远收不到, 来电页会一直挂在屏幕上
     * (模拟器实测: 电脑打来第二通时被关掉, 来电页挂了十分钟, 把后面所有操作都挡住)。
     * 电脑那边响满 ringSeconds 本来就按没接处理, 这里多留 10 秒 */
    Timer(Duration(seconds: call.ringSeconds + 10), () {
      if (_ringing?.id == call.id) onEnded({'call_id': call.id});
    });
    /* App 在前台: 直接弹 App 里的来电页 —— 不靠通知 (通知权限没给时系统会静默吞掉) */
    if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
      _push(PilotCallPage(call: call, ringing: true));
    }
    /* 系统来电照样发: 锁屏 / 在别的 App 里时靠它响铃 */
    unawaited(_ch.invokeMethod('showIncoming', {
      'callId': call.id,
      'pilotName': call.pilotName,
      'reason': call.reason,
      'ringSeconds': call.ringSeconds,
    }).catchError((Object e) => debugPrint('[pilot] showIncoming failed: $e')));
  }

  void onEnded(Map<String, dynamic> params) {
    final id = params['call_id'] as String?;
    if (id == null) return;
    /* 「在别处接了」: 接的就是这台 (正在通话) → 不挂; 其它手机才停 */
    if (params['reason'] == 'answered_elsewhere' && _active?.id == id) return;
    /* 推送叫醒的: 系统来电在响, App 这边还没登记这通 —— 也要撤掉 (别的手机接了 / 已经结束) */
    if (_ringing == null && _active == null) {
      unawaited(_ch.invokeMethod('cancel').catchError((_) => null));
      endedCallId.value = id;
      return;
    }
    if (_ringing?.id == id) {
      _ringing = null;
      unawaited(_ch.invokeMethod('cancel').catchError((_) => null));
      endedCallId.value = id; /* 前台弹着的来电页也关 */
    }
    if (_active?.id == id) {
      _active = null;
      endedCallId.value = id;
    }
  }

  Future<dynamic> _onNative(MethodCall call) async {
    if (call.method == 'onAction') {
      final a = Map<String, dynamic>.from(call.arguments as Map);
      _onAction('${a['callId']}', '${a['action']}', a['desktopId'] as String?, a['cloud'] as String?);
    }
    return null;
  }

  /// 来电页开着就不再推第二个 (前台直接弹过一次, 点通知又会来一次)
  String? _ringPageFor;

  /// 来电还没从电脑到, 你已经在系统来电上点了 (App 被杀时推送弹的那个) —— 等电脑补发过来再办
  ({String callId, String action, DateTime at})? _early;

  void _onAction(String callId, String action, [String? desktopId, String? cloudJson]) {
    /* 云端的 Pilot 打来的: 推送就是全部, 直接登记成在响的这通 (没有电脑会补发) */
    if (_ringing == null && _active == null && cloudJson != null && cloudJson.isNotEmpty) {
      try {
        final call = PilotCall.fromCloudPush(Map<String, dynamic>.from(jsonDecode(cloudJson) as Map));
        if (call.id == callId) {
          _ringing = call;
          Timer(Duration(seconds: call.ringSeconds + 10), () {
            if (_ringing?.id == call.id) onEnded({'call_id': call.id});
          });
        }
      } catch (e) {
        debugPrint('[pilot] cloud call payload bad: $e');
      }
    }
    final call = _ringing;
    if (call == null) {
      _early = (callId: callId, action: action, at: DateTime.now());
      return;
    }
    if (call.id != callId) return;
    switch (action) {
      case 'decline':
        decline(call);
        break;
      case 'accept':
        unawaited(accept(call));
        break;
      case 'open':
        /* 点了通知 / 锁屏全屏: 在 App 里显示来电, 由你点接或挂 */
        if (_ringPageFor != call.id) _push(PilotCallPage(call: call, ringing: true));
        break;
    }
  }

  bool isRinging(String callId) => _ringing?.id == callId;

  /// [openPage]: 从通知上接的要开通话页; 在 App 来电页里接的, 那一页自己转成通话, 不再开第二页
  Future<bool> accept(PilotCall call, {bool openPage = true}) async {
    if (_ringing?.id != call.id) return false;
    _ringing = null;
    unawaited(_ch.invokeMethod('cancel').catchError((_) => null));
    _active = call;
    if (openPage) {
      if (_ringPageFor == call.id) {
        answeredCallId.value = call.id; /* 来电页已经开着 (在通知上点的接): 让它就地接通 */
      } else {
        _push(PilotCallPage(call: call, ringing: false));
      }
    }
    return true;
  }

  void decline(PilotCall call) {
    if (_ringing?.id != call.id) return;
    _ringing = null;
    unawaited(_ch.invokeMethod('cancel').catchError((_) => null));
  }

  // ───────── 你打给它 ─────────

  void callOut(PilotContact pilot) {
    if (_active != null) return;
    final call = PilotCall.outgoing(pilot);
    _active = call;
    _push(PilotCallPage(call: call, ringing: false));
  }

  /// 通话页挂断
  Future<void> hangup(PilotCall call) async {
    if (_active?.id == call.id) _active = null;
  }

  void _push(Widget page) {
    if (page is PilotCallPage && page.ringing) {
      /* 同一通只弹一页: 推送的「点开」和直连的来电可能前后脚都到 */
      if (_ringPageFor == page.call.id) return;
      _ringPageFor = page.call.id;
    }
    rootNavigatorKey.currentState?.push(MaterialPageRoute<void>(builder: (_) => page, fullscreenDialog: true));
  }
}

final pilotCallControllerProvider = Provider<PilotCallController>((ref) => PilotCallController());
