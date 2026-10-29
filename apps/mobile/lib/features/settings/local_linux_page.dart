/// 设置 → 工具包 (2026-10-12): 手机里的 Linux (「完全体」), 对用户只叫「工具包」。
///
/// 用户: 「下载工具包就叫工具包, 给搞成什么 git 专业名词, 普通用户是不明白的」「Java 不支持就不支持, 别写在这上」。
/// 所以这一页只说能干什么, 不出现 Python / Node.js / git 这些词; 做不到的不列。
/// 老用户的工具包缺写代码那部分 (3.10.18 之前装的没有 Node.js) → 一行「有更新」点一下补上。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n/tr.dart';
import '../../core/local_agent/linux_env.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_primary_button.dart';
import 'settings_ui.dart';

/// 下载一次大概多大 (实测装完约 200MB)
const kLocalLinuxSizeLabel = '约 200MB';

class LocalLinuxPage extends ConsumerWidget {
  const LocalLinuxPage({super.key});

  static const _m = EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(linuxStatusProvider).valueOrNull ?? LinuxStatus.none;
    final scheme = Theme.of(context).colorScheme;
    final mb = (st.bytes / 1024 / 1024).round();
    Future<void> install() async {
      await LinuxEnv.install();
      ref.invalidate(linuxStatusProvider);
    }

    /* 老工具包缺写代码那部分 (Node.js) —— 只说「有更新」 */
    final needsUpdate = st.installed && !st.busy && st.tools.isNotEmpty && !st.has('node');
    Future<void> update() async {
      await LinuxEnv.add(const ['nodejs', 'npm']);
      ref.invalidate(linuxStatusProvider);
    }

    return SettingsFrame(
      title: tr('工具包'),
      subtitle: tr('让 Agent 在手机上干更多活'),
      body: ListView(
        padding: const EdgeInsets.only(top: NeoxSpace.md, bottom: 40),
        children: [
          SettingsGroup(
            margin: _m,
            children: [
              SettingsRow(
                clay: 'i-app',
                title: st.installed ? tr('已下载') : tr('下载工具包'),
                subtitle: !st.supported
                    ? tr('这台手机不支持 (需要 64 位安卓)')
                    : st.installed
                        ? tr('占用约 %s MB').replaceFirst('%s', '$mb')
                        : tr('%s, 只下载一次').replaceFirst('%s', tr(kLocalLinuxSizeLabel)),
                trailing: st.installed ? Icon(Icons.check_circle, color: scheme.primary, size: 20) : null,
              ),
              if (needsUpdate)
                SettingsRow(
                  title: tr('工具包有更新'),
                  subtitle: tr('加上写代码、跑程序的工具 · 约 80MB'),
                  trailing: TextButton(onPressed: update, child: Text(tr('更新'))),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, 0, NeoxSpace.xl + 4, NeoxSpace.lg),
            child: Text(
              tr('下载后, Agent 能直接在手机上处理表格数据、画图表、转换 PDF / 图片 / 音视频格式, 还能写代码、跑程序 —— 编码也不用连电脑。'),
              style: TextStyle(fontSize: 13.5, height: 1.6, color: scheme.onSurfaceVariant),
            ),
          ),

          if (st.supported && !st.installed && !st.busy)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl),
              child: NeoxPrimaryButton(
                label: st.phase == 'error'
                    ? tr('重试')
                    : tr('下载 (%s)').replaceFirst('%s', tr(kLocalLinuxSizeLabel)),
                onPressed: install,
              ),
            ),

          if (st.busy || st.phase == 'error') ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.lg, NeoxSpace.xl, NeoxSpace.sm),
              child: Row(children: [
                Expanded(
                  child: Text(
                    switch (st.phase) {
                      'downloading' => tr('正在下载'),
                      'extracting' => tr('正在解压'),
                      'packages' => tr('正在安装'),
                      _ => tr('出错了: %s').replaceFirst('%s', st.error ?? ''),
                    },
                    style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: st.phase == 'error' ? scheme.error : null),
                  ),
                ),
                if (st.busy) Text('${st.percent}%', style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
              ]),
            ),
            if (st.busy)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl),
                child: LinearProgressIndicator(value: st.percent > 0 ? st.percent / 100 : null, minHeight: 4, borderRadius: NeoxRadius.pillR),
              ),
            if (st.busy)
              Padding(
                padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, NeoxSpace.md, NeoxSpace.xl + 4, 0),
                child: Text(tr('装的时候别关 Neox, 大概几分钟'), style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              ),
          ],
          if (st.installed)
            SettingsGroup(
              margin: _m.copyWith(top: NeoxSpace.lg),
              children: [
                SettingsRow(
                  leading: Icons.delete_outline,
                  title: tr('删掉工具包'),
                  danger: true,
                  onTap: () async {
                    final ok = await showDialog<bool>(
                      context: context,
                      builder: (c) => AlertDialog(
                        content: Text(tr('删掉后释放约 %s MB。你的文件不受影响, 以后可以再下载。').replaceFirst('%s', '$mb')),
                        actions: [
                          TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
                          TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('删掉'))),
                        ],
                      ),
                    );
                    if (ok == true) {
                      await LinuxEnv.uninstall();
                      ref.invalidate(linuxStatusProvider);
                    }
                  },
                ),
              ],
            ),
          /* 开源许可署名 (GPL / LGPL 要求), 小字放最底下 */
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, NeoxSpace.xl, NeoxSpace.xl + 4, 0),
            child: Text(
              tr('基于开源项目: Alpine Linux、PRoot (GPL-2.0, github.com/termux/proot)、talloc (LGPL-3.0)。'),
              style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
            ),
          ),
        ],
      ),
    );
  }
}
