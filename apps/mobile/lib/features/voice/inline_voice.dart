/// inline_voice.dart — 输入框内联语音输入 (声纹波浪 + 实时转写).
///
/// 用户拍板 (2026-07-20): 语音不弹窗 — 波浪直接显示在输入框内, 转写文字
/// 实时写进 TextField, 更直观.
///
/// 组成:
///   - [InlineVoiceController]: 三种引擎 (本地 sherpa / 系统 speech_to_text / 云端转写) 同一套回调,
///     声级缓冲, 状态回调 —— 输入框不关心字是谁识别出来的
///   - [InlineWaveform]: 圆角竖条声纹, ticker 驱动 60fps 重绘 (不走 setState)
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/voice/cloud_asr.dart';
import '../../core/voice/hosted_asr.dart';
import '../../core/voice/sherpa_asr.dart';
import '../../core/voice/voice_settings.dart';

/// 本地识别的模型路径 (定稿那对可以没有)
typedef LocalAsrPaths = ({String model, String tokens, String? refineModel, String? refineTokens});

/// 波浪柱条数.
const int kInlineWaveBars = 36;

/// 国内 ROM (OPPO/vivo/小米) 普遍没有标准 RecognitionService — error_client
/// 的根因. 诚实降级引导键盘语音.
final String kNoSpeechServiceMsg =
    tr('这台手机没有可用的系统语音识别服务。可以用键盘自带的麦克风语音输入。');

class InlineVoiceController {
  InlineVoiceController({
    required this.onText,
    required this.onStateChange,
    required this.onError,
  });

  /// 识别文字更新 (整段 recognizedWords, 由调用方拼接到已有输入).
  final void Function(String text) onText;

  /// listening 状态变化 (true=在听).
  final void Function(bool listening) onStateChange;

  final void Function(String message) onError;

  final SpeechToText _speech = SpeechToText();
  bool _listening = false;
  bool get listening => _listening;

  /// 滚动声级缓冲 (0..1), 尾部最新 — InlineWaveform 直接读.
  final List<double> levels =
      List<double>.filled(kInlineWaveBars, 0, growable: true);
  double _lastLevel = 0;
  Timer? _decay;

  void _pushLevel(double v) {
    _lastLevel = v;
    levels.add(v.clamp(0.0, 1.0));
    while (levels.length > kInlineWaveBars) {
      levels.removeAt(0);
    }
  }

  void _setListening(bool v) {
    if (_listening == v) return;
    _listening = v;
    onStateChange(v);
  }

  /* 每次开录 +1, cancel 也 +1: 识别结果带着开录时的编号, 对不上就丢。
   * 识别引擎在停下之后还会再吐一两次 (本地的收尾精修、系统识别的 final、云端的整段转写),
   * 发送之后这些迟到的字会把刚发出去的话原样写回输入框 —— 用户看到的「发完一直存在」。 */
  int _epoch = 0;

  void _emit(int epoch, String text) {
    if (epoch == _epoch) onText(text);
  }

  VoiceEngine _engine = VoiceEngine.system;
  SherpaAsr? _local;
  StreamSubscription<AsrText>? _localText;
  StreamSubscription<double>? _localLevel;
  CloudAsr? _cloud;
  StreamSubscription<double>? _cloudLevel;
  HostedAsrSession? _hosted;
  StreamSubscription<String>? _hostedText;
  StreamSubscription<double>? _hostedLevel;

  /// 按设置里选的引擎开始听。本地要先确认模型装好 ([local] 非空), 云端要配置齐 ([cloud].ready) ——
  /// 这两个前置由调用方检查 (没装 / 没配要弹引导, 那是界面的事)。
  Future<void> start({
    VoiceEngine engine = VoiceEngine.system,
    LocalAsrPaths? local,
    CloudAsrConfig? cloud,
    HostedAsr? hosted,
  }) async {
    if (_listening) return;
    _epoch++;
    _engine = engine;
    if (engine == VoiceEngine.subscription && hosted != null && hosted.available) return _startHosted(hosted);
    if (engine == VoiceEngine.subscription) _engine = VoiceEngine.system;
    if (engine == VoiceEngine.local && local != null) return _startLocal(local);
    if (engine == VoiceEngine.cloud && cloud != null && cloud.ready) return _startCloud(cloud);
    return _startSystem();
  }

