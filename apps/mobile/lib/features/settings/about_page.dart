/// about_page.dart — 设置 → 关于 Neox (陶土稿 v5).
///
///   ← 关于
///        (陶土环 + 钴蓝球)
///          neox
///    3.10.25 · 已是最新
///   ┌ 系统更新 · 更新日志 · 意见反馈 · 给个好评 ┐
///   ┌ 服务条款 · 隐私政策 · 开源许可 ┐
///   ┌ 诊断日志 · 本机标识 · 服务器环境 ┐   ← 出问题时找的, 放最下面
///        © 2026 Neox
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/device/phone_identity.dart';
import '../../core/edition/edition.dart';
import '../../core/errors/crash_log.dart';
import '../../core/neox_constants.dart';
import '../../core/startup/app_update.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_toast.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 意见反馈: 带上本机标识, 我们收到反馈能直接对上是哪台
Future<void> openNeoxFeedback(BuildContext context, WidgetRef ref) async {
  final edition = ref.read(editionProvider);
  /* 没有官方服务 (开源版): 去 GitHub issues, 不带设备标识 */
  if (!edition.officialServices) return openNeoxExternal(context, edition.feedbackUrl);
  final ident = await ref.read(phoneIdentityProvider.future);
  if (!context.mounted) return;
  await openNeoxExternal(context, '$kNeoxFeedbackUrl&p=${Uri.encodeComponent('${defaultTargetPlatform.name} ${ident.deviceId}')}');
}

/// 打开外部链接 (法务页 / 反馈) — 失败给一句能行动的话, 不静默.
Future<void> openNeoxExternal(BuildContext context, String url) async {
  final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
  if (!ok) NeoxToast.show(tr('打不开浏览器，可手动访问 $url'));
}

class AboutPage extends ConsumerStatefulWidget {
  const AboutPage({super.key});

  @override
  ConsumerState<AboutPage> createState() => _AboutPageState();
}

class _AboutPageState extends ConsumerState<AboutPage> {
  bool _checking = false;
  bool _checkedOnce = false;
  String? _version;

  @override
  void initState() {
    super.initState();
    unawaited(PackageInfo.fromPlatform().then((i) {
      if (mounted) setState(() => _version = i.version);
    }));
    /* 进关于页按窗口重检一次: 版本行是用户最先看到"我现在是哪一版"的地方 */
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ref.read(appUpdateServiceProvider).isStale) ref.invalidate(appUpdateStatusProvider);
    });
  }

  Future<void> _check() async {
    if (_checking) return;
    setState(() => _checking = true);
    ref.invalidate(appUpdateStatusProvider);
    try {
      await ref.read(appUpdateStatusProvider.future);
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _checking = false;
      _checkedOnce = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final status = ref.watch(appUpdateStatusProvider).valueOrNull;
    final edition = ref.watch(editionProvider);
    /* 没有官方服务 (开源版): 不查更新、没有我们的条款页 —— 新版本和源码都在 GitHub */
    final official = edition.officialServices;
    final ios = defaultTargetPlatform == TargetPlatform.iOS || !official;
    final hasUpdate = !ios && status != null && status.hasUpdate;
    /* 只有用户主动点过才说「已是最新」—— 冷启动那次没查到可能只是网络不好 */
    final state = _checking
        ? tr('检查中')
        : hasUpdate
            ? tr('${status.latestVersion} 可更新')
            : (_checkedOnce || status != null)
                ? tr('已是最新')
                : '';
    return SettingsFrame(
      title: tr('关于'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          const SizedBox(height: 8),
          const Center(child: _ClayMark(size: 132)),
          const SizedBox(height: 8),
          Center(child: Text(official ? 'neox' : edition.productName, style: TextStyle(fontSize: 34, fontWeight: FontWeight.w600, color: c.ink, letterSpacing: -0.5))),
          const SizedBox(height: 4),
          Center(
            child: Text(
              [_version ?? '', if (state.isNotEmpty) state].where((s) => s.isNotEmpty).join(' · '),
              style: TextStyle(fontSize: 14, color: c.grey),
            ),
          ),
          const SizedBox(height: 16),
          SettingsGroup(
            children: [
              if (!ios)
                SettingsRow(
                  leading: Icons.sync_rounded,
                  title: tr('系统更新'),
                  tag: hasUpdate ? tr('${status.latestVersion} 可更新') : null,
                  tagColor: c.cobalt,
                  trailing: _checking ? const ClaySpinner(size: 14) : (hasUpdate ? null : Text(state, style: TextStyle(fontSize: 13, color: c.grey))),
                  showChevron: true,
                  onTap: () => hasUpdate ? context.push('/update') : unawaited(_check()),
                ),
              /* 更新日志就在更新页里 (每版的说明从发版清单来) */
              if (!ios)
                SettingsRow(
                  leading: Icons.article_outlined,
                  title: tr('更新日志'),
                  showChevron: true,
                  onTap: () => context.push('/update'),
                ),
              if (!official)
                SettingsRow(
                  leading: Icons.code_rounded,
                  title: tr('新版本与源码'),
                  tag: 'GitHub',
                  showChevron: true,
                  onTap: () => openNeoxExternal(context, 'https://github.com/neoxlabs/OpenNeox/releases'),
                ),
              SettingsRow(
                leading: Icons.chat_bubble_outline_rounded,
                title: tr('意见反馈'),
                showChevron: true,
                onTap: () => openNeoxFeedback(context, ref),
              ),
              /* 稿里还有「给个好评」: 安卓包不走应用商店, 没有能评的地方, 不放一个点了没反应的入口 */
            ],
          ),
          /* 法务入口 —— Apple 与 Google Play 对有账号体系的 app 都硬性要求隐私政策可达 */
          SettingsGroup(
            children: [
              if (official) ...[
                SettingsRow(
                  leading: Icons.description_outlined,
                  title: tr('服务条款'),
                  showChevron: true,
                  onTap: () => openNeoxExternal(context, kNeoxTermsOfServiceUrl),
                ),
                SettingsRow(
                  leading: Icons.privacy_tip_outlined,
                  title: tr('隐私政策'),
                  showChevron: true,
                  onTap: () => openNeoxExternal(context, kNeoxPrivacyPolicyUrl),
                ),
              ],
              SettingsRow(
                leading: Icons.code_rounded,
                title: tr('开源许可'),
                showChevron: true,
                onTap: () => showLicensePage(context: context, applicationName: edition.productName, applicationVersion: _version),
              ),
            ],
          ),
          /* 出问题时才找的: 诊断日志 / 本机标识 / 连的哪个后端 (开源版不连我们的后端, 不显示这一行) */
          SettingsGroup(
            title: tr('排查问题'),
            children: [const _CrashLogRow(), const _DeviceIdRow(), if (official) const _ServerEnvRow()],
          ),
          const SizedBox(height: 16),
          Center(child: Text('© ${DateTime.now().year} ${official ? 'Neox' : 'Neox Labs · AGPL-3.0'}', style: TextStyle(fontSize: 12.5, color: c.faint))),
        ],
      ),
    );
  }
}

