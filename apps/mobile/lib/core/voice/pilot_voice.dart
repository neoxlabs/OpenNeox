/// Pilot 的声音从哪来 —— 三种, 用户选一种, 选了就只走那一种 (2026-10-02):
///
///   订阅      网关 /n1/audio/speech (阿里云 CosyVoice, 套餐附带)。订阅用户什么都不用配
///   阿里云    用户自己的百炼 Key 直连阿里云 (最快, 不绕网关)。Key 跟「云端识别 · 阿里云」是同一把
///   本地      手机上的 MeloTTS (按需下载), 不联网
///
/// 没选过时按「有订阅 → 订阅; 填过阿里云 Key → 阿里云; 否则本地」定一个默认值。
/// 这是默认值, 不是失败兜底: 选中的那种说不了就如实报错, 不偷偷换另一种。
///
/// 声音不再经电脑合成 —— 电脑在线时那一圈 (手机 → 电脑 → 阿里云 → 电脑 → 手机) 正是慢的来源。
library;

import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../edition/edition.dart' show accountStatusProvider;
import '../local_agent/model_gateway_client.dart';
import '../models/model_store.dart';
import 'aliyun_tts.dart';
import 'local_tts.dart';
import 'voice_settings.dart';

enum PilotVoiceSource { subscription, aliyun, local }

/// 跟电脑同一个声音 (电脑设置里的 longxiaobai 在 v3 上归一成这个)
const kPilotVoiceModel = 'cosyvoice-v3-flash';
const kPilotVoiceName = 'longxiaochun_v3';

class PilotVoiceState {
  const PilotVoiceState({this.chosen, this.loaded = false});

  /// 用户选过的; null = 没选过, 用默认
  final PilotVoiceSource? chosen;
  final bool loaded;
}

class PilotVoice extends StateNotifier<PilotVoiceState> {
  PilotVoice(this._ref) : super(const PilotVoiceState()) {
    ready = _load();
  }

  final Ref _ref;
  late final Future<void> ready;
  static const _kSource = 'pilot.voice.source';

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final v = sp.getString(_kSource);
    state = PilotVoiceState(
      chosen: PilotVoiceSource.values.where((s) => s.name == v).firstOrNull,
      loaded: true,
    );
  }

  Future<void> choose(PilotVoiceSource s) async {
    state = PilotVoiceState(chosen: s, loaded: true);
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kSource, s.name);
  }

  /// 这个发行版有没有订阅 (开源版没有, 设置里就不出这一项)
  bool get subscriptionHosted => _ref.read(modelGatewayClientProvider).hosted;

  bool get subscriptionUsable => subscriptionHosted && _ref.read(accountStatusProvider).signedIn;

  String get _aliyunKey => _ref.read(voiceSettingsProvider).configFor('aliyun').apiKey.trim();

  /// 现在用哪种 (选过的, 或默认)
  PilotVoiceSource get source {
    final c = state.chosen;
    if (c != null) return c;
    if (subscriptionUsable) return PilotVoiceSource.subscription;
    if (_aliyunKey.isNotEmpty) return PilotVoiceSource.aliyun;
    return PilotVoiceSource.local;
  }

  /// 一句话 → 音频。说不了抛错, 错误文案给人看。
  Future<({Uint8List audio, String format})> synth(String text) async {
    await ready;
    await _ref.read(voiceSettingsProvider.notifier).ready;
    final src = source;
    final sw = Stopwatch()..start();
    final r = switch (src) {
      PilotVoiceSource.subscription => await _viaSubscription(text),
      PilotVoiceSource.aliyun => await _viaAliyun(text),
      PilotVoiceSource.local => await _viaLocal(text),
    };
    debugPrint('[pilot-voice] ${src.name} ${text.length}字 ${sw.elapsedMilliseconds}ms');
    return r;
  }

  Future<({Uint8List audio, String format})> _viaSubscription(String text) async {
    if (!subscriptionUsable) throw StateError('登录订阅账号后才能用订阅的声音');
    final audio = await _ref
        .read(modelGatewayClientProvider)
        .speech(text: text, model: kPilotVoiceModel, voice: kPilotVoiceName);
    return (audio: audio, format: 'mp3');
  }

  Future<({Uint8List audio, String format})> _viaAliyun(String text) async {
    final key = _aliyunKey;
    if (key.isEmpty) throw StateError('还没填阿里云百炼的 Key');
    final audio = await AliyunTts.instance.synth(text, apiKey: key, model: kPilotVoiceModel, voice: kPilotVoiceName);
    return (audio: audio, format: 'mp3');
  }

  Future<({Uint8List audio, String format})> _viaLocal(String text) async {
    final store = _ref.read(modelStoreProvider.notifier);
    if (!await store.isInstalled(kTtsMeloPack)) throw StateError('本地声音还没下载');
    final dir = (await store.dirOf(kTtsMeloPack)).path;
    final audio = await LocalTts.instance.synth(text, modelDir: dir);
    return (audio: audio, format: 'wav');
  }
}

final pilotVoiceProvider = StateNotifierProvider<PilotVoice, PilotVoiceState>((ref) => PilotVoice(ref));