  Future<void> _startLocal(LocalAsrPaths p) async {
    try {
      final asr = await SherpaAsr.instance(
        streamingModel: p.model,
        streamingTokens: p.tokens,
        refineModel: p.refineModel,
        refineTokens: p.refineTokens,
      );
      _local = asr;
      await _localText?.cancel();
      await _localLevel?.cancel();
      final epoch = _epoch;
      _localText = asr.texts.listen((t) => _emit(epoch, t.text));
      _localLevel = asr.levels.listen(_pushLevel);
      if (!await asr.start()) {
        onError(tr('需要麦克风权限 — 到系统设置里打开'));
        return;
      }
      _setListening(true);
    } catch (e) {
      onError(tr('本地语音启动失败: $e'));
    }
  }

  Future<void> _startHosted(HostedAsr backend) async {
    final s = HostedAsrSession(backend);
    _hosted = s;
    final epoch = _epoch;
    await _hostedText?.cancel();
    await _hostedLevel?.cancel();
    _hostedText = s.texts.listen((t) => _emit(epoch, t));
    _hostedLevel = s.levels.listen(_pushLevel);
    try {
      if (!await s.start(onError: onError)) {
        onError(tr('需要麦克风权限 — 到系统设置里打开'));
        return;
      }
      _setListening(true);
    } catch (e) {
      onError(tr('录音启动失败: $e'));
    }
  }

  Future<void> _startCloud(CloudAsrConfig c) async {
    final asr = CloudAsr(c);
    _cloud = asr;
    await _cloudLevel?.cancel();
    _cloudLevel = asr.levels.listen(_pushLevel);
    try {
      if (!await asr.start()) {
        onError(tr('需要麦克风权限 — 到系统设置里打开'));
        return;
      }
      _setListening(true);
    } catch (e) {
      onError(tr('录音启动失败: $e'));
    }
  }

  Future<void> _startSystem() async {
    try {
      final ok = await _speech.initialize(
        onError: (e) {
          _setListening(false);
          if (e.errorMsg != 'error_no_match') {
            onError(_humanize(e.errorMsg));
          }
        },
        onStatus: (status) {
          if (status == 'notListening' || status == 'done') {
            _setListening(false);
          }
        },
      );
      if (!ok) {
        onError(kNoSpeechServiceMsg);
        return;
      }
    } catch (e) {
      onError(tr('语音初始化失败: $e'));
      return;
    }
    _decay ??= Timer.periodic(const Duration(milliseconds: 50), (_) {
      _pushLevel(_listening ? _lastLevel * 0.72 : 0);
    });
    _setListening(true);
    final epoch = _epoch;
    await _speech.listen(
      onResult: (SpeechRecognitionResult r) => _emit(epoch, r.recognizedWords),
      onSoundLevelChange: (level) {
        /* Android 是 dB 相对值 (~-2..10); iOS 已经 0..1. 统一归一. */
        final norm =
            level > 1.5 || level < 0 ? ((level + 2.0) / 12.0) : level;
        _pushLevel(norm.clamp(0.0, 1.0));
      },
      listenOptions: SpeechListenOptions(
        listenMode: ListenMode.dictation,
        partialResults: true,
        localeId: 'zh_CN',
        pauseFor: const Duration(seconds: 3),
      ),
    );
  }

  /// 停止。云端这时才开始转写 —— 转写期间 [transcribing] 为 true, 结果经 onText 一次给出。
  Future<void> stop() async {
    _setListening(false);
    final epoch = _epoch;
    switch (_engine) {
      case VoiceEngine.local:
        await _local?.stop();
      case VoiceEngine.cloud:
        final c = _cloud;
        _cloud = null;
        if (c == null) return;
        onTranscribing?.call(true);
        try {
          final text = await c.stopAndTranscribe();
          if (text.isNotEmpty) _emit(epoch, text);
        } catch (e) {
          onError(e.toString().replaceFirst('Bad state: ', ''));
        } finally {
          onTranscribing?.call(false);
          c.dispose();
        }
      case VoiceEngine.subscription:
        final s = _hosted;
        _hosted = null;
        if (s == null) return;
        /* 边说边出字, 停下后网关再回一次定稿 —— 等它 (最多 4 秒) 再收 */
        onTranscribing?.call(true);
        try {
          final text = await s.stop();
          if (text.isNotEmpty) _emit(epoch, text);
        } finally {
          onTranscribing?.call(false);
          s.dispose();
        }
      case VoiceEngine.system:
        try {
          await _speech.stop();
        } catch (_) {}
    }
  }

