/// LiteRT-LM 引擎的 Dart 端 (原生侧见 android/.../LiteRtLmBridge.kt)。
///
/// 后端选择 (设置里的「推理加速」):
///   · 自动 —— NPU 预编译模型走 NPU; 通用模型 GPU 起不来就退 CPU, 退了会记下原因给页面显示
///   · GPU / CPU —— 强制
/// 每次生成完原生侧回报实测速度 (首字耗时 / 预填充 / 生成 tok/s), 存下来按模型显示在列表里。
library;

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum LlmBackendPref { auto, gpu, cpu }

const _kPrefKey = 'local_llm.backend';
const _kStatsKey = 'local_llm.stats.';

Future<LlmBackendPref> loadBackendPref() async {
  final p = await SharedPreferences.getInstance();
  final v = p.getString(_kPrefKey);
  return LlmBackendPref.values.firstWhere((e) => e.name == v, orElse: () => LlmBackendPref.auto);
}

Future<void> saveBackendPref(LlmBackendPref v) async {
  final p = await SharedPreferences.getInstance();
  await p.setString(_kPrefKey, v.name);
}

/// 某个模型最近一次的实测
class LlmRunStats {
  const LlmRunStats({required this.backend, this.ttft, this.prefillTps, this.decodeTps});
  final String backend; // 'npu' | 'gpu' | 'cpu'
  final double? ttft;
  final double? prefillTps;
  final double? decodeTps;

  String get label {
    final b = backend.toUpperCase();
    final d = decodeTps;
    return d == null || d <= 0 ? b : '$b · ${d.toStringAsFixed(d >= 10 ? 0 : 1)} tok/s';
  }
}

Future<LlmRunStats?> loadRunStats(String modelId) async {
  final p = await SharedPreferences.getInstance();
  final s = p.getStringList('$_kStatsKey$modelId');
  if (s == null || s.isEmpty) return null;
  return LlmRunStats(
    backend: s[0],
    ttft: s.length > 1 ? double.tryParse(s[1]) : null,
    prefillTps: s.length > 2 ? double.tryParse(s[2]) : null,
    decodeTps: s.length > 3 ? double.tryParse(s[3]) : null,
  );
}

Future<void> saveRunStats(String modelId, LlmRunStats st) async {
  final p = await SharedPreferences.getInstance();
  await p.setStringList('$_kStatsKey$modelId', [
    st.backend,
    '${st.ttft ?? ''}',
    '${st.prefillTps ?? ''}',
    '${st.decodeTps ?? ''}',
  ]);
}

class LiteRtLoadResult {
  const LiteRtLoadResult(this.backend, this.fallbacks);
  final String backend;

  /// 自动退级时前面几个后端失败的原因 ('gpu: xxx')
  final List<String> fallbacks;
}

class LiteRtEngine {
  LiteRtEngine._();
  static final LiteRtEngine instance = LiteRtEngine._();

  static const _method = MethodChannel('neox.llm/litert');
  static const _events = EventChannel('neox.llm/litert/stream');

  Stream<Map>? _bus;
  String? _loadedPath;
  String? _loadedBackend;
  List<String> lastFallbacks = const [];

  String? get loadedPath => _loadedPath;
  String? get loadedBackend => _loadedBackend;

  Stream<Map> get _stream => _bus ??= _events.receiveBroadcastStream().map((e) => e as Map).asBroadcastStream();

  /// [backend]: 'auto' | 'npu' | 'gpu' | 'cpu'
  Future<LiteRtLoadResult> load(String path, String backend, {int maxTokens = 4096}) async {
    final r = await _method.invokeMapMethod<String, dynamic>('load', {
      'path': path,
      'backend': backend,
      'maxTokens': maxTokens,
    });
    if (r == null || r['ok'] != true) {
      _loadedPath = null;
      _loadedBackend = null;
      final errs = (r?['errors'] as List?)?.cast<String>() ?? const [];
      throw StateError(errs.isEmpty ? 'LiteRT load failed' : errs.join('\n'));
    }
    _loadedPath = path;
    _loadedBackend = r['backend'] as String?;
    lastFallbacks = (r['fallbacks'] as List?)?.cast<String>() ?? const [];
    return LiteRtLoadResult(_loadedBackend ?? 'cpu', lastFallbacks);
  }

  /// 流式生成; 结束时把实测速度记到 [statsModelId] 名下
  Stream<String> generate({
    required List<({String role, String content})> messages,
    String? system,
    double temperature = 0.7,
    bool thinking = false,
    String? statsModelId,
  }) {
    late StreamController<String> out;
    StreamSubscription<Map>? sub;
    out = StreamController<String>(
      onListen: () async {
        /* 先订阅再发请求, 首个 token 不会漏 */
        sub = _stream.listen((e) {
          switch (e['t']) {
            case 'tok':
              out.add(e['s'] as String);
            case 'err':
              out.addError(StateError(e['msg'] as String? ?? 'LiteRT error'));
              sub?.cancel();
              out.close();
            case 'done':
              final st = LlmRunStats(
                backend: e['backend'] as String? ?? _loadedBackend ?? 'cpu',
                ttft: (e['ttft'] as num?)?.toDouble(),
                prefillTps: (e['prefillTps'] as num?)?.toDouble(),
                decodeTps: (e['decodeTps'] as num?)?.toDouble(),
              );
              if (statsModelId != null) unawaited(saveRunStats(statsModelId, st));
              sub?.cancel();
              out.close();
          }
        });
        try {
          await _method.invokeMethod('generate', {
            'messages': [
              for (final m in messages) {'role': m.role, 'content': m.content},
            ],
            'system': system,
            'temperature': temperature,
            'thinking': thinking,
          });
        } catch (e) {
          out.addError(e);
          await sub?.cancel();
          await out.close();
        }
      },
      onCancel: () async {
        await sub?.cancel();
        await stop();
      },
    );
    return out.stream;
  }

  Future<void> stop() async {
    try {
      await _method.invokeMethod('stop');
    } catch (_) {}
  }

  Future<void> unload() async {
    _loadedPath = null;
    _loadedBackend = null;
    try {
      await _method.invokeMethod('unload');
    } catch (_) {}
  }
}
