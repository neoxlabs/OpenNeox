/// update_page.dart — 应用内更新的独立页面.
///
/// 2026-09-17 用户: 「内部 ota 更新没有新建页面, 而且在输入框上方很占空间」。
/// 原来只有首页顶部那条细横幅: 更新这件事一年碰几次, 却天天占着首屏一行,
/// 而真正需要的信息 (多大、下到哪了、多快、装不上怎么办) 一行根本放不下。
///
/// 现在: 首页不再常驻横幅, 入口收在 设置 → 关于 → Neox Mobile (有新版时带一个点),
/// 点进来是这一页, 下载进度/速度/剩余时间/失败原因都在这里说清楚。
library;

import 'dart:async' show unawaited;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/startup/apk_updater.dart';
import '../../core/startup/app_update.dart';
import '../../core/startup/changelog.dart';
import '../../shared/clay/clay.dart';
import '../timeline/widgets/markdown_view.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class UpdatePage extends ConsumerStatefulWidget {
  const UpdatePage({super.key});

  @override
  ConsumerState<UpdatePage> createState() => _UpdatePageState();
}

class _UpdatePageState extends ConsumerState<UpdatePage> {
  @override
  void initState() {
    super.initState();
    /* 每次进入这个页面都按窗口重检一次 (2026-09-22「app 端怎么更新 404??」)。
     * appUpdateStatusProvider 的缓存不会自己过期 (首页强更闸门常驻 watch 它),
     * 不主动 invalidate 就可能一直拿那份过期清单 —— 里面的下载直链指向的 APK
     * 早被发包脚本清掉了, 点更新就是 404。见 AppUpdateService.isStale。
     *
     * 必须等首帧之后: ref.invalidate 要访问 ProviderScope (InheritedWidget),
     * 在 initState 里调会抛 "dependOnInheritedWidgetOfExactType ... was called
     * before initState() completed"。 */
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (ref.read(appUpdateServiceProvider).isStale) {
        ref.invalidate(appUpdateStatusProvider);
      }
    });
  }

  /// 拉坯五帧: 一团泥 → 拉起四分之一 → 一半 → 快收口 → 烧好的瓶 (assets/clay/v5/wheel-0..4)
  static String _wheelFrame({required bool hasUpdate, required ApkUpdateState upd}) {
    if (!hasUpdate || upd.phase == ApkUpdatePhase.readyToInstall) return 'wheel-4';
    if (!upd.busy) return 'wheel-0';
    final p = upd.progress ?? 0;
    return p < 0.25 ? 'wheel-1' : p < 0.55 ? 'wheel-2' : p < 0.9 ? 'wheel-3' : 'wheel-4';
  }

  /// 陶土稿 v5「系统更新」: 一块泥板 —— 拉坯插画 (跟着下载进度一帧帧拉起来), 版本 / 大小,
  /// 进度条 + 百分比 · 速度 · 还要几秒, 两颗按钮; 下面「这一版有什么」+ 完整更新日志。
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final statusAsync = ref.watch(appUpdateStatusProvider);
    final status = statusAsync.valueOrNull;
    final upd = ref.watch(apkUpdaterProvider);
    final has = status?.hasUpdate == true;
    final ready = upd.phase == ApkUpdatePhase.readyToInstall;
    final updater = ref.read(apkUpdaterProvider.notifier);

    final Widget buttons;
    if (upd.busy) {
      buttons = Row(children: [
        Expanded(child: ClayButton(label: tr('取消'), kind: ClayButtonKind.clay, size: ClayButtonSize.large, expand: true, onTap: updater.cancel)),
        const SizedBox(width: 12),
        /* 后台下载: 回到上一页, 下载照常走, 好了会弹安装 */
        Expanded(child: ClayButton.ink(label: tr('后台下载'), size: ClayButtonSize.large, expand: true, onTap: () => Navigator.of(context).maybePop())),
      ]);
    } else if (has) {
      buttons = ClayButton.ink(
        label: ready ? tr('安装') : upd.error != null ? tr('重试') : tr('下载并安装'),
        size: ClayButtonSize.large,
        expand: true,
        onTap: () => ready
            ? unawaited(updater.install())
            : unawaited(updater.downloadAndInstall(url: status!.downloadUrl!, version: status.latestVersion!)),
      );
    } else {
      buttons = ClayButton(
        label: statusAsync.isLoading ? tr('正在检查') : tr('重新检查'),
        kind: ClayButtonKind.clay,
        size: ClayButtonSize.large,
        expand: true,
        busy: statusAsync.isLoading,
        onTap: () {
          ref.invalidate(appUpdateStatusProvider);
          ref.invalidate(changelogProvider);
        },
      );
    }

    return SettingsFrame(
      title: tr('系统更新'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: ClaySlab(
              radius: 22,
              padding: EdgeInsets.zero,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    height: 210,
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 420),
                      child: ClayArt(_wheelFrame(hasUpdate: has, upd: upd), key: ValueKey(_wheelFrame(hasUpdate: has, upd: upd)), fit: BoxFit.contain),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          statusAsync.isLoading && status == null
                              ? tr('正在检查')
                              : has
                                  ? 'Neox ${status!.latestVersion}'
                                  : tr('已是最新'),
                          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: c.ink, letterSpacing: -0.3),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          [
                            if (has) '${status!.currentVersion} → ${status.latestVersion}' else if (status != null) 'Neox ${status.currentVersion}',
                            if (has && status!.sizeLabel.isNotEmpty) status.sizeLabel,
                          ].join(' · '),
                          style: TextStyle(fontSize: 13.5, color: c.grey),
                        ),
                        /* 下载中: 进度条 + 百分比 · 速度 · 剩余 */
                        if (upd.busy) ...[
                          const SizedBox(height: 16),
                          ClayProgress(value: upd.progress, height: 8),
                          const SizedBox(height: 8),
                          Text(
                            [
                              upd.progressLabel,
                              if (upd.speedLabel.isNotEmpty) upd.speedLabel,
                              if (upd.etaLabel.isNotEmpty) upd.etaLabel,
                            ].join(' · '),
                            style: TextStyle(fontSize: 13, color: c.grey),
                          ),
                        ],
                        if (!upd.busy && upd.error != null) ...[
                          const SizedBox(height: 12),
                          Text(upd.error!, style: TextStyle(fontSize: 13, color: c.redInk, height: 1.45)),
                        ],
                        const SizedBox(height: 18),
                        buttons,
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          /* 更新日志 —— 每版都写了详细日志 (2026-09-18 用户: 「做好显示更新的日志!changelog!」) */
          const _ChangelogSection(),
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  更新日志
// ════════════════════════════════════════════════════════════════
/// 版本日志列表 —— 最新那条默认展开, 其余点开.
///
/// 为什么不是"全部展开": 一条日志是十几行 (修复 N 条 + 改动 N 条), 三条就滑不完。
/// 人打开这一页想知道的是"这次更新给我什么", 那就是最新这一条; 往前翻是次要需求。
///
/// 正文走跟 timeline 同一个 MarkdownView —— 服务端写的就是 markdown (带编号列表、
/// 粗体), 自己再拼一套渲染就会两处不一致。
class _ChangelogSection extends ConsumerStatefulWidget {
  const _ChangelogSection();

