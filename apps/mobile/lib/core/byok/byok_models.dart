/// byok_models.dart — 手机端 BYOK 数据模型 + 厂商 preset.
///
/// 对齐桌面 ProviderConfigEntry 的最小子集 (desktop configTypes.ts):
/// 手机不做多 channel / capability 派生, 一个 provider = 一个协议 + 一个 key +
/// 一组模型。preset 列表抄桌面 ProviderEditForm.PROVIDER_PRESETS (2026-07-19 版).
///
/// 模型 id 命名空间: `byok/<providerId>/<vendorModelId>` — 跟订阅模型 (裸 id /
/// 'auto') 在同一个选择器里共存, phone_local_agent 按前缀路由。
library;

import 'dart:convert';
import 'package:neox_app/core/i18n/tr.dart';

/// 协议族 — 手机端第一批三个 (OpenAI 兼容覆盖国内外 90% 厂商).
enum ByokProtocol { openaiCompat, anthropic, gemini }

ByokProtocol byokProtocolFromWire(String? raw) {
  switch (raw) {
    case 'anthropic':
      return ByokProtocol.anthropic;
    case 'gemini':
      return ByokProtocol.gemini;
    default:
      return ByokProtocol.openaiCompat;
  }
}

String byokProtocolToWire(ByokProtocol p) {
  switch (p) {
    case ByokProtocol.anthropic:
      return 'anthropic';
    case ByokProtocol.gemini:
      return 'gemini';
    case ByokProtocol.openaiCompat:
      return 'openai';
  }
}

/// 用户配置的一个 BYOK provider.
class ByokProviderConfig {
  const ByokProviderConfig({
    required this.id,
    required this.name,
    required this.protocol,
    required this.baseUrl,
    required this.apiKey,
    required this.models,
    this.enabled = true,
    this.extraHeaders = const {},
    this.desktopSourceId,
  });

  /// 本地 uuid (加 provider 时生成, 不变).
  final String id;
  final String name;
  final ByokProtocol protocol;

  /// endpoint base — openai-compat 语义: chat = `$baseUrl/chat/completions`,
  /// models = `$baseUrl/models`. anthropic/gemini 适配器自己拼各家路径.
  final String baseUrl;
  final String apiKey;

  /// 用户添加的模型 id 列表 (厂商侧裸 id).
  final List<String> models;
  final bool enabled;

  /// 聚合站需要的附加 header (OpenRouter Referer 等).
  final Map<String, String> extraHeaders;

  /// 从桌面 WiFi 导入时的桌面 provider id — 用于重复导入 upsert.
  final String? desktopSourceId;

  ByokProviderConfig copyWith({
    String? name,
    String? baseUrl,
    String? apiKey,
    List<String>? models,
    bool? enabled,
    Map<String, String>? extraHeaders,
    String? desktopSourceId,
  }) =>
      ByokProviderConfig(
        id: id,
        name: name ?? this.name,
        protocol: protocol,
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        models: models ?? this.models,
        enabled: enabled ?? this.enabled,
        extraHeaders: extraHeaders ?? this.extraHeaders,
        desktopSourceId: desktopSourceId ?? this.desktopSourceId,
      );

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'protocol': byokProtocolToWire(protocol),
        'base_url': baseUrl,
        'api_key': apiKey,
        'models': models,
        'enabled': enabled,
        if (extraHeaders.isNotEmpty) 'extra_headers': extraHeaders,
        if (desktopSourceId != null && desktopSourceId!.isNotEmpty)
          'desktop_source_id': desktopSourceId,
      };

  static ByokProviderConfig? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final key = raw['api_key'];
    if (id is! String || id.isEmpty || key is! String) return null;
    final models = <String>[
      if (raw['models'] is List)
        ...(raw['models'] as List).whereType<String>().where((m) => m.isNotEmpty),
    ];
    final headers = <String, String>{};
    if (raw['extra_headers'] is Map) {
      (raw['extra_headers'] as Map).forEach((k, v) {
        if (k is String && v is String) headers[k] = v;
      });
    }
    final desk = raw['desktop_source_id'];
    return ByokProviderConfig(
      id: id,
      name: (raw['name'] as String?) ?? tr('自定义'),
      protocol: byokProtocolFromWire(raw['protocol'] as String?),
      baseUrl: (raw['base_url'] as String?) ?? '',
      apiKey: key,
      models: models,
      enabled: raw['enabled'] != false,
      extraHeaders: headers,
      desktopSourceId: desk is String && desk.isNotEmpty ? desk : null,
    );
  }

  static String encodeList(List<ByokProviderConfig> list) =>
      jsonEncode([for (final p in list) p.toJson()]);

  static List<ByokProviderConfig> decodeList(String raw) {
    try {
      final parsed = jsonDecode(raw);
      if (parsed is! List) return const [];
      return parsed
          .map(ByokProviderConfig.fromJson)
          .whereType<ByokProviderConfig>()
          .toList();
    } catch (_) {
      return const [];
    }
  }
}

