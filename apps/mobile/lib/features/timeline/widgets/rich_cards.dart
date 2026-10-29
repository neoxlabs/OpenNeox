/// rich_cards.dart — 手机端的 `neox-card:KIND` 富卡片.
///
/// 桌面早就有一整套 (apps/desktop/.../NeoxCards.tsx), 手机一张都没有: 模型写出来的卡片在手机上就是
/// 一块等宽字的 JSON (2026-10-06 用户: 「Chat 只能对话 … 卡片不同的体验还差得很远」)。
/// 这里按**同一份协议、同样的字段名**做手机版, 先做生活助手最常用的几种:
///   weather 天气 · restaurant/place 店铺地点 · news 新闻 · steps 步骤 · callout 提示 · chart 柱状 · link 链接
/// 其余 kind 和 JSON 解析不出来的, 交回普通代码块 (返回 null) —— 宁可显示原文也不画一张空卡。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

const String kNeoxCardLangPrefix = 'neox-card:';

/// 这一块代码的语言是 `neox-card:KIND` 时出卡; 不认识 / 解析不了返回 null。
/// [streaming] = 这段正文还在写: JSON 不完整时显示「卡片生成中」, 不露半截 JSON。
Widget? buildNeoxCard(String kind, String body, {bool streaming = false}) {
  final k = kind.trim().toLowerCase();
  if (!_kKinds.contains(k)) return null;
  final data = _decodeLenient(body);
  /* 解析不了: 还在写 → 「卡片生成中」; 写完了 → 交回原文代码块。
   * 原来写完后按「末尾不是 }」也判成生成中, 真机上一张天气卡转了一整轮没停 */
  if (data == null) return streaming ? const _PendingCard() : null;
  if (data is! Map) return null;
  final d = Map<String, dynamic>.from(data);
  return switch (k) {
    'weather' => _WeatherCard(d),
    'restaurant' || 'place' || 'places' => _PlacesCard(d),
    'news' => _NewsCard(d),
    'steps' => _StepsCard(d),
    'callout' => _CalloutCard(d),
    'chart' || 'bar' => _BarChartCard(d),
    'link' => _LinkCard(d),
    _ => null,
  };
}

const _kKinds = {'weather', 'restaurant', 'place', 'places', 'news', 'steps', 'callout', 'chart', 'bar', 'link'};

/// 模型写的 JSON 常见三种小毛病: HTML 实体 (`&quot;`)、尾逗号、全角引号当分隔符。
/// 先按原文解析, 失败再修一遍; 还不行返回 null。
Object? _decodeLenient(String body) {
  Object? tryDecode(String s) {
    try {
      return jsonDecode(s);
    } catch (_) {
      return null;
    }
  }

  final raw = body.trim();
  final first = tryDecode(raw);
  if (first != null) return first;
  var s = raw
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  /* 只取最外层 {...}: 前后多了说明文字或注释行 */
  final a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.substring(a, b + 1);
  s = s.replaceAllMapped(RegExp(r',\s*([}\]])'), (m) => m[1]!);
  return tryDecode(s) ?? tryDecode(s.replaceAll('“', '"').replaceAll('”', '"'));
}

String _s(Object? v) => v == null ? '' : '$v'.trim();
double? _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v.replaceAll(RegExp(r'[^\d.+-]'), ''));
  return null;
}
List<Map<String, dynamic>> _items(Object? v) =>
    v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : const [];

Future<void> _open(String url) async {
  final u = Uri.tryParse(url.trim());
  if (u == null || !(u.scheme == 'http' || u.scheme == 'https' || u.scheme == 'geo' || u.scheme == 'tel')) return;
  try {
    await launchUrl(u, mode: LaunchMode.externalApplication);
  } catch (_) {/* 没有能打开的 App */}
}

