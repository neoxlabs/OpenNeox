/// pilot_about_page.dart — 「关于你」和「记一笔」(陶土稿 v5).
///
/// 关于你:
///   ← 关于你
///   [收支] 体重  打卡  心情  去过           ← 一排胶囊, 选中墨色
///   这周花了                    (猫趴着)
///   ¥1,240
///   ┌ 一周七根陶土柱, 今天那根钴蓝 ┐
///   (吃) 午饭     12:10 · 截图记的   ¥35  ← 左滑删
///                              (+ 记一笔)
///   跟它说「午饭 35，打车 20」也行
///
/// 记一笔: ¥ 35 (大字) · 支出/收入 · 八个分类泥块 · 备注 + 时间 · 记下
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';
import 'pilot_stage.dart';

enum _Tab { money, weight, habit, mood, place }

extension on _Tab {
  String get label => switch (this) {
        _Tab.money => tr('收支'),
        _Tab.weight => tr('体重'),
        _Tab.habit => tr('打卡'),
        _Tab.mood => tr('心情'),
        _Tab.place => tr('去过'),
      };

  List<String> get types => switch (this) {
        _Tab.money => const ['finance.expense', 'finance.income'],
        _Tab.weight => const ['health.weight'],
        _Tab.habit => const ['habit.check'],
        _Tab.mood => const ['mood'],
        _Tab.place => const ['place.visit'],
      };

  String get hint => switch (this) {
        _Tab.money => tr('跟它说「午饭 35，打车 20」也行'),
        _Tab.weight => tr('跟它说「今天 65.2 公斤」也行'),
        _Tab.habit => tr('跟它说「今天跑步打卡」也行'),
        _Tab.mood => tr('跟它说「今天有点累」也行'),
        _Tab.place => tr('打开定位，它会自己记下去过哪'),
      };
}

/// 记一笔的分类: 字 · 图标
const _cats = <(String, IconData)>[
  ('吃饭', Icons.restaurant_rounded),
  ('交通', Icons.directions_car_outlined),
  ('购物', Icons.shopping_bag_outlined),
  ('住', Icons.home_outlined),
  ('娱乐', Icons.sports_esports_outlined),
  ('医疗', Icons.add_rounded),
  ('人情', Icons.people_outline_rounded),
  ('其他', Icons.more_horiz_rounded),
];

IconData _catIcon(String? cat, {bool income = false}) {
  if (income) return Icons.savings_outlined;
  final c = cat ?? '';
  if (c.contains('饭') || c.contains('餐') || c.contains('吃')) return Icons.restaurant_rounded;
  if (c.contains('咖啡') || c.contains('茶') || c.contains('饮')) return Icons.local_cafe_outlined;
  if (c.contains('车') || c.contains('交通') || c.contains('地铁') || c.contains('油')) return Icons.directions_car_outlined;
  for (final (name, icon) in _cats) {
    if (c.contains(name)) return icon;
  }
  return Icons.receipt_long_outlined;
}

/// 来源 (`device:phone:screenshot` / `agent:pilot:session-…` / `seed:demo` …) → 一句人话
String _source(String s) {
  final v = s.toLowerCase();
  if (v.contains('screenshot') || v.contains('ocr')) return tr('截图记的');
  if (v.contains('sms')) return tr('短信读的');
  if (v.contains('alipay')) return tr('支付宝');
  if (v.contains('wechat')) return tr('微信');
  if (v.contains('notif') || v.contains(':auto')) return tr('自动记的');
  if (v.startsWith('agent') || v.contains('pilot')) return tr('它记的');
  if (v.startsWith('seed')) return tr('示例');
  return tr('手记');
}

String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

class PilotAboutPage extends ConsumerStatefulWidget {
  const PilotAboutPage({super.key});

  @override
  ConsumerState<PilotAboutPage> createState() => _PilotAboutPageState();
}

class _PilotAboutPageState extends ConsumerState<PilotAboutPage> {
  _Tab _tab = _Tab.money;
  List<PilotRecord>? _rows;
  String? _error;

