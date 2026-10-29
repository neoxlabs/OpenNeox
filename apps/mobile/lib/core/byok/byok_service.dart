/// byok_service.dart — BYOK 后端工厂 + 探活.
///
/// 工厂: providerId → 对应协议的 ChatBackend (直连厂商, key 不出手机).
/// 探活: 添加 Key 时验证连通 + 尽量带回厂商可用模型列表 (加模型时直接选).
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../llm/chat_backend.dart';
import '../llm/llm_http.dart';
import 'backends/anthropic_backend.dart';
import 'backends/gemini_backend.dart';
import 'backends/openai_compat_backend.dart';
import 'byok_models.dart';
import 'byok_store.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ByokService {
  ByokService(this._ref);
  final Ref _ref;

  /// providerId → ChatBackend. provider 不存在/未启用抛用户可读错误.
  ChatBackend backendFor(String providerId) {
    final provider = _ref.read(byokStoreProvider.notifier).byId(providerId);
    if (provider == null) {
      throw ChatBackendException(tr('这个模型的 API 配置已被删除，请重新选择模型'));
    }
    if (!provider.enabled) {
      throw ChatBackendException(tr('「${provider.name}」已停用，请到设置里启用'));
    }
    return backendForConfig(provider);
  }

  ChatBackend backendForConfig(ByokProviderConfig provider) {
    final http = _ref.read(llmHttpProvider);
    switch (provider.protocol) {
      case ByokProtocol.anthropic:
        return AnthropicBackend(http: http, provider: provider);
      case ByokProtocol.gemini:
        return GeminiBackend(http: http, provider: provider);
      case ByokProtocol.openaiCompat:
        return OpenAiCompatBackend(http: http, provider: provider);
    }
  }

  /// 探活 — 验证 baseUrl + key 可用; 成功时尽量返回厂商模型列表.
  ///
  /// 策略:
  ///   openai-compat: GET /models (行业标配, 中转站基本都有)
  ///   anthropic:     GET /v1/models (官方支持)
  ///   gemini:        GET /v1beta/models
  /// 失败抛 [ChatBackendException] (文案已友好化, 直接给 UI).
  Future<ByokProbeResult> probe({
    required ByokProtocol protocol,
    required String baseUrl,
    required String apiKey,
    required String providerName,
    Map<String, String> extraHeaders = const {},
  }) async {
    final http = _ref.read(llmHttpProvider);
    final base = baseUrl.replaceAll(RegExp(r'/+$'), '');
    late final String url;
    late final Map<String, String> headers;
    switch (protocol) {
      case ByokProtocol.openaiCompat:
        url = '$base/models';
        headers = {'Authorization': 'Bearer $apiKey', ...extraHeaders};
        break;
      case ByokProtocol.anthropic:
        url = '$base/v1/models';
        headers = {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...extraHeaders,
        };
        break;
      case ByokProtocol.gemini:
        url = '$base/v1beta/models';
        headers = {'x-goog-api-key': apiKey, ...extraHeaders};
        break;
    }

    final resp = await http.request('GET', url: url, headers: headers);
    if (resp.statusCode >= 400) {
      throw byokHttpError(
        providerName: providerName,
        status: resp.statusCode,
        body: resp.body,
      );
    }
    return ByokProbeResult(models: _parseModelIds(protocol, resp.body));
  }

  List<String> _parseModelIds(ByokProtocol protocol, String body) {
    try {
      final parsed = jsonDecode(body);
      if (parsed is! Map) return const [];
      switch (protocol) {
        case ByokProtocol.openaiCompat:
        case ByokProtocol.anthropic:
          {
            final data = parsed['data'];
            if (data is! List) return const [];
            return data
                .whereType<Map>()
                .map((m) => (m['id'] as String?) ?? '')
                .where((id) => id.isNotEmpty)
                .toList();
          }
        case ByokProtocol.gemini:
          {
            final models = parsed['models'];
            if (models is! List) return const [];
            return models
                .whereType<Map>()
                .map((m) => (m['name'] as String?) ?? '')
                /* name 形如 models/gemini-2.5-flash — 剥前缀 */
                .map((n) => n.startsWith('models/') ? n.substring(7) : n)
                .where((id) => id.isNotEmpty)
                .toList();
          }
      }
    } catch (_) {
      return const [];
    }
  }
}

class ByokProbeResult {
  const ByokProbeResult({required this.models});

  /// 厂商可用模型 id (可能为空 — 部分中转站 /models 返回空).
  final List<String> models;
}

final byokServiceProvider = Provider<ByokService>((ref) => ByokService(ref));