/// BYOK 模型 id 命名空间工具.
class ByokModelRef {
  const ByokModelRef({required this.providerId, required this.modelId});
  final String providerId;
  final String modelId;

  String get fullId => 'byok/$providerId/$modelId';

  static bool isByok(String id) => id.startsWith('byok/');

  static ByokModelRef? parse(String id) {
    if (!isByok(id)) return null;
    final rest = id.substring(5);
    final slash = rest.indexOf('/');
    if (slash <= 0 || slash == rest.length - 1) return null;
    return ByokModelRef(
      providerId: rest.substring(0, slash),
      modelId: rest.substring(slash + 1),
    );
  }
}

/// 厂商 preset — 抄桌面 (base_url 已折算成 endpoint base 语义).
class ByokPreset {
  const ByokPreset({
    required this.presetId,
    required this.name,
    required this.protocol,
    required this.baseUrl,
    required this.defaultModel,
    this.keyUrl,
    this.extraHeaders = const {},
  });
  final String presetId;
  final String name;
  final ByokProtocol protocol;
  final String baseUrl;
  final String defaultModel;

  /// 厂商拿 key 的控制台地址 (显示在添加页帮助).
  final String? keyUrl;
  final Map<String, String> extraHeaders;
}

final List<ByokPreset> kByokPresets = [
  ByokPreset(
    presetId: 'openrouter',
    name: tr('OpenRouter (聚合)'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    extraHeaders: {
      'HTTP-Referer': 'https://neox-dev.com',
      'X-Title': 'Neox',
    },
  ),
  ByokPreset(
    presetId: 'openai',
    name: 'OpenAI',
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  ),
  ByokPreset(
    presetId: 'anthropic',
    name: 'Anthropic (Claude)',
    protocol: ByokProtocol.anthropic,
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  ),
  ByokPreset(
    presetId: 'gemini',
    name: 'Google Gemini',
    protocol: ByokProtocol.gemini,
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  ),
  ByokPreset(
    presetId: 'deepseek',
    name: tr('DeepSeek 深度求索'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  ),
  ByokPreset(
    presetId: 'kimi',
    name: tr('Kimi 月之暗面'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0711-preview',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  ),
  ByokPreset(
    presetId: 'glm',
    name: tr('智谱 GLM'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  ),
  ByokPreset(
    presetId: 'qwen',
    name: tr('通义千问 Qwen'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  ),
  ByokPreset(
    presetId: 'doubao',
    name: tr('豆包 Doubao'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6-251015',
    keyUrl: 'https://console.volcengine.com/ark',
  ),
  ByokPreset(
    presetId: 'minimax',
    name: 'MiniMax',
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-M3',
    keyUrl: 'https://platform.minimaxi.com/',
  ),
  ByokPreset(
    presetId: 'siliconflow',
    name: tr('硅基流动 SiliconFlow'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  ),
  ByokPreset(
    presetId: 'groq',
    name: 'Groq',
    protocol: ByokProtocol.openaiCompat,
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  ),
  ByokPreset(
    presetId: 'custom',
    name: tr('自定义 (OpenAI 兼容)'),
    protocol: ByokProtocol.openaiCompat,
    baseUrl: '',
    defaultModel: '',
  ),
];
