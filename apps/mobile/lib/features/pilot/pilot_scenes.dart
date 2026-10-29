part of 'pilot_records_page.dart';

/// pilot_scenes.dart — 会随数据变的场景 (2026-10-11)。
///
/// 用户: 「每一个图形都是有用的、实际要变化的 —— 存钱罐的高度、膨胀程度, 地图动态 …… 当成一个整体,
///        能表达出很多信息, 不是假的装饰物」。
///
///   钱    六根柱子 = 近 6 个月各花了多少 (本月是那根蓝的), 虚线 = 平时一个月;
///         硬币堆的高度 = 本月花钱的速度 (平时同期的几倍); 存钱罐鼓多大 = 上个月存下的比例
///   足迹  岛就是地图: 去过的地方按真坐标落点 (以家为中心, 远的按对数往外放), 去得多的钉子大,
///         最近一次是蓝的; 最近几次按时间连成一条虚线, 进来时一段段画出来
/// 数都来自服务端 summarizeRooms 的 scene (pilot-data-sdk insights.ts)。

const _clayTop = Color(0xFFF6F3EE);
const _clayFront = Color(0xFFE6E0D7);
const _claySide = Color(0xFFD4CDC2);
const _blueTop = Color(0xFF5C8BFF);
const _blueFront = Color(0xFF2F6BFF);
const _blueSide = Color(0xFF2456D6);

// ───────── 钱 ─────────

class _MoneyScene extends StatefulWidget {
  const _MoneyScene({required this.scene, required this.onSay});
  final Map<String, dynamic> scene;
  final void Function(String) onSay;

  @override
  State<_MoneyScene> createState() => _MoneySceneState();
}

class _MoneySceneState extends State<_MoneyScene> with SingleTickerProviderStateMixin {
  late final AnimationController _grow = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..forward();

  @override
  void didUpdateWidget(covariant _MoneyScene old) {
    super.didUpdateWidget(old);
    if (jsonEncode(old.scene) != jsonEncode(widget.scene)) _grow.forward(from: 0);
  }

  @override
  void dispose() {
    _grow.dispose();
    super.dispose();
  }

  List<({String ym, double amount})> get _months => [
        for (final m in (widget.scene['months'] as List? ?? const []))
          if (m is Map) (ym: '${m['ym']}', amount: (m['amount'] as num?)?.toDouble() ?? 0),
      ];

