/// pilot_talk.dart — 手机跟 Pilot 说话 (2026-10-03 架构统一)。
///
/// Pilot 只有一个家: 云端 (账本 + 容器, core/pilot/pilot_cloud.dart)。手机是它的一台设备 ——
/// 说的话交给云端的它、它的回话边推边念; 手机上来的短信 / 通知也交给它判断。手机自己不当脑子,
/// 不存它的对话、不跟谁同步 (以前的「本地优先 / 手机先顶上再交回电脑」整套已经拆掉: 两个脑子各记一半, 永远对不齐)。
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/pilot/pilot_cloud.dart';
import 'pilot_link.dart';
import 'pilot_patrol_filter.dart';
import 'spoken_lead.dart';

class PilotTalk {
  PilotTalk(this._ref);
  final Ref _ref;

  /// 正在跟它说话 / 它正办着上一件: 这时来的通知别插队
  bool _busy = false;

  /// 跟它说一句, 等它办完, 返回它最后说的那句。[attachments]: 通话里摄像头拍的那张
  ///
  /// [onLead]: 边写边念 —— 这一轮第一段话的口播句一定下来就回调一次 (调用方马上去念, 不等整轮跑完)。
  /// 返回值是最后那段话; 调用方拿它跟已经念过的比, 只补念没念过的。
  /// [onTool]: 它这一轮每动一次手 (工具名) 回调一次 —— 页面上那排「它动过的手」
  Future<String> ask(
    PilotContact pilot,
    String text, {
    List<Map<String, Object?>> attachments = const [],
    void Function(String lead)? onLead,
    void Function(String tool)? onTool,
  }) async {
    final cloud = _ref.read(pilotCloudProvider);
    if (cloud == null || !await cloud.enabled()) return '这个账号还没开通 Pilot。';
    var seg = StringBuffer();
    var leadSent = false;
    final sw = Stopwatch()..start();
    int? firstTextMs;
    void fire(String lead) {
      leadSent = true;
      debugPrint('[pilot] 口播句 ${sw.elapsedMilliseconds}ms (首字 ${firstTextMs ?? -1}ms)');
      onLead?.call(lead);
    }

    _busy = true;
    try {
      final answer = await cloud.ask(pilot.sessionId, text, attachments: attachments, onDelta: (chunk, tool) {
        if (!tool) firstTextMs ??= sw.elapsedMilliseconds;
        if (tool) onTool?.call(chunk);
        if (leadSent) return;
        if (tool) {
          /* 一个字没说就去调工具 (查网页要好几秒): 先垫一句, 不让人干等着 */
          final lead = seg.isEmpty ? _fillerFor(chunk) : closedLead(seg.toString(), force: true);
          if (lead != null) fire(lead);
          seg = StringBuffer();
          return;
        }
        seg.write(chunk);
        final lead = closedLead(seg.toString());
        if (lead != null) fire(lead);
      });
      debugPrint('[pilot] 整轮 ${sw.elapsedMilliseconds}ms');
      return answer;
    } catch (e) {
      debugPrint('[pilot] ask failed: $e');
      final why = '$e';
      if (RegExp(r'余额|额度|quota|insufficient|402').hasMatch(why)) return '我这边的额度用完了, 想不了事。';
      if (RegExp(r'SocketException|Failed host lookup|Network|网络').hasMatch(why)) return '现在没网, 我连不上自己。';
      return '我这会儿连不上, 稍后再说一次。';
    } finally {
      _busy = false;
    }
  }

  /// 它一个字没说就去调工具时先垫的那句 (按工具挑口气); 瞬间就回的工具不垫
  static String? _fillerFor(String tool) => switch (tool) {
        'clock' || 'calculator' || 'report_to_user' || 'remember' || 'forget' => null,
        'web_search' || 'web_fetch' || 'phone' => '我查一下。',
        _ => '好, 我来办。',
      };

  // ───────── 手机上来的短信 / 通知: 交给它判断 ─────────
  //
  // 广告 / 系统杂音 / 验证码丢掉, 短信 / 未接来电 / 有人找你才叫醒; 攒 60 秒一批 (未接来电 5 秒), 每小时最多叫醒 6 次。
  // 它看完要你知道的走 report_to_user (云端按急不急推通知 / 打电话)。

  final List<Map<String, Object?>> _pendingSignals = [];
  Timer? _signalTimer;
  final List<int> _wakes = [];

