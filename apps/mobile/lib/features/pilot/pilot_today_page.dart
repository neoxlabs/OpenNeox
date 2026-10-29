/// pilot_today_page.dart — Pilot 的「今天」(2026-10-11, 设计见 docs/NEOX_PILOT_ASSISTANT_DESIGN_2026_10_11.md §2)。
///
/// 打开就知道今天怎么样:
///   顶上    几号 · 问候 · 一行情境「在家 · 多云 21° · 15 点有雨」
///   要紧的三件  服务端简报挑的 (触发引擎同一个 composeBrief), 每件带一键动作
///   今天响过的  触发引擎到点推过的 (夜里攒下的标「早上并进简报」)
///   它替你办完的 近三天它做出来的成品 (PPT / 文档 / 小应用)
///   两扇门    我的世界 (八个房间) · 团队 (主管 + 专员)
/// 晨间简报、到点提醒的推送点开就是这一页。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/notifications/inbox.dart';
import '../../core/notifications/local_notifications.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../core/pilot/weather.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_toast.dart';
import 'context_sense.dart';
import 'pilot_jarvis_page.dart';
import 'pilot_link.dart';
import 'pilot_records_page.dart';
import 'pilot_talk.dart';
import 'pilot_team_page.dart';

/// 洞察的 domain → 房间的陶土图标 (跟我的世界同一套)
String clayOfDomain(String domain) => switch (domain) {
      'money' => 'i-coins',
      'home' => 'i-house',
      'social' || 'day' => 'i-person',
      'work' => 'i-laptop',
      'place' => 'i-route',
      'mood' => 'i-heart',
      'me' => 'i-book',
      _ => 'i-pulse',
    };

class PilotTodayPage extends ConsumerStatefulWidget {
  const PilotTodayPage({super.key, this.pilot});

  /// 跟谁说 (从 Pilot 页进来时带着); 点推送进来没有, 自己找主管
  final PilotContact? pilot;

  @override
  ConsumerState<PilotTodayPage> createState() => _PilotTodayPageState();
}

class _PilotTodayPageState extends ConsumerState<PilotTodayPage> {
  PilotToday? _today;
  WeatherNow? _weather;
  PilotContact? _pilot;
  String? _error;
  /// 点过一键动作的那几件: 卡片收成「办好了」
  final Set<String> _done = {};

  PilotRecordsApi? get _api => ref.read(pilotCloudProvider)?.records;

  /// 点推送进来的那一条 —— 摆在最上面, 能直接办 (2026-10-11 用户: Pilot 发个推送, 点进去啥也没有)
  Map<String, Object?>? _tapped;

  @override
  void initState() {
    super.initState();
    _pilot = widget.pilot;
    _tapped = InboxStore.instance.takeOpenItem();
    /* 已经停在这页时又点了一条: app.dart 不会再推一层, 这里自己接 */
    InboxStore.instance.openRequests.addListener(_onOpenRequest);
    unawaited(_load());
    unawaited(_loadWeather());
    if (_pilot == null) unawaited(_findChief());
  }

  void _onOpenRequest() {
    if (InboxStore.instance.openTarget != 'pilot_today') return;
    final it = InboxStore.instance.takeOpenItem();
    if (it != null && mounted) setState(() => _tapped = it);
    unawaited(_load());
  }

  @override
  void dispose() {
    InboxStore.instance.openRequests.removeListener(_onOpenRequest);
    super.dispose();
  }

  Future<void> _snoozeTapped(String title, String body) async {
    final at = DateTime.now().add(const Duration(minutes: 30));
    try {
      await LocalNotifications.scheduleReminder(title: body.isEmpty ? title : '$title：$body', at: at);
      HapticFeedback.mediumImpact();
      _toast(tr('好，半小时后再提醒你'));
      setState(() => _tapped = null);
    } catch (e) {
      _toast(tr('提醒没排上：$e'));
    }
  }

  Future<void> _findChief() async {
    try {
      final list = await ref.read(pilotLinkProvider).listPilots();
      if (mounted && list.isNotEmpty) setState(() => _pilot = list.first);
    } catch (_) {}
  }