  /// 不要结果地停 (消息已经发出去了): 立刻停录, 之后到的识别结果一律丢掉。
  /// 不停的话麦克风还开着, 会把念出来的回复也录进去, 再发一遍。
  Future<void> cancel() async {
    _epoch++;
    _setListening(false);
    switch (_engine) {
      case VoiceEngine.local:
        await _local?.stop();
      case VoiceEngine.cloud:
        final c = _cloud;
        _cloud = null;
        await c?.cancel();
        c?.dispose();
      case VoiceEngine.subscription:
        final s = _hosted;
        _hosted = null;
        await s?.cancel();
        s?.dispose();
      case VoiceEngine.system:
        try {
          await _speech.cancel();
        } catch (_) {}
    }
  }

  /// 云端转写中 (录完在等服务器) —— 输入框据此显示「识别中…」
  void Function(bool busy)? onTranscribing;

  void dispose() {
    _decay?.cancel();
    _decay = null;
    unawaited(_speech.cancel());
    unawaited(_localText?.cancel());
    unawaited(_localLevel?.cancel());
    unawaited(_local?.stop());
    unawaited(_cloudLevel?.cancel());
    unawaited(_cloud?.cancel());
    unawaited(_hostedText?.cancel());
    unawaited(_hostedLevel?.cancel());
    _hosted?.dispose();
  }

  String _humanize(String code) {
    switch (code) {
      case 'error_permission':
      case 'error_insufficient_permissions':
        return tr('需要麦克风权限 — 到系统设置里打开');
      case 'error_network':
        return tr('语音服务需要网络');
      case 'error_busy':
        return tr('语音服务被占用, 稍后再试');
      case 'error_client':
      case 'error_server':
        return kNoSpeechServiceMsg;
      default:
        return tr('识别出错 ($code)');
    }
  }
}

/// 输入框内联声纹 — 圆角竖条, 尾部 (最新) 不透明, 头部淡出.
class InlineWaveform extends StatefulWidget {
  const InlineWaveform({
    super.key,
    required this.levels,
    this.height = 20,
    this.color,
  });

  /// 共享可变 buffer (InlineVoiceController.levels).
  final List<double> levels;
  final double height;
  final Color? color;

  @override
  State<InlineWaveform> createState() => _InlineWaveformState();
}

class _InlineWaveformState extends State<InlineWaveform>
    with SingleTickerProviderStateMixin {
  late final AnimationController _tick = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 1),
  )..repeat();

  @override
  void dispose() {
    _tick.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? Theme.of(context).colorScheme.primary;
    return SizedBox(
      height: widget.height,
      width: double.infinity,
      child: CustomPaint(
        painter: _WavePainter(
          levels: widget.levels,
          color: color,
          repaint: _tick,
        ),
      ),
    );
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.levels,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final List<double> levels;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final n = levels.length;
    if (n == 0) return;
    /* 细条定宽 (2026-09-30 用户: 「太粗大、太高, 一点都不精致」)。原来条宽 = 屏宽 / (条数×1.75),
     * 大屏上一根 5~6px、高 32 —— 一排胶囊糖。现在 2px 宽、3px 间距、整体居中, 高度封顶 20。 */
    const barW = 2.0;
    const gap = 3.0;
    final total = n * barW + (n - 1) * gap;
    final left = ((size.width - total) / 2).clamp(0.0, double.infinity);
    final midY = size.height / 2;
    const minH = 2.0;
    final paint = Paint()..style = PaintingStyle.fill;

    for (var i = 0; i < n; i++) {
      final ageFade = 0.25 + 0.75 * (i / (n - 1));
      final h = minH + (size.height - minH) * math.sqrt(levels[i]);
      paint.color = color.withValues(alpha: ageFade);
      final x = left + i * (barW + gap);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset(x + barW / 2, midY),
            width: barW,
            height: h,
          ),
          Radius.circular(barW / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WavePainter old) =>
      old.color != color || old.levels != levels;
}
