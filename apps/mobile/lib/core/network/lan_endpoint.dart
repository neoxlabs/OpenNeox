/// lan_endpoint.dart — LAN endpoint 候选解析、去重、排序。
///
/// Mobile 连接 Desktop 时不能只信一个 lastSeenLanIp。手机可能同时有 Wi-Fi、
/// 热点、蜂窝共享等多个接口，Desktop 也可能有多个内网 IP。这里只接受精确
/// 来源：presence、mDNS 里匹配 deviceId 的地址，以及上次鉴权成功的缓存。
library;

import 'dart:io';

enum LanEndpointSource { presence, mdns, cache }

class LanEndpoint {
  const LanEndpoint({
    required this.host,
    required this.port,
    required this.source,
  });

  final String host;
  final int port;
  final LanEndpointSource source;

  String get key => '$host:$port';

  String get sourceLabel => switch (source) {
    LanEndpointSource.presence => 'presence',
    LanEndpointSource.mdns => 'mdns',
    LanEndpointSource.cache => 'cache',
  };

  @override
  String toString() => '$host:$port/$sourceLabel';
}

class LocalNetworkProfile {
  const LocalNetworkProfile._(this._addresses);

  final List<int> _addresses;

  static const empty = LocalNetworkProfile._(<int>[]);

  /// 手机自己有没有一个局域网地址 (蜂窝接口的不算)。没有 = LAN 直连不可能通。
  bool get hasLocalLanAddress => _addresses.isNotEmpty;

  static Future<LocalNetworkProfile> capture() async {
    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        includeLinkLocal: false,
        type: InternetAddressType.IPv4,
      );
      final addresses = <int>[];
      for (final iface in interfaces) {
        /* 2026-09-17: 蜂窝接口的地址不算"局域网"。运营商 NAT 常发 10.x 私网地址,
         * 原来会被当成手机在某个 10.x 局域网里 —— 既给同为 10.x 的电脑地址加了
         * 假亲和度, 也让"手机根本没连 Wi-Fi"这件事在这里看不出来。 */
        if (isCellularInterfaceName(iface.name)) continue;
        for (final addr in iface.addresses) {
          final parsed = _parseIpv4(addr.address);
          if (parsed == null) continue;
          if (!_isUsableLanIpv4(parsed)) continue;
          addresses.add(parsed);
        }
      }
      return LocalNetworkProfile._(addresses);
    } catch (_) {
      return empty;
    }
  }

  /// 数值越高，越像“手机当前能直连到的内网地址”。
  int affinity(String host) {
    final ip = _parseIpv4(host);
    if (ip == null || !_isUsableLanIpv4(ip)) return 0;
    var best = 10;
    for (final local in _addresses) {
      if (ip == local) best = best < 1000 ? 1000 : best;
      if (_samePrefix(ip, local, 24)) best = best < 900 ? 900 : best;
      if (_samePrefix(ip, local, 16)) best = best < 650 ? 650 : best;
      if (_samePrefix(ip, local, 8)) best = best < 350 ? 350 : best;
    }
    return best;
  }
}

List<LanEndpoint> extractLanEndpointsFromCapabilities(
  Map<String, dynamic>? caps, {
  required LanEndpointSource source,
}) {
  if (caps == null || caps.isEmpty) return const [];
  final port = _parsePort(caps['lan_port']);
  if (port == null) return const [];

  final hosts = <String>[];
  final single = caps['lan_ip'];
  if (single is String) hosts.add(single);

  final multi = caps['lan_ips'];
  if (multi is List) {
    hosts.addAll(multi.whereType<String>());
  }

  final endpoints = <LanEndpoint>[];
  final seen = <String>{};
  for (final rawHost in hosts) {
    final host = rawHost.trim();
    if (!isUsableLanIpv4Host(host)) continue;
    final key = '$host:$port';
    if (!seen.add(key)) continue;
    endpoints.add(LanEndpoint(host: host, port: port, source: source));
  }
  return endpoints;
}

List<LanEndpoint> rankLanEndpoints(
  Iterable<LanEndpoint> raw,
  LocalNetworkProfile profile,
) {
  final bestByKey = <String, LanEndpoint>{};
  for (final endpoint in raw) {
    if (!isUsableLanIpv4Host(endpoint.host)) continue;
    if (endpoint.port <= 0 || endpoint.port > 65535) continue;
    final existing = bestByKey[endpoint.key];
    if (existing == null ||
        _sourceScore(endpoint.source) > _sourceScore(existing.source)) {
      bestByKey[endpoint.key] = endpoint;
    }
  }
  final ranked = bestByKey.values.toList();
  ranked.sort((a, b) {
    final byAffinity = profile.affinity(b.host) - profile.affinity(a.host);
    if (byAffinity != 0) return byAffinity;
    final bySource = _sourceScore(b.source) - _sourceScore(a.source);
    if (bySource != 0) return bySource;
    return a.key.compareTo(b.key);
  });
  return ranked;
}

/// 是不是蜂窝数据接口 (iOS `pdp_ip*`; Android 高通 `rmnet*` / 联发科 `ccmni*` /
/// 展锐 `seth_lte*` / 通用 `wwan*`; 464XLAT 的 `v4-rmnet*` / `clat*`)。
bool isCellularInterfaceName(String name) {
  final n = name.toLowerCase();
  const prefixes = [
    'pdp_ip',
    'rmnet',
    'v4-rmnet',
    'ccmni',
    'v4-ccmni',
    'seth_lte',
    'wwan',
    'clat',
  ];
  return prefixes.any(n.startsWith);
}

bool isUsableLanIpv4Host(String host) {
  final ip = _parseIpv4(host.trim());
  return ip != null && _isUsableLanIpv4(ip);
}

int? _parsePort(Object? raw) {
  if (raw is int) return raw > 0 && raw <= 65535 ? raw : null;
  if (raw is num) {
    final value = raw.toInt();
    return value > 0 && value <= 65535 ? value : null;
  }
  if (raw is String) {
    final value = int.tryParse(raw.trim());
    return value != null && value > 0 && value <= 65535 ? value : null;
  }
  return null;
}

int _sourceScore(LanEndpointSource source) => switch (source) {
  LanEndpointSource.presence => 30,
  LanEndpointSource.mdns => 20,
  LanEndpointSource.cache => 0,
};

int? _parseIpv4(String host) {
  final parts = host.split('.');
  if (parts.length != 4) return null;
  var value = 0;
  for (final part in parts) {
    if (part.isEmpty) return null;
    final n = int.tryParse(part);
    if (n == null || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value;
}

bool _isUsableLanIpv4(int ip) {
  final a = (ip >> 24) & 0xff;
  final b = (ip >> 16) & 0xff;
  if (a == 0 || a == 127) return false;
  if (a == 169 && b == 254) return false;
  if (a >= 224) return false;
  return _isPrivateIpv4(ip);
}

/// RFC1918 私网段。注意 100.64.0.0/10 (运营商级 NAT / Tailscale) **不在**里面,
/// 所以不会被当成局域网 —— test/lan_endpoint_test.dart 锁住这一条 (2026-09-17)。
bool _isPrivateIpv4(int ip) {
  final a = (ip >> 24) & 0xff;
  final b = (ip >> 16) & 0xff;
  if (a == 10) return true;
  if (a == 192 && b == 168) return true;
  return a == 172 && b >= 16 && b <= 31;
}

bool _samePrefix(int a, int b, int bits) {
  final mask = bits == 0 ? 0 : (0xffffffff << (32 - bits)) & 0xffffffff;
  return (a & mask) == (b & mask);
}