  @override
  Widget build(BuildContext context) {
    final months = _months;
    final usual = (widget.scene['usualMonth'] as num?)?.toDouble();
    final pace = (widget.scene['pace'] as num?)?.toDouble();
    final save = (widget.scene['savingsRate'] as num?)?.toDouble();
    /* 存钱罐: 存 0 → 0.72 倍, 存一半 → 1.05 倍, 花超了 (负的) 瘪下去 */
    final pigScale = (0.72 + (save ?? 0.2).clamp(-0.3, 0.7) * 0.66).clamp(0.55, 1.2);
    /* 硬币: 平时同期 = 4 枚, 快一倍 = 8 枚 */
    final coins = pace == null ? 0 : (pace * 4).round().clamp(1, 12);
    return LayoutBuilder(builder: (c, box) {
      final w = box.maxWidth, h = box.maxHeight;
      final slabH = w * 494 / 900;
      final slabTop = h - slabH;
      /* 柱子站在台面左半边, 存钱罐 + 硬币在右边 */
      final barsRect = Rect.fromLTWH(w * 0.07, slabTop - h * 0.42 + slabH * 0.30, w * 0.44, h * 0.42);
      final pigW = w * 0.30 * pigScale;
      final coinW = w * 0.11;
      return Stack(clipBehavior: Clip.none, children: [
        Positioned(left: 0, right: 0, bottom: 0, child: Image.asset('assets/twin/p-plinth.webp', fit: BoxFit.fitWidth, filterQuality: FilterQuality.medium)),
        Positioned.fromRect(
          rect: barsRect,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () {
              if (months.isEmpty) return widget.onSay(tr('记几笔，柱子就长出来了'));
              final now = months.last.amount;
              widget.onSay(usual == null
                  ? tr('这个月到今天花了 ${_yuan(now)}')
                  : tr('这个月到今天 ${_yuan(now)}，平时一个月 ${_yuan(usual)}（虚线）'));
            },
            child: AnimatedBuilder(
              animation: _grow,
              builder: (c, _) => CustomPaint(painter: _BarsPainter(months: months, usual: usual, t: Curves.easeOutBack.transform(_grow.value.clamp(0, 1)))),
            ),
          ),
        ),
        /* 存钱罐: 存得越多越鼓 */
        AnimatedBuilder(
          animation: _grow,
          builder: (c, child) {
            final p = Curves.elasticOut.transform(((_grow.value - 0.15) / 0.85).clamp(0.0, 1.0));
            return Positioned(
              left: w * 0.79 - pigW / 2,
              top: slabTop + slabH * 0.40 - pigW * 0.96,
              width: pigW,
              child: Transform.scale(scale: 0.6 + 0.4 * p, alignment: Alignment.bottomCenter, child: child),
            );
          },
          child: GestureDetector(
            onTap: () => widget.onSay(save == null
                ? tr('有了收入记录，存钱罐就知道该多鼓')
                : save >= 0
                    ? tr('上个月存下了 ${(save * 100).round()}%，存得越多它越鼓')
                    : tr('上个月花的比挣的多 ${(-save * 100).round()}%，它瘪了')),
            child: Image.asset('assets/twin/p-pig.webp', filterQuality: FilterQuality.medium),
          ),
        ),
        /* 硬币堆: 站在存钱罐左前方, 一枚一枚落下 (画在罐子后面一层会被挡住) */
        for (var i = 0; i < coins; i++)
          AnimatedBuilder(
            animation: _grow,
            builder: (c, child) {
              final start = 0.25 + i * 0.05;
              final p = Curves.bounceOut.transform(((_grow.value - start) / 0.35).clamp(0.0, 1.0));
              final y = slabTop + slabH * 0.50 - coinW * 0.67 - i * coinW * 0.20;
              return Positioned(left: w * 0.52, top: y - (1 - p) * h * 0.4, width: coinW, child: Opacity(opacity: p > 0 ? 1 : 0, child: child));
            },
            child: GestureDetector(
              onTap: () => widget.onSay(pace == null
                  ? tr('再记一阵子才能比快慢')
                  : pace >= 1.15
                      ? tr('这个月花得是平时同期的 ${pace.toStringAsFixed(1)} 倍，硬币堆高了')
                      : pace <= 0.85
                          ? tr('比平时同期少花了 ${((1 - pace) * 100).round()}%，硬币堆矮了')
                          : tr('跟平时同期差不多')),
              child: Image.asset('assets/twin/p-coin.webp', filterQuality: FilterQuality.medium),
            ),
          ),
      ]);
    });
  }
}

