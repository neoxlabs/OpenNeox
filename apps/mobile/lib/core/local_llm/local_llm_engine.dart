/// 本地大模型推理, 两个引擎按模型分派:
///   · GGUF → llama.cpp (llama_flutter_android), CPU
///   · .litertlm → LiteRT-LM (litert_engine.dart), NPU / GPU / CPU, 按「推理加速」设置选后端
///
/// 一次只驻留一个模型 (手机内存扛不住两个): 换模型先卸再装, 跨引擎也一样 —— 先把另一个引擎卸干净。
/// 加载一个 1~2.5GB 的模型要几秒, 所以装好就留着, 下一条消息直接用。
///
/// 纯对话, 不带工具: 这个量级的模型工具调用不可靠, 调错一次比不调还糟。
/// 每轮把整段对话重新喂进去 —— 简单且不会串会话; 上下文 4096, 历史由调用方按字数截过。
library;

import 'dart:async';
import 'dart:io';

import 'package:llama_flutter_android/llama_flutter_android.dart';

import '../models/model_store.dart';
import 'litert_engine.dart';
import 'local_model_catalog.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// [s] 结尾若是同一段连续重复 3 遍 (段长 2~80, 重复部分合计 ≥ 12 字), 返回只保留第一遍的截断点; 否则 null。
/// 纯符号段不算 (表格分隔线 |---|---|, 分割线 ====)。
int? repeatCutPoint(String s) {
  for (var p = 2; p <= 80 && p * 3 <= s.length; p++) {
    if (p * 3 < 12) continue;
    final a = s.length - p;
    final unit = s.substring(a);
    if (!_kLetter.hasMatch(unit)) continue;
    if (s.substring(a - p, a) == unit && s.substring(a - 2 * p, a - p) == unit) {
      return a - p;
    }
  }
  return null;
}

final _kLetter = RegExp(r'\p{L}', unicode: true);

class LocalLlmEngine {
  LocalLlmEngine._();
  static final LocalLlmEngine instance = LocalLlmEngine._();

  LlamaController? _ctl;
  String? _loadedId;
  LlmEngineKind? _loadedKind;
  String? _loadedPref;
  Future<void>? _loading;

  final _litert = LiteRtEngine.instance;

  Future<String> _modelPath(LocalLlm m, ModelStore store) async {
    if (!await store.isInstalled(m.pack)) {
      throw StateError(tr('「${m.name}」还没下载，去「我的模型 → 本地部署」下载'));
    }
    final path = await store.pathOf(m.pack, m.file);
    if (!await File(path).exists()) throw StateError(tr('模型文件不见了，请重新下载'));
    return path;
  }

  Future<void> _unloadAll() async {
    final old = _ctl;
    _ctl = null;
    _loadedId = null;
    _loadedKind = null;
    _loadedPref = null;
    if (old != null) await old.dispose();
    if (_litert.loadedPath != null) await _litert.unload();
  }

  /// 装载 (已装载同一个、同样后端设置直接返回)
  Future<void> _ensure(LocalLlm m, ModelStore store) async {
    final pref = m.engine == LlmEngineKind.litert ? await _litertBackend(m) : 'cpu';
    bool ready() => _loadedId == m.id && _loadedPref == pref && (_ctl != null || _litert.loadedPath != null);
    if (ready()) return;
    if (_loading != null) {
      await _loading;
      if (ready()) return;
    }
    final c = Completer<void>();
    _loading = c.future;
    try {
      final path = await _modelPath(m, store);
      await _unloadAll();
      if (m.engine == LlmEngineKind.litert) {
        await _litert.load(path, pref);
      } else {
        final ctl = LlamaController();
        await ctl.loadModel(
          modelPath: path,
          /* 4 线程: 手机上大核一般 4 个以内, 线程数超过大核只会更慢 (语音那边实测过同一个结论) */
          threads: 4,
          contextSize: 4096,
          gpuLayers: 0,
        );
        _ctl = ctl;
      }
      _loadedId = m.id;
      _loadedKind = m.engine;
      _loadedPref = pref;
    } finally {
      c.complete();
      _loading = null;
    }
  }

  /// NPU 预编译模型只能走 NPU; 通用 LiteRT 模型按设置 (自动 = GPU 起不来退 CPU, GPU = 只用 GPU)
  Future<String> _litertBackend(LocalLlm m) async {
    if (m.isNpu) return 'npu';
    return switch (await loadBackendPref()) {
      LlmBackendPref.auto => 'auto',
      LlmBackendPref.gpu => 'gpu',
      LlmBackendPref.cpu => 'cpu',
    };
  }