/// 品牌标
class _ClayMark extends StatelessWidget {
  const _ClayMark({required this.size});
  final double size;

  /// 用全端同一张新标 (珍珠白环 + 钴蓝球, 来自桌面 brand/mark-ring), 不自己画
  @override
  Widget build(BuildContext context) =>
      Image.asset('assets/brand/mark-clay.png', width: size, height: size, filterQuality: FilterQuality.medium);
}

class _CrashLogRow extends StatelessWidget {
  const _CrashLogRow();

  @override
  Widget build(BuildContext context) => SettingsRow(
        leading: Icons.monitor_heart_outlined,
        title: tr('诊断日志'),
        showChevron: true,
        onTap: () => _showCrashLogSheet(context),
      );
}

class _DeviceIdRow extends ConsumerWidget {
  const _DeviceIdRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ident = ref.watch(phoneIdentityProvider).valueOrNull;
    return SettingsRow(
      leading: Icons.smartphone_rounded,
      title: tr('本机标识'),
      subtitle: ident?.deviceId ?? tr('加载中'),
      /* 点一下复制 —— 这串 id 存在的意义就是出问题时报给我们 */
      onTap: ident == null
          ? null
          : () {
              Clipboard.setData(ClipboardData(text: ident.deviceId));
              NeoxToast.show(tr('本机标识已复制'));
            },
    );
  }
}

/// 当前包连的后端 —— 判据是跟生产常量比值, 不是猜域名 (生产域名本身就叫 neox-dev.com)
class _ServerEnvRow extends StatelessWidget {
  const _ServerEnvRow();

  @override
  Widget build(BuildContext context) {
    final host = Uri.tryParse(kNeoxCloudBaseUrl)?.host ?? kNeoxCloudBaseUrl;
    final isProd = kIsProductionApiBase;
    return SettingsRow(
      leading: isProd ? Icons.dns_outlined : Icons.warning_amber_rounded,
      title: tr('服务器环境'),
      subtitle: isProd ? host : tr('$host · 非生产环境'),
      danger: !isProd,
    );
  }
}

void _showCrashLogSheet(BuildContext context) {
  showClaySheet<void>(
    context,
    scrollable: false,
    builder: (ctx) => SizedBox(
      height: MediaQuery.sizeOf(ctx).height * 0.7,
      child: FutureBuilder<String?>(
        future: CrashLog.read(),
        builder: (ctx, snap) {
          final c = ClayInk.of(ctx);
          final log = snap.data;
          return Column(
            children: [
              ClaySheetHeader(
                title: tr('诊断日志'),
                trailing: log == null
                    ? null
                    : Row(mainAxisSize: MainAxisSize.min, children: [
                        ClayRoundButton(
                          icon: Icons.copy_rounded,
                          flat: true,
                          size: 36,
                          tooltip: tr('复制全部'),
                          onTap: () {
                            Clipboard.setData(ClipboardData(text: log));
                            NeoxToast.show(tr('已复制到剪贴板'));
                          },
                        ),
                        ClayRoundButton(
                          icon: Icons.delete_outline_rounded,
                          flat: true,
                          size: 36,
                          tooltip: tr('清空'),
                          onTap: () async {
                            await CrashLog.clear();
                            if (ctx.mounted) Navigator.pop(ctx);
                          },
                        ),
                      ]),
              ),
              Expanded(
                child: snap.connectionState != ConnectionState.done
                    ? const Center(child: ClaySpinner(size: 18))
                    : log == null
                        ? Center(child: Text(tr('没有错误记录 — 一切正常'), style: TextStyle(fontSize: 14, color: c.grey)))
                        : SingleChildScrollView(
                            padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                            child: SelectableText(
                              log,
                              style: TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 11.5, height: 1.4, color: c.ink),
                            ),
                          ),
              ),
            ],
          );
        },
      ),
    ),
  );
}