/// 卡片外壳: 细描边 + 大圆角, 跟搜索来源卡 / 产物卡同一套。
class _Shell extends StatelessWidget {
  const _Shell({required this.child, this.title, this.icon, this.padding = const EdgeInsets.fromLTRB(14, 12, 14, 12)});
  final Widget child;
  final String? title;
  final IconData? icon;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(borderRadius: NeoxRadius.inputR, border: Border.all(color: scheme.outlineVariant)),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (title != null && title!.isNotEmpty) ...[
              Row(children: [
                if (icon != null) ...[Icon(icon, size: 16, color: scheme.onSurfaceVariant), const SizedBox(width: 6)],
                Expanded(
                  child: Text(title!, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
                ),
              ]),
              const SizedBox(height: 8),
            ],
            child,
          ],
        ),
      ),
    );
  }
}

class _PendingCard extends StatelessWidget {
  const _PendingCard();
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _Shell(
      child: Row(children: [
        SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.6, color: scheme.onSurfaceVariant)),
        const SizedBox(width: 10),
        Text(tr('卡片生成中…'), style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
      ]),
    );
  }
}

/* ── 天气 ──  {location, current:{temp,feels_like,text,wind,humidity}, forecast:[{day,high,low,text,rain_chance}]} */
class _WeatherCard extends StatelessWidget {
  const _WeatherCard(this.d);
  final Map<String, dynamic> d;

  IconData _icon(String t) {
    if (RegExp(r'雷|thunder').hasMatch(t)) return Icons.thunderstorm_rounded;
    if (RegExp(r'雪|snow').hasMatch(t)) return Icons.ac_unit_rounded;
    if (RegExp(r'雨|rain|shower').hasMatch(t)) return Icons.water_drop_rounded;
    if (RegExp(r'阴|云|cloud|overcast').hasMatch(t)) return Icons.cloud_rounded;
    if (RegExp(r'雾|霾|fog|haze|mist').hasMatch(t)) return Icons.foggy;
    return Icons.wb_sunny_rounded;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final cur = d['current'] is Map ? Map<String, dynamic>.from(d['current'] as Map) : const <String, dynamic>{};
    final temp = _num(cur['temp']);
    final text = _s(cur['text']);
    final forecast = _items(d['forecast']).take(5).toList();
    final meta = [
      if (_num(cur['feels_like']) != null) tr('体感 ${_num(cur['feels_like'])!.round()}°'),
      if (_s(cur['humidity']).isNotEmpty) tr('湿度 ${_s(cur['humidity']).replaceAll('%', '')}%'),
      if (_s(cur['wind']).isNotEmpty) _s(cur['wind']),
    ];
    return _Shell(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(_icon(text), size: 38, color: scheme.primary),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_s(d['location']).isEmpty ? tr('天气') : _s(d['location']),
                  style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
              Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                if (temp != null)
                  Text('${temp.round()}°', style: TextStyle(fontSize: 34, height: 1.1, fontWeight: FontWeight.w300, color: scheme.onSurface)),
                const SizedBox(width: 8),
                Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Text(text, style: TextStyle(fontSize: 15, color: scheme.onSurface)),
                ),
              ]),
            ]),
          ),
        ]),
        if (meta.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(meta.join(' · '), style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
        ],
        if (forecast.isNotEmpty) ...[
          const SizedBox(height: 10),
          Divider(height: 1, color: scheme.outlineVariant.withValues(alpha: 0.6)),
          const SizedBox(height: 8),
          for (final f in forecast)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(children: [
                /* 92: 「Thu Oct 8」「10月7日 明天」一行放得下; 52 时英文日期折成两行 */
                SizedBox(
                    width: 92,
                    child: Text(_s(f['day']),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: scheme.onSurface))),
                Icon(_icon(_s(f['text'])), size: 16, color: scheme.onSurfaceVariant),
                const SizedBox(width: 6),
                Expanded(child: Text(_s(f['text']), maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant))),
                if (_num(f['rain_chance']) != null && _num(f['rain_chance'])! > 0)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Text('${_num(f['rain_chance'])!.round()}%', style: TextStyle(fontSize: 12, color: scheme.primary)),
                  ),
                Text(
                  [if (_num(f['low']) != null) '${_num(f['low'])!.round()}°', if (_num(f['high']) != null) '${_num(f['high'])!.round()}°'].join(' / '),
                  style: TextStyle(fontSize: 13.5, fontFeatures: const [FontFeature.tabularFigures()], color: scheme.onSurface),
                ),
              ]),
            ),
        ],
      ]),
    );
  }
}

