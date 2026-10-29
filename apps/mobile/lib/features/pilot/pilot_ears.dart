/// pilot_ears.dart — Pilot 听你说话 (2026-10-01): 通话页和 Pilot 主页共用。
///
/// 识别引擎按语音设置走 (本地 sherpa / 系统 / 云端); 本地模型没装、云端没配时退到系统识别,
/// 不在对话里弹设置 —— 说话的场景里跳出一个设置页最打断人。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/model_store.dart';
import '../../core/voice/hosted_asr.dart';
import '../../core/voice/voice_settings.dart';
import '../voice/inline_voice.dart';

Future<InlineVoiceController> startPilotEars(
  WidgetRef ref, {
  required void Function(String text) onText,
  required void Function(String message) onError,
  void Function(bool listening)? onState,
}) async {
  final settingsCtl = ref.read(voiceSettingsProvider.notifier);
  await settingsCtl.ready;
  final settings = ref.read(voiceSettingsProvider);
  final store = ref.read(modelStoreProvider.notifier);

  final hosted = ref.read(hostedAsrProvider);
  final subscriptionUsable = hosted?.available ?? false;
  var engine = settings.effectiveEngine(subscriptionUsable: subscriptionUsable);
  LocalAsrPaths? local;
  if (engine == VoiceEngine.local) {
    if (await store.isInstalled(kAsrStreamingPack)) {
      final refine = await store.isInstalled(kAsrRefinePack);
      local = (
        model: await store.pathOf(kAsrStreamingPack, 'model.int8.onnx'),
        tokens: await store.pathOf(kAsrStreamingPack, 'tokens.txt'),
        refineModel: refine ? await store.pathOf(kAsrRefinePack, 'model.int8.onnx') : null,
        refineTokens: refine ? await store.pathOf(kAsrRefinePack, 'tokens.txt') : null,
      );
    } else {
      engine = subscriptionUsable ? VoiceEngine.subscription : VoiceEngine.system;
    }
  } else if (engine == VoiceEngine.cloud && !settings.cloud.ready) {
    engine = subscriptionUsable ? VoiceEngine.subscription : VoiceEngine.system;
  }

  final voice = InlineVoiceController(onText: onText, onStateChange: onState ?? (_) {}, onError: onError);
  await voice.start(engine: engine, local: local, cloud: settings.cloud, hosted: hosted);
  return voice;
}
