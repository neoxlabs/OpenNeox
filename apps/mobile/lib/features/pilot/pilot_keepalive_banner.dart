/// pilot_keepalive_banner.dart — Pilot 页顶部那条「无障碍被关了」提示 (2026-10-18)。
///
/// 只在安卓、且无障碍真的关着时出现: 一条平的陶土条 + 一个 › , 点了进检查页。
/// 回到前台 (从系统设置回来) 会重新查一次, 开好了自己消失。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n/tr.dart';
import '../../shared/clay/clay.dart';
import 'pilot_keepalive_guide.dart';

const _ch = MethodChannel(kPilotKeepAliveChannel);

class PilotKeepAliveBanner extends StatefulWidget {
  const PilotKeepAliveBanner({super.key});

  @override
  State<PilotKeepAliveBanner> createState() => _PilotKeepAliveBannerState();
}

class _PilotKeepAliveBannerState extends State<PilotKeepAliveBanner> with WidgetsBindingObserver {
  /// null = 还没查到; false 不画
  bool? _accessibility;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final st = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    if (!mounted) return;
    /* 非安卓 (iOS) 拿不到状态, 不显示 */
    setState(() => _accessibility = st == null ? true : st['accessibility'] == true);
  }

  @override
  Widget build(BuildContext context) {
    if (_accessibility != false) return const SizedBox.shrink();
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: GestureDetector(
        onTap: () async {
          await context.push('/pilot/keepalive');
          unawaited(_check());
        },
        child: ClaySlab(
          radius: 16,
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          child: Row(
            children: [
              ClayTile(icon: Icons.touch_app_outlined, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      tr('无障碍被关掉了'),
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      tr('Pilot 现在读不了屏幕，也点不了别的 App'),
                      style: TextStyle(fontSize: 12, color: c.grey),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right_rounded, size: 20, color: c.faint),
            ],
          ),
        ),
      ),
    );
  }
}
