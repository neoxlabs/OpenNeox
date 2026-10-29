/// appearance_page.dart — 设置 → 外观 (陶土稿 v5).
///
///   三张小手机: 浅陶 / 夜陶 / 跟随系统 (选中墨色描边 + 右上实心勾)
///   字号: A ●───○───○ A 五档 + 一句预览
///   其他: 首页插画 / 动效
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/clay/clay.dart';
import '../../shared/theme/display_prefs.dart';
import '../../shared/theme/theme_mode_provider.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

String themeModeLabel(ThemeMode m) => switch (m) {
      ThemeMode.light => tr('浅陶'),
      ThemeMode.dark => tr('夜陶'),
      ThemeMode.system => tr('跟随系统'),
    };

class AppearancePage extends ConsumerWidget {
  const AppearancePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final mode = ref.watch(themeModeProvider);
    final display = ref.watch(displayPrefsProvider);
    final ctl = ref.read(displayPrefsProvider.notifier);
    return SettingsFrame(
      title: tr('外观'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Row(
              children: [
                for (final (i, m) in [ThemeMode.light, ThemeMode.dark, ThemeMode.system].indexed) ...[
                  if (i > 0) const SizedBox(width: 10),
                  Expanded(
                    child: _ThemeCard(
                      mode: m,
                      selected: mode == m,
                      onTap: () {
                        HapticFeedback.selectionClick();
                        ref.read(themeModeProvider.notifier).setMode(m);
                      },
                    ),
                  ),
                ],
              ],
            ),
          ),
          SettingsGroup(
            title: tr('字号'),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Text('A', style: TextStyle(fontSize: 13, color: c.grey)),
                        Expanded(
                          child: SliderTheme(
                            data: SliderTheme.of(context).copyWith(
                              activeTrackColor: c.line,
                              inactiveTrackColor: c.line,
                              thumbColor: c.ink,
                              overlayColor: c.ink.withValues(alpha: 0.06),
                              activeTickMarkColor: c.faint,
                              inactiveTickMarkColor: c.faint,
                              trackHeight: 2,
                            ),
                            child: Slider(
                              min: 0,
                              max: (kTextScaleSteps.length - 1).toDouble(),
                              divisions: kTextScaleSteps.length - 1,
                              value: display.textStep.toDouble(),
                              onChanged: (v) {
                                if (v.round() != display.textStep) HapticFeedback.selectionClick();
                                ctl.setTextStep(v.round());
                              },
                            ),
                          ),
                        ),
                        Text('A', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: c.ink)),
                      ],
                    ),
                    const SizedBox(height: 10),
                    /* 预览: 一个头像方块 + 一句问候, 跟着上面的档位变大变小 */
                    ClayWell(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        children: [
                          ClayTile(icon: Icons.person_outline_rounded, size: 36),
                          const SizedBox(width: 12),
                          Flexible(
                            child: ClaySlab(
                              radius: 14,
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                              child: Text(tr('下午好，今天想交付什么？'), style: TextStyle(fontSize: 14.5, color: c.ink)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          SettingsGroup(
            title: tr('其他'),
            children: [
              SettingsRow(
                leading: Icons.image_outlined,
                title: tr('首页插画'),
                trailing: SettingsSwitch(value: display.homeArt, onChanged: ctl.setHomeArt),
                onTap: () => ctl.setHomeArt(!display.homeArt),
              ),
              SettingsRow(
                leading: Icons.auto_awesome_outlined,
                title: tr('动效'),
                trailing: SettingsSwitch(value: display.motion, onChanged: ctl.setMotion),
                onTap: () => ctl.setMotion(!display.motion),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 一张主题卡: 一部小手机的样子 (浅 / 深 / 一半一半) + 名字
class _ThemeCard extends StatelessWidget {
  const _ThemeCard({required this.mode, required this.selected, required this.onTap});
  final ThemeMode mode;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    const light = (bg: Color(0xFFF2EEE8), slab: Color(0xFFFBFAF7), ink: Color(0xFFD9D3C9));
    const dark = (bg: Color(0xFF2A2622), slab: Color(0xFF3A3530), ink: Color(0xFF5A544C));
    Widget phone(({Color bg, Color slab, Color ink}) p) => Container(
          color: p.bg,
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(width: 22, height: 4, decoration: BoxDecoration(color: p.ink, borderRadius: BorderRadius.circular(2))),
              const SizedBox(height: 8),
              Expanded(child: Container(decoration: BoxDecoration(color: p.slab, borderRadius: BorderRadius.circular(6)))),
              const SizedBox(height: 6),
              Row(children: [
                for (var i = 0; i < 3; i++) ...[
                  if (i > 0) const SizedBox(width: 4),
                  Expanded(child: Container(height: 10, decoration: BoxDecoration(color: p.slab, borderRadius: BorderRadius.circular(3)))),
                ],
              ]),
            ],
          ),
        );
    return GestureDetector(
      onTap: onTap,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              color: c.slab,
              border: Border.all(color: selected ? c.ink : Colors.transparent, width: 1.6),
              boxShadow: clayShadow(c, lift: selected ? 0.5 : 1.0),
            ),
            child: Column(
              children: [
                AspectRatio(
                  aspectRatio: 0.62,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: switch (mode) {
                      ThemeMode.light => phone(light),
                      ThemeMode.dark => phone(dark),
                      ThemeMode.system => Row(children: [Expanded(child: phone(light)), Expanded(child: phone(dark))]),
                    },
                  ),
                ),
                const SizedBox(height: 10),
                /* 三张卡一样高: 名字只占一行, 长了缩小 (英文「Follow system」会折行把这一张撑高) */
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(themeModeLabel(mode), maxLines: 1, style: TextStyle(fontSize: 14, fontWeight: selected ? FontWeight.w600 : FontWeight.w500, color: c.ink)),
                ),
              ],
            ),
          ),
          if (selected) const Positioned(right: 8, top: 8, child: ClayCheck(filled: true, size: 22)),
        ],
      ),
    );
  }
}