  PilotRecordsApi? get _api => ref.read(pilotCloudProvider)?.records;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 这一格近 7 天的记录 (去过: 近 30 天)
  Future<void> _load() async {
    final api = _api;
    if (api == null) return;
    final now = DateTime.now();
    final from = DateTime(now.year, now.month, now.day).subtract(Duration(days: _tab == _Tab.place ? 29 : 6));
    final tab = _tab;
    try {
      final rows = await api.query(types: tab.types, from: from, to: now, limit: 80);
      if (!mounted || tab != _tab) return;
      setState(() {
        _rows = rows..sort((a, b) => b.at.compareTo(a.at));
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e'.replaceFirst('Bad state: ', ''));
    }
  }

  void _switch(_Tab t) {
    if (t == _tab) return;
    HapticFeedback.selectionClick();
    setState(() {
      _tab = t;
      _rows = null;
    });
    unawaited(_load());
  }

  Future<void> _delete(PilotRecord r) async {
    setState(() => _rows?.remove(r));
    try {
      await _api?.delete(r.id);
    } catch (e) {
      NeoxToast.show(tr('没删掉：$e'));
      unawaited(_load());
    }
  }

  Future<void> _add() async {
    final ok = switch (_tab) {
      _Tab.weight => await showPilotWeightSheet(context, ref),
      _ => await showPilotQuickSheet(context, ref),
    };
    if (ok == true) {
      /* 档案投影有一两秒延迟 */
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      await _load();
    }
  }

  /// 每天一个数: 收支 = 当天花了多少; 体重 = 当天最后一次; 打卡 = 几次; 心情 = 平均分; 去过 = 几处
  List<double> _perDay(List<PilotRecord> rows) {
    final today = DateTime.now();
    final days = [for (var i = 6; i >= 0; i--) DateTime(today.year, today.month, today.day).subtract(Duration(days: i))];
    return [
      for (final d in days)
        () {
          final on = rows.where((r) => r.at.year == d.year && r.at.month == d.month && r.at.day == d.day).toList();
          switch (_tab) {
            case _Tab.money:
              return on.where((r) => r.type == 'finance.expense').fold<double>(0, (s, r) => s + (r.value ?? 0));
            case _Tab.weight:
              return on.isEmpty ? 0.0 : (on.first.value ?? 0);
            case _Tab.mood:
              final s = [for (final r in on) ((r.data['score'] as num?)?.toDouble() ?? 0)];
              return s.isEmpty ? 0.0 : s.reduce((a, b) => a + b) / s.length;
            case _Tab.habit:
            case _Tab.place:
              return on.length.toDouble();
          }
        }(),
    ];
  }

  ({String label, String value}) _headline(List<PilotRecord> rows) {
    switch (_tab) {
      case _Tab.money:
        final spent = rows.where((r) => r.type == 'finance.expense').fold<double>(0, (s, r) => s + (r.value ?? 0));
        return (label: tr('这周花了'), value: pilotYuan(spent));
      case _Tab.weight:
        final w = rows.firstOrNull?.value;
        return (label: tr('最近体重'), value: w == null ? '—' : '${w.toStringAsFixed(1)} kg');
      case _Tab.habit:
        return (label: tr('这周打卡'), value: tr('${rows.length} 次'));
      case _Tab.mood:
        final s = [for (final r in rows) ((r.data['score'] as num?)?.toDouble() ?? 0)];
        final avg = s.isEmpty ? null : s.reduce((a, b) => a + b) / s.length;
        return (label: tr('这周心情'), value: avg == null ? '—' : _moodWord(avg));
      case _Tab.place:
        final places = {for (final r in rows) r.title}.length;
        return (label: tr('这个月去了'), value: tr('$places 个地方'));
    }
  }

  static String _moodWord(double s) => s >= 4.2 ? tr('很好') : s >= 3.4 ? tr('还行') : s >= 2.5 ? tr('一般') : tr('有点低');

  ({String title, String sub, String trailing, IconData icon}) _row(PilotRecord r) {
    final src = _source(r.source);
    switch (_tab) {
      case _Tab.money:
        final income = r.type == 'finance.income';
        final cat = r.data['category'] as String?;
        /* 服务端没写名字时拼的是「支出 吃饭」: 收支这一格本来就是钱, 前缀去掉 */
        final raw = r.title.replaceFirst(RegExp(r'^(支出|收入)\s*'), '').trim();
        final title = raw.isNotEmpty ? raw : (cat ?? (income ? tr('收入') : tr('支出')));
        return (title: title, sub: '${_hm(r.at)} · $src', trailing: '${income ? '+' : ''}${pilotYuan(r.value)}', icon: _catIcon('$cat$title', income: income));
      case _Tab.weight:
        return (title: tr('体重'), sub: '${r.at.month}/${r.at.day} ${_hm(r.at)} · $src', trailing: '${(r.value ?? 0).toStringAsFixed(1)} kg', icon: Icons.monitor_weight_outlined);
      case _Tab.habit:
        return (title: '${r.data['habit'] ?? r.title}', sub: '${r.at.month}/${r.at.day} ${_hm(r.at)}', trailing: '✓', icon: Icons.eco_outlined);
      case _Tab.mood:
        final s = (r.data['score'] as num?)?.toDouble() ?? 0;
        return (title: _moodWord(s), sub: '${r.at.month}/${r.at.day} ${_hm(r.at)}', trailing: '${s.round()} / 5', icon: Icons.sentiment_satisfied_alt_outlined);
      case _Tab.place:
        return (title: r.title.isEmpty ? tr('某个地方') : r.title, sub: '${r.at.month}/${r.at.day} ${_hm(r.at)}', trailing: '', icon: Icons.place_outlined);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final rows = _rows;
    final today = DateTime.now();
    final labels = [
      for (var i = 6; i >= 0; i--) i == 0 ? tr('今天') : trWeekday(today.subtract(Duration(days: i)).weekday),
    ];
    final head = rows == null ? null : _headline(rows);
    return ClayPage(
      title: tr('关于你'),
      body: Stack(
        children: [
          RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(0, 0, 0, 120),
              children: [
                ClayFilterPills<_Tab>(
                  options: [for (final t in _Tab.values) (t, t.label)],
                  value: _tab,
                  onChanged: _switch,
                ),
                SizedBox(
                  height: 150,
                  child: Stack(
                    children: [
                      const Positioned(right: -10, top: 0, bottom: 0, child: ClayArt('pilot-rest', width: 230, fit: BoxFit.contain)),
                      Positioned(
                        left: 20,
                        bottom: 18,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(head?.label ?? '', style: TextStyle(fontSize: 13.5, color: c.grey)),
                            const SizedBox(height: 4),
                            Text(head?.value ?? '—', style: TextStyle(fontSize: 34, fontWeight: FontWeight.w700, color: c.ink, letterSpacing: -0.5)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                if (rows == null && _error == null)
                  const Padding(padding: EdgeInsets.symmetric(vertical: 60), child: Center(child: ClaySpinner(size: 20)))
                else if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 40),
                    child: Center(child: ClayButton(label: tr('没连上，点一下重试'), kind: ClayButtonKind.clay, onTap: _load)),
                  )
                else ...[
                  if (_tab != _Tab.place)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: PilotWeekBars(values: _perDay(rows!), labels: labels),
                    ),
                  const SizedBox(height: 6),
                  if (rows!.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Center(child: Text(tr('这几天还没有'), style: TextStyle(fontSize: 14, color: c.grey))),
                    ),
                  for (final (i, r) in rows.take(40).indexed) ...[
                    if (i > 0) Padding(padding: const EdgeInsets.only(left: 78, right: 20), child: Container(height: 0.6, color: c.hairline)),
                    _RecordRow(key: ValueKey(r.id), view: _row(r), onDelete: () => _delete(r)),
                  ],
                ],
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                  child: Text(_tab.hint, textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: c.grey)),
                ),
              ],
            ),
          ),
          if (_tab == _Tab.money || _tab == _Tab.weight)
            Positioned(
              right: 20,
              bottom: 24,
              child: GestureDetector(
                onTap: _add,
                child: Container(
                  width: 74,
                  height: 74,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: c.slab,
                    boxShadow: clayShadow(c, lift: 1.4),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.add_rounded, size: 26, color: c.ink),
                      Text(_tab == _Tab.weight ? tr('记体重') : tr('记一笔'), style: TextStyle(fontSize: 11.5, color: c.ink, fontWeight: FontWeight.w500)),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 一条记录: 陶土方块 + 名字 / 时间 · 来源 + 右边的数; 左滑露出红色删除块
class _RecordRow extends StatelessWidget {
  const _RecordRow({super.key, required this.view, required this.onDelete});
  final ({String title, String sub, String trailing, IconData icon}) view;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Dismissible(
      key: key!,
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onDelete(),
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 28),
        decoration: BoxDecoration(color: c.red, borderRadius: const BorderRadius.horizontal(left: Radius.circular(16))),
        child: const Icon(Icons.delete_outline_rounded, color: Colors.white),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
        child: Row(
          children: [
            ClayTile(icon: view.icon, size: 46),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(view.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: c.ink)),
                  const SizedBox(height: 2),
                  Text(view.sub, style: TextStyle(fontSize: 12.5, color: c.grey)),
                ],
              ),
            ),
            Text(view.trailing, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: c.ink)),
          ],
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  记一笔
// ════════════════════════════════════════════════════════════════

/// 记一笔: 金额大字 · 支出 / 收入 · 分类 · 备注 + 时间 · 记下. 记上了返回 true
Future<bool?> showPilotQuickSheet(BuildContext context, WidgetRef ref) =>
    showClaySheet<bool>(context, builder: (_) => const _QuickSheet());

class _QuickSheet extends ConsumerStatefulWidget {
  const _QuickSheet();

  @override
  ConsumerState<_QuickSheet> createState() => _QuickSheetState();
}

class _QuickSheetState extends ConsumerState<_QuickSheet> {
  final _amount = TextEditingController();
  final _note = TextEditingController();
  bool _income = false;
  String _cat = '吃饭';
  DateTime _at = DateTime.now();
  bool _busy = false;

  double? get _v => double.tryParse(_amount.text.trim());

  @override
  void initState() {
    super.initState();
    _amount.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_at));
    if (t == null) return;
    setState(() => _at = DateTime(_at.year, _at.month, _at.day, t.hour, t.minute));
  }

  Future<void> _save() async {
    final v = _v;
    if (v == null || v <= 0 || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(pilotCloudProvider)?.records.log([
        {
          'type': _income ? 'finance.income' : 'finance.expense',
          'occurred_at': _at.millisecondsSinceEpoch,
          'value': v,
          if (_note.text.trim().isNotEmpty) 'title': _note.text.trim(),
          'data': {'currency': 'CNY', 'category': _cat},
        },
      ]);
      HapticFeedback.mediumImpact();
      final sign = _income ? '+' : '';
      NeoxToast.show(tr('记下了 · $sign${pilotYuan(v)}'));
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      NeoxToast.show(tr('没记上：$e'));
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final now = DateTime.now();
    final day = _at.day == now.day ? tr('今天') : '${_at.month}/${_at.day}';
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ClayRoundButton(icon: Icons.close_rounded, flat: true, size: 40, onTap: () => Navigator.pop(context)),
              Expanded(child: Center(child: Text(tr('记一笔'), style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.ink)))),
              const SizedBox(width: 40),
            ],
          ),
          const SizedBox(height: 6),
          /* 金额: 「¥ 35」整体居中的大字, 打开就弹数字键盘 */
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('¥ ', style: TextStyle(fontSize: 40, fontWeight: FontWeight.w700, color: c.ink)),
              IntrinsicWidth(
                child: TextField(
                  controller: _amount,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  cursorColor: c.cobalt,
                  style: TextStyle(fontSize: 40, fontWeight: FontWeight.w700, color: c.ink, letterSpacing: -0.5),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    filled: false,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 8),
                    hintText: '0',
                    hintStyle: TextStyle(fontSize: 40, fontWeight: FontWeight.w700, color: c.faint),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Center(
            child: SizedBox(
              width: 240,
              child: ClaySegmented<bool>(
                options: [(false, tr('支出')), (true, tr('收入'))],
                value: _income,
                inkSelected: true,
                onChanged: (v) => setState(() => _income = v),
              ),
            ),
          ),
          const SizedBox(height: 18),
          LayoutBuilder(builder: (context, box) {
            final w = (box.maxWidth - 3 * 12) / 4;
            return Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                for (final (name, icon) in _cats)
                  SizedBox(
                    width: w,
                    height: math.min(w * 0.85, 72),
                    child: _CatTile(name: tr(name), icon: icon, selected: _cat == name, onTap: () => setState(() => _cat = name)),
                  ),
              ],
            );
          }),
          const SizedBox(height: 16),
          ClaySlab(
            radius: 16,
            padding: const EdgeInsets.fromLTRB(14, 0, 8, 0),
            child: Row(
              children: [
                Icon(Icons.edit_outlined, size: 18, color: c.grey),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _note,
                    style: TextStyle(fontSize: 14.5, color: c.ink),
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      filled: false,
                      hintText: tr('备注（可选）'),
                      hintStyle: TextStyle(fontSize: 14.5, color: c.faint),
                    ),
                  ),
                ),
                GestureDetector(
                  onTap: _pickTime,
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Row(children: [
                      Text('$day ${_hm(_at)}', style: TextStyle(fontSize: 13.5, color: c.ink)),
                      Icon(Icons.arrow_drop_down_rounded, size: 20, color: c.grey),
                    ]),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          ClayButton.ink(label: tr('记下'), size: ClayButtonSize.large, expand: true, busy: _busy, onTap: (_v ?? 0) > 0 ? _save : null),
        ],
      ),
    );
  }
}

