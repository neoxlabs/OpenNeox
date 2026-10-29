/// 云端语音识别: 录一段 → 松开 / 点停 → 整段发给识别服务 (两种接口见 [CloudAsrProtocol])。
///
/// 不做流式: 各家流式接口互不兼容 (OpenAI Realtime / 阿里 WebSocket / 讯飞...), 整段上传各家都有。
/// 录音期间照样有波形。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'voice_settings.dart';

class CloudAsr {
  CloudAsr(this.config);
  final CloudAsrConfig config;

  final _rec = AudioRecorder();
  final _lv = StreamController<double>.broadcast();
  Timer? _amp;
  String? _path;
  double _level = 0;

  Stream<double> get levels => _lv.stream;

  Future<bool> start() async {
    if (!await _rec.hasPermission()) return false;
    final dir = await getTemporaryDirectory();
    _path = '${dir.path}/neox-voice-${DateTime.now().millisecondsSinceEpoch}.wav';
    await _rec.start(
      const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1, autoGain: false, noiseSuppress: true),
      path: _path!,
    );
    _amp = Timer.periodic(const Duration(milliseconds: 60), (_) async {
      try {
        final a = await _rec.getAmplitude();
        final v = normalizeDb(a.current);
        _level += (v - _level) * (v > _level ? .5 : .12);
        if (!_lv.isClosed) _lv.add(_level);
      } catch (_) {}
    });
    return true;
  }

  /// 停止录音并识别。没说话 / 太短返回空串; 服务报错抛 [StateError] (带人话)。
  Future<String> stopAndTranscribe() async {
    _amp?.cancel();
    _amp = null;
    if (!_lv.isClosed) _lv.add(0);
    final path = await _rec.stop() ?? _path;
    if (path == null) return '';
    final f = File(path);
    try {
      if (!await f.exists() || await f.length() < 16000) return ''; // < 0.5 秒
      return await transcribeWav(config, await f.readAsBytes());
    } finally {
      unawaited(f.delete().catchError((_) => f));
    }
  }

  /// 整段 WAV 送去识别。两种接口见 [CloudAsrProtocol]; 服务报错抛 [StateError] (带人话)。
  static Future<String> transcribeWav(CloudAsrConfig config, Uint8List wav) async {
    final base = config.baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    final dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 15), receiveTimeout: const Duration(seconds: 60)));
    final auth = Options(headers: {'Authorization': 'Bearer ${config.apiKey.trim()}'});
    try {
      if (config.protocol == CloudAsrProtocol.chatAudio) {
        /* 阿里云百炼 qwen3-asr: 音频作为 input_audio 塞进一条用户消息, 结果在回复正文里 */
        final r = await dio.post<Map<String, dynamic>>(
          '$base/chat/completions',
          data: {
            'model': config.model.trim(),
            'stream': false,
            'messages': [
              {
                'role': 'user',
                'content': [
                  {
                    'type': 'input_audio',
                    'input_audio': {'data': 'data:audio/wav;base64,${base64Encode(wav)}'},
                  },
                ],
              },
            ],
          },
          options: auth,
        );
        final choices = r.data?['choices'];
        final msg = choices is List && choices.isNotEmpty ? (choices.first as Map)['message'] : null;
        return ((msg is Map ? msg['content'] : null) as String?)?.trim() ?? '';
      }
      final form = FormData.fromMap({
        'model': config.model.trim(),
        'file': MultipartFile.fromBytes(wav, filename: 'audio.wav'),
        'response_format': 'json',
      });
      final r = await dio.post<Map<String, dynamic>>('$base/audio/transcriptions', data: form, options: auth);
      return (r.data?['text'] as String?)?.trim() ?? '';
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      if (code == 401 || code == 403) throw StateError(tr('Key 不对或没开通语音识别'));
      if (code == 404) throw StateError(tr('接口地址不对'));
      /* 400 多半是模型名 / 参数, 服务商原话最有用 */
      final said = _vendorMessage(e.response?.data);
      if (code != null) throw StateError(said == null ? tr('识别失败 ($code)') : '$code · $said');
      throw StateError(tr('连不上识别服务'));
    }
  }

  /// 测连接: 送 1 秒静音。能正常返回 (哪怕是空文本) 就算通。返回耗时毫秒。
  static Future<int> test(CloudAsrConfig config) async {
    final sw = Stopwatch()..start();
    await transcribeWav(config, silentWav(1));
    return sw.elapsedMilliseconds;
  }

  static String? _vendorMessage(Object? data) {
    Object? m = data;
    if (m is Map) m = m['error'] is Map ? (m['error'] as Map)['message'] : (m['message'] ?? m['error']);
    if (m is! String || m.trim().isEmpty) return null;
    final s = m.trim();
    return s.length > 120 ? '${s.substring(0, 120)}…' : s;
  }

  Future<void> cancel() async {
    _amp?.cancel();
    _amp = null;
    try {
      final p = await _rec.stop();
      if (p != null) await File(p).delete();
    } catch (_) {}
  }

  void dispose() {
    _amp?.cancel();
    unawaited(_rec.dispose());
    unawaited(_lv.close());
  }
}

/// [seconds] 秒的 16kHz 单声道 16bit 静音 WAV (测连接用)
Uint8List silentWav(int seconds) {
  const rate = 16000;
  final dataLen = rate * 2 * seconds;
  final b = ByteData(44 + dataLen);
  void str(int o, String s) {
    for (var i = 0; i < s.length; i++) {
      b.setUint8(o + i, s.codeUnitAt(i));
    }
  }

  str(0, 'RIFF');
  b.setUint32(4, 36 + dataLen, Endian.little);
  str(8, 'WAVE');
  str(12, 'fmt ');
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little); // PCM
  b.setUint16(22, 1, Endian.little); // mono
  b.setUint32(24, rate, Endian.little);
  b.setUint32(28, rate * 2, Endian.little);
  b.setUint16(32, 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  str(36, 'data');
  b.setUint32(40, dataLen, Endian.little);
  return b.buffer.asUint8List();
}

/// 分贝 → 0..1: −55dB 当静 (安静房间底噪), −12dB 当满 —— 跟本地识别同一条曲线
double normalizeDb(double db) => math.max(0, math.min(1, (db + 55) / 43));
