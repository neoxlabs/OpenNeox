/// 阿里云百炼 CosyVoice 直连 (用户自己的 Key): 一句话 → mp3。
///
/// 协议 (跟电脑 core/services/ttsService.ts 的 DashscopeTtsProvider 同一套):
///   wss://dashscope.aliyuncs.com/api-ws/v1/inference, 头 `Authorization: bearer <key>`
///   run-task → task-started → continue-task(文本) → finish-task → 二进制音频帧… → task-finished
///
/// 连接留着复用: 一条连接上可以一个任务接一个任务地跑。国内直连实测 (2026-10-02, cosyvoice-v3-flash)
/// 建连 160ms + 起任务 50ms + 首帧 220ms —— 留着连接每句省掉建连那段。
/// 空闲超过 [_idle] 就丢掉 (服务端约 60 秒踢空闲连接), 下一句重新连。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

class AliyunTts {
  AliyunTts._();
  static final AliyunTts instance = AliyunTts._();

  static const _url = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  static const _idle = Duration(seconds: 45);

  WebSocket? _ws;
  String? _wsKey;
  DateTime _lastUsed = DateTime.fromMillisecondsSinceEpoch(0);
  StreamSubscription<dynamic>? _sub;

  /* 当前任务 (一条连接同一时刻只跑一个) */
  String? _taskId;
  BytesBuilder? _audio;
  Completer<Uint8List>? _done;
  Future<void> _queue = Future.value();

  /// 合成一句。多句同时来就排队 (一条连接只能顺序跑)。
  Future<Uint8List> synth(String text, {required String apiKey, required String model, required String voice}) {
    final run = _queue.then((_) => _synth(text, apiKey, model, voice));
    _queue = run.then((_) {}, onError: (_) {});
    return run;
  }

  Future<Uint8List> _synth(String text, String key, String model, String voice) async {
    final ws = await _connect(key);
    final id = _newId();
    _taskId = id;
    _audio = BytesBuilder(copy: false);
    final done = _done = Completer<Uint8List>();
    final started = Completer<void>();
    _onStarted = started;
    ws.add(_frame('run-task', id, {
      'task_group': 'audio',
      'task': 'tts',
      'function': 'SpeechSynthesizer',
      'model': model,
      'parameters': {'text_type': 'PlainText', 'voice': voice, 'format': 'mp3', 'sample_rate': 24000},
      'input': <String, Object?>{},
    }));
    try {
      await started.future.timeout(const Duration(seconds: 8));
      ws.add(_frame('continue-task', id, {'input': {'text': text}}));
      ws.add(_frame('finish-task', id, {'input': <String, Object?>{}}));
      final bytes = await done.future.timeout(const Duration(seconds: 20));
      _lastUsed = DateTime.now();
      return bytes;
    } catch (e) {
      /* 这条连接的状态说不清了 (超时 / 任务失败), 不再复用 */
      await _drop();
      rethrow;
    } finally {
      _taskId = null;
      _audio = null;
      _done = null;
      _onStarted = null;
    }
  }

  Completer<void>? _onStarted;

  Future<WebSocket> _connect(String key) async {
    final live = _ws;
    if (live != null &&
        _wsKey == key &&
        live.readyState == WebSocket.open &&
        DateTime.now().difference(_lastUsed) < _idle) {
      return live;
    }
    await _drop();
    final ws = await WebSocket.connect(_url, headers: {'Authorization': 'bearer $key'})
        .timeout(const Duration(seconds: 8));
    _ws = ws;
    _wsKey = key;
    _lastUsed = DateTime.now();
    _sub = ws.listen(_onMessage, onDone: () => _fail('连接断了'), onError: (Object e) => _fail('$e'));
    return ws;
  }

  void _onMessage(dynamic data) {
    if (data is List<int>) {
      _audio?.add(data);
      return;
    }
    if (data is! String) return;
    final Map<String, dynamic> m;
    try {
      m = jsonDecode(data) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final header = m['header'];
    if (header is! Map || header['task_id'] != _taskId) return;
    switch (header['event']) {
      case 'task-started':
        if (!(_onStarted?.isCompleted ?? true)) _onStarted!.complete();
      case 'task-finished':
        final bytes = _audio?.takeBytes() ?? Uint8List(0);
        if (!(_done?.isCompleted ?? true)) {
          bytes.isEmpty ? _done!.completeError(StateError('阿里云没返回声音')) : _done!.complete(bytes);
        }
      case 'task-failed':
        _fail('${header['error_code'] ?? ''} ${header['error_message'] ?? ''}'.trim());
    }
  }

  void _fail(String why) {
    final err = StateError('阿里云语音合成失败: $why');
    if (!(_onStarted?.isCompleted ?? true)) _onStarted!.completeError(err);
    if (!(_done?.isCompleted ?? true)) _done!.completeError(err);
    _ws = null;
  }

  Future<void> _drop() async {
    final ws = _ws;
    _ws = null;
    await _sub?.cancel();
    _sub = null;
    if (ws != null) {
      try {
        await ws.close();
      } catch (_) {/* 已经断了 */}
    }
  }

  static String _frame(String action, String id, Map<String, Object?> payload) => jsonEncode({
        'header': {'action': action, 'task_id': id, 'streaming': 'duplex'},
        'payload': payload,
      });

  static final _rand = Random.secure();
  static String _newId() => List.generate(32, (_) => _rand.nextInt(16).toRadixString(16)).join();
}
