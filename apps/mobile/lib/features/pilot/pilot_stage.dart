/// pilot_stage.dart — Pilot 首页的零件 (陶土稿 v5「猫在说话」).
///
///   ☰          小航 ▾          (电话)
///   ┌──────── 房间场景 (整宽) ────────┐
///   │      ( 15 号要还信用卡… )       │  ← 泥做的气泡, 尖朝猫
///   │            🐱                  │  ← 点猫 = 说话
///   └────────────────────────────────┘
///            ● ○ ○ ○ ○                  ← 左右滑换房间: 今天 / 钱 / 身体 / 足迹 / 关系
///   [ 好，设提醒 ]  [ 晚点说 ]             ← 今天: 一件事当场办
///   还有 2 件 …                          ← 每件一行: 陶土方块 + 带数字的一句 + 小按钮
///   (键盘)      ( ● 按住说话 )      (相机)
///
/// 房间里: 三个数 (不加框) + 一件能办的事 + 一行入口。数都是服务端 summarizeRooms 算好的, 这里只画。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';

enum PilotRoom { today, money, body, trips, people }

extension PilotRoomX on PilotRoom {
  String get label => switch (this) {
        PilotRoom.today => tr('今天'),
        PilotRoom.money => tr('钱'),
        PilotRoom.body => tr('身体'),
        PilotRoom.trips => tr('足迹'),
        PilotRoom.people => tr('关系'),
      };

  /// 场景图 (assets/clay/v5/pilot/scene-*.webp, 夜陶有 -d)
  String get scene => 'pilot/scene-$name';

  /// 没数的时候教一句怎么喂它
  String get hint => switch (this) {
        PilotRoom.today => tr('跟我说「明早 8 点叫我」，我就记住了'),
        PilotRoom.money => tr('跟我说「午饭 35，打车 20」，或者截图账单给我'),
        PilotRoom.body => tr('跟我说「今天 65.2 公斤」「跑了 5 公里」'),
        PilotRoom.trips => tr('跟我说「车停在 B2 C 区」，到时候问我就行'),
        PilotRoom.people => tr('跟我说「我妈生日 3 月 8 号」，我就记住了'),
      };
}

/// 一条发现归哪个房间 (服务端 domain: money / body / mood / social / habit / place / cross)
PilotRoom pilotRoomOf(PilotInsight i) => switch (i.domain) {
      'money' => PilotRoom.money,
      'body' || 'habit' => PilotRoom.body,
      'place' => PilotRoom.trips,
      'social' => PilotRoom.people,
      'cross' => i.id.contains('spend') ? PilotRoom.money : PilotRoom.body,
      _ => PilotRoom.today,
    };

IconData pilotIconOf(PilotInsight i) => switch (i.domain) {
      'money' => Icons.credit_card_rounded,
      'body' => Icons.bedtime_outlined,
      'habit' => Icons.eco_outlined,
      'mood' => Icons.sentiment_satisfied_alt_outlined,
      'social' => Icons.card_giftcard_rounded,
      'place' => Icons.place_outlined,
      _ => Icons.lightbulb_outline_rounded,
    };

// ════════════════════════════════════════════════════════════════
//  场景 + 气泡
// ════════════════════════════════════════════════════════════════

/// 一个房间的场景图, 上面可以浮一个气泡; 点猫 (中间那块) = 说话.
class PilotScene extends StatelessWidget {
  const PilotScene({super.key, required this.room, this.bubble, this.onTapCat, this.onLongPressCat});