  Future<void> _load() async {
    final api = _api;
    if (api == null) return;
    try {
      final t = await api.today();
      if (mounted) setState(() { _today = t; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = '$e'.replaceFirst('Bad state: ', ''));
    }
  }

  Future<void> _loadWeather() async {
    final at = await ref.read(contextSenseProvider.notifier).whereNow();
    if (at == null) return;
    final w = await fetchWeather(at.$1, at.$2);
    if (mounted && w != null) setState(() => _weather = w);
  }

  // ───────── 动作 ─────────

  /// 简报里的一件 → 对应的洞察 (拿它的动作和房间); 夜里攒下的提醒没有洞察
  PilotInsight? _insightOf(String item) => _today?.overview.insights.where((i) => i.title == item).firstOrNull;

  Future<void> _act(String item, PilotInsight? ins) async {
    final a = ins?.action;
    if (a == null) {
      await _ask(ins == null ? tr('提醒我的这件事：「$item」。现在该做什么？能替我办的直接办。') : tr('关于「${ins.title}」：${ins.detail} 给我一个今天就能做的办法，能替我办的直接办，说短一点。'), title: item);
      return;
    }
    switch (a['kind']) {
      case 'remind':
        final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch('${a['at']}');
        if (m == null) return;
        final now = DateTime.now();
        var at = DateTime(now.year, now.month, now.day, int.parse(m[1]!), int.parse(m[2]!));
        if (!at.isAfter(now)) at = at.add(const Duration(days: 1));
        try {
          await LocalNotifications.scheduleReminder(title: '${a['title']}', at: at);
          HapticFeedback.mediumImpact();
          setState(() => _done.add(item));
          final dayWord = at.day == now.day ? tr('今天') : tr('明天');
          final timeText = a['at'];
          _toast(tr('好，$dayWord $timeText 提醒你'));
        } catch (e) {
          _toast(tr('提醒没排上：$e'));
        }
      case 'checkin':
        final habit = '${a['habit']}';
        await _api?.log([{'type': 'habit.check', 'occurred_at': DateTime.now().millisecondsSinceEpoch, 'data': {'habit': habit, 'done': true}}]);
        HapticFeedback.mediumImpact();
        setState(() => _done.add(item));
        _toast(tr('$habit 打卡 ✓'));
      default:
        await _ask('${a['prompt']}', title: '${a['label']}');
    }
  }

  /// 交给它办: 底板里等它说完 (它能动手: 记录、提醒、查、做)
  Future<void> _ask(String prompt, {required String title}) async {
    final pilot = _pilot;
    if (pilot == null) {
      _toast(tr('还没有 Pilot'));
      return;
    }
    final answer = ref.read(pilotTalkProvider).ask(pilot, prompt);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _AnswerSheet(title: title, answer: answer, pilotName: pilot.name),
    );
    unawaited(_load());
  }

  void _toast(String s) => NeoxToast.show(s);

  // ───────── 画 ─────────

  String get _hello {
    final h = DateTime.now().hour;
    if (h < 5) return tr('夜深了');
    if (h < 11) return tr('早上好');
    if (h < 14) return tr('中午好');
    if (h < 18) return tr('下午好');
    return tr('晚上好');
  }

