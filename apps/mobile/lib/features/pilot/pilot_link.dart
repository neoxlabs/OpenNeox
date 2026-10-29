/// pilot_link.dart — 手机这台设备看 Pilot 的那扇窗 (2026-10-03 架构统一)。
///
/// Pilot 只住在云端 (core/pilot/pilot_cloud.dart): 联系人、任务板、汇报读写都直接找云端账本, 不经电脑。
/// 云端连不上时页面不变空: 联系人和任务板用上次拿到的。它的声音由手机自己合成 (core/voice/pilot_voice.dart)。
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/edition/edition.dart' show accountStatusProvider;
import '../../core/pilot/pilot_cloud.dart';
import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import '../../core/voice/pilot_voice.dart';
import 'pilot_speech_gate.dart';
import 'spoken_lead.dart';

const _kContactsCache = 'pilot_contacts_cache_v1';
const _kBoardCache = 'pilot_board_cache_v1:';

/// 停在哪个 Pilot 的页上 (进页写、退页删): App 被关掉时还开着它, 下次打开直接回到它
const kPilotLastOpenPref = 'pilot_last_open_v1';

/// 上次关 App 时停着的那个 Pilot; 没有 / 联系人缓存里找不到 = null
Future<PilotContact?> lastOpenPilot() async {
  final prefs = await SharedPreferences.getInstance();
  final id = prefs.getString(kPilotLastOpenPref);
  final raw = prefs.getString(_kContactsCache);
  if (id == null || raw == null) return null;
  final all = [for (final p in jsonDecode(raw) as List) PilotContact.fromJson(Map<String, dynamic>.from(p as Map))];
  /* 'list' = 停在会话列表 (2026-10-14 起 Pilot 首页是列表) */
  if (id == 'list') return all.isEmpty ? null : all.first;
  for (final c in all) {
    if (c.sessionId == id) return c;
  }
  return null;
}

const _voice = MethodChannel('neox.pilot/voice');

class PilotContact {
  Map<String, Object?> toJson() => {
        'session_id': sessionId,
        'name': name,
        'avatar': avatar.name,
        'persona': persona,
        'patrol_minutes': patrolMinutes,
        'updated_at': updatedAt,
        'model_id': modelId,
      };

  PilotContact.fromJson(Map<String, dynamic> j)
      : sessionId = j['session_id'] as String? ?? '',
        name = j['name'] as String? ?? 'Pilot',
        avatar = j['avatar'] == 'corgi' ? PilotLook.corgi : PilotLook.cat,
        persona = j['persona'] as String? ?? '',
        patrolMinutes = (j['patrol_minutes'] as num?)?.toInt() ?? 0,
        updatedAt = (j['updated_at'] as num?)?.toInt() ?? 0,
        modelId = j['model_id'] as String?;

  final String sessionId;
  final String name;
  final PilotLook avatar;
  final String persona;
  final int patrolMinutes;
  final int updatedAt;

  /// 它用的模型; null = 没单独选过, 用 kPilotDefaultModel
  final String? modelId;
}

enum PilotLook { cat, corgi }

/// 一条汇报 (report_to_user 交上来的)
class PilotReport {
  PilotReport.fromJson(Map<String, dynamic> j)
      : id = '${j['id']}',
        status = '${j['status']}',
        title = '${j['title']}',
        summary = '${j['summary'] ?? ''}',
        options = [for (final o in (j['options'] as List? ?? const [])) '$o'],
        at = DateTime.fromMillisecondsSinceEpoch((j['at'] as num?)?.toInt() ?? 0),
        read = j['read'] == true,
        answer = j['answer'] as String?,
        times = (j['times'] as num?)?.toInt() ?? 1;

  final String id;
  /// done | blocked | failed | progress
  final String status;
  final String title;
  final String summary;
  final List<String> options;
  final DateTime at;
  final bool read;
  final String? answer;
  /// 同一件事报了几次 (账本合并成一条)
  final int times;

