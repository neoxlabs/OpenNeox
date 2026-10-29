/// 接入线路自动选择 (2026-10-08) —— Cloudflare 还是香港中转, 后台自动测, 用户无感知。
///
/// 国内直连 Cloudflare 免费套餐的共享 IP 常掉包 (实测 13/20 成功、中位 3.2s), 经我们的香港节点
/// (海外机, 不用任何国内基础设施) 20/20、0.32s。海外 Cloudflare 本来就快 —— 不按地区判断, 谁快走谁。
///
/// 手机端怎么切: 云端地址全是 `'$kNeoxCloudBaseUrl/...'` 现拼的, 所以 [kNeoxCloudBaseUrl] 改成 getter,
/// 选中香港时返回香港专用入口 `https://hk.neox-dev.com` (香港按入口改回原 Host 回源, 同一套后端,
/// 登录态 / 计费不变, 中途切换安全)。没用 dart:io 的 connectionFactory 全局改解析: 它一接管就得自己做
/// 所有 https 的 TLS, 还拿不到调用方设的证书回调 —— 局域网配对的自签证书会被它弄坏。
///
/// 节奏跟桌面 / CLI (packages/platform/src/platform/edgeRoute.ts) 一致: 启动先用上次结论, 过期 (6h)
/// 后台重测; 每 2 分钟看一眼当前线路, 连着两次不通整体重测。服务端 GET /api/v1/edges 能下线路
/// (只回 cf = 全体退回 Cloudflare)。dart-define 改了 NEOX_API_BASE (测试环境) 时整套不生效。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

class EdgeDef {
  const EdgeDef(this.id, {this.alias = const {}});
  final String id;

  /// 原主机名 → 专用入口主机名
  final Map<String, String> alias;

  static EdgeDef? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['id'];
    if (id is! String || !RegExp(r'^[a-z0-9-]{1,16}$').hasMatch(id)) return null;
    final raw = j['alias'];
    final alias = <String, String>{};
    if (raw is Map) {
      final host = RegExp(r'^([a-z0-9-]+\.)?neox-dev\.com$');
      for (final e in raw.entries) {
        final k = e.key, v = e.value;
        if (k is! String || v is! String || !host.hasMatch(k) || !host.hasMatch(v)) return null;
        alias[k] = v;
      }
    }
    return EdgeDef(id, alias: alias);
  }

  Map<String, Object> toJson() => {'id': id, 'alias': alias};
}

class EdgeSample {
  const EdgeSample(this.ok, this.medianMs);
  final int ok;
  final int? medianMs;
}

const _kDefaultEdges = <EdgeDef>[
  EdgeDef('cf'),
  EdgeDef('hk', alias: {
    'neox-dev.com': 'hk.neox-dev.com',
    'app.neox-dev.com': 'hk.neox-dev.com',
    'gateway.neox-dev.com': 'gw-hk.neox-dev.com',
  }),
];

const _kPrefKey = 'neox.edge_route.v1';
const _kProbeHost = 'neox-dev.com';
const _kProbePath = '/api/health';
const _kProbeTimeout = Duration(seconds: 5);
const _kSamples = 3;
const _kCacheTtl = Duration(hours: 6);
const _kWatchEvery = Duration(minutes: 2);

/// 只在香港明显更好时离开 Cloudflare (跟桌面端 chooseEdge 同一规则, 有单测):
/// 成功次数更多, 或一样多但 Cloudflare 中位慢一半以上 (+150ms 防抖)。全都不通 → 保持现状。
String chooseEdge(Map<String, EdgeSample> samples, String current) {
  final cf = samples['cf'];
  var best = 'cf';
  if (cf != null) {
    for (final e in samples.entries) {
      if (e.key == 'cf') continue;
      final s = e.value;
      final better = s.ok > cf.ok ||
          (s.ok == cf.ok && s.ok > 0 && s.medianMs != null && cf.medianMs != null &&
              cf.medianMs! > s.medianMs! * 1.5 + 150);
      if (better && (best == 'cf' || (s.medianMs ?? 1 << 30) < (samples[best]!.medianMs ?? 1 << 30))) {
        best = e.key;
      }
    }
  }
  return samples.values.any((s) => s.ok > 0) ? best : current;
}

/// 把 base (如 https://neox-dev.com) 按线路换成专用入口; 不在映射里的原样返回。
String mapBaseForEdge(String base, EdgeDef? edge) {
  if (edge == null || edge.alias.isEmpty) return base;
  final u = Uri.tryParse(base);
  final to = u == null ? null : edge.alias[u.host];
  return to == null ? base : u!.replace(host: to).toString().replaceFirst(RegExp(r'/$'), '');
}

class EdgeRoute {
  EdgeRoute._();
  static final EdgeRoute instance = EdgeRoute._();

  List<EdgeDef> _edges = _kDefaultEdges;
  String _active = 'cf';
  bool _started = false;
  bool _enabled = true;
  int _fails = 0;
  Future<void>? _probing;

  String get active => _active;

  EdgeDef? _edge(String id) {
    for (final e in _edges) {
      if (e.id == id) return e;
    }
    return null;
  }

