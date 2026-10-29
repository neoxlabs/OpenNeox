/// whats_new.dart — 更新后第一次打开: 「已更新到 3.10.25 · 打开就能说事」(陶土稿 v5).
///
/// 一张底部泥板, 最多三页: 烧好的瓶 + 「已更新到 x」+ 一句大字 + 一句灰字 · 三个点 · 下一个 / 跳过。
/// 内容取这一版更新日志里的前三条 (「**大字**：灰字」或一行一条); 读不到日志就不弹 —— 不编。
/// 新装的不弹 (没有上一个版本); 每个版本只弹一次。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/startup/changelog.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

const _kSeen = 'whats_new_seen_version';

/// 一条日志 → 最多三页 (大字 / 灰字)
List<({String head, String body})> whatsNewPages(String md) {
  final out = <({String head, String body})>[];
  for (final raw in md.split('\n')) {
    final line = raw.replaceFirst(RegExp(r'^\s*(?:[-*•·]|\d+[.、)])\s+'), '').trim();
    if (line.isEmpty || line.startsWith('#')) continue;
    final bold = RegExp(r'^\*\*(.+?)\*\*[:：\s—-]*(.*)$').firstMatch(line);
    if (bold != null) {
      out.add((head: bold.group(1)!.trim(), body: bold.group(2)!.trim()));
    } else {
      final cut = RegExp(r'[：:，,—]').firstMatch(line);
      out.add(cut != null && cut.start > 3 && cut.start < 18
          ? (head: line.substring(0, cut.start).trim(), body: line.substring(cut.end).trim())
          : (head: line.length > 18 ? '${line.substring(0, 17)}…' : line, body: line.length > 18 ? line : ''));
    }
    if (out.length == 3) break;
  }
  return out;
}

/// 首页起来以后调一次
Future<void> maybeShowWhatsNew(BuildContext context, WidgetRef ref) async {
  final prefs = ref.read(sharedPreferencesProvider);
  final now = (await PackageInfo.fromPlatform()).version;
  final seen = prefs.getString(_kSeen);
  if (seen == now) return;
  await prefs.setString(_kSeen, now);
  /* 新装: 没有上一个版本, 不弹 */
  if (seen == null) return;
  List<ChangelogEntry> entries;
  try {
    entries = await ref.read(changelogProvider.future);
  } catch (_) {
    return;
  }
  final entry = entries.where((e) => e.version == now).firstOrNull;
  if (entry == null) return;
  final pages = whatsNewPages(entry.bodyMd);
  if (pages.isEmpty || !context.mounted) return;
  await showClaySheet<void>(context, builder: (_) => _WhatsNewSheet(version: now, pages: pages));
}

class _WhatsNewSheet extends StatefulWidget {
  const _WhatsNewSheet({required this.version, required this.pages});
  final String version;
  final List<({String head, String body})> pages;

  @override
  State<_WhatsNewSheet> createState() => _WhatsNewSheetState();
}

class _WhatsNewSheetState extends State<_WhatsNewSheet> {
  int _i = 0;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final p = widget.pages[_i];
    final last = _i == widget.pages.length - 1;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClayWell(
            radius: 20,
            padding: EdgeInsets.zero,
            child: const SizedBox(height: 200, child: ClayArt('wheel-4', fit: BoxFit.contain)),
          ),
          const SizedBox(height: 18),
          Text(tr('已更新到 ${widget.version}'), style: TextStyle(fontSize: 13.5, color: c.grey)),
          const SizedBox(height: 6),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            child: Column(
              key: ValueKey(_i),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p.head, style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: c.ink, height: 1.3)),
                if (p.body.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(p.body, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, color: c.grey, height: 1.5)),
                ],
              ],
            ),
          ),
          const SizedBox(height: 20),
          if (widget.pages.length > 1)
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var k = 0; k < widget.pages.length; k++)
                  Container(
                    width: 7,
                    height: 7,
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    decoration: BoxDecoration(color: k == _i ? c.ink : c.line, shape: BoxShape.circle),
                  ),
              ],
            ),
          const SizedBox(height: 18),
          ClayButton.ink(
            label: last ? tr('好的') : tr('下一个'),
            size: ClayButtonSize.large,
            expand: true,
            onTap: () => last ? Navigator.pop(context) : setState(() => _i++),
          ),
          if (!last)
            Center(child: ClayButton(label: tr('跳过'), kind: ClayButtonKind.text, onTap: () => Navigator.pop(context))),
        ],
      ),
    );
  }
}