/// 分类泥块: 圆形小图标 + 字; 选中 = 墨色描边 + 右上一颗钴蓝珠
class _CatTile extends StatelessWidget {
  const _CatTile({required this.name, required this.icon, required this.selected, required this.onTap});
  final String name;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return GestureDetector(
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                color: c.slab,
                border: Border.all(color: selected ? c.ink : Colors.transparent, width: 1.6),
                boxShadow: clayShadow(c, lift: selected ? 0.5 : 0.9),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: c.fill,
                      boxShadow: clayShadow(c, lift: 0.4),
                    ),
                    child: Icon(icon, size: 18, color: c.ink),
                  ),
                  const SizedBox(height: 4),
                  Text(name, style: TextStyle(fontSize: 12.5, color: c.ink, fontWeight: selected ? FontWeight.w600 : FontWeight.w400)),
                ],
              ),
            ),
          ),
          if (selected) Positioned(right: 6, top: 6, child: ClayDot(color: c.cobalt, size: 9)),
        ],
      ),
    );
  }
}

/// 记体重: 一个数
Future<bool?> showPilotWeightSheet(BuildContext context, WidgetRef ref) =>
    showClaySheet<bool>(context, builder: (_) => const _WeightSheet());

class _WeightSheet extends ConsumerStatefulWidget {
  const _WeightSheet();

