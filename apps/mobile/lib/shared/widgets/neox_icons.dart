/// neox_icons.dart — 自绘图标集 (24 网格 · 统一描边 · 统一光学外框).
///
/// **为什么不用 Material Icons**
///
/// 2026-09-04 用户实拍顶栏: "加号虽然本身大小应该是一样的, 但由于它加号的这种
/// 符号特性, 就天然显得比手机要小; 手机呢又更高, 视觉上不协调"。量了一下他是对的:
///
/// | 顶栏图标 | 代码里的 size | 实测墨迹外框 (pt) |
/// |---|---|---|
/// | smartphone_outlined | 20 | 11.3 × 18.7 |
/// | add_outlined        | 22 | 12.7 × 12.7 |
/// | more_vert           | 22 |  4.0 × 14.7 |
///
/// 手机比加号高 47%, 三个图标的墨迹外框没有一个对得上。原来代码里那张
/// `_opticalGlyph` 对照表是拍脑袋写的 (给 add 放到 22、给 computer 收到 20),
/// 但它调的是**字号**, 而 Material 每个 glyph 在自己 em 框里的占比根本不一样,
/// 调字号救不回来。更别说 Material Outlined 各 glyph 的笔画粗细本来就不统一
/// (加号是纯直线, 手机是圆角矩形+听筒细节), 混在一排里就是"质量不高"。
///
/// **这里的做法**: 每个 glyph 自己画在 24×24 网格上, 两条硬约束 —
///   1. 描边一律 [_stroke] (1.7/24), 圆头圆角, 缩放时按比例走;
///   2. 每个 glyph 的**光学外框**按下表定, 不是按 bbox 相等, 而是按"看起来一样大":
///      稀疏的符号 (加号 / 三点) 要画得比密实的形状 (手机 / 电脑) 更大才平衡。
///
/// 改任何一个 glyph 之后, 必须重新截图量一遍墨迹外框 —— 这套东西的对错只有
/// 眼睛和像素能判, typecheck 和单测一律绿。
library;

import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// 设计网格 —— 所有坐标都写在 24×24 里, 渲染时整体缩放.
const double _grid = 24;

/// 统一描边 (24 网格下). 1.7 是在 21pt 渲染尺寸下最接近"细但不飘"的值.
const double _stroke = 1.7;

enum NeoxIconGlyph {
  /// 汉堡 — 会话抽屉
  menu,

  /// 左箭头 — 返回上一页 / 回到设备会话列表
  back,

  /// 加号 — 新会话
  plus,

  /// 竖三点 — 更多
  more,

  /// 手机 — 运行位置 / 设备
  phone,

  /// 笔记本 — 运行位置 (电脑)
  laptop,

  /// 云 — 运行位置 (云端)
  cloud,

  /// 图片 — 图片工作台
  image,

  /// 问号 — 会话上下文还没取到时的占位
  question,

  /// 下箭头 (细) — 模式切换的展开提示
  chevronDown,

  /// 右箭头 (细) — "点进去" 的提示
  chevronRight,

  /// 麦克风 — 语音输入
  mic,

  /// 上箭头 — 发送
  arrowUp,
}

/// 自绘图标. [size] 是**渲染方框**边长, 不是墨迹大小 —— 墨迹按 glyph 各自的
/// 光学外框走, 见文件头说明。
class NeoxIcon extends StatelessWidget {
  const NeoxIcon(this.glyph, {super.key, this.size = 21, this.color});

  final NeoxIconGlyph glyph;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? DefaultTextStyle.of(context).style.color!;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _NeoxIconPainter(glyph, c, size)),
    );
  }
}

class _NeoxIconPainter extends CustomPainter {
  _NeoxIconPainter(this.glyph, this.color, this.renderSize);

  final NeoxIconGlyph glyph;
  final Color color;
  final double renderSize;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / _grid;
    canvas.save();
    canvas.scale(k);
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = _stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..isAntiAlias = true;
    final fill = Paint()
      ..color = color
      ..style = PaintingStyle.fill
      ..isAntiAlias = true;

