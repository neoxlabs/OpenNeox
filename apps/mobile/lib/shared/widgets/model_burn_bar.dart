/// model_burn_bar.dart — 额度消耗速度条。
///
/// 桌面端一直有 (TimelineComposer 的 ModelBurnBar), 手机端没有 —— 用户对比后原话:
/// "并且没有显示消耗速度"。
///
/// relativeCost = 该模型烧额度的速度, 以基准模型 = 1.0 计, **已含倍率**。
/// 服务端 buildRelativeCostMap 下发, 跟公开定价页同一个数 —— 两处不一致会被读成
/// "我们在糊弄"。
///
/// ⚠️ 它显示的是**消耗量不是品质**。绿→红容易被读成"绿=好/红=差", 而最强的那个模型
/// 恰恰最费。所以语义标签用"省/快"而不是"好/差", 并且挂在无障碍标签上。
///
/// null / 非正数 = 服务端没给 (BYOK 模型 / 基准缺失) → **不渲染**。
/// 画一条灰色占位会被当成"消耗极低", 那是凭空的误导。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

final _levels = <({double max, String zh})>[
  (max: 0.30, zh: tr('极省')),
  (max: 0.80, zh: tr('省')),
  (max: 2.00, zh: tr('适中')),
  (max: 4.00, zh: tr('较快')),
  (max: double.infinity, zh: tr('很快')),
];

/* 2026-10-09 起 relativeCost 是「显示倍率」: 1× ≈ 每亿 token $20, DeepSeek 0.1×、GPT 3× (原来
 * 以 Sonnet = 1, 其余全挤在 0.0x)。位置用**对数**尺度, 0.08~20 跨两百多倍; 下限 12% 保证
 * 最省的模型也有可见的一小段。 */
const _burnMin = 0.08;
const _burnMax = 20.0;

/// 0.11× / 2.8× / 16× —— 跟桌面端 formatBurn 一个规则
String formatBurn(double rc) {
  if (rc >= 10) return '${rc.round()}×';
  if (rc >= 1) return '${(rc * 10).round() / 10}×';
  return '${(rc * 100).round() / 100}×';
}

double burnFraction(double rc) {
  final clamped = rc.clamp(_burnMin, _burnMax);
  final t = (math.log(clamped / _burnMin)) / (math.log(_burnMax / _burnMin));
  return t.clamp(0.12, 1.0);
}

String burnLevelLabel(double rc) {
  for (final l in _levels) {
    if (rc <= l.max) return l.zh;
  }
  return _levels.last.zh;
}

class ModelBurnBar extends StatelessWidget {
  const ModelBurnBar({super.key, required this.relativeCost, this.width = 44});

  final double? relativeCost;
  final double width;

  @override
  Widget build(BuildContext context) {
    final rc = relativeCost;
    if (rc == null || !rc.isFinite || rc <= 0) return const SizedBox.shrink();
    final f = burnFraction(rc);
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: tr('额度消耗 ${formatBurn(rc)}，${burnLevelLabel(rc)}'),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(
          formatBurn(rc),
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            fontFeatures: const [FontFeature.tabularFigures()],
            color: scheme.onSurface.withValues(alpha: 0.60),
          ),
        ),
        const SizedBox(width: 5),
        Container(
        width: width,
        height: 4,
        decoration: BoxDecoration(
          color: scheme.onSurface.withValues(alpha: 0.10),
          borderRadius: NeoxRadius.barR,
        ),
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: f,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: NeoxRadius.barR,
              /* 渐变按**整条宽度**铺开再裁切 —— 填到哪里颜色就正好是那个位置该有的,
               * 不会出现"短条也是红色"。跟桌面端 background-size 那招同一个用意。 */
              gradient: LinearGradient(
                colors: const [
                  Color(0xFF4ADE80),
                  Color(0xFFFACC15),
                  Color(0xFFF87171),
                ],
                stops: <double>[0, 0.55 / f, 1 / f]
                    .map((e) => e.clamp(0.0, 1.0))
                    .toList(),
              ),
            ),
          ),
        ),
      ),
      ]),
    );
  }
}
