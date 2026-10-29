/// byok_store.dart — BYOK provider 持久化 + Riverpod 状态.
///
/// 存储: 整个 provider 列表 (含 key) JSON 一条塞 flutter_secure_storage —
/// iOS Keychain / Android EncryptedSharedPreferences, 比桌面的文件加密
/// (enc:v1 NXS1) 更强, 且天然跟随系统备份策略 (Keychain 不入 iCloud 备份明文).
///
/// 零账号原则: 本 store 完全不依赖 NeoxCloud 登录态 — BYOK 是"下载即用"路径.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import 'byok_models.dart';
import 'package:neox_app/core/i18n/tr.dart';

const _kStorageKey = 'neox_byok_providers_v1';

class ByokStore extends StateNotifier<List<ByokProviderConfig>> {
  ByokStore({FlutterSecureStorage? secure})
      : _secure = secure ?? const FlutterSecureStorage(),
        super(const []) {
    _load();
  }

  final FlutterSecureStorage _secure;
  final _loaded = Completer<void>();

  /// 首次读取完成 (UI 需要区分 "还没读" vs "真没有").
  Future<void> get ready => _loaded.future;

  Future<void> _load() async {
    try {
      final raw = await _secure.read(key: _kStorageKey);
      if (raw != null && raw.isNotEmpty) {
        state = ByokProviderConfig.decodeList(raw);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[byok] load failed: $e');
    } finally {
      if (!_loaded.isCompleted) _loaded.complete();
    }
  }

  Future<void> _persist() async {
    try {
      await _secure.write(
        key: _kStorageKey,
        value: ByokProviderConfig.encodeList(state),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('[byok] persist failed: $e');
    }
  }

  /// 添加 provider — 返回生成的 providerId.
  Future<String> add({
    required String name,
    required ByokProtocol protocol,
    required String baseUrl,
    required String apiKey,
    required List<String> models,
    Map<String, String> extraHeaders = const {},
  }) async {
    final id = const Uuid().v4().substring(0, 8);
    state = [
      ...state,
      ByokProviderConfig(
        id: id,
        name: name.trim(),
        protocol: protocol,
        baseUrl: _normalizeBaseUrl(baseUrl),
        apiKey: apiKey.trim(),
        models: models.where((m) => m.trim().isNotEmpty).toList(),
        extraHeaders: extraHeaders,
      ),
    ];
    await _persist();
    return id;
  }

  Future<void> update(ByokProviderConfig updated) async {
    state = [
      for (final p in state)
        if (p.id == updated.id)
          updated.copyWith(baseUrl: _normalizeBaseUrl(updated.baseUrl))
        else
          p,
    ];
    await _persist();
  }

  Future<void> remove(String providerId) async {
    state = state.where((p) => p.id != providerId).toList();
    await _persist();
  }

  ByokProviderConfig? byId(String providerId) {
    for (final p in state) {
      if (p.id == providerId) return p;
    }
    return null;
  }

  /// 从桌面 WiFi 导出结果 upsert — 按 [desktopSourceId] 去重.
  /// 返回 (added, updated).
  Future<({int added, int updated})> upsertFromDesktop(
    List<ByokProviderConfig> incoming,
  ) async {
    if (incoming.isEmpty) return (added: 0, updated: 0);
    var added = 0;
    var updated = 0;
    final next = [...state];
    for (final p in incoming) {
      final src = p.desktopSourceId;
      if (src == null || src.isEmpty) continue;
      final idx = next.indexWhere((e) => e.desktopSourceId == src);
      final merged = ByokProviderConfig(
        id: idx >= 0 ? next[idx].id : const Uuid().v4().substring(0, 8),
        name: p.name.trim().isEmpty
            ? (idx >= 0 ? next[idx].name : tr('电脑导入'))
            : p.name.trim(),
        protocol: p.protocol,
        baseUrl: _normalizeBaseUrl(p.baseUrl),
        apiKey: p.apiKey.trim(),
        models: p.models.where((m) => m.trim().isNotEmpty).toList(),
        enabled: true,
        extraHeaders: p.extraHeaders,
        desktopSourceId: src,
      );
      if (idx >= 0) {
        next[idx] = merged;
        updated++;
      } else {
        next.add(merged);
        added++;
      }
    }
    state = next;
    await _persist();
    return (added: added, updated: updated);
  }

  /// 尾部斜杠归一 — 适配器统一 `$baseUrl/path` 拼接.
  static String _normalizeBaseUrl(String raw) {
    var s = raw.trim();
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }
}

final byokStoreProvider =
    StateNotifierProvider<ByokStore, List<ByokProviderConfig>>(
  (ref) => ByokStore(),
);

/// 所有启用的 BYOK 模型 (跨 provider 平铺), 给模型选择器用.
final byokModelsProvider = Provider<List<({ByokProviderConfig provider, String modelId})>>(
  (ref) {
    final providers = ref.watch(byokStoreProvider);
    return [
      for (final p in providers)
        if (p.enabled)
          for (final m in p.models) (provider: p, modelId: m),
    ];
  },
);