  @override
  ConsumerState<_WeightSheet> createState() => _WeightSheetState();
}

class _WeightSheetState extends ConsumerState<_WeightSheet> {
  final _v = TextEditingController();

  @override
  void initState() {
    super.initState();
    _v.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _v.dispose();
    super.dispose();
  }

  double? get _kg => double.tryParse(_v.text.trim());

  Future<void> _save() async {
    final kg = _kg;
    if (kg == null || kg <= 0) return;
    try {
      await ref.read(pilotCloudProvider)?.records.log([
        {'type': 'health.weight', 'value': kg},
      ]);
      HapticFeedback.mediumImpact();
      NeoxToast.show(tr('记下了 · ${kg.toStringAsFixed(1)} kg'));
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      NeoxToast.show(tr('没记上：$e'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClaySheetHeader(title: tr('记体重')),
          TextField(
            controller: _v,
            autofocus: true,
            textAlign: TextAlign.center,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            cursorColor: c.cobalt,
            style: TextStyle(fontSize: 44, fontWeight: FontWeight.w700, color: c.ink),
            decoration: InputDecoration(
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              filled: false,
              hintText: '0.0',
              hintStyle: TextStyle(fontSize: 44, fontWeight: FontWeight.w700, color: c.faint),
              suffixText: ' kg',
              suffixStyle: TextStyle(fontSize: 20, color: c.grey),
            ),
          ),
          const SizedBox(height: 16),
          ClayButton.ink(label: tr('记下'), size: ClayButtonSize.large, expand: true, onTap: (_kg ?? 0) > 0 ? _save : null),
        ],
      ),
    );
  }
}
