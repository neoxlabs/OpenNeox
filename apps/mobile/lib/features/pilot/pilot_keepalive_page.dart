/// pilot_keepalive_page.dart — 设置 → 让 Pilot 一直在线 (2026-10-18)。
///
///   ←  让 Pilot 一直在线
///   [ 还差 3 项 ]                     ← 顶上一条汇总
///   ┌ 系统权限 ─────────────────┐
///   │ 无障碍       已开 / 未开  › │
///   │ 通知使用权   已开 / 未开  › │
///   │ 电池不限制   已开 / 未开  › │
///   │ 自启动       请确认已开   › │
///   │ 后台弹出     请确认已开   › │  (仅小米)
///   └───────────────────────────┘
///   改完回来会自动重新检查。
///
/// 平铺的陶土列表, 跟别的设置页同一套零件 (SettingsFrame / SettingsGroup / SettingsRow)。
/// 状态和跳转都走原生 neox.phone/keepalive; 跳不到对应页时原生回落应用详情页, 这里提示手动路径。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/i18n/tr.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../settings/settings_ui.dart';
import 'pilot_keepalive_guide.dart';

const _ch = MethodChannel(kPilotKeepAliveChannel);

/// 第一次开 Pilot (「先帮你盯什么」点完) 引导一次; 之后从设置页进。
Future<void> promptPilotKeepAliveOnce(BuildContext context) async {
  if (defaultTargetPlatform != TargetPlatform.android) return;
  if (await pilotKeepAliveSeen()) return;
  await markPilotKeepAliveSeen();
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PilotKeepAlivePage()));
}

class PilotKeepAlivePage extends StatefulWidget {
  const PilotKeepAlivePage({super.key});

  @override
  State<PilotKeepAlivePage> createState() => _PilotKeepAlivePageState();
}

class _PilotKeepAlivePageState extends State<PilotKeepAlivePage> with WidgetsBindingObserver {
  PilotKeepAliveStatus? _status;
  String? _busy;

  /// 上次点的那项原生跳不到系统页、回落了应用详情 —— 把手动路径留在页面上
  KeepAliveItem? _fallback;

  static const _m = EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /* 从系统设置开完权限回来, 状态跟着刷新 */
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final st = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    if (!mounted || st == null) return;
    setState(() => _status = PilotKeepAliveStatus.from(st));
  }

  Future<void> _open(KeepAliveItem item) async {
    if (_busy != null) return;
    setState(() {
      _busy = item.id;
      _fallback = null;
    });
    final r = await _ch.invokeMethod<Map>('open', {'item': item.id}).catchError((_) => null);
    if (!mounted) return;
    setState(() {
      _busy = null;
      /* 不能用 SnackBar: 用户在系统设置里转一圈才回来, 5 秒早过了, 提示等于看不到 */
      if (r?['opened'] == 'appDetails' && item.manualPath.isNotEmpty) _fallback = item;
    });
  }

  @override
  Widget build(BuildContext context) {
    final st = _status;
    final c = ClayInk.of(context);
    return SettingsFrame(
      title: tr('让 Pilot 一直在线'),
      subtitle: tr('手机默认会清理后台，这几项开完 Pilot 才会一直在'),
      body: st == null
          ? const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
          : ListView(
              padding: const EdgeInsets.only(top: NeoxSpace.md, bottom: 40),
              children: [
                _summary(st, c),
                if (_fallback != null) _fallbackNote(_fallback!, c),
                SettingsGroup(
                  title: tr('系统权限'),
                  margin: _m,
                  children: [
                    for (final it in st.items)
                      SettingsRow(
                        leading: _iconOf(it.id),
                        title: tr(it.title),
                        /* 一行放不下路径 (各家都十几个字), 这里只写「没开会怎样」;
                           路径等跳不到时由 _fallbackNote 给完整的一句 */
                        subtitle: st.stateOf(it.id) == true ? tr('已开') : tr(it.why),
                        trailing: _stateOf(st, it, c),
                        showChevron: true,
                        onTap: () => _open(it),
                      ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl + 4),
                  child: Text(
                    tr('各家的开关名字不一样，点开没看到这一项就是这台手机没有，可忽略。改完回到 Neox 会自动重新检查。'),
                    style: TextStyle(fontSize: 12.5, height: 1.5, color: c.grey),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _summary(PilotKeepAliveStatus st, ClayInk c) {
    final left = st.detectableCount - st.readyCount;
    final done = left == 0;
    return SettingsSurface(
      margin: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.md),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Row(
        children: [
          ClayTile(icon: done ? Icons.check_rounded : Icons.bolt_rounded, size: 40),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  done ? tr('能查的都开好了') : tr('还差 $left 项'),
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.ink),
                ),
                const SizedBox(height: 3),
                Text(
                  done
                      ? tr('自启动那几项请自己确认一下')
                      : tr('点下面的项直接去系统设置'),
                  style: TextStyle(fontSize: 12.5, color: c.grey),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 跳不到系统页时留在页面上的一句 (用户从系统设置回来还在)
  Widget _fallbackNote(KeepAliveItem it, ClayInk c) => Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, 0, NeoxSpace.xl + 4, NeoxSpace.md),
        child: Text(
          tr('没找到「') + tr(it.title) + tr('」的系统页，已打开应用详情。手动路径：') + tr(it.manualPath),
          style: TextStyle(fontSize: 12.5, height: 1.5, color: c.grey),
        ),
      );

  Widget? _stateOf(PilotKeepAliveStatus st, KeepAliveItem it, ClayInk c) {
    final on = st.stateOf(it.id);
    if (on == true) return Icon(Icons.check_circle, color: c.green, size: 20);
    return SettingsTag(
      label: on == false ? tr('未开') : tr('请确认已开'),
      color: on == false ? c.redInk : c.grey,
    );
  }

  IconData _iconOf(String id) => switch (id) {
        'accessibility' => Icons.touch_app_outlined,
        'notifications' => Icons.mark_email_unread_outlined,
        'battery' => Icons.battery_charging_full_rounded,
        'autostart' => Icons.restart_alt_rounded,
        'background_popup' => Icons.open_in_new_rounded,
        'lockscreen' => Icons.lock_clock_outlined,
        _ => Icons.settings_outlined,
      };
}
