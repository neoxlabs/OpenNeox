/// lan_endpoint_hints_provider.dart — presence 推送来的 Desktop LAN 候选缓存。
///
/// Drift 里只存一个 lastSeenLanIp/Port；这里保留同一台电脑的多个实时候选地址，
/// 供 ws_client_provider 连接时自动选择最快可用路线。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'lan_endpoint.dart';

class LanEndpointHints {
  const LanEndpointHints(this.byDeviceId);

  final Map<String, List<LanEndpoint>> byDeviceId;

  List<LanEndpoint> forDevice(String deviceId) =>
      byDeviceId[deviceId] ?? const [];

  static const empty = LanEndpointHints(<String, List<LanEndpoint>>{});
}

class LanEndpointHintsController extends StateNotifier<LanEndpointHints> {
  LanEndpointHintsController() : super(LanEndpointHints.empty);

  void replacePresenceEndpoints(String deviceId, List<LanEndpoint> endpoints) {
    final next = Map<String, List<LanEndpoint>>.from(state.byDeviceId);
    if (endpoints.isEmpty) {
      next.remove(deviceId);
    } else {
      next[deviceId] = List.unmodifiable(endpoints);
    }
    state = LanEndpointHints(Map.unmodifiable(next));
  }

  void clear(String deviceId) {
    if (!state.byDeviceId.containsKey(deviceId)) return;
    final next = Map<String, List<LanEndpoint>>.from(state.byDeviceId)
      ..remove(deviceId);
    state = LanEndpointHints(Map.unmodifiable(next));
  }
}

final lanEndpointHintsProvider =
    StateNotifierProvider<LanEndpointHintsController, LanEndpointHints>(
      (ref) => LanEndpointHintsController(),
    );