/* ── 店铺 / 地点 ──  {title?, items:[{name,cuisine,priceRange,rating,address,phone,highlight,mapUrl}]} */
class _PlacesCard extends StatelessWidget {
  const _PlacesCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final items = _items(d['items']);
    if (items.isEmpty) return const SizedBox.shrink();
    return _Shell(
      title: _s(d['title']).isEmpty ? tr('${items.length} 个地点') : _s(d['title']),
      icon: Icons.place_rounded,
      padding: const EdgeInsets.fromLTRB(14, 12, 6, 6),
      child: Column(children: [
        for (var i = 0; i < items.length; i++) ...[
          if (i > 0) Divider(height: 1, color: scheme.outlineVariant.withValues(alpha: 0.5)),
          _PlaceRow(items[i]),
        ],
      ]),
    );
  }
}

class _PlaceRow extends StatelessWidget {
  const _PlaceRow(this.p);
  final Map<String, dynamic> p;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final name = _s(p['name']);
    final rating = _num(p['rating']);
    final sub = [_s(p['cuisine']), _s(p['priceRange'])].where((x) => x.isNotEmpty).join(' · ');
    final address = _s(p['address']);
    final mapUrl = _s(p['mapUrl']).isNotEmpty
        ? _s(p['mapUrl'])
        : 'geo:0,0?q=${Uri.encodeComponent([name, address].where((x) => x.isNotEmpty).join(' '))}';
    final phone = _s(p['phone']);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: scheme.onSurface))),
              if (rating != null) ...[
                const SizedBox(width: 6),
                Icon(Icons.star_rounded, size: 15, color: Colors.amber.shade600),
                Text(rating.toStringAsFixed(1), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              ],
            ]),
            if (sub.isNotEmpty) Text(sub, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
            if (_s(p['highlight']).isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(_s(p['highlight']), maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: scheme.onSurface)),
              ),
            if (address.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(address, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              ),
          ]),
        ),
        if (phone.isNotEmpty)
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: tr('打电话'),
            onPressed: () => _open('tel:$phone'),
            icon: Icon(Icons.call_rounded, size: 19, color: scheme.primary),
          ),
        IconButton(
          visualDensity: VisualDensity.compact,
          tooltip: tr('导航'),
          onPressed: () => _open(mapUrl),
          icon: Icon(Icons.directions_rounded, size: 20, color: scheme.primary),
        ),
      ]),
    );
  }
}

/* ── 新闻 ──  {title?, items:[{title,source,timestamp,summary,url,tag}]} */
class _NewsCard extends StatelessWidget {
  const _NewsCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final items = _items(d['items']);
    if (items.isEmpty) return const SizedBox.shrink();
    return _Shell(
      title: _s(d['title']).isEmpty ? tr('新闻') : _s(d['title']),
      icon: Icons.newspaper_rounded,
      child: Column(children: [
        for (var i = 0; i < items.length; i++) ...[
          if (i > 0) Divider(height: 14, color: scheme.outlineVariant.withValues(alpha: 0.5)),
          InkWell(
            onTap: _s(items[i]['url']).isEmpty ? null : () => _open(_s(items[i]['url'])),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_s(items[i]['title']), maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14.5, height: 1.3, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              if (_s(items[i]['summary']).isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(_s(items[i]['summary']), maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, height: 1.35, color: scheme.onSurfaceVariant)),
                ),
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(
                  [_s(items[i]['tag']), _s(items[i]['source']), _s(items[i]['timestamp'])].where((x) => x.isNotEmpty).join(' · '),
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                ),
              ),
            ]),
          ),
        ],
      ]),
    );
  }
}

