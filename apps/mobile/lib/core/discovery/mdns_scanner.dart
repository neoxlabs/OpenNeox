/// mdns_scanner.dart — 扫 `_neox._tcp.local.` Desktop 广播.
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §3.1:
///   service type: _neox._tcp.local.
///   TXT: device_id / device_name / version / pubkey_fp
///
/// 用 multicast_dns 包 (Flutter 官方). 流程:
///   PTR query → 拿 service instance 列表
///   SRV query (instance) → 拿 hostname + port
///   A query (hostname) → 拿 IP
///   TXT query (instance) → 拿 device_id / device_name / version / pubkey_fp
///
/// 持续轮询 (每 5s 一轮), 维护 `Map<device_id, DesktopBeacon>`. 超 30s 没刷新视为消失.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:multicast_dns/multicast_dns.dart';

/// 一台被发现的 Desktop
class DesktopBeacon {
  const DesktopBeacon({
    required this.deviceId,
    required this.deviceName,
    required this.host,
    required this.port,
    required this.pubkeyFingerprint,
    required this.protocolVersion,
    required this.lastSeenAt,
  });

  final String deviceId;
  final String deviceName;
  final String host;
  final int port;
  final String pubkeyFingerprint;
  final int protocolVersion;
  final DateTime lastSeenAt;

  DesktopBeacon copyWith({DateTime? lastSeenAt}) => DesktopBeacon(
    deviceId: deviceId,
    deviceName: deviceName,
    host: host,
    port: port,
    pubkeyFingerprint: pubkeyFingerprint,
    protocolVersion: protocolVersion,
    lastSeenAt: lastSeenAt ?? this.lastSeenAt,
  );
}

const String _kServiceFqn = '_neox._tcp.local';
const Duration _kScanInterval = Duration(seconds: 5);
const Duration _kBeaconTtl = Duration(seconds: 30);
const Duration _kPtrLookupTimeout = Duration(milliseconds: 700);
const Duration _kRecordLookupTimeout = Duration(milliseconds: 500);

class MdnsScanner {
  MdnsScanner();

  final StreamController<List<DesktopBeacon>> _ctrl =
      StreamController<List<DesktopBeacon>>.broadcast();
  final Map<String, DesktopBeacon> _byId = {};
  MDnsClient? _client;
  Timer? _timer;
  bool _running = false;
  bool _disposed = false;

  Stream<List<DesktopBeacon>> get beacons => _ctrl.stream;
  List<DesktopBeacon> get current => _byId.values.toList(growable: false);