  final PilotRoom room;
  final Widget? bubble;
  final VoidCallback? onTapCat;
  final VoidCallback? onLongPressCat;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      return Stack(
        fit: StackFit.expand,
        children: [
          ClayArt(room.scene, fit: BoxFit.cover),
          /* 猫在场景正中偏下: 点那一块就是点它 */
          Positioned(
            left: box.maxWidth * 0.28,
            right: box.maxWidth * 0.28,
            top: box.maxHeight * 0.30,
            bottom: box.maxHeight * 0.08,
            child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTapCat, onLongPress: onLongPressCat),
          ),
          if (bubble != null)
            Positioned(
              left: 20,
              right: 20,
              top: 12,
              child: Align(
                alignment: Alignment.topCenter,
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 260),
                  transitionBuilder: (c, a) => FadeTransition(
                    opacity: a,
                    child: ScaleTransition(scale: Tween(begin: 0.92, end: 1.0).animate(a), alignment: Alignment.bottomCenter, child: c),
                  ),
                  child: bubble,
                ),
              ),
            ),
        ],
      );
    });
  }
}

/// 猫头上那个泥做的气泡: 釉面白、圆角 22、下面一个小尖朝着猫.
class PilotBubble extends StatelessWidget {
  const PilotBubble({super.key, required this.child, this.onTap, this.maxLines = 3});

  final Widget child;
  final VoidCallback? onTap;
  final int maxLines;

  /// 常用: 一句话
  factory PilotBubble.text(String text, {Key? key, VoidCallback? onTap, bool muted = false}) => PilotBubble(
        key: key ?? ValueKey('b:$text'),
        onTap: onTap,
        child: Builder(builder: (context) {
          final c = ClayInk.of(context);
          return Text(
            text,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 15, height: 1.45, color: muted ? c.grey : c.ink, fontWeight: FontWeight.w500),
          );
        }),
      );

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return GestureDetector(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 300),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(
                color: c.slab,
                borderRadius: BorderRadius.circular(22),
                boxShadow: clayShadow(c, lift: 1.1),
              ),
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12), child: child),
            ),
            CustomPaint(size: const Size(18, 10), painter: _TailPainter(c.slabBottom)),
          ],
        ),
      ),
    );
  }
}

class _TailPainter extends CustomPainter {
  _TailPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size s) {
    final p = Path()
      ..moveTo(0, 0)
      ..quadraticBezierTo(s.width * 0.45, s.height * 0.2, s.width * 0.5, s.height)
      ..quadraticBezierTo(s.width * 0.55, s.height * 0.2, s.width, 0)
      ..close();
    canvas.drawPath(p, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_TailPainter old) => old.color != color;
}

/// 它在想: 三个点依次跳
class PilotThinkingDots extends StatefulWidget {
  const PilotThinkingDots({super.key});

  @override
  State<PilotThinkingDots> createState() => _PilotThinkingDotsState();
}

class _PilotThinkingDotsState extends State<PilotThinkingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Transform.translate(
                offset: Offset(0, -4 * math.max(0, math.sin(_c.value * math.pi * 2 - i * 0.9))),
                child: Container(width: 7, height: 7, decoration: BoxDecoration(color: c.grey, shape: BoxShape.circle)),
              ),
            ),
        ],
      ),
    );
  }
}

/// 在听但还没听到字: 几根跟着音量跳的竖条
class PilotLevelBars extends StatelessWidget {
  const PilotLevelBars({super.key, required this.level});
  final double level;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final t = DateTime.now().millisecondsSinceEpoch / 140;
    return SizedBox(
      height: 22,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 5; i++)
            AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              margin: const EdgeInsets.symmetric(horizontal: 2.5),
              width: 4,
              height: 5 + 17 * (0.25 + 0.75 * level) * (0.5 + 0.5 * math.sin(t + i * 1.3)).abs(),
              decoration: BoxDecoration(color: c.cobalt, borderRadius: BorderRadius.circular(2)),
            ),
        ],
      ),
    );
  }
}

/// 场景下面的五个小点: 第几个房间
class PilotPageDots extends StatelessWidget {
  const PilotPageDots({super.key, required this.count, required this.index});
  final int count;
  final int index;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            margin: const EdgeInsets.symmetric(horizontal: 3.5),
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: i == index ? c.cobalt : c.line, shape: BoxShape.circle),
          ),
      ],
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  房间里的数 / 一件事 / 一周的柱子
// ════════════════════════════════════════════════════════════════

