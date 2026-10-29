/// 切到工作 / 编码时提示一次: 补全本地 Linux (2026-10-12)。
///
/// 用户: 「在切换模式的时候…弹出一个弹窗或者提示, 允许用户可以手动的去补全插件性能, 也跟用户说大概要占 100 兆」。
/// 只提示一次 (点哪个都算看过); 之后从右上角菜单或 设置 → 本地能力 进。
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/i18n/tr.dart';
import '../../../core/local_agent/linux_env.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../../shared/widgets/neox_primary_button.dart';

const _kSeen = 'local_linux_offer_seen_v1';
bool _showing = false;

Future<void> offerLocalLinuxOnce(BuildContext context) async {
  final p = await SharedPreferences.getInstance();
  if (p.getBool(_kSeen) == true) return;
  final st = await LinuxEnv.status();
  if (!st.supported || st.installed || st.busy || !context.mounted) return;
  await p.setBool(_kSeen, true);
  if (!context.mounted) return;
  await offerLocalLinux(context);
}

/// 用到工具包的那一刻再提一次 (发了压缩包 / 音视频这类手机读不了的文件), 说清这次为什么要它。
/// 返回是否开始下载。不支持 / 已装 / 正在装时不弹, 返回 false。
Future<bool> offerLocalLinux(BuildContext context, {String? reason}) async {
  if (_showing) return false;
  final st = await LinuxEnv.status();
  if (!st.supported || st.installed || st.busy || !context.mounted) return false;
  _showing = true;
  final scheme = Theme.of(context).colorScheme;
  final go = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (c) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Image.asset('assets/clay/i-app.webp', height: 56),
            const SizedBox(height: NeoxSpace.md),
            Text(tr('下载工具包'), textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: NeoxSpace.sm),
            Text(
              reason ?? tr('下载一次约 200MB, Agent 就能在手机上处理表格数据、画图表、转换文件格式, 还能写代码、跑程序 —— 不用连电脑。'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14, height: 1.55, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: NeoxSpace.lg),
            NeoxPrimaryButton(label: tr('下载 (%s)').replaceFirst('%s', tr('约 200MB')), onPressed: () => Navigator.pop(c, true)),
            TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('以后再说'))),
          ],
        ),
      ),
    ),
  );
  _showing = false;
  if (go == true) {
    await LinuxEnv.install();
    if (context.mounted) context.push('/settings/local-linux');
  }
  return go == true;
}