  String get _date {
    final d = DateTime.now();
    return '${tr('${d.month} 月 ${d.day} 日')} · ${trWeekday(d.weekday)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final sense = ref.watch(contextSenseProvider);
    final t = _today;
    final items = t?.briefItems ?? const <String>[];
    final where = sense.state == null ? null : (sense.away ? tr('在外地 · ${sense.city}') : tr(ctxStateZh[sense.state] ?? ''));

    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            await Future.wait([_load(), _loadWeather()]);
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, 120),
            children: [
              Row(children: [
                IconButton(
                  padding: EdgeInsets.zero,
                  alignment: Alignment.centerLeft,
                  icon: const Icon(Icons.arrow_back_ios_new, size: 20),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                const Spacer(),
              ]),
              Text(_date, style: theme.textTheme.labelLarge?.copyWith(color: mute, letterSpacing: 0.5)),
              const SizedBox(height: 4),
              Text(_hello, style: theme.textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -1)),
              const SizedBox(height: NeoxSpace.md),
              /* 一行情境: 在哪 · 天气 */
              Wrap(spacing: 8, runSpacing: 8, children: [
                if (where != null && where.isNotEmpty) _Chip(clay: sense.state == 'home' ? 'i-house' : 'i-route', text: where),
                if (_weather != null) _Chip(clay: _weather!.raining || _weather!.rainAt != null ? 'i-cloud' : 'i-sun', text: _weather!.line, warn: _weather!.rainAt != null),
              ]),
              const SizedBox(height: NeoxSpace.xl),
              if (_tapped != null) ...[
                _Section(title: tr('刚才找你的')),
                _TappedCard(
                  title: '${_tapped!['title'] ?? ''}',
                  body: '${_tapped!['body'] ?? ''}',
                  onAct: () {
                    final title = '${_tapped!['title'] ?? ''}';
                    final body = '${_tapped!['body'] ?? ''}';
                    setState(() => _tapped = null);
                    unawaited(_ask(tr('你刚才提醒我：「$title：$body」。现在该做什么？能替我办的直接办，说短一点。'), title: title));
                  },
                  onSnooze: () => _snoozeTapped('${_tapped!['title'] ?? ''}', '${_tapped!['body'] ?? ''}'),
                  onDismiss: () => setState(() => _tapped = null),
                ),
                const SizedBox(height: NeoxSpace.xl),
              ],
              _Section(title: items.isEmpty ? tr('今天') : tr('要紧的 ${items.length} 件')),
              if (t == null && _error == null)
                const Padding(padding: EdgeInsets.symmetric(vertical: 40), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
              else if (_error != null)
                _Calm(clay: 'i-cloud', text: tr('没连上：$_error'), onTap: _load)
              else if (items.isEmpty)
                _Calm(clay: 'i-sun', text: tr('今天没什么要紧的。记点东西，它会越来越懂你。'))
              else
                for (final it in items) ...[
                  _BriefCard(
                    item: it,
                    insight: _insightOf(it),
                    done: _done.contains(it),
                    onAct: () => _act(it, _insightOf(it)),
                    onTalk: () => _ask(
                      _insightOf(it) == null ? tr('「$it」这件事你怎么看？') : tr('关于「${_insightOf(it)!.title}」：${_insightOf(it)!.detail} 你怎么看？说短一点。'),
                      title: it,
                    ),
                  ),
                  const SizedBox(height: NeoxSpace.md),
                ],
              if ((t?.fired ?? const []).isNotEmpty) ...[
                const SizedBox(height: NeoxSpace.lg),
                _Section(title: tr('今天到点的')),
                /* 同一句只留最新一次 (改过触发 / 重装后会再响一遍) */
                for (final f in {for (final f in t!.fired.reversed) '${f['text']}': f}.values.toList().reversed) _FiredRow(f: f),
              ],
              const SizedBox(height: NeoxSpace.lg),
              _Section(title: tr('它替你办完的')),
              if ((t?.done ?? const []).isEmpty)
                _Hint(
                  clay: 'i-doc',
                  text: tr('说一句「做个周会 PPT」「给我做个投票器」，做好放这里'),
                  onTap: () => _ask(tr('我想让你帮我做个东西，你能做哪些？举三个例子，一句一个。'), title: tr('能帮我做什么')),
                )
              else
                for (final d in t!.done) _DoneRow(d: d),
              const SizedBox(height: NeoxSpace.xl),
              Row(children: [
                Expanded(
                  child: _Door(
                    art: 'assets/twin/world-life.webp',
                    title: tr('我的世界'),
                    sub: tr('八个房间'),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotRecordsPage(pilot: _pilot))).then((_) => _load()),
                  ),
                ),
                const SizedBox(width: NeoxSpace.md),
                Expanded(
                  child: _Door(
                    art: NeoxClay.of('i-team'),
                    title: tr('团队'),
                    sub: tr('主管 + 专员'),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotTeamPage(pilot: _pilot))),
                  ),
                ),
              ]),
            ],
          ),
        ),
      ),
      /* 跟它说: 去它本人那页 (形象 + 说话) */
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      floatingActionButton: _pilot == null
          ? null
          : GestureDetector(
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotJarvisPage(pilot: _pilot!))),
              child: Container(
                height: 52,
                padding: const EdgeInsets.symmetric(horizontal: 22),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface,
                  borderRadius: NeoxRadius.pillR,
                  boxShadow: const [BoxShadow(color: Color(0x22000000), blurRadius: 16, offset: Offset(0, 6))],
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Image.asset(NeoxClay.of('i-mic'), width: 26, height: 26, filterQuality: FilterQuality.medium),
                  const SizedBox(width: 10),
                  Text(tr('跟${_pilot!.name}说'), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                ]),
              ),
            ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title});
  final String title;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: NeoxSpace.sm),
        child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
      );
}

