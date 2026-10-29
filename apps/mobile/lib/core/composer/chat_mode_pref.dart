/// chat_mode_pref.dart — 聊天模式 / Agent 模式 (2026-09-23, 跟桌面 chatModeStore 同语义).
///
/// 聊天模式每条消息带 `chat_mode: true`, 电脑那边换精简 prompt、一个工具都不带
/// (core/runtime/turnTier.ts)。手机本地跑的会话同样不带工具。
///
/// 记在每个会话上: 切回旧会话还是它原来的模式。新会话沿用上一次选的模式 ——
/// 只想聊天的人不用每开一个会话都切一遍。会话发出第一条消息时把当时的模式钉住 (pin),
/// 之后在别的会话里改默认值不会影响它。
///
/// 存 SharedPreferences; 读不到 = Agent (现有行为)。
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;

const _kDefault = 'neox_chat_mode_default';
const _kSessions = 'neox_chat_mode_sessions';
const _kMaxSessions = 500;

class ChatModeState {
  const ChatModeState({required this.defaultOn, required this.bySession});
  final bool defaultOn;
  final Map<String, bool> bySession;

  /// 这个会话现在是不是聊天模式 (没钉过的会话 / 还没会话 = 默认值)。
  bool isOn(String? sessionId) =>
      sessionId != null && bySession.containsKey(sessionId) ? bySession[sessionId]! : defaultOn;
}

class ChatModeController extends StateNotifier<ChatModeState> {
  ChatModeController(this._prefs) : super(_load(_prefs));
  final SharedPreferences _prefs;

  static ChatModeState _load(SharedPreferences prefs) {
    final on = prefs.getBool(_kDefault) ?? false;
    final map = <String, bool>{};
    try {
      final raw = prefs.getString(_kSessions);
      if (raw != null) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          decoded.forEach((k, v) {
            if (k is String && v is bool) map[k] = v;
          });
        }
      }
    } catch (_) {/* 读坏了 = 全按默认 */}
    return ChatModeState(defaultOn: on, bySession: map);
  }

  void _save(ChatModeState next) {
    state = next;
    _prefs.setBool(_kDefault, next.defaultOn);
    _prefs.setString(_kSessions, jsonEncode(next.bySession));
  }

  /// 用户切换: 改这个会话, 同时改新会话的默认值。
  void set(String? sessionId, bool on) {
    final map = Map<String, bool>.of(state.bySession);
    if (sessionId != null) {
      map.remove(sessionId); // 重新插到末尾 = 最近用过
      map[sessionId] = on;
    }
    _save(ChatModeState(defaultOn: on, bySession: _trim(map)));
  }

  /// 发消息时调: 还没钉过的会话把当前生效的模式钉住, 返回这一条该用的模式。
  bool pin(String sessionId) {
    if (state.bySession.containsKey(sessionId)) return state.bySession[sessionId]!;
    final map = Map<String, bool>.of(state.bySession)..[sessionId] = state.defaultOn;
    _save(ChatModeState(defaultOn: state.defaultOn, bySession: _trim(map)));
    return state.defaultOn;
  }

  static Map<String, bool> _trim(Map<String, bool> map) {
    if (map.length <= _kMaxSessions) return map;
    /* 插入顺序即时间顺序, 丢最早的 */
    return Map.fromEntries(map.entries.skip(map.length - _kMaxSessions));
  }
}

final chatModeProvider = StateNotifierProvider<ChatModeController, ChatModeState>(
  (ref) => ChatModeController(ref.read(sharedPreferencesProvider)),
);
