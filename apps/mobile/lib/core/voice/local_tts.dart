/// 手机本地语音合成 (sherpa-onnx + MeloTTS 中英混说, 跟电脑本地合成同一个模型)。
///
/// 模型按需下载 (约 170MB, 不进安装包), 托管在 R2: models/tts/vits-melo-tts-zh_en。
/// sherpa 1.12.15 起 Melo 不再需要 jieba 词典目录, 所以清单是平铺的几个文件。
///
/// 合成在后台 isolate 里跑: 一句要几百毫秒到一秒多, 放主 isolate 上通话界面会卡。
/// 引擎 (FFI 句柄) 建在那个 isolate 里、一直留着 —— 建一次要读 170MB 模型。
library;

import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;

import '../models/model_store.dart';

const ModelPack kTtsMeloPack = ModelPack(
  kind: 'tts',
  id: 'vits-melo-tts-zh_en',
  title: '本地声音',
  subtitle: '不联网也能说话, 中英混说',
  manifestUrl: 'https://dl.neox-dev.com/models/tts/vits-melo-tts-zh_en/manifest.json',
  approxBytes: 177503169,
);

class LocalTts {
  LocalTts._();
  static final LocalTts instance = LocalTts._();

  SendPort? _port;
  String? _dir;
  Future<SendPort>? _starting;

  /// 一句话 → WAV 字节。[modelDir] = 模型装好的目录。
  Future<Uint8List> synth(String text, {required String modelDir, double speed = 1.0}) async {
    final port = await _ensure(modelDir);
    final reply = ReceivePort();
    port.send([text, speed, reply.sendPort]);
    final r = await reply.first.timeout(const Duration(seconds: 30));
    reply.close();
    if (r is String) throw StateError('本地合成失败: $r');
    final (samples, rate) = r as (Float32List, int);
    return _wav(samples, rate);
  }

  Future<SendPort> _ensure(String dir) {
    if (_port != null && _dir == dir) return Future.value(_port);
    if (_starting != null && _dir == dir) return _starting!;
    _dir = dir;
    final ready = ReceivePort();
    return _starting = Isolate.spawn(_worker, [dir, ready.sendPort]).then((_) async {
      final r = await ready.first;
      ready.close();
      if (r is String) {
        _starting = null;
        _dir = null;
        throw StateError('本地声音模型起不来: $r');
      }
      return _port = r as SendPort;
    });
  }

  static void _worker(List<Object?> args) {
    final dir = args[0] as String;
    final ready = args[1] as SendPort;
    final sherpa.OfflineTts tts;
    try {
      sherpa.initBindings();
      tts = sherpa.OfflineTts(sherpa.OfflineTtsConfig(
        model: sherpa.OfflineTtsModelConfig(
          vits: sherpa.OfflineTtsVitsModelConfig(
            model: '$dir/model.onnx',
            lexicon: '$dir/lexicon.txt',
            tokens: '$dir/tokens.txt',
          ),
          numThreads: 2,
          debug: false,
          provider: 'cpu',
        ),
        ruleFsts: ['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst'].map((f) => '$dir/$f').join(','),
      ));
    } catch (e) {
      ready.send('$e');
      return;
    }
    final inbox = ReceivePort();
    ready.send(inbox.sendPort);
    inbox.listen((msg) {
      final m = msg as List<Object?>;
      final reply = m[2] as SendPort;
      try {
        final a = tts.generate(text: m[0] as String, speed: m[1] as double);
        reply.send((a.samples, a.sampleRate));
      } catch (e) {
        reply.send('$e');
      }
    });
  }

  static Uint8List _wav(Float32List samples, int rate) {
    final n = samples.length;
    final b = ByteData(44 + n * 2);
    void str(int at, String s) {
      for (var i = 0; i < s.length; i++) {
        b.setUint8(at + i, s.codeUnitAt(i));
      }
    }

    str(0, 'RIFF');
    b.setUint32(4, 36 + n * 2, Endian.little);
    str(8, 'WAVE');
    str(12, 'fmt ');
    b.setUint32(16, 16, Endian.little);
    b.setUint16(20, 1, Endian.little);
    b.setUint16(22, 1, Endian.little);
    b.setUint32(24, rate, Endian.little);
    b.setUint32(28, rate * 2, Endian.little);
    b.setUint16(32, 2, Endian.little);
    b.setUint16(34, 16, Endian.little);
    str(36, 'data');
    b.setUint32(40, n * 2, Endian.little);
    for (var i = 0; i < n; i++) {
      final v = samples[i].clamp(-1.0, 1.0);
      b.setInt16(44 + i * 2, (v < 0 ? v * 0x8000 : v * 0x7fff).round(), Endian.little);
    }
    return b.buffer.asUint8List();
  }
}