  /// 流式对话。[messages] 为 {role, content} (content 只取文本)。
  Stream<String> chat({
    required LocalLlm model,
    required ModelStore store,
    required List<({String role, String content})> messages,
    int maxTokens = 1024,
    double temperature = 0.7,
  }) async* {
    await _ensure(model, store);
    if (model.engine == LlmEngineKind.litert) {
      /* LiteRT 自己套模板: system 单独给, 其余按轮次; Qwen3 的思考用 ThinkingConfig 关 */
      final system = messages.where((m) => m.role == 'system').map((m) => m.content).join('\n\n');
      final turns = [for (final m in messages) if (m.role != 'system') m];
      yield* _guardLoop(
        _stripThink(
          _litert.generate(
            messages: turns,
            system: system.isEmpty ? null : system,
            temperature: temperature,
            statsModelId: model.id,
          ),
          model.hybridThinking || model.id.contains('qwen3'),
        ),
        maxTokens,
      );
      return;
    }
    final ctl = _ctl!;
    await ctl.clearContext();
    final msgs = [
      for (final m in messages) ChatMessage(role: m.role, content: m.content),
    ];
    /* Qwen3 混合思考: 系统提示里加 /no_think 关掉长思考 (官方开关) */
    if (model.hybridThinking && msgs.isNotEmpty && msgs.first.role == 'system') {
      msgs.first.content = '${msgs.first.content} /no_think';
    }
    final t0 = DateTime.now();
    DateTime? first;
    var chunks = 0;
    yield* _guardLoop(_stripThink(
      ctl
          .generateChat(
            messages: msgs,
            template: model.template,
            maxTokens: maxTokens,
            temperature: temperature,
          )
          .map((t) {
        first ??= DateTime.now();
        chunks++;
        return t;
      }),
      model.hybridThinking,
    ), maxTokens);
    /* llama.cpp 插件不回报速度: 按流出的 token 块数 / 生成时长粗算 (一块≈一个 token) */
    final f = first;
    if (f != null && chunks > 4) {
      final secs = DateTime.now().difference(f).inMilliseconds / 1000.0;
      unawaited(saveRunStats(
        model.id,
        LlmRunStats(
          backend: 'cpu',
          ttft: f.difference(t0).inMilliseconds / 1000.0,
          decodeTps: secs > 0 ? chunks / secs : null,
        ),
      ));
    }
  }

  /// 复读刹车 + 长度上限。NPU 只做贪心解码 (采样参数不生效), 小模型一进循环就停不下来,
  /// 真机上一句「我正在努力！」刷满整个上下文; LiteRT 也没有单次输出上限的参数。
  /// 结尾出现同一段 (2~80 字) 连续 3 遍就停, 并把多出来的重复截掉; 流出块数到 [maxTokens] 也停。
  Stream<String> _guardLoop(Stream<String> src, int maxTokens) async* {
    final buf = StringBuffer();
    var sent = 0;
    var chunks = 0;
    await for (final tok in src) {
      buf.write(tok);
      chunks++;
      final s = buf.toString();
      final cut = repeatCutPoint(s);
      if (cut != null) {
        if (cut > sent) yield s.substring(sent, cut);
        await stop();
        return;
      }
      yield s.substring(sent);
      sent = s.length;
      if (chunks >= maxTokens) {
        await stop();
        return;
      }
    }
  }

  /* 关了思考 Qwen3 仍会先吐一个空的 <think></think>, 这段不给用户看。
   * 0 = 开头还没看清 (攒着) · 1 = 在 think 里 (丢) · 2 = 正文 (直出) */
  Stream<String> _stripThink(Stream<String> src, bool enabled) async* {
    var phase = enabled ? 0 : 2;
    var buf = '';
    await for (final tok in src) {
      if (phase == 2) {
        yield tok;
        continue;
      }
      buf += tok;
      if (phase == 0) {
        final t = buf.trimLeft();
        if (t.startsWith('<think>')) {
          phase = 1;
        } else if (!'<think>'.startsWith(t)) {
          phase = 2;
          yield buf;
          continue;
        } else {
          continue;
        }
      }
      final end = buf.indexOf('</think>');
      if (end < 0) continue;
      phase = 2;
      final rest = buf.substring(end + 8).trimLeft();
      if (rest.isNotEmpty) yield rest;
    }
    if (phase == 0 && buf.isNotEmpty) yield buf;
  }

  Future<void> stop() async {
    try {
      if (_loadedKind == LlmEngineKind.litert) {
        await _litert.stop();
      } else {
        await _ctl?.stop();
      }
    } catch (_) {}
  }

  /// 删除模型前先卸载 (文件被占着删不掉 / 删了还在内存里跑)
  Future<void> unloadIf(String id) async {
    if (_loadedId != id) return;
    await _unloadAll();
  }

  String? get loadedId => _loadedId;

  /// 当前模型实际跑在哪个后端 ('npu' | 'gpu' | 'cpu'); 自动退级后可能和设置不一样
  String? get loadedBackend => _loadedKind == LlmEngineKind.litert ? _litert.loadedBackend : (_ctl != null ? 'cpu' : null);
}