    switch (glyph) {
      /* 汉堡 —— 三条线跨 18 宽. 它的"大小"完全由宽度决定, 高度反而不能撑满,
       * 撑满就变成一块栅栏。行距 5 是三条线还能各自读出来的下限。 */
      case NeoxIconGlyph.menu:
        for (final y in const [7.0, 12.0, 17.0]) {
          canvas.drawLine(const Offset(3, 0).translate(0, y),
              const Offset(21, 0).translate(0, y), p);
        }

      /* 加号 —— 臂展 17.5, 比手机的 17 还要大一点点.
       * 反直觉但这是对的: 加号只有两条线, 中间全是空的, 画到跟实心形状一样大
       * 就会显得小一圈。这正是用户看到的那个问题。 */
      case NeoxIconGlyph.plus:
        canvas.drawLine(const Offset(12, 3.25), const Offset(12, 20.75), p);
        canvas.drawLine(const Offset(3.25, 12), const Offset(20.75, 12), p);

      /* 竖三点 —— 三个实心点, 总高 16.5.
       * 点是实心的, 视觉重量高, 所以外框要比加号收一截。半径 1.55 跟 1.7 的
       * 描边配一对: 看起来像"同一支笔点下去的"。 */
      case NeoxIconGlyph.more:
        for (final y in const [3.75, 12.0, 20.25]) {
          canvas.drawCircle(Offset(12, y), 1.55, fill);
        }

      /* 手机 —— 高 17 (不是 18.7). 密实的封闭形状要比稀疏符号收一点。
       * 宽高比 11:17 接近真实手机, 再窄就变成遥控器。
       * 听筒那道短线放在顶端内侧 —— 有它才一眼是手机, 没它像张卡片。 */
      case NeoxIconGlyph.phone:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(6.5, 3.5, 11, 17),
            const Radius.circular(2.6),
          ),
          p,
        );
        canvas.drawLine(const Offset(10.4, 6.6), const Offset(13.6, 6.6), p);

      /* 笔记本 —— 屏 + 底座. 总宽 19 总高 14.
       * 横向的东西要比竖向的略宽才等重 (视觉上竖直方向更"显长")。 */
      case NeoxIconGlyph.laptop:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(4.5, 5, 15, 10),
            const Radius.circular(1.8),
          ),
          p,
        );
        canvas.drawLine(const Offset(2.5, 18.5), const Offset(21.5, 18.5), p);

      /* 云 —— 三段弧拼一朵, 总宽 18 高 11.
       * 不用 Material 那颗 (它的下沿是一条平底直线, 跟这里全圆角的语言打架)。 */
      case NeoxIconGlyph.cloud:
        final path = Path()
          ..moveTo(7, 18.5)
          ..arcToPoint(const Offset(7, 10.5),
              radius: const Radius.circular(4), clockwise: true)
          ..arcToPoint(const Offset(15.5, 9.2),
              radius: const Radius.circular(5.2), clockwise: true)
          ..arcToPoint(const Offset(17.5, 18.5),
              radius: const Radius.circular(4.6), clockwise: true)
          ..close();
        canvas.drawPath(path, p);

      /* 图片 —— 相框 + 山 + 太阳, 外框 17×17.
       * 山峰只画一座: 两座在 21pt 下会糊成锯齿。 */
      case NeoxIconGlyph.image:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(3.5, 3.5, 17, 17),
            const Radius.circular(2.6),
          ),
          p,
        );
        canvas.drawCircle(const Offset(9, 9), 1.5, p);
        canvas.drawPath(
          Path()
            ..moveTo(4.2, 17.2)
            ..lineTo(10, 11.4)
            ..lineTo(19.8, 20.2),
          p,
        );

      /* 问号 —— 上钩 + 下点, 总高 16.
       * 只在"会话上下文还没取到"这一拍出现, 一闪而过, 所以画得比同排收一点。 */
      case NeoxIconGlyph.question:
        canvas.drawPath(
          Path()
            ..moveTo(8.4, 8.6)
            ..arcToPoint(const Offset(14.6, 10.4),
                radius: const Radius.circular(3.4), clockwise: true)
            ..lineTo(12, 14.2),
          p,
        );
        canvas.drawCircle(const Offset(12, 18.4), 1.1, fill);

      /* 下箭头 —— 只跨 9 宽. 它是**附属提示**不是动作, 画大了就跟旁边的
       * 品牌字抢戏。所有 chevron 都该比同排的动作图标小一号。 */
      case NeoxIconGlyph.chevronDown:
        canvas.drawPath(
          Path()
            ..moveTo(7.5, 10)
            ..lineTo(12, 14.5)
            ..lineTo(16.5, 10),
          p,
        );

      /* 右箭头 —— 跟 chevronDown 同一个形状转 90°, 同样只跨 9.
       * 两者必须同尺寸: 一个页面里"能展开"和"能点进去"是同一级提示,
       * 大小不一样会让人以为它们分量不同。 */
      case NeoxIconGlyph.back:
        /* 左箭头 —— 杆 + 45° 头, 头的臂长跟 chevronRight 一致 (4.5/4.5) */
        canvas.drawPath(
          Path()
            ..moveTo(19, 12)
            ..lineTo(5.5, 12)
            ..moveTo(10, 7.5)
            ..lineTo(5.5, 12)
            ..lineTo(10, 16.5),
          p,
        );

      case NeoxIconGlyph.chevronRight:
        canvas.drawPath(
          Path()
            ..moveTo(10, 7.5)
            ..lineTo(14.5, 12)
            ..lineTo(10, 16.5),
          p,
        );

      /* 麦克风 —— 胶囊 + 下方托弧 + 立杆, 总高 17.
       * 托弧用 arc 不用两条斜线, 跟整套的圆角语言一致。 */
      case NeoxIconGlyph.mic:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(9, 3.5, 6, 11),
            const Radius.circular(3),
          ),
          p,
        );
        canvas.drawArc(
          const Rect.fromLTWH(5.75, 5.5, 12.5, 12.5),
          0.15 * math.pi,
          0.7 * math.pi,
          false,
          p,
        );
        canvas.drawLine(const Offset(12, 18), const Offset(12, 20.5), p);

      /* 上箭头 —— 杆 + 两撇, 总高 15.
       * 它总是长在实心圆里, 圆本身已经占了视觉重量, 所以要比裸露的加号小一圈。 */
      case NeoxIconGlyph.arrowUp:
        canvas.drawLine(const Offset(12, 19.5), const Offset(12, 4.5), p);
        canvas.drawPath(
          Path()
            ..moveTo(5.75, 10.75)
            ..lineTo(12, 4.5)
            ..lineTo(18.25, 10.75),
          p,
        );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _NeoxIconPainter old) =>
      old.glyph != glyph || old.color != color || old.renderSize != renderSize;
}