class _Chip extends StatelessWidget {
  const _Chip({required this.clay, required this.text, this.warn = false});
  final String clay;
  final String text;
  final bool warn;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(6, 4, 14, 4),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: NeoxRadius.pillR,
        border: Border.all(color: warn ? NeoxBrand.blue.withValues(alpha: 0.35) : theme.colorScheme.outlineVariant.withValues(alpha: 0.6)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Image.asset(NeoxClay.of(clay), width: 24, height: 24, filterQuality: FilterQuality.medium),
        const SizedBox(width: 6),
        Text(text, style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

/// 点推送进来的那一条: 说了什么 + 三个出口 (交给它办 / 半小时后再提醒 / 知道了)
class _TappedCard extends StatelessWidget {
  const _TappedCard({required this.title, required this.body, required this.onAct, required this.onSnooze, required this.onDismiss});
  final String title;
  final String body;
  final VoidCallback onAct;
  final VoidCallback onSnooze;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    Widget quiet(String label, VoidCallback onTap) => GestureDetector(
          onTap: onTap,
          child: Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: NeoxRadius.pillR),
            child: Text(label, style: TextStyle(color: theme.colorScheme.onSurface, fontWeight: FontWeight.w600, height: 1.25)),
          ),
        );
    return Container(
      padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, NeoxSpace.lg, NeoxSpace.lg, NeoxSpace.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: NeoxBrand.blue.withValues(alpha: 0.35)),
        boxShadow: const [BoxShadow(color: Color(0x12000000), blurRadius: 14, offset: Offset(0, 4))],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Image.asset(NeoxClay.of('i-calendar'), width: 36, height: 36, filterQuality: FilterQuality.medium),
          const SizedBox(width: NeoxSpace.md),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700, height: 1.25)),
              if (body.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(body, style: theme.textTheme.bodySmall?.copyWith(color: mute, height: 1.45)),
              ],
            ]),
          ),
        ]),
        const SizedBox(height: NeoxSpace.md),
        Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          quiet(tr('知道了'), onDismiss),
          const SizedBox(width: 8),
          quiet(tr('半小时后'), onSnooze),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: onAct,
            child: Container(
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
              decoration: NeoxBrand.clayBlue(NeoxRadius.pillR),
              child: Text(tr('交给它办'), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, height: 1.25)),
            ),
          ),
        ]),
      ]),
    );
  }
}

/// 要紧的一件: 房间图标 · 标题 · 一句带数的说明 · 一键动作
class _BriefCard extends StatelessWidget {
  const _BriefCard({required this.item, required this.insight, required this.done, required this.onAct, required this.onTalk});
  final String item;
  final PilotInsight? insight;
  final bool done;
  final VoidCallback onAct;
  final VoidCallback onTalk;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final ins = insight;
    final label = done ? tr('办好了') : '${ins?.action?['label'] ?? tr('交给它')}';
    return GestureDetector(
      onTap: onTalk,
      child: Container(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, NeoxSpace.lg, NeoxSpace.lg, NeoxSpace.md),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(22),
          border: ins?.tone == 'watch' ? Border.all(color: const Color(0xFFE8A35A).withValues(alpha: 0.45)) : null,
          boxShadow: const [BoxShadow(color: Color(0x12000000), blurRadius: 14, offset: Offset(0, 4))],
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Image.asset(NeoxClay.of(ins == null ? 'i-calendar' : clayOfDomain(ins.domain)), width: 36, height: 36, filterQuality: FilterQuality.medium),
            const SizedBox(width: NeoxSpace.md),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(item, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700, height: 1.25)),
                if (ins != null && ins.detail.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(ins.detail, maxLines: 3, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: mute, height: 1.45)),
                ],
              ]),
            ),
          ]),
          const SizedBox(height: NeoxSpace.md),
          Align(
            alignment: Alignment.centerRight,
            child: GestureDetector(
              onTap: done ? null : onAct,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                height: 36,
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
                decoration: done
                    ? BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: NeoxRadius.pillR)
                    : NeoxBrand.clayBlue(NeoxRadius.pillR),
                child: Text(label, style: TextStyle(color: done ? mute : Colors.white, fontWeight: FontWeight.w600, height: 1.25)),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

class _FiredRow extends StatelessWidget {
  const _FiredRow({required this.f});
  final Map<String, dynamic> f;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final at = DateTime.fromMillisecondsSinceEpoch((f['at'] as num?)?.toInt() ?? 0);
    final late = f['result'] == 'deferred' || f['result'] == 'briefed';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        Image.asset(NeoxClay.of('i-calendar'), width: 26, height: 26, filterQuality: FilterQuality.medium),
        const SizedBox(width: NeoxSpace.md),
        Expanded(child: Text('${f['text']}', style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600))),
        Text(late ? tr('夜里，并进早报') : '${at.hour}:${at.minute.toString().padLeft(2, '0')}',
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      ]),
    );
  }
}