/// 六根等轴测的陶土柱子 (正面 / 侧面 / 顶面三块面), 本月那根钴蓝; 虚线 = 平时一个月
class _BarsPainter extends CustomPainter {
  _BarsPainter({required this.months, required this.usual, required this.t});
  final List<({String ym, double amount})> months;
  final double? usual;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    if (months.isEmpty) return;
    final maxV = math.max(months.map((m) => m.amount).fold<double>(0, math.max), usual ?? 0);
    if (maxV <= 0) return;
    final n = months.length;
    final slot = size.width / n;
    final bw = slot * 0.58;
    final depth = bw * 0.42;
    final base = size.height;
    final topRoom = size.height - depth - 14;
    for (var i = 0; i < n; i++) {
      final m = months[i];
      final last = i == n - 1;
      final x = i * slot + (slot - bw) / 2;
      final hgt = math.max(4.0, m.amount / maxV * topRoom * t);
      final top = base - hgt;
      /* 正面 */
      final front = RRect.fromRectAndCorners(Rect.fromLTWH(x, top, bw, hgt), topLeft: const Radius.circular(3), bottomLeft: const Radius.circular(6), bottomRight: const Radius.circular(6));
      canvas.drawRRect(front.shift(const Offset(2, 4)), Paint()..color = const Color(0x16000000)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5));
      canvas.drawRRect(front, Paint()..color = last ? _blueFront : _clayFront);
      /* 侧面 (往右上) */
      final side = Path()
        ..moveTo(x + bw, top)
        ..lineTo(x + bw + depth * 0.7, top - depth * 0.5)
        ..lineTo(x + bw + depth * 0.7, base - depth * 0.5 - 4)
        ..lineTo(x + bw, base - 4)
        ..close();
      canvas.drawPath(side, Paint()..color = last ? _blueSide : _claySide);
      /* 顶面 */
      final topFace = Path()
        ..moveTo(x, top)
        ..lineTo(x + depth * 0.7, top - depth * 0.5)
        ..lineTo(x + bw + depth * 0.7, top - depth * 0.5)
        ..lineTo(x + bw, top)
        ..close();
      canvas.drawPath(topFace, Paint()..color = last ? _blueTop : _clayTop);
      /* 正面左上一道受光 */
      canvas.drawRect(Rect.fromLTWH(x + 2, top + 2, bw * 0.16, math.max(0, hgt - 8)), Paint()..color = Colors.white.withValues(alpha: last ? 0.18 : 0.45));
      /* 月份 */
      final tp = TextPainter(
        text: TextSpan(text: last ? '本月' : '${int.parse(m.ym.substring(5))}月', style: TextStyle(fontSize: 10, fontWeight: last ? FontWeight.w800 : FontWeight.w600, color: last ? _blueFront : const Color(0xFF8A8478))),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(x + bw / 2 - tp.width / 2, top - depth * 0.5 - tp.height - 2));
    }
    final u = usual;
    if (u != null && u > 0) {
      final y = base - u / maxV * topRoom * t;
      final p = Paint()..color = const Color(0xFF8A8478)..strokeWidth = 1.4;
      for (var x = 0.0; x < size.width; x += 8) {
        canvas.drawLine(Offset(x, y), Offset(math.min(x + 4, size.width), y), p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _BarsPainter old) => old.t != t || old.months != months || old.usual != usual;
}

// ───────── 足迹: 岛就是地图 ─────────

/// 地图台面四个角 (占 p-maptile.webp 的比例): 后角 / 右角 / 前角 / 左角; 往里收一点免得钉子出边。
/// 东西走左角 → 右角 (屏幕上横着那条长对角线), 南北走后角 → 前角
const _nw = Offset(0.505, 0.10), _ne = Offset(0.91, 0.43), _se = Offset(0.48, 0.77), _sw = Offset(0.08, 0.41);

double _km(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371.0;
  final dLat = (lat2 - lat1) * math.pi / 180, dLng = (lng2 - lng1) * math.pi / 180;
  final a = math.sin(dLat / 2) * math.sin(dLat / 2) + math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * r * math.asin(math.sqrt(a));
}

class _MapScene extends StatefulWidget {
  const _MapScene({required this.scene, required this.onSay, this.onHome});
  final Map<String, dynamic> scene;
  final void Function(String) onSay;
  /// 点地图上的家: 设家 / 公司 / 车 (情境层)
  final VoidCallback? onHome;

  @override
  State<_MapScene> createState() => _MapSceneState();
}

class _MapSceneState extends State<_MapScene> with SingleTickerProviderStateMixin {
  late final AnimationController _draw = AnimationController(vsync: this, duration: const Duration(milliseconds: 2600))..forward();

  @override
  void dispose() {
    _draw.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pins = [
      for (final p in (widget.scene['pins'] as List? ?? const []))
        if (p is Map) (name: '${p['name']}', lat: (p['lat'] as num).toDouble(), lng: (p['lng'] as num).toDouble(), count: (p['count'] as num?)?.toInt() ?? 1, lastDays: (p['lastDays'] as num?)?.toInt() ?? 999),
    ];
    final route = [
      for (final p in (widget.scene['route'] as List? ?? const []))
        if (p is Map) (name: '${p['name']}', lat: (p['lat'] as num).toDouble(), lng: (p['lng'] as num).toDouble()),
    ];
    final h = widget.scene['home'] is Map ? widget.scene['home'] as Map : null;
    /* 家: 档案 home.geo (手机「这里是家」时记的); 没有就取这些地方的中心 */
    final home = (h != null
            ? ((h['lat'] as num).toDouble(), (h['lng'] as num).toDouble())
            : pins.isEmpty
                ? null
                : (pins.map((p) => p.lat).reduce((a, b) => a + b) / pins.length, pins.map((p) => p.lng).reduce((a, b) => a + b) / pins.length));
    /* 以家为原点: 方位照真的, 远近取对数 —— 家附近的不挤成一团, 一千公里外的也还在岛上。
     * 然后把所有点 (连家) 的外框等比放满台面: 住海边的人去的地方全在西边, 不缩到一个角里 */
    (double, double) polar(double lat, double lng) {
      if (home == null) return (0, 0);
      final d = _km(home.$1, home.$2, lat, lng);
      final r = math.log(1 + d);
      final dx = (lng - home.$2) * math.cos(home.$1 * math.pi / 180), dy = lat - home.$1;
      final len = math.sqrt(dx * dx + dy * dy);
      return len == 0 ? (0, 0) : (dx / len * r, -dy / len * r);
    }
    final pts = [(0.0, 0.0), for (final p in pins) polar(p.lat, p.lng)];
    final minX = pts.map((p) => p.$1).reduce(math.min), maxX = pts.map((p) => p.$1).reduce(math.max);
    final minY = pts.map((p) => p.$2).reduce(math.min), maxY = pts.map((p) => p.$2).reduce(math.max);
    /* 东西走台面左角 → 右角那条长对角线 (屏幕上横着), 南北走后角 → 前角; 两个方向各自放满到 [-1, 1] */
    (double, double) norm((double, double) p) => (
          maxX - minX < 0.5 ? 0 : (p.$1 - minX) / (maxX - minX) * 2 - 1,
          maxY - minY < 0.5 ? 0 : (p.$2 - minY) / (maxY - minY) * 2 - 1,
        );
    /* 台面是菱形: |横| + |竖| ≤ 1 才在面上; 整体缩到最远那个点刚好在 88% 处 */
    final reach = pts.map(norm).map((p) => p.$1.abs() + p.$2.abs()).fold<double>(1, math.max);
    final k = 0.88 / reach;
    final center = (_sw + _ne + _nw + _se) / 4;
    Offset place(double lat, double lng) {
      final (a, b) = norm(polar(lat, lng));
      return center + (_ne - _sw) * (a * k / 2) + (_se - _nw) * (b * k / 2);
    }
    final newest = pins.isEmpty ? null : pins.reduce((a, b) => a.lastDays <= b.lastDays ? a : b);
    final maxCount = pins.isEmpty ? 1 : pins.map((p) => p.count).reduce(math.max);
    return LayoutBuilder(builder: (c, box) {
      final w = box.maxWidth, hh = box.maxHeight;
      Offset px(Offset f) => Offset(f.dx * w, f.dy * hh);
      double size(({String name, double lat, double lng, int count, int lastDays}) p) => 22 + 16 * math.sqrt(p.count / maxCount);
      /* 标签: 从最近去的往后挑, 跟已经挂上的挨得太近就不挂 (叠在一起两个都看不清), 最多四个 */
      final labelled = <String>{};
      final taken = <Offset>[];
      for (final p in [...pins]..sort((a, b) => a.lastDays.compareTo(b.lastDays))) {
        if (labelled.length >= 4) break;
        final at = px(place(p.lat, p.lng));
        if (taken.any((o) => (o.dx - at.dx).abs() < 84 && (o.dy - at.dy).abs() < 30)) continue;
        labelled.add(p.name);
        taken.add(at);
      }
      return Stack(clipBehavior: Clip.none, children: [
        Positioned.fill(child: Image.asset('assets/twin/p-maptile.webp', fit: BoxFit.fill, filterQuality: FilterQuality.medium)),
        /* 路线: 按时间一段段画出来, 头上一颗蓝点 */
        Positioned.fill(
          child: AnimatedBuilder(
            animation: _draw,
            builder: (c, _) => CustomPaint(painter: _RoutePainter([for (final r in route) px(place(r.lat, r.lng))], Curves.easeInOut.transform(_draw.value))),
          ),
        ),
        for (final (i, p) in ([...pins]..sort((a, b) => place(a.lat, a.lng).dy.compareTo(place(b.lat, b.lng).dy))).indexed)
          AnimatedBuilder(
            animation: _draw,
            builder: (c, child) {
              final k = Curves.easeOutBack.transform(((_draw.value - i * 0.04) / 0.4).clamp(0.0, 1.0));
              /* 钉子是 Positioned, 外面包了动画就不是 Stack 的直接孩子了: 再套一层铺满的 Stack 给它落脚 */
              return Positioned.fill(
                child: Opacity(
                  opacity: k.clamp(0.0, 1.0),
                  child: Transform.translate(offset: Offset(0, (1 - k) * -18), child: Stack(clipBehavior: Clip.none, children: [child!])),
                ),
              );
            },
            child: _pin(px(place(p.lat, p.lng)), p, p == newest, size(p)),
          ),
        /* 家画在钉子上面: 家门口的钉子再多也不会把它盖住 */
        if (home != null)
          _sprite(px(place(home.$1, home.$2)), 40, Image.asset(NeoxClay.of('i-house'), filterQuality: FilterQuality.medium), widget.onHome ?? () => widget.onSay(tr('家'))),
        /* 地名最上面, 路线画完再浮出来 */
        for (final p in pins)
          if (labelled.contains(p.name))
            AnimatedBuilder(
              animation: _draw,
              builder: (c, child) => Positioned.fill(
                child: Opacity(opacity: ((_draw.value - 0.5) / 0.3).clamp(0.0, 1.0), child: Stack(clipBehavior: Clip.none, children: [child!])),
              ),
              child: _label(px(place(p.lat, p.lng)), p, p == newest, size(p)),
            ),
      ]);
    });
  }

  Widget _sprite(Offset at, double size, Widget child, VoidCallback onTap) => Positioned(
        left: at.dx - size / 2,
        top: at.dy - size * 0.85,
        width: size,
        height: size,
        child: GestureDetector(onTap: onTap, child: child),
      );

  void _sayPin(({String name, double lat, double lng, int count, int lastDays}) p) {
    final when = p.lastDays == 0 ? tr('今天') : tr('${p.lastDays} 天前');
    final more = p.count > 1 ? tr('，一年里去了 ${p.count} 次') : '';
    widget.onSay(tr('${p.name} · $when去过$more'));
  }

  Widget _pin(Offset at, ({String name, double lat, double lng, int count, int lastDays}) p, bool newest, double size) => Positioned(
        left: at.dx - size / 2,
        top: at.dy - size,
        width: size,
        height: size,
        child: GestureDetector(
          onTap: () => _sayPin(p),
          child: Image.asset(newest ? 'assets/twin/p-pinblue.webp' : 'assets/twin/p-pin.webp', height: size, filterQuality: FilterQuality.medium),
        ),
      );

  /// 地名标签单独一层, 画在家和钉子上面 (以前跟钉子一起画, 家一盖就看不见最近去的那个)
  Widget _label(Offset at, ({String name, double lat, double lng, int count, int lastDays}) p, bool newest, double size) {
    final theme = Theme.of(context);
    return Positioned(
      left: at.dx - 60,
      top: at.dy - size - 24,
      width: 120,
      child: Center(
        child: GestureDetector(
          onTap: () => _sayPin(p),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
            decoration: BoxDecoration(
              color: theme.colorScheme.surface.withValues(alpha: 0.94),
              borderRadius: NeoxRadius.pillR,
              boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 6, offset: Offset(0, 2))],
            ),
            child: Text(p.name, maxLines: 1, style: theme.textTheme.labelSmall?.copyWith(fontWeight: FontWeight.w700, color: newest ? NeoxBrand.blue : null)),
          ),
        ),
      ),
    );
  }
}