  void onSignals(List<Map<String, Object?>> batch) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final wake = [
      for (final s in batch)
        if (classifySignal(s) case final k? when now - ((s['at'] as num?)?.toInt() ?? now) < 30 * 60_000) {...s, 'kind': k},
    ];
    if (wake.isEmpty) return;
    _pendingSignals.addAll(wake);
    final urgent = wake.any((s) => s['kind'] == 'missed_call');
    if (_signalTimer == null || urgent) {
      _signalTimer?.cancel();
      _signalTimer = Timer(urgent ? const Duration(seconds: 5) : const Duration(seconds: 60), () => unawaited(_wakeOnSignals()));
    }
  }

  Future<void> _wakeOnSignals() async {
    _signalTimer = null;
    if (_busy) {
      _signalTimer = Timer(const Duration(seconds: 60), () => unawaited(_wakeOnSignals()));
      return;
    }
    final batch = List<Map<String, Object?>>.from(_pendingSignals);
    _pendingSignals.clear();
    if (batch.isEmpty) return;
    final now = DateTime.now();
    _wakes.removeWhere((t) => t < now.millisecondsSinceEpoch - 3_600_000);
    final urgent = batch.any((s) => s['kind'] == 'missed_call');
    if (!urgent && _wakes.length >= 6) return;
    List<PilotContact> pilots;
    try {
      pilots = await _ref.read(pilotLinkProvider).listPilots();
    } catch (_) {
      return;
    }
    if (pilots.isEmpty) return;
    _wakes.add(now.millisecondsSinceEpoch);
    /* 分工里管手机消息的那个; 没有就最近说过话的那个 (列表本来就按最近排) */
    final duty = RegExp(r'(手机|消息|短信|电话|通知|微信|phone|message|sms|call)', caseSensitive: false);
    final who = pilots.where((p) => duty.hasMatch(p.persona)).firstOrNull ?? pilots.first;
    debugPrint('[pilot] wake ${who.name} on ${batch.length} signals');
    await ask(who, signalPrompt(batch, now));
  }

  static String signalPrompt(List<Map<String, Object?>> batch, DateTime now) {
    String esc(Object? s) => '${s ?? ''}'.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    final items = batch.map((s) {
      final at = DateTime.fromMillisecondsSinceEpoch((s['at'] as num?)?.toInt() ?? now.millisecondsSinceEpoch);
      final text = '${s['text'] ?? ''}';
      return '<n kind="${s['kind']}" app="${esc(s['app'])}" at="${_hm(at)}">${esc(s['title'])}${text.isEmpty ? '' : ': ${esc(text.length > 300 ? text.substring(0, 300) : text)}'}</n>';
    }).join();
    return '<phone-signal><now>${_hm(now)}</now><items>$items</items><instruction>'
        '用户手机上刚来了这些 (他现在没在跟你说话)。按你的分工判断要不要管: '
        '要他马上知道或拍板的 (重要的人找他、未接来电可能要回、出了状况) → report_to_user, 急的用 urgent, 该尽快知道用 attention; '
        '能只读查一下就说清楚的先查; 要他回的短信可以替他起草, 用 phone 的 send_sms —— 会变成「批准 / 不要」的卡等他点头, 不会直接发 (2026-10-14 动作卡); '
        '微信等别的 App 里的不替他回, 不回拨、不下单。没什么要紧 → 只回复 $kPilotQuiet, 别的字一个都不要写。'
        // 2026-10-08: 用户看不到这条触发消息, 回复不点明来源就像在接上一句话
        '要开口时, 第一句先说是哪个 App 里谁的消息 (比如「微信群硅碳AI诊疗答疑群通知:」), 他看不到这条通知原文。'
        '</instruction></phone-signal>';
  }

  static String _hm(DateTime t) => '${t.month}/${t.day} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

// ───────── 信号分类 ─────────

final _smsPkg = RegExp(r'(messaging|mms|\.sms|message)', caseSensitive: false);
final _dialerPkg = RegExp(r'(dialer|incallui|\.phone$|contacts|telecom)', caseSensitive: false);
final _chatPkg = RegExp(r'^(com\.tencent\.mm|com\.tencent\.mobileqq|com\.tencent\.tim|com\.whatsapp|org\.telegram|com\.alibaba\.android\.rimet|com\.ss\.android\.lark|com\.slack|com\.discord|jp\.naver\.line|com\.facebook\.orca|com\.tencent\.wework)');
final _systemPkg = RegExp(r'^(android|com\.android\.systemui|com\.android\.settings|com\.android\.vending|com\.google\.android\.gms|com\.android\.providers\.downloads)$');
final _promo = RegExp(r'(退订|回T|回TD|拒收请回|促销|优惠券|限时|特惠|广告|抽奖|会员日|unsubscribe|promo)', caseSensitive: false);
final _code = RegExp(r'(验证码|校验码|动态码|verification code|security code|\bOTP\b|one-time)', caseSensitive: false);
final _missed = RegExp(r'(未接|missed call|missed)', caseSensitive: false);

/// 要叫醒它的种类 (missed_call / sms / chat); 丢掉的返回 null
String? classifySignal(Map<String, Object?> s) {
  final pkg = '${s['package'] ?? ''}';
  final cat = '${s['category'] ?? ''}';
  final body = '${s['title'] ?? ''} ${s['text'] ?? ''}';
  if (_systemPkg.hasMatch(pkg) || cat == 'progress' || cat == 'transport' || cat == 'service') return null;
  if (_promo.hasMatch(body) || cat == 'promo' || _code.hasMatch(body)) return null;
  if ((_dialerPkg.hasMatch(pkg) || cat == 'missed_call') && _missed.hasMatch(body)) return 'missed_call';
  if (cat == 'call') return null;
  if (_smsPkg.hasMatch(pkg)) return 'sms';
  if (_chatPkg.hasMatch(pkg) || cat == 'msg') return 'chat';
  return null;
}

final pilotTalkProvider = Provider<PilotTalk>((ref) => PilotTalk(ref));
