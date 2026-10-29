/// tool_result_cards.dart — 工具结果卡: 搜索来源 / 我的位置.
///
/// 2026-10-06 用户: 「Chat 只能对话, 搜索、定位等各种卡片不同的体验, 还是差得很远」。
/// 手机 Chat 一直有 web_search / get_location, 但结果只进折叠行里的一段等宽 JSON —— 用户看到的是
/// 「搜索了 1 次 ›」一行灰字, 答案里引用的东西从哪来、点哪打开, 全看不见。
///
/// 这两张卡跟 ArtifactStrip 一样放在折叠行**外面**: 来源和位置是这一步真正交付给用户的东西,
/// 不是过程。数据直接从工具输出解析 —— 两个工具的输出格式都是我们自己定的
/// (hosted_web_search.dart / phone_tools.dart), 不改协议, 历史消息也一样出卡。
library;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../state/timeline_state.dart';
import 'package:neox_app/core/i18n/tr.dart';

class SearchHit {
  const SearchHit({required this.title, required this.url, this.date, this.snippet = ''});
  final String title;
  final String url;
  final String? date;
  final String snippet;

  String get host {
    final h = Uri.tryParse(url)?.host ?? '';
    return h.startsWith('www.') ? h.substring(4) : h;
  }
}

/// 解析 web_search 的输出 (WebSearchTool.run 写的格式):
///   `1. 标题` 后面跟缩进 3 格的若干行: 链接 / 日期 / 摘要 (都可能缺)。
List<SearchHit> parseWebSearchOutput(String out) {
  final hits = <SearchHit>[];
  String? title;
  String url = '';
  String? date;
  final snippet = StringBuffer();
  void flush() {
    if (title != null) {
      hits.add(SearchHit(title: title!, url: url, date: date, snippet: snippet.toString().trim()));
    }
    title = null;
    url = '';
    date = null;
    snippet.clear();
  }

  final head = RegExp(r'^(\d+)\. (.+)$');
  final dateLike = RegExp(r'^\d{4}-\d{2}-\d{2}');
  for (final raw in out.split('\n')) {
    final m = head.firstMatch(raw);
    if (m != null) {
      flush();
      title = m.group(2)!.trim();
      continue;
    }
    if (title == null) continue;
    final line = raw.trim();
    if (line.isEmpty) continue;
    if (url.isEmpty && (line.startsWith('http://') || line.startsWith('https://'))) {
      url = line;
    } else if (date == null && snippet.isEmpty && dateLike.hasMatch(line)) {
      date = line.length > 10 ? line.substring(0, 10) : line;
    } else {
      if (snippet.isNotEmpty) snippet.write(' ');
      snippet.write(line);
    }
  }
  flush();
  return hits;
}

/// 解析 get_location 的输出: `纬度 31.2, 经度 121.4 (精度约 35 米, 刚定位)`
@visibleForTesting
({double lat, double lng, String note})? parseLocationOutput(String out) {
  final m = RegExp(r'纬度\s*(-?[\d.]+)\s*,\s*经度\s*(-?[\d.]+)\s*(?:\((.*)\))?').firstMatch(out);
  if (m == null) return null;
  final lat = double.tryParse(m.group(1)!);
  final lng = double.tryParse(m.group(2)!);
  if (lat == null || lng == null) return null;
  return (lat: lat, lng: lng, note: (m.group(3) ?? '').trim());
}

/// 这一步该出哪张卡; 没有就返回 null (调用方什么都不画)。
Widget? toolResultCardFor(TimelineEntry e) {
  if (e.pending || !e.toolSuccess) return null;
  final out = e.output ?? '';
  if (out.isEmpty) return null;
  switch (e.toolName) {
    case 'web_search':
      final hits = parseWebSearchOutput(out).where((h) => h.url.isNotEmpty).toList();
      if (hits.isEmpty) return null;
      final q = e.args?['query'];
      return SearchSourcesCard(hits: hits, query: q is String ? q : null);
    case 'get_location':
      final loc = parseLocationOutput(out);
      return loc == null ? null : LocationCard(lat: loc.lat, lng: loc.lng, note: loc.note);
  }
  return null;
}

Future<void> _open(Uri uri) async {
  try {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {/* 没有能打开它的 App —— 不弹错, 用户点了没反应自己会换个办法 */}
}

/// 搜索来源: 默认露 3 条, 其余点「另外 N 个来源」展开。每条 = 站点首字母徽 + 标题 + 站点 · 日期。
///
/// 不拉 favicon: 那要拿每个域名去打第三方图标服务, 等于把用户搜了什么告诉别人。首字母 + 稳定配色
/// 已经足够让人一眼分出"这三条是同一家还是三家"。
class SearchSourcesCard extends StatefulWidget {
  const SearchSourcesCard({super.key, required this.hits, this.query});
  final List<SearchHit> hits;
  final String? query;

  @override
  State<SearchSourcesCard> createState() => _SearchSourcesCardState();
}

class _SearchSourcesCardState extends State<SearchSourcesCard> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final shown = _all ? widget.hits : widget.hits.take(3).toList();
    final rest = widget.hits.length - shown.length;
    return Container(
      margin: const EdgeInsets.only(top: 2, bottom: 6),
      decoration: BoxDecoration(
        borderRadius: NeoxRadius.inputR,
        border: Border.all(color: scheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
            child: Row(
              children: [
                Icon(Icons.travel_explore_rounded, size: 15, color: scheme.onSurfaceVariant),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    widget.query == null || widget.query!.isEmpty
                        ? tr('${widget.hits.length} 个来源')
                        : tr('「${widget.query}」· ${widget.hits.length} 个来源'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                  ),
                ),
              ],
            ),
          ),
          for (final h in shown) _SourceRow(hit: h),
          if (rest > 0)
            InkWell(
              onTap: () => setState(() => _all = true),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                child: Text(
                  tr('另外 $rest 个来源'),
                  style: TextStyle(fontSize: 13, color: scheme.primary, fontWeight: FontWeight.w500),
                ),
              ),
            )
          else
            const SizedBox(height: 6),
        ],
      ),
    );
  }
}

