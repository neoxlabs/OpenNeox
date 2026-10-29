/// 端侧流式语音识别 (sherpa-onnx), 移植自 OpenNeoxOS mobile/lib/audio/asr.dart。
///
/// 那边是把模型打进安装包 (103MB); 这里改成**按需下载** (见 voice_settings.dart 的两个 ModelPack),
/// 路径从 ModelStore 取。其余参数都是那边在天玑 9400 上量过的, 原样保留:
///
///   · 两段式: 流式 zipformer 边说边出字, 离线 paraformer 一句说完整句重识别定稿 (RTF 0.007)
///   · 4 线程最快 (8 线程反而慢: 超过大核数之后调度开销盖过并行收益)
///   · NNAPI 会直接 Abort (int8 zipformer 的算子它接不住), GPU 固定开销比算得还久 —— 只用 CPU
///   · 麦克风走 VOICE_COMMUNICATION 那一路 (硬件回声消除), 不开自动增益 (会把底噪拉满当成语音)
///   · PCM 转浮点用 ByteData.getInt16, 不能 asInt16List (回调给的视图 offset 是奇数, 对齐会抛)
///
/// 定稿模型可以没有 —— 没下就只有第一遍, 照样能用。
library;

import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:record/record.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

class AsrText {
  const AsrText(this.text, this.done);
  final String text;
  final bool done;
}

class SherpaAsr {
  SherpaAsr._(this._recognizer, this._offline);

  final sherpa.OnlineRecognizer _recognizer;
  final sherpa.OfflineRecognizer? _offline;

  sherpa.OnlineStream? _stream;
  final _utterance = <double>[];
  final _rec = AudioRecorder();
  StreamSubscription<Uint8List>? _sub;

  final _out = StreamController<AsrText>.broadcast();
  final _lv = StreamController<double>.broadcast();

  /// 识别结果 (永远是这次说话的全文)
  Stream<AsrText> get texts => _out.stream;

  /// 音量 0..1 (分贝映射 + 上升快下降慢的平滑)
  Stream<double> get levels => _lv.stream;

  double _level = 0;
  bool _on = false;
  bool get running => _on;
  String _last = '';
  bool _spokeThisRound = false;
  final _settled = StringBuffer();
  int _lastRolling = 0;
  static const _rollingEvery = 16000 * 3 ~/ 2;
  static const _rollingWindow = 16000 * 12;

  static SherpaAsr? _instance;
  static Future<void>? _loading;
  static String? _loadedKey;

  /// 建 recognizer 要接近 1 秒 (读 25MB 模型 + 建图), 所以起来一次就留着。
  /// 模型路径变了 (用户后来又下了定稿模型) 就重建。
  static Future<SherpaAsr> instance({
    required String streamingModel,
    required String streamingTokens,
    String? refineModel,
    String? refineTokens,
  }) async {
    final key = '$streamingModel|$refineModel';
    if (_instance != null && _loadedKey == key) return _instance!;
    if (_instance != null && _loadedKey != key) {
      await _instance!.stop();
      _instance = null;
      _loading = null;
    }
    _loading ??= _create(streamingModel, streamingTokens, refineModel, refineTokens).then((_) => _loadedKey = key);
    await _loading;
    return _instance!;
  }

  static Future<void> _create(String model, String tokens, String? m2, String? t2) async {
    sherpa.initBindings();
    final config = sherpa.OnlineRecognizerConfig(
      model: sherpa.OnlineModelConfig(
        zipformer2Ctc: sherpa.OnlineZipformer2CtcModelConfig(model: model),
        tokens: tokens,
        numThreads: 4,
        provider: 'cpu',
      ),
      ruleFsts: '',
      enableEndpoint: true,
      /* rule2 0.7s: 每个自然换气锁定一段; 再短会切在词中间, 离线那遍的优势就没了 */
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.7,
      rule3MinUtteranceLength: 20,
    );
    sherpa.OfflineRecognizer? offline;
    if (m2 != null && t2 != null) {
      try {
        offline = sherpa.OfflineRecognizer(sherpa.OfflineRecognizerConfig(
          model: sherpa.OfflineModelConfig(
            paraformer: sherpa.OfflineParaformerModelConfig(model: m2),
            tokens: t2,
            numThreads: 4,
            provider: 'cpu',
          ),
        ));
      } catch (_) {/* 定稿起不来不致命 */}
    }
    _instance = SherpaAsr._(sherpa.OnlineRecognizer(config), offline);
  }