  Future<void> start() async {
    if (_running || _disposed) return;
    _running = true;
    _client = MDnsClient(rawDatagramSocketFactory: _bindMdnsSocket);
    try {
      await _client!.start(
        interfacesFactory: _mdnsInterfaces,
        onError: (err) => stderr.writeln('[mdns] socket error: $err'),
      );
    } catch (e) {
      _running = false;
      _client = null;
      rethrow;
    }
    // 立刻扫一轮 + 周期扫
    unawaited(_oneRound());
    _timer = Timer.periodic(_kScanInterval, (_) {
      if (_disposed) return;
      unawaited(_oneRound());
    });
  }

  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    try {
      _client?.stop();
    } catch (_) {}
    _client = null;
    _running = false;
  }

  Future<void> dispose() async {
    _disposed = true;
    await stop();
    await _ctrl.close();
  }

  Future<void> _oneRound() async {
    final client = _client;
    if (client == null) return;
    try {
      // 1. PTR — 列出当前 _neox._tcp.local. 的 service instances
      final ptrStream = _lookup<PtrResourceRecord>(
        client,
        ResourceRecordQuery.serverPointer(_kServiceFqn),
        timeout: _kPtrLookupTimeout,
      );
      final discovered = <String>{}; // service instance fqn

      await for (final ptr in ptrStream) {
        if (_disposed) return;
        discovered.add(ptr.domainName);
        await _resolveInstance(client, ptr.domainName);
      }

      // GC: 超过 ttl 没刷新的 beacon 移除
      final now = DateTime.now();
      final stale = _byId.entries
          .where((e) => now.difference(e.value.lastSeenAt) > _kBeaconTtl)
          .map((e) => e.key)
          .toList();
      for (final id in stale) {
        _byId.remove(id);
      }

      _emit();
    } catch (_) {
      /* 一轮失败不致命, 下轮再来 */
    }
  }

  Future<void> _resolveInstance(MDnsClient client, String instanceFqn) async {
    try {
      // SRV → port + target host
      SrvResourceRecord? srv;
      await for (final r in _lookup<SrvResourceRecord>(
        client,
        ResourceRecordQuery.service(instanceFqn),
        timeout: _kRecordLookupTimeout,
      )) {
        srv = r;
        break;
      }
      if (srv == null) return;

      // TXT → device_id / device_name / version / pubkey_fp
      String? deviceId, deviceName, pubkeyFp;
      int protocolVersion = 1;
      await for (final r in _lookup<TxtResourceRecord>(
        client,
        ResourceRecordQuery.text(instanceFqn),
        timeout: _kRecordLookupTimeout,
      )) {
        for (final entry in r.text.split('\n')) {
          final eqIdx = entry.indexOf('=');
          if (eqIdx <= 0) continue;
          final k = entry.substring(0, eqIdx);
          final v = entry.substring(eqIdx + 1);
          switch (k) {
            case 'device_id':
              deviceId = v;
              break;
            case 'device_name':
              deviceName = v;
              break;
            case 'version':
              protocolVersion = int.tryParse(v) ?? 1;
              break;
            case 'pubkey_fp':
              pubkeyFp = v;
              break;
          }
        }
        break; // 取首条 TXT
      }
      if (deviceId == null) return; // device_id 是必备

      // A → IPv4
      String? host;
      try {
        await for (final r in _lookup<IPAddressResourceRecord>(
          client,
          ResourceRecordQuery.addressIPv4(srv.target),
          timeout: _kRecordLookupTimeout,
        )) {
          if (r.address.type == InternetAddressType.IPv4) {
            host = r.address.address;
            break;
          }
        }
      } catch (_) {}
      // fallback IPv6
      if (host == null) {
        try {
          await for (final r in _lookup<IPAddressResourceRecord>(
            client,
            ResourceRecordQuery.addressIPv6(srv.target),
            timeout: _kRecordLookupTimeout,
          )) {
            host = r.address.address;
            break;
          }
        } catch (_) {}
      }
      if (host == null) return;

      _byId[deviceId] = DesktopBeacon(
        deviceId: deviceId,
        deviceName: deviceName ?? srv.target,
        host: host,
        port: srv.port,
        pubkeyFingerprint: pubkeyFp ?? '',
        protocolVersion: protocolVersion,
        lastSeenAt: DateTime.now(),
      );
    } catch (_) {
      /* 单 instance 解析失败不影响其他 */
    }
  }

  Stream<T> _lookup<T extends ResourceRecord>(
    MDnsClient client,
    ResourceRecordQuery query, {
    required Duration timeout,
  }) {
    try {
      return client
          .lookup<T>(query, timeout: timeout)
          .handleError((_) {}, test: (_) => true);
    } catch (_) {
      return Stream<T>.empty();
    }
  }

  void _emit() {
    if (_ctrl.isClosed) return;
    _ctrl.add(current);
  }
}

Future<Iterable<NetworkInterface>> _mdnsInterfaces(InternetAddressType type) {
  return NetworkInterface.list(
    includeLoopback: false,
    includeLinkLocal: false,
    type: type,
  );
}

Future<RawDatagramSocket> _bindMdnsSocket(
  dynamic host,
  int port, {
  bool reuseAddress = false,
  bool reusePort = false,
  int ttl = 1,
}) async {
  final effectiveReusePort = Platform.isAndroid ? false : reusePort;
  try {
    return await RawDatagramSocket.bind(
      host,
      port,
      reuseAddress: reuseAddress,
      reusePort: effectiveReusePort,
      ttl: ttl,
    );
  } catch (e) {
    if (!effectiveReusePort) rethrow;
    return RawDatagramSocket.bind(
      host,
      port,
      reuseAddress: reuseAddress,
      reusePort: false,
      ttl: ttl,
    );
  }
}

/// 全局单例 — App 生命周期内只起一个 mDNS 扫描器.
final mdnsScannerProvider = Provider<MdnsScanner>((ref) {
  final s = MdnsScanner();
  ref.onDispose(() {
    unawaited(s.dispose());
  });
  return s;
});

/// 当前发现的 Desktop 列表 (持续流, UI watch 此 provider).
final desktopBeaconsProvider = StreamProvider<List<DesktopBeacon>>((
  ref,
) async* {
  final scanner = ref.watch(mdnsScannerProvider);
  await scanner.start();
  yield scanner.current;
  yield* scanner.beacons;
});
