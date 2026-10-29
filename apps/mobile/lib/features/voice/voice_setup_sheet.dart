/// 点麦克风时本地语音还没装 → 这个弹窗 (2026-09-30 用户: 「不可用就给用户一个弹窗, 做好插画, 做好动画」)。
///
/// 三条路: 下载离线语音 (推荐, 下完直接开始听) / 用系统语音 / 去配云端识别。
/// 下载就在弹窗里进行, 进度条 + 插画下方那排声波跟着动; 下完弹窗自己收起并告诉调用方"可以听了"。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/model_store.dart';
import '../../core/voice/voice_settings.dart';
import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

enum VoiceSetupResult { localReady, useSystem, openedSettings, dismissed }

Future<VoiceSetupResult> showVoiceSetupSheet(BuildContext context) async {
  final r = await showModalBottomSheet<VoiceSetupResult>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _VoiceSetupSheet(),
  );
  return r ?? VoiceSetupResult.dismissed;
}

class _VoiceSetupSheet extends ConsumerStatefulWidget {
  const _VoiceSetupSheet();
  @override
  ConsumerState<_VoiceSetupSheet> createState() => _VoiceSetupSheetState();
}

class _VoiceSetupSheetState extends ConsumerState<_VoiceSetupSheet> with SingleTickerProviderStateMixin {
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(seconds: 3))..repeat();
  bool _withRefine = true;
  bool _started = false;

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  Future<void> _download() async {
    setState(() => _started = true);
    final store = ref.read(modelStoreProvider.notifier);
    await store.download(kAsrStreamingPack);
    if (!mounted) return;
    if (!ref.read(modelStatusProvider(kAsrStreamingPack)).installed) return; // 失败: 留在弹窗里给重试
    if (_withRefine) {
      await store.download(kAsrRefinePack);
      if (!mounted) return;
      /* 定稿模型失败不挡路 —— 没有它只是少了整句校正, 实时识别照样能用 */
    }
    await ref.read(voiceSettingsProvider.notifier).setEngine(VoiceEngine.local);
    if (mounted) Navigator.of(context).pop(VoiceSetupResult.localReady);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final dark = theme.brightness == Brightness.dark;
    final s1 = ref.watch(modelStatusProvider(kAsrStreamingPack));
    final s2 = ref.watch(modelStatusProvider(kAsrRefinePack));
    final totalBytes = kAsrStreamingPack.approxBytes + (_withRefine ? kAsrRefinePack.approxBytes : 0);
    final downloading = s1.downloading || s2.downloading;
    final failed = s1.phase == ModelPhase.failed ? s1.error : null;
    /* 两个包合成一条进度 (按字节), 用户只关心"还要多久" */
    final got = (s1.installed ? kAsrStreamingPack.approxBytes : s1.received) +
        (_withRefine ? (s2.installed ? kAsrRefinePack.approxBytes : s2.received) : 0);
    final progress = totalBytes == 0 ? 0.0 : (got / totalBytes).clamp(0.0, 1.0);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            /* 插画: 轻轻上下浮 + 底下一排声波呼吸; 下载时声波按进度点亮 */
            AnimatedBuilder(
              animation: _anim,
              builder: (context, _) {
                final t = _anim.value * 2 * math.pi;
                return Column(
                  children: [
                    Transform.translate(
                      offset: Offset(0, math.sin(t) * 3),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(NeoxRadius.card + 6),
                        child: AspectRatio(
                          aspectRatio: 3 / 2,
                          child: Image.asset(
                            dark ? 'assets/brand/voice-dark.png' : 'assets/brand/voice-light.png',
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: NeoxSpace.md),
                    SizedBox(
                      height: 18,
                      child: CustomPaint(
                        size: const Size(double.infinity, 18),
                        painter: _BreathingBars(
                          phase: t,
                          lit: downloading || _started ? progress : 1,
                          active: scheme.primary,
                          idle: scheme.outlineVariant,
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: NeoxSpace.md),
            Text(
              tr('离线语音输入'),
              style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: NeoxSpace.xs),
            Text(
              tr('不联网也能用，国行手机也能用。模型下到手机上，不占安装包。'),
              style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant, height: 1.5),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: NeoxSpace.md),
            if (!downloading && !(_started && failed == null))
              CheckboxListTile(
                value: _withRefine,
                onChanged: (v) => setState(() => _withRefine = v ?? true),
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: Text(tr('同时下载整句校正（${formatBytes(kAsrRefinePack.approxBytes)}，更准）')),
              ),
            if (downloading || (_started && failed == null)) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(value: progress == 0 ? null : progress, minHeight: 6),
              ),
              const SizedBox(height: NeoxSpace.xs),
              Text(
                '${formatBytes(got)} / ${formatBytes(totalBytes)}',
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: NeoxSpace.sm),
              TextButton(
                onPressed: () {
                  /* 暂停而不是丢掉: 下次点下载从断点接着下 */
                  final store = ref.read(modelStoreProvider.notifier);
                  store.pause(kAsrStreamingPack);
                  store.pause(kAsrRefinePack);
                  setState(() => _started = false);
                },
                child: Text(tr('暂停')),
              ),
            ] else ...[
              if (failed != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoxSpace.sm),
                  child: Text(failed, style: theme.textTheme.bodySmall?.copyWith(color: scheme.error), textAlign: TextAlign.center),
                ),
              FilledButton(
                onPressed: _download,
                child: Text(failed != null ? tr('重试下载') : tr('下载 · ${formatBytes(totalBytes)}')),
              ),
              const SizedBox(height: NeoxSpace.xs),
              Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: () async {
                        await ref.read(voiceSettingsProvider.notifier).setEngine(VoiceEngine.system);
                        if (context.mounted) Navigator.of(context).pop(VoiceSetupResult.useSystem);
                      },
                      child: Text(tr('用系统语音')),
                    ),
                  ),
                  Expanded(
                    child: TextButton(
                      onPressed: () {
                        /* 先拿 router 再关弹窗: 关掉之后这个 context 就失效了, 再取会跳不过去 */
                        final router = GoRouter.of(context);
                        Navigator.of(context).pop(VoiceSetupResult.openedSettings);
                        router.push('/settings/voice/cloud');
                      },
                      child: Text(tr('用云端识别')),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 一排圆头竖条: 未下载时整体呼吸; 下载中从左往右按进度点亮
class _BreathingBars extends CustomPainter {
  _BreathingBars({required this.phase, required this.lit, required this.active, required this.idle});
  final double phase;
  final double lit;
  final Color active;
  final Color idle;

  @override
  void paint(Canvas canvas, Size size) {
    /* 细条、居中、不铺满 —— 铺满整宽的粗条像一排糖, 不精致 */
    const n = 31;
    const w = 2.0;
    const gap = 4.0;
    final left = (size.width - (n * w + (n - 1) * gap)) / 2;
    final mid = size.height / 2;
    final paint = Paint()..strokeCap = StrokeCap.round..strokeWidth = w;
    for (var i = 0; i < n; i++) {
      final x = left + i * (w + gap) + w / 2;
      /* 中间高两头低, 叠一层沿 x 走的正弦波 */
      final env = math.sin(math.pi * (i + 0.5) / n);
      final wave = 0.55 + 0.45 * math.sin(phase * 2 + i * 0.55);
      final h = math.max(4.0, size.height * env * wave);
      paint.color = (i + 1) / n <= lit ? active : idle;
      canvas.drawLine(Offset(x, mid - h / 2), Offset(x, mid + h / 2), paint);
    }
  }

  @override
  bool shouldRepaint(_BreathingBars old) => old.phase != phase || old.lit != lit;
}