class _RoutePainter extends CustomPainter {
  _RoutePainter(this.points, this.t);
  final List<Offset> points;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2) return;
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (var i = 1; i < points.length; i++) {
      /* 两点之间拱一点, 像走过去的路, 不是尺子划的 */
      final a = points[i - 1], b = points[i];
      final mid = (a + b) / 2 + Offset(0, -math.min(26.0, (b - a).distance * 0.18));
      path.quadraticBezierTo(mid.dx, mid.dy, b.dx, b.dy);
    }
    final metric = path.computeMetrics().toList();
    final total = metric.fold<double>(0, (s, m) => s + m.length);
    var left = total * t;
    final dash = Paint()
      ..color = NeoxBrand.blue.withValues(alpha: 0.7)
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    Offset? head;
    for (final m in metric) {
      var d = 0.0;
      while (d < m.length && left > 0) {
        final seg = math.min(7.0, math.min(m.length - d, left));
        canvas.drawPath(m.extractPath(d, d + seg), dash);
        d += 13;
        left -= 13;
      }
      final tan = m.getTangentForOffset(math.min(m.length, math.max(0, d - 13)));
      if (tan != null) head = tan.position;
      if (left <= 0) break;
    }
    if (head != null && t < 1) {
      canvas.drawCircle(head, 5, Paint()..color = NeoxBrand.blue);
      canvas.drawCircle(head, 9, Paint()..color = NeoxBrand.blue.withValues(alpha: 0.18));
    }
  }

  @override
  bool shouldRepaint(covariant _RoutePainter old) => old.t != t || old.points.length != points.length;
}