  @override
  ConsumerState<_ChangelogSection> createState() => _ChangelogSectionState();
}

class _ChangelogSectionState extends ConsumerState<_ChangelogSection> {
  /// 「完整更新日志 ›」点开后才列出更早的版本
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final async = ref.watch(changelogProvider);
    final entries = async.valueOrNull ?? const <ChangelogEntry>[];

    if (async.isLoading) {
      return const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: ClaySpinner(size: 18)));
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 0, 10),
            child: Text(tr('这一版有什么'), style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink)),
          ),
          if (entries.isEmpty)
            /* 读不到就说读不到 —— 不装作"这版没有改动" */
            Text(tr('暂时读不到更新日志，联网后再试。'), style: TextStyle(fontSize: 13, color: c.grey))
          else ...[
            for (var i = 0; i < (_all ? entries.length : 1); i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _ChangelogCard(entry: entries[i], initiallyOpen: i == 0),
              ),
            if (entries.length > 1)
              Center(
                child: GestureDetector(
                  onTap: () => setState(() => _all = !_all),
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: Text(_all ? tr('收起') : tr('完整更新日志 ›'), style: TextStyle(fontSize: 13.5, color: c.grey)),
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _ChangelogCard extends StatefulWidget {
  const _ChangelogCard({required this.entry, required this.initiallyOpen});

  final ChangelogEntry entry;
  final bool initiallyOpen;

  @override
  State<_ChangelogCard> createState() => _ChangelogCardState();
}

class _ChangelogCardState extends State<_ChangelogCard> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final e = widget.entry;
    final date = e.publishedAt;

    return ClaySlab(
      radius: 18,
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            borderRadius: BorderRadius.circular(18),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
              child: Row(
                children: [
                  /* 版本号小签 —— 一列卡片里它是唯一的锚点 */
                  ClayChip(label: e.version, dense: true),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      /* 标题里 "Neox 3.4.0 — " 这段前缀去掉: 版本号签已经说了 */
                      _shortTitle(e),
                      maxLines: _open ? 3 : 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: c.ink, height: 1.35),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 20, color: c.faint),
                ],
              ),
            ),
          ),
          if (_open) ...[
            Container(height: 0.6, color: c.hairline),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (date != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}',
                        style: TextStyle(fontSize: 12, color: c.grey),
                      ),
                    ),
                  MarkdownView(data: e.bodyMd),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 去掉标题里的 "Neox 3.4.0 — " 前缀 (版本徽标已经写了).
  String _shortTitle(ChangelogEntry e) {
    final t = e.title;
    for (final dash in const [' — ', ' – ', ' - ']) {
      final i = t.indexOf(dash);
      if (i > 0 && t.substring(0, i).contains(e.version)) {
        return t.substring(i + dash.length).trim();
      }
    }
    return t;
  }
}