/// 同一个域名永远同一个色 —— 用户靠颜色就能看出三条是不是同一家
({Color bg, Color ink, String initial}) _siteBadge(BuildContext context, String host) {
  final dark = Theme.of(context).brightness == Brightness.dark;
  final hue = (host.codeUnits.fold<int>(0, (a, c) => (a * 31 + c) & 0xffff) % 360).toDouble();
  return (
    bg: HSLColor.fromAHSL(1, hue, 0.45, dark ? 0.35 : 0.88).toColor(),
    ink: HSLColor.fromAHSL(1, hue, 0.55, dark ? 0.85 : 0.32).toColor(),
    initial: host.isEmpty ? '·' : host[0].toUpperCase(),
  );
}

/// 陶土稿 v5 对话 / 工作模式: 来源收成一行「◐◑◒ 8 个来源 ›」, 点开是一张来源清单.
class SourcesRow extends StatelessWidget {
  const SourcesRow({super.key, required this.hits});
  final List<SearchHit> hits;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final hosts = <String>[];
    for (final h in hits) {
      if (!hosts.contains(h.host)) hosts.add(h.host);
    }
    final shown = hosts.take(3).toList();
    return Align(
      alignment: Alignment.centerLeft,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => showClaySheet<void>(
          context,
          builder: (_) => Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ClaySheetHeader(title: tr('${hits.length} 个来源')),
                for (final h in hits) _SourceRow(hit: h),
              ],
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 18.0 + (shown.length - 1) * 12,
                height: 20,
                child: Stack(
                  children: [
                    for (final (i, host) in shown.indexed)
                      Positioned(
                        left: i * 12.0,
                        child: Builder(builder: (context) {
                          final b = _siteBadge(context, host);
                          return Container(
                            width: 20,
                            height: 20,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: b.bg, shape: BoxShape.circle, border: Border.all(color: c.canvas, width: 1.5)),
                            child: Text(b.initial, style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: b.ink)),
                          );
                        }),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(tr('${hits.length} 个来源'), style: TextStyle(fontSize: 13, color: c.grey)),
              Icon(Icons.chevron_right_rounded, size: 17, color: c.faint),
            ],
          ),
        ),
      ),
    );
  }
}

class _SourceRow extends StatelessWidget {
  const _SourceRow({required this.hit});
  final SearchHit hit;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final host = hit.host;
    final b = _siteBadge(context, host);
    final initial = b.initial;
    final badge = b.bg;
    final badgeInk = b.ink;
    return InkWell(
      onTap: () {
        final u = Uri.tryParse(hit.url);
        if (u != null) _open(u);
      },
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 7, 14, 7),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 22,
              height: 22,
              margin: const EdgeInsets.only(top: 1),
              alignment: Alignment.center,
              decoration: BoxDecoration(color: badge, borderRadius: NeoxRadius.smallR),
              child: Text(initial, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: badgeInk)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hit.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, height: 1.3, color: scheme.onSurface, fontWeight: FontWeight.w500),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    [host, if (hit.date != null) hit.date!].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 我的位置: 坐标 + 精度/时效 + 「在地图打开」(geo: 链接, 系统让用户挑地图 App)。
///
/// 不显示街道地址: 手机上没有逆地理接口, 编一个"附近"出来比只给坐标更糟。模型拿坐标去搜周边时,
/// 搜索结果卡里自然会有地名。
class LocationCard extends StatelessWidget {
  const LocationCard({super.key, required this.lat, required this.lng, this.note = ''});
  final double lat;
  final double lng;
  final String note;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: 2, bottom: 6),
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
      decoration: BoxDecoration(
        borderRadius: NeoxRadius.inputR,
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: scheme.primaryContainer, borderRadius: NeoxRadius.chipR),
            child: Icon(Icons.my_location_rounded, size: 18, color: scheme.onPrimaryContainer),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(tr('我的位置'), style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface)),
                const SizedBox(height: 2),
                Text(
                  '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}',
                  maxLines: 1,
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
                /* 精度 / 时效单独一行 —— 跟坐标挤一行时手机宽度下被截成「精度约 3…」 */
                if (note.isNotEmpty)
                  Text(note, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          TextButton(
            onPressed: () => _open(Uri.parse('geo:$lat,$lng?q=$lat,$lng')),
            child: Text(tr('在地图打开')),
          ),
        ],
      ),
    );
  }
}