  bool get needsDecision => status == 'blocked' && answer == null;
}

class PilotBoard {
  const PilotBoard(this.reports, this.reminders);
  final List<PilotReport> reports;
  final List<({String title, DateTime at})> reminders;
}

class PilotLink {
  PilotLink(this._ref);
  final Ref _ref;

  /// 念稿的轮次凭证 (pilot:U-20): 点停 / 开新一轮都让上一轮作废
  final PilotSpeechGate speech = PilotSpeechGate();

  /// 这个账号开通了 Pilot 没有 (没开通的账号不显示 Pilot 入口)
  Future<bool> available({bool refresh = false}) async {
    final c = _ref.read(pilotCloudProvider);
    return c != null && await c.enabled(refresh: refresh);
  }

  Future<PilotCloud> _cloud() async {
    final c = _ref.read(pilotCloudProvider);
    if (c == null || !await c.enabled()) throw StateError('这个账号还没开通 Pilot');
    return c;
  }

  /// 上次拿到的联系人 (同步读本地), 没有 = null
  List<PilotContact>? cachedPilots() {
    final raw = _ref.read(sharedPreferencesProvider).getString(_kContactsCache);
    if (raw == null) return null;
    try {
      return [for (final p in jsonDecode(raw) as List) PilotContact.fromJson(Map<String, dynamic>.from(p as Map))];
    } catch (_) {
      return null;
    }
  }

  /// 联系人, 最近说过话的在前。连不上时用上次拿到的 —— 它不能因为断网就「消失」
  Future<List<PilotContact>> listPilots() async {
    final prefs = await SharedPreferences.getInstance();
    try {
      final cloud = await _cloud();
      final out = [
        for (final p in await cloud.pilots())
          PilotContact.fromJson({
            'session_id': p['id'], 'name': p['name'], 'avatar': p['avatar'], 'persona': p['persona'],
            'patrol_minutes': p['patrolMinutes'], 'updated_at': p['updatedAt'], 'model_id': p['modelId'],
          }),
      ];
      await prefs.setString(_kContactsCache, jsonEncode([for (final p in out) p.toJson()]));
      return out;
    } catch (_) {
      final raw = prefs.getString(_kContactsCache);
      if (raw == null) rethrow;
      return [for (final p in jsonDecode(raw) as List) PilotContact.fromJson(Map<String, dynamic>.from(p as Map))];
    }
  }

  /// 开一轮念稿 (pilot:U-20)。这一轮里的句子都从它说; 用户点停, 没念完的全作废。
  PilotNarration narration() => PilotNarration(this, speech.begin());

  /// 这一轮的凭证还能不能出声
  bool stillSpeaking(int token) => speech.open(token);

  /// 让 Pilot 把这句话说出来, 播完才返回。返回 null = 说出来了, 否则是说不了的原因。
  /// 只念口播段 (跟电脑上念的同一条规则)。
  ///
  /// [epoch] 传这一轮的凭证 (见 [narration]); 不传就按调用当下的那一轮算。
  /// 合成期间用户点了停 → 合成回来也不播 (否则停了半秒又开口, 像没停掉)。
  Future<String?> speak(String text, {String? sessionId, int? epoch}) async {
    final token = epoch ?? speech.epoch;
    final lead = spokenLead(text).trim();
    if (lead.isEmpty) return null;
    if (!speech.open(token)) return null; /* 停过了 / 已经换了新一轮: 一个字都不出声 */
    try {
      final r = await _ref.read(pilotVoiceProvider.notifier).synth(lead);
      if (!speech.open(token)) return null; /* 合成这会儿点了停 */
      final ok = await _voice.invokeMethod<bool>('play', {'audio': r.audio, 'format': r.format});
      if (!speech.open(token)) return null; /* 播到一半停了: 是我们停的, 不是「说不了」 */
      return ok == true ? null : '播放失败';
    } catch (e) {
      if (!speech.open(token)) return null;
      return '$e'.replaceFirst('Bad state: ', '');
    }
  }

