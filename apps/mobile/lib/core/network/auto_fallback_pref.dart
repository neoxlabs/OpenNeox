/// auto_fallback_pref.dart — "本地连不上自动切云中转" 开关持久化.
///
/// 默认开启. ws_client_provider.connectLan 失败超 N 秒
/// (或换 WiFi 后 mDNS 扫不到) 时自动 connectCloudRelay, 不用每次手动切.
///
/// 存 secure storage 跨重启复用.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _kKey = 'neox_auto_fallback_to_cloud';

class AutoFallbackController extends StateNotifier<bool> {
  AutoFallbackController(this._storage) : super(true) {
    _hydrate();
  }
  final FlutterSecureStorage _storage;

  Future<void> _hydrate() async {
    final v = await _storage.read(key: _kKey);
    if (mounted) state = v == null ? true : v == 'true';
  }

  Future<void> setEnabled(bool v) async {
    state = v;
    await _storage.write(key: _kKey, value: v ? 'true' : 'false');
  }
}

final autoFallbackProvider =
    StateNotifierProvider<AutoFallbackController, bool>(
      (ref) => AutoFallbackController(const FlutterSecureStorage()),
    );
