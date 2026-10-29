/// inference_params_provider.dart — 手机本地 Agent 的推理参数偏好.
///
/// 作用域: phone-local 会话 (BYOK 直连 + 订阅网关). 桌面/云端会话的参数
/// 由桌面端自己管理, 不受这里影响.
///
/// 参数面 (刻意收敛, 不过度暴露):
///   - temperature: null=厂商默认; 0.0~1.5 步进 0.1
///   - maxTokens:   1024 / 4096 / 8192 / 16384
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

class InferenceParams {
  const InferenceParams({this.temperature, this.maxTokens = 4096});

  /// null = 不传, 用厂商默认.
  final double? temperature;
  final int maxTokens;

  InferenceParams copyWith({double? Function()? temperature, int? maxTokens}) =>
      InferenceParams(
        temperature: temperature != null ? temperature() : this.temperature,
        maxTokens: maxTokens ?? this.maxTokens,
      );

  String get temperatureLabel =>
      temperature == null ? tr('默认') : temperature!.toStringAsFixed(1);

  /// 菜单里的一行值. 没改过就只写「默认」—— 原来是「T 默认 · 4K」, 普通用户看不懂 T 和 4K。
  String get summary => (temperature == null && maxTokens == 4096)
      ? tr('默认')
      : tr('温度 $temperatureLabel · ${maxTokens ~/ 1024}K');
}

const kMaxTokenChoices = [1024, 4096, 8192, 16384];

const _kTempKey = 'neox_infer_temperature';
const _kMaxTokKey = 'neox_infer_max_tokens';

class InferenceParamsController extends StateNotifier<InferenceParams> {
  InferenceParamsController(this._prefs) : super(_load(_prefs));
  final SharedPreferences _prefs;

  static InferenceParams _load(SharedPreferences p) {
    final t = p.getDouble(_kTempKey);
    final m = p.getInt(_kMaxTokKey) ?? 4096;
    return InferenceParams(
      temperature: t,
      maxTokens: kMaxTokenChoices.contains(m) ? m : 4096,
    );
  }

  Future<void> setTemperature(double? t) async {
    state = state.copyWith(temperature: () => t);
    if (t == null) {
      await _prefs.remove(_kTempKey);
    } else {
      await _prefs.setDouble(_kTempKey, t);
    }
  }

  Future<void> setMaxTokens(int m) async {
    state = state.copyWith(maxTokens: m);
    await _prefs.setInt(_kMaxTokKey, m);
  }
}

final inferenceParamsProvider =
    StateNotifierProvider<InferenceParamsController, InferenceParams>(
      (ref) => InferenceParamsController(ref.read(sharedPreferencesProvider)),
    );

/// 这个模型的思考能不能真关掉 —— 只有能关的才给「思考」开关 (关不掉的给了开关就是骗人)。
///
/// 2026-10-08 经订阅网关端到端实测 (流式 + 带工具, 跟手机同形):
///   · DeepSeek V4 Flash / V4 Pro / V4.1 Flash、neox-free: 关掉后思考 0 字, 首字 1.4–2.6 秒
///     (neox-free 开着思考首字 5.1 秒、想 600 多字)
///   · GLM-5.3 / GPT 系: schemas/models 里的 effort_map 就没有 off 档, 上游只能调深浅
/// [modelId] 可以带 `neox-cloud-payg:` / BYOK `<provider>:` 前缀。
bool canToggleThinking(String modelId) {
  final id = modelId.split(':').last.toLowerCase();
  return id.contains('deepseek') || id == 'neox-free';
}

/// 对话 (手机上跑的 Chat) 要不要思考 —— **每个模型各记一份**, 默认不思考: 普通聊天要的是快,
/// 想清楚再答的场景用户自己在那个模型上打开 (2026-10-08 用户: 「每个模型的 thinking」, 不是一个全局开关)。
/// 只对 [canToggleThinking] 的模型真生效; 其它模型照它们自己的来 (面板上写明)。
///
/// 2026-10-14 陶土稿 v5: 从开 / 关变成四档「关 · 低 · 中 · 高」(模型面板顶上的分段)。
/// 老数据里存的 true 当作「中」。[state] 仍是 modelId → 开没开 (旧调用点只关心这个), 档位另存一张表。
enum ThinkLevel {
  off,
  low,
  medium,
  high;

  /// 发给网关的 reasoning_effort (关 = null, 由 noThinking 那条路处理)
  String? get effort => switch (this) {
        ThinkLevel.off => null,
        ThinkLevel.low => 'low',
        ThinkLevel.medium => 'medium',
        ThinkLevel.high => 'high',
      };

  static ThinkLevel fromName(String? s) =>
      ThinkLevel.values.where((l) => l.name == s).firstOrNull ?? ThinkLevel.off;
}

class ChatThinkingController extends StateNotifier<Map<String, bool>> {
  ChatThinkingController(this._prefs) : _levels = _loadLevels(_prefs), super(_load(_prefs));
  final SharedPreferences _prefs;
  Map<String, ThinkLevel> _levels;

  static Map<String, bool> _load(SharedPreferences p) {
    try {
      final raw = p.getString(_kThinkingKey);
      if (raw == null) return const {};
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry('$k', v == true));
    } catch (_) {
      return const {};
    }
  }

  static Map<String, ThinkLevel> _loadLevels(SharedPreferences p) {
    try {
      final raw = p.getString(_kLevelKey);
      final levels = raw == null
          ? <String, ThinkLevel>{}
          : (jsonDecode(raw) as Map).map((k, v) => MapEntry('$k', ThinkLevel.fromName('$v')));
      /* 老的开 / 关: 开着的当「中」 */
      for (final e in _load(p).entries) {
        if (e.value && !levels.containsKey(e.key)) levels[e.key] = ThinkLevel.medium;
      }
      return levels;
    } catch (_) {
      return {};
    }
  }

  bool isOn(String modelId) => level(modelId) != ThinkLevel.off;

  ThinkLevel level(String modelId) => _levels[modelId] ?? (state[modelId] == true ? ThinkLevel.medium : ThinkLevel.off);

  void set(String modelId, bool on) => setLevel(modelId, on ? ThinkLevel.medium : ThinkLevel.off);

  void setLevel(String modelId, ThinkLevel l) {
    _levels = {..._levels, modelId: l};
    _prefs.setString(_kLevelKey, jsonEncode(_levels.map((k, v) => MapEntry(k, v.name))));
    state = {...state, modelId: l != ThinkLevel.off};
    _prefs.setString(_kThinkingKey, jsonEncode(state));
  }
}

const _kThinkingKey = 'neox_chat_thinking_by_model';
const _kLevelKey = 'neox_chat_thinking_level_by_model';

final chatThinkingProvider = StateNotifierProvider<ChatThinkingController, Map<String, bool>>(
  (ref) => ChatThinkingController(ref.read(sharedPreferencesProvider)),
);