  /// 点停: 先作废这一轮 (在途合成 / 排队待播立刻失效), 再停原生播放器 (sound 立刻断)。
  Future<void> stopSpeaking() async {
    speech.interrupt();
    try {
      await _voice.invokeMethod('stop');
    } catch (_) {/* 没在播 */}
  }

  /// 任务板: 它的汇报 (等你拍板 / 办完 / 没办成) + 接下来的提醒。连不上时返回上次的
  Future<PilotBoard> board(String sessionId) async {
    final prefs = await SharedPreferences.getInstance();
    Object? r;
    try {
      r = {'ok': true, ...await (await _cloud()).board(sessionId)};
      await prefs.setString('$_kBoardCache$sessionId', jsonEncode(r));
    } catch (_) {
      final raw = prefs.getString('$_kBoardCache$sessionId');
      if (raw == null) rethrow;
      r = jsonDecode(raw);
    }
    if (r is! Map || r['ok'] != true) return const PilotBoard([], []);
    return PilotBoard(
      [for (final x in (r['reports'] as List? ?? const [])) if (x is Map) PilotReport.fromJson(Map<String, dynamic>.from(x))],
      [for (final x in (r['reminders'] as List? ?? const [])) if (x is Map) (title: '${x['title']}', at: DateTime.fromMillisecondsSinceEpoch((x['at'] as num).toInt()))],
    );
  }

  /// 在手机上看到了 = 读了 (云端的升级阶梯停)
  Future<void> markRead(String sessionId) async {
    try {
      await (await _cloud()).markReportsRead(sessionId);
    } catch (_) {/* 下次再报 */}
  }

  Future<void> answerReport(String id, String answer) async {
    try {
      await (await _cloud()).answerReport(id, answer);
    } catch (_) {/* 回话本身已经发进会话 */}
  }
}

/// 一轮念稿 (pilot:U-20): 拿着开轮时的凭证, 说的话都经它。
/// 点停后 [stopped] 为 true, 后面的 [say] 一律不出声 —— 调用方不用自己记「停过没有」。
class PilotNarration {
  PilotNarration(this._link, this._token);
  final PilotLink _link;
  final int _token;

  bool get stopped => !_link.stillSpeaking(_token);

  Future<String?> say(String text, {String? sessionId}) =>
      stopped ? Future<String?>.value() : _link.speak(text, sessionId: sessionId, epoch: _token);
}

final pilotLinkProvider = Provider<PilotLink>((ref) => PilotLink(ref));

/// Pilot 页的联系人列表 —— 先给本地存的那份 (立刻画), 再拉新的替换; 下拉刷新时 invalidate
///
/// 2026-10-12 用户: 「pilot 有权限的人为什么总是慢一步加载出来」—— 原来两个都是 FutureProvider:
/// 先等 /me (冷启动第一下常握手失败, 再等 2 秒重问), 再等 /pilots, 抽屉每次打开 (autoDispose) 重来一遍。
final pilotContactsProvider = StreamProvider.autoDispose<List<PilotContact>>((ref) async* {
  final link = ref.read(pilotLinkProvider);
  final cached = link.cachedPilots();
  if (cached != null) yield cached;
  try {
    yield await link.listPilots();
  } catch (_) {
    if (cached == null) rethrow;
  }
});

/// 这个账号能不能用 Pilot (首页入口据此显示) —— 先按上次的答案, 问到了再纠正。
/// 跟着登录态重算: 冷启动凭据还没从钥匙串读出来时问到的「没登录 = false」不能一直留着。
final pilotAvailableProvider = StreamProvider<bool>((ref) async* {
  ref.watch(accountStatusProvider.select((a) => (a.signedIn, a.promptName)));
  final cached = ref.read(pilotCloudProvider)?.cachedEnabled;
  if (cached != null) yield cached;
  final fresh = await ref.read(pilotLinkProvider).available();
  if (fresh != cached) yield fresh;
});
