/// 本地语音预热 (2026-09-30 用户: 「ASR 预热问题」)。
///
/// 建 recognizer 要把 25MB (+ 78MB 定稿) 模型读进内存并建图, 天玑 9400 上约 1 秒。放在第一次点麦克风
/// 时做, 用户按下去一秒没反应, 常常以为没点上再按一次。现在首页出来、手空着的时候先建好;
/// 之后每次点麦克风都是直接开录。
///
/// sherpa 的对象是 FFI 句柄, 不能跨 isolate 传, 所以只能在主 isolate 上建 —— 挑空闲时刻做,
/// 一次性, 之后常驻 (SherpaAsr 单例)。没选本地引擎 / 模型没下载就什么都不做。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/model_store.dart';
import 'sherpa_asr.dart';
import 'voice_settings.dart';

bool _warmed = false;

Future<void> warmUpLocalAsr(WidgetRef ref) async {
  if (_warmed) return;
  try {
    final settingsCtl = ref.read(voiceSettingsProvider.notifier);
    await settingsCtl.ready;
    if (ref.read(voiceSettingsProvider).engine != VoiceEngine.local) return;
    final store = ref.read(modelStoreProvider.notifier);
    if (!await store.isInstalled(kAsrStreamingPack)) return;
    final refine = await store.isInstalled(kAsrRefinePack);
    _warmed = true;
    await SherpaAsr.instance(
      streamingModel: await store.pathOf(kAsrStreamingPack, 'model.int8.onnx'),
      streamingTokens: await store.pathOf(kAsrStreamingPack, 'tokens.txt'),
      refineModel: refine ? await store.pathOf(kAsrRefinePack, 'model.int8.onnx') : null,
      refineTokens: refine ? await store.pathOf(kAsrRefinePack, 'tokens.txt') : null,
    );
  } catch (_) {
    /* 预热失败不打扰: 点麦克风时会照常再建一次, 那时候的报错才给人看 */
    _warmed = false;
  }
}
