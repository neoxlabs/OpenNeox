/// 语音输入设置: 用哪个引擎 + 云端识别的配置。
///
///   本地 (默认): sherpa-onnx 离线识别, 模型按需下载 (不占安装包), 不联网、国行机也能用
///   系统: 手机自带的识别服务 (speech_to_text) —— 很多国行 ROM 没有, 保留给有的人
///   云端: 第三方识别服务, 两种接口:
///     · transcriptions —— OpenAI 的 `/audio/transcriptions` (OpenAI / Groq / SiliconFlow / 智谱 / 自建 whisper)
///     · chatAudio —— 聊天接口里塞一段音频 (阿里云百炼 qwen3-asr: 它的兼容模式没有 /audio/transcriptions, 实测 404)
///
/// 每家服务商各存一份 (地址 / 模型 / Key), 切过去再切回来不用重填。
/// Key 进安全存储, 其余进 SharedPreferences。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/model_store.dart';

/// subscription = 订阅附带的网关识别 (见 hosted_asr.dart), 只在有托管识别的发行版里出现。
enum VoiceEngine { local, system, cloud, subscription }

/// 流式出字的那个 (必需): 边说边出字
const ModelPack kAsrStreamingPack = ModelPack(
  kind: 'asr',
  id: 'zipformer-ctc-zh-small-int8',
  title: '实时识别',
  subtitle: '边说边出字',
  manifestUrl: 'https://dl.neox-dev.com/models/asr/zipformer-ctc-zh-small-int8/manifest.json',
  approxBytes: 26355706,
);

/// 整句定稿的那个 (可选): 一句说完把整句重新识别一遍, 更准
const ModelPack kAsrRefinePack = ModelPack(
  kind: 'asr',
  id: 'paraformer-zh-small-int8',
  title: '整句校正',
  subtitle: '说完一句自动改正错字',
  manifestUrl: 'https://dl.neox-dev.com/models/asr/paraformer-zh-small-int8/manifest.json',
  approxBytes: 81904027,
);

enum CloudAsrProtocol { transcriptions, chatAudio }

/// 常见服务的预设 —— 选一个, 只填 Key
class CloudAsrPreset {
  const CloudAsrPreset({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.models,
    this.protocol = CloudAsrProtocol.transcriptions,
    this.keyUrl,
  });
  final String id;
  final String name;
  final String baseUrl;

  /// 第一个是默认; 模型栏可以随便改, 这里只是候选
  final List<String> models;
  final CloudAsrProtocol protocol;

  /// 去哪拿 Key
  final String? keyUrl;
}

const String kCustomAsrPresetId = 'custom';

