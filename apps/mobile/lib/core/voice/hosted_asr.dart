/// hosted_asr.dart — 托管语音识别 (订阅网关流式识别) 的契约 + 一次会话.
///
/// 手机的语音输入以前只有三种: 本地 (先下 103MB 模型) / 系统语音 (国行常没有) / 自己填 Key。
/// 订阅用户点麦克风弹的是「下载模型」, 而桌面订阅用户点了就能说 (2026-10-05 模拟器实测)。
/// 这里接上桌面同一条路: WebSocket 推 16k 单声道 PCM, 网关回 {type:'transcript', text, isFinal},
/// text 是到目前为止的整段 (网关把已定稿的句子拼好了), 收尾发 {type:'stop'}。
///
/// 端点和凭据由发行版给 (商业版 = NeoxCloud 网关 /n1/asr/stream); 开源版没有, 这一项不出现。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:record/record.dart';

import '../edition/edition.dart';
import 'package:neox_app/core/i18n/tr.dart';

abstract class HostedAsr {
  /// 现在能不能用 (通常 = 已登录订阅)。
  bool get available;

  /// 这次会话连哪、带什么头。失败抛 [StateError] (带人话)。
  Future<({Uri url, Map<String, String> headers})> endpoint();
}

final hostedAsrProvider = Provider<HostedAsr?>(
  (ref) => ref.watch(editionProvider).hostedAsr(ref),
);

/// 一次录音 = 一条 WebSocket。边录边送, 握手期间说的话先攒着, 连上一起送
/// (握手 ~1 秒, 不攒的话一句话开头就没了 —— 桌面 2026-10-04 踩过)。
class HostedAsrSession {
  HostedAsrSession(this._backend);
  final HostedAsr _backend;

  final _rec = AudioRecorder();
  final _texts = StreamController<String>.broadcast();
  final _levels = StreamController<double>.broadcast();
  final _pending = <Uint8List>[];
  WebSocket? _ws;
  StreamSubscription<Uint8List>? _mic;
  Completer<String>? _final;
  String _last = '';
  bool _stopping = false;

  /// 到目前为止的整段识别结果
  Stream<String> get texts => _texts.stream;
  Stream<double> get levels => _levels.stream;

  /// false = 没有麦克风权限。连接失败抛 [StateError]。
  Future<bool> start({void Function(String message)? onError}) async {
    if (!await _rec.hasPermission()) return false;
    final pcm = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
      autoGain: false,
      echoCancel: true,
      noiseSuppress: true,
      androidConfig: AndroidRecordConfig(audioSource: AndroidAudioSource.voiceCommunication),
    ));
    _mic = pcm.listen(_onChunk);
    unawaited(_connect(onError));
    return true;
  }

  Future<void> _connect(void Function(String message)? onError) async {
    try {
      final ep = await _backend.endpoint();
      final ws = await WebSocket.connect(ep.url.toString(), headers: ep.headers)
          .timeout(const Duration(seconds: 10));
      _ws = ws;
      for (final c in _pending) {
        ws.add(c);
      }
      _pending.clear();
      if (_stopping) ws.add(jsonEncode({'type': 'stop'}));
      ws.listen(
        (data) {
          if (data is! String) return;
          Map<String, dynamic> msg;
          try {
            msg = jsonDecode(data) as Map<String, dynamic>;
          } catch (_) {
            return;
          }
          if (msg['type'] == 'error') {
            onError?.call('${msg['message'] ?? tr('语音识别出错')}');
            _finish();
            return;
          }
          final text = '${msg['text'] ?? ''}'.trim();
          if (text.isNotEmpty && text != _last) {
            _last = text;
            if (!_texts.isClosed) _texts.add(text);
          }
          if (msg['isFinal'] == true && _stopping) _finish();
        },
        onDone: _finish,
        onError: (_) => _finish(),
      );
    } catch (e) {
      onError?.call(e is StateError ? e.message : tr('连不上语音识别服务, 检查一下网络'));
      _finish();
    }
  }

  void _onChunk(Uint8List bytes) {
    final ws = _ws;
    if (ws != null) {
      ws.add(bytes);
    } else if (!_stopping) {
      _pending.add(bytes);
    }
    _pushLevel(bytes);
  }

  void _pushLevel(Uint8List bytes) {
    if (_levels.isClosed || bytes.length < 2) return;
    final d = ByteData.sublistView(bytes);
    final n = bytes.lengthInBytes ~/ 2;
    var sum = 0.0;
    for (var i = 0; i < n; i++) {
      final v = d.getInt16(i * 2, Endian.little) / 32768.0;
      sum += v * v;
    }
    final rms = math.sqrt(sum / n);
    _levels.add((rms * 6).clamp(0.0, 1.0));
  }

  /// 停录并等最终结果 (最多 4 秒)。返回最终整段。
  Future<String> stop() async {
    if (_stopping) return _final?.future ?? Future.value(_last);
    _stopping = true;
    _final = Completer<String>();
    await _mic?.cancel();
    await _rec.stop();
    if (!_levels.isClosed) _levels.add(0);
    _ws?.add(jsonEncode({'type': 'stop'}));
    return _final!.future.timeout(const Duration(seconds: 4), onTimeout: () {
      _finish();
      return _last;
    });
  }

  /// 不要结果地停 (消息已经发出去了)
  Future<void> cancel() async {
    _stopping = true;
    await _mic?.cancel();
    await _rec.stop();
    _finish();
  }

  void _finish() {
    final f = _final;
    if (f != null && !f.isCompleted) f.complete(_last);
    unawaited(_ws?.close());
    _ws = null;
  }

  void dispose() {
    unawaited(_mic?.cancel());
    unawaited(_rec.dispose());
    _finish();
    unawaited(_texts.close());
    unawaited(_levels.close());
  }
}