typedef PilotStat = ({String value, String? unit, String label});

/// 三个数并排, 不加框; 中间两道淡竖线
class PilotStatsRow extends StatelessWidget {
  const PilotStatsRow({super.key, required this.stats});
  final List<PilotStat> stats;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final cells = <Widget>[];
    for (final (i, s) in stats.indexed) {
      if (i > 0) cells.add(Container(width: 0.8, height: 34, color: c.line));
      cells.add(Expanded(
        child: Column(
          children: [
            Text.rich(
              TextSpan(children: [
                TextSpan(text: s.value, style: TextStyle(fontSize: 23, fontWeight: FontWeight.w700, color: c.ink, letterSpacing: -0.3)),
                if (s.unit != null) TextSpan(text: ' ${s.unit}', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: c.ink)),
              ]),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 3),
            Text(s.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
          ],
        ),
      ));
    }
    return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(children: cells));
  }
}

/// 一件事一行: 陶土方块 (带一颗蓝珠) + 带数字的一句 + 小按钮. [primary] = 墨色按钮 (房间里那件最要紧的)
class PilotThingRow extends StatelessWidget {
  const PilotThingRow({
    super.key,
    required this.icon,
    required this.title,
    this.sub,
    this.big,
    this.action,
    this.onAction,
    this.onTap,
    this.primary = false,
    this.done = false,
  });

  final IconData icon;
  final String title;
  final String? sub;

  /// 下面一行加粗大字 (钱: ¥3,280)
  final String? big;
  final String? action;
  final VoidCallback? onAction;
  final VoidCallback? onTap;
  final bool primary;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ClaySlab(
        radius: 18,
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
        onTap: onTap,
        child: Row(
          children: [
            ClayTile(icon: icon, size: 46, bead: done ? null : c.cobalt),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, height: 1.35, color: c.ink, fontWeight: FontWeight.w500)),
                  if (big != null) Text(big!, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.ink, height: 1.3)),
                  if (sub != null) Text(sub!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.4)),
                ],
              ),
            ),
            if (done) ...[
              const SizedBox(width: 8),
              ClayChip(label: tr('办好了'), tone: ClayTone.green, dense: true),
            ] else if (action != null) ...[
              const SizedBox(width: 8),
              primary
                  ? ClayButton.ink(label: action!, size: ClayButtonSize.small, onTap: onAction)
                  : ClayButton(label: action!, kind: ClayButtonKind.clay, size: ClayButtonSize.small, onTap: onAction),
            ],
          ],
        ),
      ),
    );
  }
}

/// 一周的柱子: 陶土小胶囊, 今天那根钴蓝; 下面一行灰字结论
class PilotWeekBars extends StatelessWidget {
  const PilotWeekBars({super.key, required this.values, required this.labels, this.caption});