/* ── 步骤 ──  {title?, items:[{title,desc,status:"done|doing|todo"}]} */
class _StepsCard extends StatelessWidget {
  const _StepsCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final items = _items(d['items']);
    if (items.isEmpty) return const SizedBox.shrink();
    return _Shell(
      title: _s(d['title']),
      icon: Icons.format_list_numbered_rounded,
      child: Column(children: [
        for (var i = 0; i < items.length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 22, height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _s(items[i]['status']) == 'done' ? scheme.primary : scheme.surfaceContainerHigh,
                ),
                child: _s(items[i]['status']) == 'done'
                    ? Icon(Icons.check_rounded, size: 14, color: scheme.onPrimary)
                    : Text('${i + 1}', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_s(items[i]['title']), style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500, color: scheme.onSurface)),
                  if (_s(items[i]['desc']).isNotEmpty)
                    Text(_s(items[i]['desc']), style: TextStyle(fontSize: 13, height: 1.35, color: scheme.onSurfaceVariant)),
                ]),
              ),
            ]),
          ),
      ]),
    );
  }
}

/* ── 提示 ──  {tone:"info|good|warn|bad", title?, text} */
class _CalloutCard extends StatelessWidget {
  const _CalloutCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = _s(d['tone']);
    final (IconData icon, Color c) = switch (tone) {
      'good' => (Icons.check_circle_rounded, scheme.okInk),
      'warn' => (Icons.warning_amber_rounded, scheme.warnInk),
      'bad' => (Icons.error_rounded, scheme.error),
      _ => (Icons.info_rounded, scheme.primary),
    };
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.08), borderRadius: NeoxRadius.inputR),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 18, color: c),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (_s(d['title']).isNotEmpty)
              Text(_s(d['title']), style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface)),
            Text(_s(d['text']), style: TextStyle(fontSize: 14, height: 1.4, color: scheme.onSurface)),
          ]),
        ),
      ]),
    );
  }
}

/* ── 图表 ──  {title, type, series:[{label,value}], unit?} —— 手机上统一画成横条, 一眼看比例 */
class _BarChartCard extends StatelessWidget {
  const _BarChartCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final series = _items(d['series']).where((s) => _num(s['value']) != null).toList();
    if (series.isEmpty) return const SizedBox.shrink();
    final max = series.map((s) => _num(s['value'])!.abs()).fold<double>(0, (a, b) => b > a ? b : a);
    final unit = _s(d['unit']);
    String fmt(double v) => v == v.roundToDouble() ? v.round().toString() : v.toStringAsFixed(1);
    return _Shell(
      title: _s(d['title']),
      icon: Icons.bar_chart_rounded,
      child: Column(children: [
        for (final s in series)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(children: [
              SizedBox(width: 84, child: Text(_s(s['label']), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, color: scheme.onSurface))),
              Expanded(
                child: LayoutBuilder(builder: (_, c) {
                  final frac = max <= 0 ? 0.0 : (_num(s['value'])!.abs() / max).clamp(0.0, 1.0);
                  return Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      height: 10,
                      width: (c.maxWidth * frac).clamp(2.0, c.maxWidth),
                      decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.75), borderRadius: NeoxRadius.barR),
                    ),
                  );
                }),
              ),
              const SizedBox(width: 8),
              Text('${fmt(_num(s['value'])!)}$unit',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, fontFeatures: const [FontFeature.tabularFigures()], color: scheme.onSurface)),
            ]),
          ),
      ]),
    );
  }
}

/* ── 链接 ──  {url, title?, description?} */
class _LinkCard extends StatelessWidget {
  const _LinkCard(this.d);
  final Map<String, dynamic> d;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = _s(d['url']);
    if (url.isEmpty) return const SizedBox.shrink();
    final host = Uri.tryParse(url)?.host.replaceFirst('www.', '') ?? url;
    return InkWell(
      onTap: () => _open(url),
      borderRadius: NeoxRadius.inputR,
      child: _Shell(
        child: Row(children: [
          Icon(Icons.link_rounded, size: 20, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_s(d['title']).isEmpty ? host : _s(d['title']), maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              if (_s(d['description']).isNotEmpty)
                Text(_s(d['description']), maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
              Text(host, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
            ]),
          ),
          Icon(Icons.open_in_new_rounded, size: 16, color: scheme.onSurfaceVariant),
        ]),
      ),
    );
  }
}