  void _pushLevel(Float32List f) {
    if (f.isEmpty) return;
    var sum = 0.0;
    for (final v in f) {
      sum += v * v;
    }
    final rms = math.sqrt(sum / f.length);
    final db = 20 * math.log(rms + 1e-7) / math.ln10;
    final v = ((db + 55) / 43).clamp(0.0, 1.0);
    _level += (v - _level) * (v > _level ? .5 : .12);
    if (!_lv.isClosed) _lv.add(_level);
  }

  String? _secondPass() {
    final off = _offline;
    if (off == null || _utterance.length < 16000 * 0.3) return null;
    try {
      final s = off.createStream();
      final from = _utterance.length > _rollingWindow ? _utterance.length - _rollingWindow : 0;
      s.acceptWaveform(samples: Float32List.fromList(_utterance.sublist(from)), sampleRate: 16000);
      off.decode(s);
      final t = off.getResult(s).text.trim();
      s.free();
      return t.isEmpty ? null : t;
    } catch (_) {
      return null;
    }
  }

  /// false = 没有麦克风权限
  Future<bool> start() async {
    if (_on) return true;
    if (!await _rec.hasPermission()) return false;
    _stream = _recognizer.createStream();
    _last = '';
    _utterance.clear();
    _lastRolling = 0;
    _settled.clear();
    _spokeThisRound = false;
    final pcm = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      autoGain: false,
      echoCancel: true,
      noiseSuppress: true,
      androidConfig: AndroidRecordConfig(audioSource: AndroidAudioSource.voiceCommunication),
    ));
    _sub = pcm.listen(_onChunk, onError: (_) => stop());
    _on = true;
    return true;
  }

  void _onChunk(Uint8List bytes) {
    final s = _stream;
    if (s == null || bytes.length < 2) return;
    final data = ByteData.sublistView(bytes);
    final n = bytes.lengthInBytes ~/ 2;
    final f = Float32List(n);
    for (var i = 0; i < n; i++) {
      f[i] = data.getInt16(i * 2, Endian.little) / 32768.0;
    }
    s.acceptWaveform(samples: f, sampleRate: 16000);
    _utterance.addAll(f);
    _pushLevel(f);
    while (_recognizer.isReady(s)) {
      _recognizer.decode(s);
    }
    final text = _recognizer.getResult(s).text;
    final end = _recognizer.isEndpoint(s);
    if (text.isNotEmpty) _spokeThisRound = true;

    /* 滚动定稿: 每攒 1.5 秒把当前这一段整段重识别, 前面的字边说边改好 */
    if (!end && _spokeThisRound && _utterance.length - _lastRolling >= _rollingEvery) {
      _lastRolling = _utterance.length;
      final rolled = _secondPass();
      if (rolled != null) {
        if (rolled != _last) {
          _last = rolled;
          _emit(rolled, false);
        }
        return;
      }
    }
    if (!end && text.isNotEmpty && text != _last) {
      _last = text;
      _emit(text, false);
    }
    if (end) {
      /* 静音也会触发断句 —— 这一轮流式出过字才算真有人说话, 才定稿 */
      if (_spokeThisRound) {
        final better = _secondPass();
        if (better != null) {
          _emit(better, true);
          _settled.write(better);
        } else if (_last.isNotEmpty) {
          _emit(_last, true);
          _settled.write(_last);
        }
      }
      _utterance.clear();
      _lastRolling = 0;
      _spokeThisRound = false;
      _recognizer.reset(s);
      _last = '';
    }
  }

  void _emit(String seg, bool done) {
    if (_out.isClosed) return;
    _out.add(AsrText('$_settled$seg', done));
  }

  Future<void> stop() async {
    if (!_on) return;
    _on = false;
    await _sub?.cancel();
    _sub = null;
    try {
      await _rec.stop();
    } catch (_) {}
    _level = 0;
    if (!_lv.isClosed) _lv.add(0);
    _stream?.free();
    _stream = null;
  }
}
