/// changelog.dart — 更新日志 (服务端 /api/v1/changelog).
///
/// **为什么补这个** (2026-09-18 用户: 「做好显示更新的日志!changelog! 做好看」)
///
/// 更新页原来只有两行: 「已是最新版本 / 当前 v3.3.8」+「重新检查」。也就是说
/// 用户**看不到这一版改了什么** —— 我们每一版都写了详细日志灌进生产库
/// (scripts/seed-changelog-*.sql), 而手机端一个字都没显示。
///
/// 接口是公开的 (登录可选), 直接 GET: /api/v1/changelog?limit=N
///
/// 两个数据形状上的坑:
///   · title / bodyMd 是**双语塞在一个字段里**, 用 `<!--zh-->` 分隔
///     (前半英文后半中文)。不切开的话界面上会把两种语言都显示出来。
///   · platforms 是逗号分隔的字符串 ('android' / 'mac,win' / 'all'),
///     手机端只显示跟自己有关的那些 —— 桌面版的日志对手机用户是噪音。
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import '../neox_constants.dart';

/// 双语字段的分隔标记 —— 服务端约定, 前半 en 后半 zh.
const _kZhMarker = '<!--zh-->';

/// 取双语字段里该显示的那一半.
String pickLocalized(String raw, {required bool zh}) {
  final i = raw.indexOf(_kZhMarker);
  if (i < 0) return raw.trim();
  return (zh ? raw.substring(i + _kZhMarker.length) : raw.substring(0, i))
      .trim();
}

/// 这条日志跟当前平台有关吗.
///
/// 'all' / 空 = 所有平台; 否则逗号分隔的列表里要含 [platform]。
bool changelogAppliesTo(String platforms, String platform) {
  final p = platforms.trim().toLowerCase();
  if (p.isEmpty || p == 'all') return true;
  return p.split(',').map((s) => s.trim()).contains(platform);
}

class ChangelogEntry {
  const ChangelogEntry({
    required this.id,
    required this.version,
    required this.title,
    required this.bodyMd,
    required this.publishedAt,
  });

  final String id;
  final String version;
  final String title;
  final String bodyMd;

  /// 服务端给的是 ISO 文本; 解析不出来就 null (不为了排版去编一个时间).
  final DateTime? publishedAt;

  static ChangelogEntry? fromJson(Map<String, dynamic> j, {required bool zh}) {
    final version = (j['version'] as String?)?.trim() ?? '';
    if (version.isEmpty) return null;
    final rawTitle = (j['title'] as String?) ?? '';
    final rawBody = (j['bodyMd'] as String?) ?? (j['body_md'] as String?) ?? '';
    final ts = (j['publishedAt'] as String?) ?? (j['published_at'] as String?);
    return ChangelogEntry(
      id: (j['id'] as String?) ?? version,
      version: version,
      title: pickLocalized(rawTitle, zh: zh),
      bodyMd: pickLocalized(rawBody, zh: zh),
      publishedAt: ts == null ? null : DateTime.tryParse(ts)?.toLocal(),
    );
  }
}

/* ── 缓存 (2026-09-18 用户: 「优化 changelog 性能 异步 缓存等」) ──────────
 *
 * 原来每次进更新页都拉一次, 而且 limit=30 —— 每条正文上千字、双语两份,
 * 一次几十 KB, 而这一页只展示最新那几条。三个浪费叠在一起: 拉太多、每次都拉、
 * 拉到之前界面上是个转圈。
 *
 * 现在: limit 降到 8; 结果落 SharedPreferences (TTL 30 分钟);
 * **先给缓存再后台刷新** —— 有缓存时第一帧就有内容, 新数据回来再无声替换。
 */
const _kCacheKey = 'neox_changelog_cache_v1';
const _kCacheTtl = Duration(minutes: 30);

/// 拉这个平台的更新日志 (最新在前).
///
/// 失败返回**缓存**, 没缓存才返回空 —— 更新页的主功能是"有没有新版/装不装",
/// 日志拉不到不该把那半边也弄挂。界面按空列表显示一句"暂时读不到"。
final changelogProvider = FutureProvider<List<ChangelogEntry>>((ref) async {
  const platform = 'android'; // iOS 上架后按 Platform 分
  const zh = true; // 界面目前只有中文; 有语言开关时接上
  final prefs = ref.watch(sharedPreferencesProvider);

  List<ChangelogEntry> parse(String body) {
    final data = jsonDecode(body);
    if (data is! Map) return const [];
    final list = data['entries'];
    if (list is! List) return const [];
    final out = <ChangelogEntry>[];
    for (final raw in list) {
      if (raw is! Map<String, dynamic>) continue;
      final platforms = (raw['platforms'] as String?) ?? '';
      if (!changelogAppliesTo(platforms, platform)) continue;
      final e = ChangelogEntry.fromJson(raw, zh: zh);
      if (e != null) out.add(e);
    }
    return out;
  }

  /* 缓存还新鲜 → 直接用, 不发请求 */
  final cachedAt = prefs.getInt('${_kCacheKey}_at') ?? 0;
  final cachedBody = prefs.getString(_kCacheKey);
  final age = DateTime.now().millisecondsSinceEpoch - cachedAt;
  if (cachedBody != null && age >= 0 && age < _kCacheTtl.inMilliseconds) {
    try {
      return parse(cachedBody);
    } catch (_) {
      /* 缓存坏了当没有 */
    }
  }

  try {
    final uri = Uri.parse('$kNeoxProductionApiBase/api/v1/changelog?limit=8');
    final resp = await http
        .get(uri, headers: const {'accept': 'application/json'})
        .timeout(const Duration(seconds: 10));
    if (resp.statusCode != 200) {
      debugPrint('[changelog] HTTP ${resp.statusCode}');
      /* 请求失败但有旧缓存 → 用旧的, 别把这一段变成空白 */
      if (cachedBody != null) {
        try { return parse(cachedBody); } catch (_) { /* 落到空 */ }
      }
      return const [];
    }
    final body = utf8.decode(resp.bodyBytes);
    await prefs.setString(_kCacheKey, body);
    await prefs.setInt('${_kCacheKey}_at', DateTime.now().millisecondsSinceEpoch);
    return parse(body);
  } catch (e) {
    debugPrint('[changelog] 拉取失败: $e');
    if (cachedBody != null) {
      try { return parse(cachedBody); } catch (_) { /* 落到空 */ }
    }
    return const [];
  }
});