class _DoneRow extends StatelessWidget {
  const _DoneRow({required this.d});
  final Map<String, dynamic> d;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final url = d['url'] as String?;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        /* 点开: 浏览器打开 (文档下载后用 WPS / Office 开, 小应用直接能用); 长按: 把链接发给别人 */
        onTap: url == null ? null : () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
        onLongPress: url == null ? null : () => Share.share('${d['title'] ?? ''} $url'),
        child: Row(children: [
          Image.asset(NeoxClay.of(url != null && url.contains('/app/') ? 'i-app' : 'i-doc'), width: 32, height: 32, filterQuality: FilterQuality.medium),
          const SizedBox(width: NeoxSpace.md),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${d['title'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
              Text(
                url == null ? '${d['text'] ?? ''}' : tr('点开 · 长按发给别人'),
                style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.clay, required this.text, this.onTap});
  final String clay;
  final String text;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(NeoxSpace.md),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6)),
        ),
        child: Row(children: [
          Image.asset(NeoxClay.of(clay), width: 32, height: 32, filterQuality: FilterQuality.medium),
          const SizedBox(width: NeoxSpace.md),
          Expanded(child: Text(text, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant, height: 1.4))),
        ]),
      ),
    );
  }
}

class _Calm extends StatelessWidget {
  const _Calm({required this.clay, required this.text, this.onTap});
  final String clay;
  final String text;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: NeoxSpace.xl),
          child: Column(children: [
            Image.asset(NeoxClay.of(clay), width: 72, height: 72, filterQuality: FilterQuality.medium),
            const SizedBox(height: NeoxSpace.sm),
            Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ]),
        ),
      );
}

/// 两扇门: 我的世界 / 团队
class _Door extends StatelessWidget {
  const _Door({required this.art, required this.title, required this.sub, required this.onTap});
  final String art;
  final String title;
  final String sub;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 150,
        padding: const EdgeInsets.all(NeoxSpace.md),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(22),
          boxShadow: const [BoxShadow(color: Color(0x12000000), blurRadius: 14, offset: Offset(0, 4))],
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Center(child: Image.asset(art, fit: BoxFit.contain, filterQuality: FilterQuality.medium))),
          Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
          Text(sub, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
        ]),
      ),
    );
  }
}

/// 交给它办 → 等它说完
class _AnswerSheet extends StatelessWidget {
  const _AnswerSheet({required this.title, required this.answer, required this.pilotName});
  final String title;
  final Future<String> answer;
  final String pilotName;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.xl),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: NeoxSpace.md),
            Flexible(
              child: FutureBuilder<String>(
                future: answer,
                builder: (c, s) => s.connectionState != ConnectionState.done
                    ? Row(children: [
                        const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        const SizedBox(width: NeoxSpace.md),
                        Text(tr('$pilotName 在办…'), style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                      ])
                    : SingleChildScrollView(
                        child: Text(s.hasError ? tr('没办成：${s.error}') : (s.data?.trim().isEmpty ?? true ? tr('办好了') : s.data!.trim()),
                            style: theme.textTheme.bodyLarge?.copyWith(height: 1.55)),
                      ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