const List<CloudAsrPreset> kCloudAsrPresets = [
  CloudAsrPreset(
    id: 'aliyun',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-asr-flash'],
    protocol: CloudAsrProtocol.chatAudio,
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  ),
  CloudAsrPreset(
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    keyUrl: 'https://platform.openai.com/api-keys',
  ),
  CloudAsrPreset(
    id: 'zhipu',
    name: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-asr'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  ),
  CloudAsrPreset(
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  ),
  CloudAsrPreset(
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    keyUrl: 'https://console.groq.com/keys',
  ),
  CloudAsrPreset(
    id: kCustomAsrPresetId,
    name: '自定义',
    baseUrl: '',
    models: [],
  ),
];

CloudAsrPreset cloudAsrPreset(String id) =>
    kCloudAsrPresets.firstWhere((p) => p.id == id, orElse: () => kCloudAsrPresets.last);

class CloudAsrConfig {
  const CloudAsrConfig({
    this.provider = 'aliyun',
    this.baseUrl = '',
    this.apiKey = '',
    this.model = '',
    this.protocol = CloudAsrProtocol.transcriptions,
  });
  final String provider;
  final String baseUrl;
  final String apiKey;
  final String model;
  final CloudAsrProtocol protocol;

  bool get ready => baseUrl.trim().isNotEmpty && apiKey.trim().isNotEmpty && model.trim().isNotEmpty;

  /// 某家服务商的初始值 (地址 / 默认模型 / 接口类型来自预设, Key 空着)
  factory CloudAsrConfig.fromPreset(CloudAsrPreset p) => CloudAsrConfig(
        provider: p.id,
        baseUrl: p.baseUrl,
        model: p.models.isEmpty ? '' : p.models.first,
        protocol: p.protocol,
      );

  CloudAsrConfig copyWith({String? baseUrl, String? apiKey, String? model, CloudAsrProtocol? protocol}) =>
      CloudAsrConfig(
        provider: provider,
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        model: model ?? this.model,
        protocol: protocol ?? this.protocol,
      );
}

class VoiceSettings {
  const VoiceSettings({
    this.engine = VoiceEngine.local,
    this.cloud = const CloudAsrConfig(),
    this.saved = const {},
    this.loaded = false,
    this.chosen = false,
  });
  final VoiceEngine engine;

  /// 用户自己选过识别方式。没选过时订阅用户默认走订阅 —— 点麦克风就能说,
  /// 不该先弹「下载 103MB 模型」(见 [effectiveEngine])。
  final bool chosen;

  /// 这次实际用哪个: 没选过、且有可用的订阅识别 → 订阅; 否则按设置。
  VoiceEngine effectiveEngine({required bool subscriptionUsable}) {
    if (engine == VoiceEngine.subscription && !subscriptionUsable) return VoiceEngine.local;
    if (!chosen && subscriptionUsable) return VoiceEngine.subscription;
    return engine;
  }

  /// 当前用的那家
  final CloudAsrConfig cloud;

  /// 每家存过的配置 (按 provider id)
  final Map<String, CloudAsrConfig> saved;
  final bool loaded;

  /// 某家服务商: 存过就用存的, 没存过用预设
  CloudAsrConfig configFor(String provider) => saved[provider] ?? CloudAsrConfig.fromPreset(cloudAsrPreset(provider));

  VoiceSettings copyWith({
    VoiceEngine? engine,
    CloudAsrConfig? cloud,
    Map<String, CloudAsrConfig>? saved,
    bool? loaded,
    bool? chosen,
  }) =>
      VoiceSettings(
        engine: engine ?? this.engine,
        cloud: cloud ?? this.cloud,
        saved: saved ?? this.saved,
        loaded: loaded ?? this.loaded,
        chosen: chosen ?? this.chosen,
      );
}

class VoiceSettingsController extends StateNotifier<VoiceSettings> {
  VoiceSettingsController() : super(const VoiceSettings()) {
    ready = _load();
  }

  late final Future<void> ready;

  static const _kEngine = 'voice.engine';
  static const _kProvider = 'voice.cloud.provider';
  static String _kBaseOf(String p) => 'voice.cloud.$p.base';
  static String _kModelOf(String p) => 'voice.cloud.$p.model';
  static String _kKeyOf(String p) => 'voice.cloud.$p.key';
  /* 3.4.12 之前只存一份 (不分服务商) */
  static const _kLegacyBase = 'voice.cloud.base';
  static const _kLegacyModel = 'voice.cloud.model';
  static const _kLegacyKey = 'voice.cloud.key';
  static const _secure = FlutterSecureStorage();

  Future<String> _readKey(String k) async {
    try {
      return await _secure.read(key: k) ?? '';
    } catch (_) {
      return '';
    }
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    final e = sp.getString(_kEngine);
    final saved = <String, CloudAsrConfig>{};
    for (final p in kCloudAsrPresets) {
      final key = await _readKey(_kKeyOf(p.id));
      final base = sp.getString(_kBaseOf(p.id));
      final model = sp.getString(_kModelOf(p.id));
      if (key.isEmpty && base == null && model == null) continue;
      saved[p.id] = CloudAsrConfig.fromPreset(p).copyWith(
        apiKey: key,
        baseUrl: base,
        model: model,
      );
    }
    var provider = sp.getString(_kProvider);
    /* 老版本那一份: 按地址认回是哪家, 认不出算自定义 */
    final legacyBase = sp.getString(_kLegacyBase);
    if (provider == null && legacyBase != null && legacyBase.isNotEmpty) {
      final p = kCloudAsrPresets.firstWhere(
        (p) => p.baseUrl.isNotEmpty && legacyBase.startsWith(p.baseUrl),
        orElse: () => kCloudAsrPresets.last,
      );
      provider = p.id;
      saved[p.id] = CloudAsrConfig.fromPreset(p).copyWith(
        baseUrl: legacyBase,
        model: sp.getString(_kLegacyModel) ?? '',
        apiKey: await _readKey(_kLegacyKey),
      );
    }
    provider ??= kCloudAsrPresets.first.id;
    state = VoiceSettings(
      engine: VoiceEngine.values.firstWhere((v) => v.name == e, orElse: () => VoiceEngine.local),
      cloud: saved[provider] ?? CloudAsrConfig.fromPreset(cloudAsrPreset(provider)),
      saved: saved,
      loaded: true,
      chosen: e != null,
    );
  }

  Future<void> setEngine(VoiceEngine e) async {
    state = state.copyWith(engine: e, chosen: true);
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kEngine, e.name);
  }

  /// 存这家的配置, 并设成当前用的那家
  Future<void> setCloud(CloudAsrConfig c) async {
    final clean = c.copyWith(baseUrl: c.baseUrl.trim(), model: c.model.trim(), apiKey: c.apiKey.trim());
    state = state.copyWith(cloud: clean, saved: {...state.saved, clean.provider: clean});
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kProvider, clean.provider);
    await sp.setString(_kBaseOf(clean.provider), clean.baseUrl);
    await sp.setString(_kModelOf(clean.provider), clean.model);
    try {
      await _secure.write(key: _kKeyOf(clean.provider), value: clean.apiKey);
    } catch (_) {}
  }
}

final voiceSettingsProvider =
    StateNotifierProvider<VoiceSettingsController, VoiceSettings>((ref) => VoiceSettingsController());