  /// 给 kNeoxCloudBaseUrl / relay base 用。没启用 (测试环境) 或 Cloudflare 线路时原样返回。
  String mapBase(String base) => _enabled ? mapBaseForEdge(base, _edge(_active)) : base;

  /// 编译期强制线路 (`--dart-define=NEOX_EDGE=hk|cf`), 跟桌面 / CLI 的 NEOX_EDGE 环境变量同义。
  /// 只给测试包用: 模拟器的网络常走开发机代理, 测速不会选香港, 要强制才验证得到香港这条路。
  static const _forced = String.fromEnvironment('NEOX_EDGE');

  /// 启动时调一次 (不阻塞首帧: 读缓存是同步拿到的 prefs, 测速在后台)。
  Future<void> start({required bool enabled}) async {
    if (_started) return;
    _started = true;
    _enabled = enabled;
    if (!enabled) return;
    if (_forced.isNotEmpty && _edge(_forced) != null) {
      _active = _forced;
      return;
    }
    DateTime? decidedAt;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_kPrefKey);
      if (raw != null) {
        final j = jsonDecode(raw) as Map<String, dynamic>;
        final edges = (j['edges'] as List?)?.map(EdgeDef.fromJson).toList();
        if (edges != null && edges.isNotEmpty && edges.every((e) => e != null) && edges.any((e) => e!.id == 'cf')) {
          _edges = edges.cast<EdgeDef>();
        }
        decidedAt = DateTime.fromMillisecondsSinceEpoch((j['decidedAt'] as num).toInt());
        final edge = j['edge'] as String?;
        if (edge != null && _edge(edge) != null && DateTime.now().difference(decidedAt) < _kCacheTtl * 4) {
          _active = edge;
        }
      }
    } catch (_) {/* 缓存坏了就当没有 */}
    if (decidedAt == null || DateTime.now().difference(decidedAt) > _kCacheTtl) unawaited(_reprobe());
    Timer.periodic(_kWatchEvery, (_) => unawaited(_watchdog())); /* 跟 app 同寿, 不用取消 */
  }

  Future<void> _reprobe() => _probing ??= _probeAll().whenComplete(() => _probing = null);

  Future<void> _watchdog() async {
    final cur = _edge(_active);
    if (cur == null) return;
    final ok = await _probeOnce(cur) != null;
    _fails = ok ? 0 : _fails + 1;
    if (_fails >= 2) {
      _fails = 0;
      await _reprobe();
    }
  }

  Future<int?> _probeOnce(EdgeDef edge) async {
    final host = edge.alias[_kProbeHost] ?? _kProbeHost;
    final client = HttpClient()..connectionTimeout = _kProbeTimeout;
    final sw = Stopwatch()..start();
    try {
      final req = await client.getUrl(Uri.https(host, _kProbePath)).timeout(_kProbeTimeout);
      req.headers.set(HttpHeaders.userAgentHeader, 'neox-edge-probe');
      final res = await req.close().timeout(_kProbeTimeout);
      await res.drain<void>().timeout(_kProbeTimeout);
      return res.statusCode == 200 ? sw.elapsedMilliseconds : null;
    } catch (_) {
      return null;
    } finally {
      client.close(force: true);
    }
  }

  Future<EdgeSample> _probeEdge(EdgeDef edge) async {
    final ms = <int>[];
    for (var i = 0; i < _kSamples; i++) {
      final r = await _probeOnce(edge);
      if (r != null) ms.add(r);
    }
    ms.sort();
    return EdgeSample(ms.length, ms.isEmpty ? null : ms[ms.length ~/ 2]);
  }

  /* 服务端清单: 加 / 下线路不用发版; 拉不到就沿用现有的 */
  Future<void> _refreshList() async {
    final client = HttpClient()..connectionTimeout = _kProbeTimeout;
    try {
      final base = mapBase('https://neox-dev.com');
      final req = await client.getUrl(Uri.parse('$base/api/v1/edges')).timeout(_kProbeTimeout);
      final res = await req.close().timeout(_kProbeTimeout);
      if (res.statusCode != 200) return;
      final body = jsonDecode(await res.transform(utf8.decoder).join().timeout(_kProbeTimeout));
      final list = (body is Map ? body['edges'] : null) as List?;
      final edges = list?.map(EdgeDef.fromJson).toList();
      if (edges != null && edges.isNotEmpty && edges.length <= 8 && edges.every((e) => e != null) && edges.any((e) => e!.id == 'cf')) {
        _edges = edges.cast<EdgeDef>();
      }
    } catch (_) {
    } finally {
      client.close(force: true);
    }
  }

  Future<void> _probeAll() async {
    await _refreshList();
    final results = await Future.wait(_edges.map((e) async => MapEntry(e.id, await _probeEdge(e))));
    final samples = Map.fromEntries(results);
    _active = chooseEdge(samples, _active);
    if (_edge(_active) == null) _active = 'cf';
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kPrefKey, jsonEncode({
        'edge': _active,
        'decidedAt': DateTime.now().millisecondsSinceEpoch,
        'edges': _edges.map((e) => e.toJson()).toList(),
      }));
    } catch (_) {}
  }
}