  final List<double> values;
  final List<String> labels;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final top = values.fold<double>(0, math.max);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ClaySlab(
        radius: 18,
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
        child: Column(
          children: [
            SizedBox(
              height: 96,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final (i, v) in values.indexed)
                    Expanded(
                      child: Center(
                        child: Container(
                          width: 22,
                          height: top <= 0 ? 8 : math.max(8, 92 * v / top),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(11),
                            color: i == values.length - 1 ? c.cobalt : c.fill,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                for (final (i, l) in labels.indexed)
                  Expanded(
                    child: Text(l,
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 11.5, color: i == labels.length - 1 ? c.ink : c.grey, fontWeight: i == labels.length - 1 ? FontWeight.w600 : FontWeight.w400)),
                  ),
              ],
            ),
            if (caption != null) ...[
              const SizedBox(height: 10),
              Text(caption!, style: TextStyle(fontSize: 12.5, color: c.grey)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 房间底下一行入口「本月账单 · 2 张没交 ›」
class PilotLinkRow extends StatelessWidget {
  const PilotLinkRow({super.key, required this.text, this.icon, required this.onTap});
  final String text;
  final IconData? icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        child: Row(
          children: [
            if (icon != null) ...[Icon(icon, size: 16, color: c.grey), const SizedBox(width: 6)],
            Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.grey))),
            Icon(Icons.chevron_right_rounded, size: 18, color: c.faint),
          ],
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  底部: 键盘 / 按住说话 / 相机
// ════════════════════════════════════════════════════════════════

enum PilotVoiceState { idle, listening, thinking, speaking }

class PilotVoiceBar extends StatelessWidget {
  const PilotVoiceBar({
    super.key,
    required this.state,
    required this.level,
    required this.onKeyboard,
    required this.onCamera,
    required this.onTap,
    required this.onHoldStart,
    required this.onHoldEnd,
  });

  final PilotVoiceState state;
  final double level;
  final VoidCallback onKeyboard;
  final VoidCallback onCamera;
  final VoidCallback onTap;
  final VoidCallback onHoldStart;
  final VoidCallback onHoldEnd;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final label = switch (state) {
      PilotVoiceState.idle => tr('按住说话'),
      PilotVoiceState.listening => tr('松开就发'),
      PilotVoiceState.thinking => tr('在想…'),
      PilotVoiceState.speaking => tr('点一下停'),
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(36, 4, 36, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              ClayRoundButton(icon: Icons.keyboard_alt_outlined, size: 48, tooltip: tr('打字'), onTap: onKeyboard),
              GestureDetector(
                onTap: () {
                  HapticFeedback.lightImpact();
                  onTap();
                },
                onLongPressStart: (_) {
                  HapticFeedback.mediumImpact();
                  onHoldStart();
                },
                onLongPressEnd: (_) => onHoldEnd(),
                child: _VoiceKey(state: state, level: level),
              ),
              ClayRoundButton(icon: Icons.photo_camera_outlined, size: 48, tooltip: tr('拍照'), onTap: onCamera),
            ],
          ),
          const SizedBox(height: 4),
          Text(label, style: TextStyle(fontSize: 12.5, color: c.grey)),
        ],
      ),
    );
  }
}

/// 中间那颗大泥键: 一颗钴蓝珠子; 在听时一圈光跟着音量亮暗
class _VoiceKey extends StatelessWidget {
  const _VoiceKey({required this.state, required this.level});
  final PilotVoiceState state;
  final double level;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final listening = state == PilotVoiceState.listening;
    return AnimatedContainer(
      /* 跟两边的键盘 / 相机一样大 (2026-10-14 用户: 说话键做这么大不合理) */
      duration: const Duration(milliseconds: 120),
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        /* 平的: 在听时底色随音量染一层钴蓝, 不用光晕 (2026-10-14 控件全扁平, 跟桌面设置同) */
        color: listening ? Color.alphaBlend(c.cobalt.withValues(alpha: 0.10 + 0.22 * level), c.fill) : c.fill,
      ),
      child: Center(
        child: switch (state) {
          PilotVoiceState.thinking => const ClaySpinner(size: 16),
          PilotVoiceState.speaking => Container(width: 12, height: 12, decoration: BoxDecoration(color: c.ink, borderRadius: BorderRadius.circular(3))),
          _ => AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              width: listening ? 14 + 6 * level : 13,
              height: listening ? 14 + 6 * level : 13,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: c.cobalt,
              ),
            ),
        },
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  数怎么写
// ════════════════════════════════════════════════════════════════

String pilotYuan(num? v) {
  if (v == null) return '—';
  final n = v.round().abs();
  final s = n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${v < 0 ? '−' : ''}¥$s';
}

String pilotHours(num? minutes) => minutes == null || minutes <= 0 ? '—' : (minutes / 60).toStringAsFixed(1);
