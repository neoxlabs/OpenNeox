/// biometric_lock_screen.dart — 应用锁 (陶土稿 v5-applock).
///
///        ( 圆环 + 蓝珠 )
///        Neox 已锁定
///        用指纹解锁
///
///          ( 指纹 )        ← 平底圆键, 验证中一圈钴蓝
///
///        用手机密码
///
/// 一进来就自动弹系统验证; 划掉了再点指纹键。系统面板本身就带「用密码」,
/// 底下那行是给找不到入口的人的第二个门。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/clay/clay.dart';
import 'biometric_lock.dart';
import 'package:neox_app/core/i18n/tr.dart';

class BiometricLockScreen extends ConsumerStatefulWidget {
  const BiometricLockScreen({super.key});
  @override
  ConsumerState<BiometricLockScreen> createState() => _BiometricLockScreenState();
}

class _BiometricLockScreenState extends ConsumerState<BiometricLockScreen> {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  Future<void> _unlock() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(biometricLockProvider.notifier).unlock();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Center(
          child: Column(
            children: [
              const Spacer(flex: 3),
              Image.asset('assets/brand/mark-clay.png', width: 132, height: 132, filterQuality: FilterQuality.high),
              const SizedBox(height: 40),
              Text(tr('Neox 已锁定'), style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: c.ink)),
              const SizedBox(height: 10),
              Text(tr('用指纹或面容解锁'), style: TextStyle(fontSize: 16, color: c.grey)),
              const Spacer(flex: 2),
              Semantics(
                button: true,
                label: tr('解锁'),
                child: GestureDetector(
                  onTap: _busy ? null : _unlock,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    width: 96,
                    height: 96,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: c.slab,
                      border: Border.all(color: _busy ? c.cobalt : c.line, width: _busy ? 2 : 1),
                    ),
                    child: Icon(Icons.fingerprint_rounded, size: 46, color: c.ink.withValues(alpha: 0.8)),
                  ),
                ),
              ),
              const Spacer(flex: 2),
              ClayButton(label: tr('用手机密码'), kind: ClayButtonKind.text, onTap: _busy ? null : _unlock),
              const SizedBox(height: 28),
            ],
          ),
        ),
      ),
    );
  }
}
