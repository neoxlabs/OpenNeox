/// pilot_jarvis_page.dart — 手机上的 Pilot 本人 (2026-10-01 用户: Pilot 是单独的一个界面, 渲染一个宠物,
/// 语音对话, 整个一个贾维斯的感觉; 对话可以切换, 但正常不用切换)。
///
/// 2026-10-14 Pilot 改成 IM 以后这页只当「房间」: 资料页「它替你看着的」点一格进来。
///   顶     ← · 房间名 · 电话 (让它现在打给你)
///   场景   一间房, 猫在里面; 头上一个泥气泡说那件事。左右滑换房间: 今天 / 钱 / 身体 / 足迹 / 关系
///   今天   一件事当场办 (墨色「好，设提醒」/ 陶土「晚点说」) + 还有 N 件, 每件一行
///   房间   三个数 (不加框) + 一件能办的事 + 一行入口
///   底     键盘 (切到聊天) · 按住说话 (松手就发; 点一下 = 说一句, 停顿 1.3 秒自动发) · 相机
///
/// 话交给云端的它 (pilot_talk.dart), 回话边推边念。
/// 声音按设置 (订阅 / 自己的阿里云 Key / 本地模型, core/voice/pilot_voice.dart), 不经电脑。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/notifications/local_notifications.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../core/privacy/ai_consent.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';
import '../voice/inline_voice.dart';
import 'call/pilot_call_controller.dart';
import 'context_sense.dart';
import 'pilot_ears.dart';
import 'pilot_link.dart';
import 'pilot_about_page.dart';
import 'pilot_stage.dart';
import 'pilot_talk.dart';
import 'spoken_lead.dart';

enum _Mood { idle, listening, thinking, speaking }

const _endOfTurn = Duration(milliseconds: 1300);

/// 2026-10-14 Pilot 改成 IM (会话列表 → 聊天 → 资料页) 以后, 这一页只当「房间」用:
/// 资料页「它替你看着的」点一格进来, 停在那间房; 左上返回, 键盘 / 点气泡 = 回聊天。
class PilotJarvisPage extends ConsumerStatefulWidget {
  const PilotJarvisPage({super.key, required this.pilot, this.initialRoom = PilotRoom.today});
  final PilotContact pilot;
  final PilotRoom initialRoom;

  @override
  ConsumerState<PilotJarvisPage> createState() => _PilotJarvisPageState();
}

class _PilotJarvisPageState extends ConsumerState<PilotJarvisPage> with WidgetsBindingObserver {
  _Mood _mood = _Mood.idle;
  String _heard = '';
  DateTime _lastHeard = DateTime.now();
  InlineVoiceController? _voice;
  Timer? _endTimer;
  Timer? _levelTick;
  Timer? _boardTick;
  double _level = 0;
  PilotBoard _board = const PilotBoard([], []);
  String? _answering;

  /// 按住说话 (松手就发) 还是点一下说 (停顿自动发)
  bool _holding = false;

  String get _sid => widget.pilot.sessionId;
  /* initState 里先拿住: dispose 里还要用 (停声), 那时 ref 已经不能用了 */
  late final PilotLink _link = ref.read(pilotLinkProvider);
  late final PilotTalk _talk = ref.read(pilotTalkProvider);

  /// 这一轮: 你说的、它最后说的
  String _said = '';
  String _lastAnswer = '';

  /// 刚办完的一句回执 (「设好了，14 号晚上提醒你」), 2 秒后收起
  String? _receipt;
  Timer? _receiptTimer;


  /// 房间
  late final _pages = PageController(initialPage: widget.initialRoom.index);
  late int _room = widget.initialRoom.index;

  /// 洞察 + 房间的数 (服务端算好的)
  PilotOverview? _overview;

  /// 点过「晚点说」/ 办完的那几件
  final Set<String> _dismissed = {};
  final Set<String> _done = {};

  /// 想聊天 = 回到聊天页 (这页是从聊天 → 资料 → 房间进来的)
  Future<void> _setChat(bool on) async {
    HapticFeedback.selectionClick();
    if (on && mounted) Navigator.of(context).maybePop();
  }

  final _scaffold = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    _link;
    _talk;
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      /* 跟 Pilot 说的话会发给 AI 模型 —— 第一次进来先问 (App Store 5.1.2(i)), 不同意就退出 */
      if (!await ensureAiDataConsent(context)) {
        if (mounted) Navigator.of(context).maybePop();
        return;
      }
      if (!mounted) return;
      unawaited(_refreshBoard(markRead: true));
      unawaited(_loadOverview());
    });
    /* 板上的事随时会变 (它汇报了 / 你在电脑上点了), 页面开着时每 20 秒对一次 */
    _boardTick = Timer.periodic(const Duration(seconds: 20), (_) => _refreshBoard(markRead: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _endTimer?.cancel();
    _levelTick?.cancel();
    _boardTick?.cancel();
    _receiptTimer?.cancel();
    _voice?.dispose();
    _pages.dispose();
    unawaited(_link.stopSpeaking());
    super.dispose();
  }

  Future<void> _refreshBoard({bool markRead = false}) async {
    try {
      final b = await _link.board(_sid);
      if (!mounted) return;
      setState(() => _board = b);
      /* 这一页开着 = 你看到了它的汇报: 告诉电脑, 别再为它打电话 */
      if (markRead && b.reports.any((r) => !r.read)) unawaited(_link.markRead(_sid));
    } catch (_) {/* 连不上也没缓存: 板空着, 说话照常会报错 */}
  }

  Future<void> _loadOverview() async {
    try {
      final o = await ref.read(pilotCloudProvider)?.records.overview();
      if (mounted && o != null) setState(() => _overview = o);
    } catch (_) {/* 没网: 房间里的数先空着 */}
  }

  void _setMood(_Mood m) {
    if (mounted) setState(() => _mood = m);
  }

  // ───────── 说话 ─────────

  /// 点猫 / 点说话键: 待机 → 听, 在听 → 发, 在说 → 停
  Future<void> _onOrb() async {
    switch (_mood) {
      case _Mood.idle:
        await _listen();
      case _Mood.listening:
        await _finishListening();
      case _Mood.speaking:
        await _link.stopSpeaking();
        _setMood(_Mood.idle);
      case _Mood.thinking:
        break;
    }
  }

  Future<void> _holdStart() async {
    if (_mood == _Mood.speaking) await _link.stopSpeaking();
    if (_mood != _Mood.idle && _mood != _Mood.speaking) return;
    _holding = true;
    await _listen();
  }

  Future<void> _holdEnd() async {
    if (!_holding) return;
    _holding = false;
    if (_mood == _Mood.listening) await _finishListening();
  }

  Future<void> _listen() async {
    _heard = '';
    _setMood(_Mood.listening);
    _voice?.dispose();
    try {
      _voice = await startPilotEars(
        ref,
        onText: (t) {
          if (t.trim() == _heard.trim()) return;
          _heard = t;
          _lastHeard = DateTime.now();
          if (mounted) setState(() {});
        },
        onError: (msg) {
          NeoxToast.show(msg);
          _setMood(_Mood.idle);
        },
      );
    } catch (_) {
      _setMood(_Mood.idle);
      return;
    }
    _levelTick?.cancel();
    _levelTick = Timer.periodic(const Duration(milliseconds: 80), (_) {
      final lv = _voice?.levels.isNotEmpty == true ? _voice!.levels.last : 0.0;
      if (mounted && (lv - _level).abs() > 0.02) setState(() => _level = lv);
    });
    _endTimer?.cancel();
    /* 按住说话时等松手; 点一下说时停顿 1.3 秒自动发 */
    _endTimer = Timer.periodic(const Duration(milliseconds: 200), (t) {
      if (_holding || _mood != _Mood.listening || _heard.trim().isEmpty) return;
      if (DateTime.now().difference(_lastHeard) < _endOfTurn) return;
      t.cancel();
      unawaited(_finishListening());
    });
  }

  Future<void> _finishListening() async {
    _endTimer?.cancel();
    _levelTick?.cancel();
    _level = 0;
    await _voice?.stop(); /* 云端识别在 stop 时才出整段 */
    final text = _heard.trim();
    if (text.isEmpty) {
      _setMood(_Mood.idle);
      return;
    }
    await _ask(text, speakReply: true);
  }

  /// 话交给云端的它, 第一句写完就念 (不等整轮, 它可能还要调工具)
  Future<void> _ask(String text, {required bool speakReply}) async {
    setState(() {
      _said = text.startsWith('「') ? '' : text;
      _lastAnswer = '';
      _receipt = null;
    });
    _setMood(_Mood.thinking);
    var early = '';
    Future<String?>? firstSay;
    /* 这一轮念稿的凭证: 用户点停 / 下一次说话都让这一轮作废 (pilot:U-20) */
    final say = speakReply ? _link.narration() : null;
    final answer = await _talk.ask(
      widget.pilot,
      text,
      onLead: say == null
          ? null
          : (lead) {
              early = lead;
              _setMood(_Mood.speaking);
              firstSay = say.say(lead, sessionId: _sid);
            },
    );
    unawaited(_refreshBoard(markRead: true));
    unawaited(_loadOverview());
    if (!mounted) return;
    setState(() => _lastAnswer = _spoken(answer));
    if (firstSay != null) await firstSay;
    if (speakReply && answer.isNotEmpty) {
      final rest = leadRemainder(early, _spoken(answer));
      /* 点过停: 后面这一句也不再念 (以前停了半秒又开口) */
      if (rest.isNotEmpty && !(say?.stopped ?? true)) {
        _setMood(_Mood.speaking);
        await say!.say(rest, sessionId: _sid);
      }
    }
    /* 用户点过停: 界面归他刚才那一下管 (可能已经在听下一句), 别拨回待机 */
    if (say != null && say.stopped) return;
    _setMood(_Mood.idle);
  }

  String _spoken(String s) => s
      .replaceAll(RegExp(r'```[\s\S]*?```'), '')
      .replaceAll(RegExp(r'[*_`#>|]'), '')
      .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1] ?? '')
      .trim();

  Future<void> _decide(PilotReport r, String option) async {
    if (_answering != null) return;
    setState(() => _answering = r.id);
    await _link.answerReport(r.id, option);
    await _ask('「${r.title}」: $option', speakReply: false);
    if (mounted) setState(() => _answering = null);
  }

  /// 办完一件: 气泡换成回执, 2 秒后收起
  void _showReceipt(String text) {
    HapticFeedback.mediumImpact();
    _receiptTimer?.cancel();
    setState(() => _receipt = text);
    _receiptTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _receipt = null);
    });
  }

  /// 一条发现的一键动作: 定提醒 / 打卡 / 交给它办
  Future<void> _act(PilotInsight ins) async {
    final a = ins.action;
    if (a == null) {
      await _ask(tr('关于「${ins.title}」：${ins.detail} 给我一个今天就能做的办法，能替我办的直接办，说短一点。'), speakReply: false);
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
          if (!mounted) return;
          setState(() => _done.add(ins.id));
          final dayWord = at.day == now.day ? tr('今天') : tr('明天');
          final timeText = a['at'];
          _showReceipt(tr('设好了，$dayWord $timeText 提醒你'));
        } catch (e) {
          NeoxToast.show(tr('提醒没排上：$e'));
        }
      case 'checkin':
        final habit = '${a['habit']}';
        await ref.read(pilotCloudProvider)?.records.log([
          {'type': 'habit.check', 'occurred_at': DateTime.now().millisecondsSinceEpoch, 'data': {'habit': habit, 'done': true}},
        ]);
        if (!mounted) return;
        setState(() => _done.add(ins.id));
        _showReceipt(tr('$habit 打卡 ✓'));
      default:
        setState(() => _done.add(ins.id));
        await _ask('${a['prompt']}', speakReply: false);
    }
  }

  void _later(String id) {
    HapticFeedback.selectionClick();
    setState(() => _dismissed.add(id));
  }

  // ───────── 底部: 键盘 / 相机 ─────────

  /// 键盘 = 切到聊天 (打字、发图、翻历史都在那)
  void _keyboard() => _setChat(true);

  /// 相机 = 回聊天 (拍票据 / 拍药盒 / 拍白板在聊天的 ＋ 里)
  void _camera() => _setChat(true);

  // ───────── 界面 ─────────

  List<PilotInsight> get _insights => [
        for (final i in _overview?.insights ?? const <PilotInsight>[])
          if (!_dismissed.contains(i.id)) i,
      ]..sort((a, b) {
          /* 要留神的在前, 同档按分数 */
          final t = (b.tone == 'watch' ? 1 : 0) - (a.tone == 'watch' ? 1 : 0);
          return t != 0 ? t : b.score.compareTo(a.score);
        });

  List<PilotInsight> _roomInsights(PilotRoom r) => [for (final i in _insights) if (pilotRoomOf(i) == r) i];

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final room = PilotRoom.values[_room];

    return Scaffold(
      key: _scaffold,
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Column(
          children: [
            _header(room),
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  AspectRatio(
                    aspectRatio: 1.36,
                    child: PageView.builder(
                      controller: _pages,
                      itemCount: PilotRoom.values.length,
                      onPageChanged: (i) {
                        HapticFeedback.selectionClick();
                        setState(() => _room = i);
                      },
                      itemBuilder: (_, i) {
                        final r = PilotRoom.values[i];
                        return PilotScene(
                          room: r,
                          bubble: i == _room ? _bubble(r) : null,
                          onTapCat: () {
                            HapticFeedback.lightImpact();
                            unawaited(_onOrb());
                          },
                          onLongPressCat: _mood == _Mood.idle ? _keyboard : null,
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: 14),
                  PilotPageDots(count: PilotRoom.values.length, index: _room),
                  const SizedBox(height: 18),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 220),
                      child: KeyedSubtree(key: ValueKey(room), child: _roomBody(room)),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
            PilotVoiceBar(
              state: switch (_mood) {
                _Mood.idle => PilotVoiceState.idle,
                _Mood.listening => PilotVoiceState.listening,
                _Mood.thinking => PilotVoiceState.thinking,
                _Mood.speaking => PilotVoiceState.speaking,
              },
              level: _level,
              onKeyboard: _keyboard,
              onCamera: _camera,
              onTap: () => unawaited(_onOrb()),
              onHoldStart: () => unawaited(_holdStart()),
              onHoldEnd: () => unawaited(_holdEnd()),
            ),
          ],
        ),
      ),
    );
  }

  /// 顶栏: ☰ · 名字 ▾ (今天) / 房间名 (其它房间) · 电话
  Widget _header(PilotRoom room) {
    final c = ClayInk.of(context);
    return SizedBox(
      height: 56,
      child: Row(
        children: [
          const SizedBox(width: 8),
          ClayRoundButton(
            icon: Icons.arrow_back_rounded,
            flat: true,
            size: 44,
            tooltip: MaterialLocalizations.of(context).backButtonTooltip,
            onTap: () => Navigator.of(context).maybePop(),
          ),
          /* 只写房间名: 它的设置 (模型 / 在哪工作 / 权限) 都在资料页, 这里不再挂一份菜单 */
          Expanded(
            child: Center(
              child: Text(
                room == PilotRoom.today ? widget.pilot.name : room.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink),
              ),
            ),
          ),
          ClayRoundButton(
            icon: Icons.phone_in_talk_outlined,
            size: 44,
            tooltip: tr('让它打给你'),
            onTap: () => ref.read(pilotCallControllerProvider).callOut(widget.pilot),
          ),
          const SizedBox(width: 12),
        ],
      ),
    );
  }

  /// 场景上的气泡: 在听 → 你说的 / 在想 → 三个点 / 刚回 → 它说的 / 回执 / 今天那件事
  Widget? _bubble(PilotRoom room) {
    if (_mood == _Mood.listening) {
      return _heard.isEmpty
          ? const PilotBubble(key: ValueKey('lv'), child: _LiveLevel())
          : PilotBubble.text(_heard, key: const ValueKey('heard'), muted: true);
    }
    if (_mood == _Mood.thinking) return const PilotBubble(key: ValueKey('think'), child: PilotThinkingDots());
    if (_receipt != null) return PilotBubble.text(_receipt!);
    final line = _lastAnswer.isNotEmpty ? _lastAnswer : _said;
    if (line.isNotEmpty) return PilotBubble.text(line, onTap: () => _setChat(true));
    if (room != PilotRoom.today) return null;
    final t = _thing();
    if (t != null) return PilotBubble.text(t.text);
    return PilotBubble.text(tr('我在。按住下面的键跟我说话'), muted: true);
  }

  /// 今天最要紧的那一件: 等你拍板的 > 要留神的发现
  ({String text, String? go, String later, VoidCallback onGo, VoidCallback onLater})? _thing() {
    final decision = _board.reports.where((r) => r.needsDecision).firstOrNull;
    if (decision != null && !_dismissed.contains(decision.id)) {
      final opts = decision.options.isEmpty ? [tr('好，就这么办'), tr('晚点说')] : decision.options;
      return (
        text: decision.title,
        go: opts.first,
        later: opts.length > 1 ? opts[1] : tr('晚点说'),
        onGo: () => _decide(decision, opts.first),
        onLater: opts.length > 1 ? () => _decide(decision, opts[1]) : () => _later(decision.id),
      );
    }
    final ins = _insights.where((i) => !_done.contains(i.id)).firstOrNull;
    if (ins == null) return null;
    final label = ins.action?['label'] as String?;
    return (
      text: ins.suggestion == null || ins.suggestion!.isEmpty ? ins.title : '${ins.title}，${ins.suggestion}',
      go: label ?? tr('交给你'),
      later: tr('晚点说'),
      onGo: () => _act(ins),
      onLater: () => _later(ins.id),
    );
  }

  Widget _roomBody(PilotRoom room) => switch (room) {
        PilotRoom.today => _todayBody(),
        PilotRoom.money => _moneyBody(),
        PilotRoom.body => _bodyBody(),
        PilotRoom.trips => _tripsBody(),
        PilotRoom.people => _peopleBody(),
      };

  /// 行里的小按钮只放两三个字 (「今晚 8 点提醒我打给妈妈」挤掉了正文); 全句留给今天那颗大按钮
  static String _shortAction(PilotInsight i) {
    final a = i.action;
    final label = a?['label'] as String?;
    if (label != null && label.characters.length <= 6) return label;
    return switch (a?['kind']) {
      'remind' => tr('提醒我'),
      'checkin' => tr('打卡'),
      _ => tr('交给你'),
    };
  }

  /// 一件发现 → 一行
  Widget _insightRow(PilotInsight i, {bool primary = false}) => PilotThingRow(
        icon: pilotIconOf(i),
        title: i.title,
        sub: i.detail.isEmpty ? null : i.detail,
        action: _shortAction(i),
        primary: primary,
        done: _done.contains(i.id),
        onAction: () => _act(i),
        onTap: () => _ask(tr('关于「${i.title}」：${i.detail} 你怎么看？说短一点。'), speakReply: false),
      );

  Widget _hint(PilotRoom r) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(r.hint, textAlign: TextAlign.center, style: TextStyle(fontSize: 12.5, color: c.grey)),
    );
  }

  Widget _todayBody() {
    final c = ClayInk.of(context);
    final t = _thing();
    final top = _insights.where((i) => !_done.contains(i.id)).firstOrNull;
    final rest = [for (final i in _insights) if (i.id != top?.id || _board.reports.any((r) => r.needsDecision)) i].take(3).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (t != null)
          Row(
            children: [
              Expanded(child: ClayButton.ink(label: t.go ?? tr('好'), size: ClayButtonSize.large, expand: true, busy: _answering != null, onTap: t.onGo)),
              const SizedBox(width: 12),
              Expanded(child: ClayButton(label: t.later, kind: ClayButtonKind.clay, size: ClayButtonSize.large, expand: true, onTap: t.onLater)),
            ],
          ),
        if (rest.isNotEmpty) ...[
          const SizedBox(height: 22),
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 10),
            child: Text(tr('还有 ${rest.length} 件'), style: TextStyle(fontSize: 13.5, color: c.grey)),
          ),
          for (final i in rest) _insightRow(i),
        ],
        if (t == null && rest.isEmpty) _hint(PilotRoom.today),
        /* 今天到点的提醒: 一行灰字 */
        for (final r in _board.reminders.where((r) => r.at.isAfter(DateTime.now()) && r.at.difference(DateTime.now()).inHours < 24).take(2))
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(children: [
              Icon(Icons.alarm_rounded, size: 15, color: c.grey),
              const SizedBox(width: 6),
              Text('${_hm(r.at)}  ${r.title}', style: TextStyle(fontSize: 13, color: c.grey)),
            ]),
          ),
      ],
    );
  }

  Map<String, dynamic> _r(String id) => _overview?.room(id) ?? const {};

  Widget _moneyBody() {
    final money = _r('money');
    final home = _r('home');
    final bills = [for (final b in (home['bills'] as List? ?? const [])) if (b is Map) Map<String, dynamic>.from(b)];
    final unpaid = bills.where((b) => b['paid'] == false).toList();
    final owe = unpaid.fold<double>(0, (s, b) => s + ((b['amount'] as num?)?.toDouble() ?? 0));
    final scene = money['scene'] is Map ? Map<String, dynamic>.from(money['scene'] as Map) : const <String, dynamic>{};
    final save = (scene['savingsRate'] as num?)?.toDouble();
    final list = _roomInsights(PilotRoom.money);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PilotStatsRow(stats: [
          (value: _overview == null ? '—' : pilotYuan(money['monthSpent'] as num?), unit: null, label: tr('本月花了')),
          unpaid.isNotEmpty
              ? (value: pilotYuan(owe), unit: null, label: tr('待交'))
              : (value: _overview == null ? '—' : pilotYuan(money['spent7'] as num?), unit: null, label: tr('近 7 天')),
          (value: save == null ? '—' : '${save >= 0 ? '+' : ''}${(save * 100).round()}%', unit: null, label: tr('上月存下')),
        ]),
        const SizedBox(height: 18),
        if (list.isNotEmpty) _insightRow(list.first, primary: true) else _hint(PilotRoom.money),
        for (final i in list.skip(1).take(1)) _insightRow(i),
        PilotLinkRow(
          text: bills.isEmpty ? tr('看收支明细') : unpaid.isEmpty ? tr('本月账单 · 都交了') : tr('本月账单 · ${unpaid.length} 张没交'),
          onTap: () => _openRecords(),
        ),
      ],
    );
  }

  Widget _bodyBody() {
    final body = _r('body');
    final scene = body['scene'] is Map ? Map<String, dynamic>.from(body['scene'] as Map) : const <String, dynamic>{};
    final sleep = [for (final s in (scene['sleep7'] as List? ?? const [])) if (s is Map) ((s['min'] as num?)?.toDouble() ?? 0)];
    final days = [for (final s in (scene['sleep7'] as List? ?? const [])) if (s is Map) '${s['day']}'];
    /* 没记的那天是 0: 不算进平均 (不然一周只记了三天就成了「平均 2.4 小时」) */
    final slept = sleep.where((m) => m > 0).toList();
    final avg = slept.isEmpty ? null : slept.reduce((a, b) => a + b) / slept.length;
    final weight = (body['weight'] as num?)?.toDouble();
    final list = _roomInsights(PilotRoom.body);
    String dayLabel(String d, bool last) {
      if (last) return tr('今天');
      final t = DateTime.tryParse(d);
      return t == null ? '' : trWeekday(t.weekday);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PilotStatsRow(stats: [
          (value: pilotHours(avg), unit: avg == null ? null : tr('小时'), label: tr('平均睡眠')),
          (value: weight == null ? '—' : weight.toStringAsFixed(1), unit: weight == null ? null : 'kg', label: tr('体重')),
          (value: '${body['workoutsWeek'] ?? '—'}', unit: body['workoutsWeek'] == null ? null : tr('次'), label: tr('本周运动')),
        ]),
        const SizedBox(height: 18),
        if (sleep.length >= 3)
          PilotWeekBars(
            values: sleep,
            labels: [for (final (i, d) in days.indexed) dayLabel(d, i == days.length - 1)],
            caption: avg != null && avg < 390 ? tr('这周睡得少') : tr('这周睡得还行'),
          ),
        if (list.isNotEmpty) _insightRow(list.first, primary: true) else if (sleep.length < 3) _hint(PilotRoom.body),
      ],
    );
  }

  Widget _tripsBody() {
    final place = _r('place');
    final places = [for (final p in (place['places'] as List? ?? const [])) if (p is Map) Map<String, dynamic>.from(p)];
    final sense = ref.watch(contextSenseProvider);
    final city = sense.city ?? _r('home')['city'] as String?;
    final list = _roomInsights(PilotRoom.trips);
    final lastPlace = places.isEmpty ? '' : '${places.first['name']}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PilotStatsRow(stats: [
          (value: city ?? '—', unit: null, label: sense.away ? tr('在外地') : tr('现在在')),
          (value: places.isEmpty ? '—' : '${places.length}', unit: places.isEmpty ? null : tr('个'), label: tr('去过的地方')),
          (value: '${place['newThisMonth'] ?? '—'}', unit: place['newThisMonth'] == null ? null : tr('个'), label: tr('本月新去')),
        ]),
        const SizedBox(height: 18),
        for (final (n, i) in list.take(2).indexed) _insightRow(i, primary: n == 0),
        if (list.isEmpty) _hint(PilotRoom.trips),
        if (places.isNotEmpty)
          PilotLinkRow(icon: Icons.place_outlined, text: tr('最近去了 $lastPlace'), onTap: () => _openRecords()),
      ],
    );
  }

  Widget _peopleBody() {
    final people = [for (final p in (_r('people')['list'] as List? ?? const [])) if (p is Map) Map<String, dynamic>.from(p)];
    final bday = ([...people.where((p) => p['birthdayInDays'] is num)]..sort((a, b) => (a['birthdayInDays'] as num).compareTo(b['birthdayInDays'] as num))).firstOrNull;
    final quiet = ([...people.where((p) => p['lastContactDays'] is num)]..sort((a, b) => (b['lastContactDays'] as num).compareTo(a['lastContactDays'] as num))).firstOrNull;
    final list = _roomInsights(PilotRoom.people);
    final bdayName = bday?['name'];
    final quietName = quiet?['name'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PilotStatsRow(stats: [
          (value: people.isEmpty ? '—' : '${people.length}', unit: people.isEmpty ? null : tr('个'), label: tr('你在乎的人')),
          bday == null
              ? (value: '—', unit: null, label: tr('最近的生日'))
              : bday['birthdayInDays'] == 0
                  ? (value: tr('今天'), unit: null, label: tr('$bdayName生日'))
                  : (value: '${bday['birthdayInDays']}', unit: tr('天后'), label: tr('$bdayName生日')),
          quiet == null
              ? (value: '—', unit: null, label: tr('多久没联系'))
              : (value: '${quiet['lastContactDays']}', unit: tr('天'), label: tr('没联系$quietName')),
        ]),
        const SizedBox(height: 18),
        for (final (n, i) in list.take(2).indexed) _insightRow(i, primary: n == 0),
        _hint(PilotRoom.people),
      ],
    );
  }

  void _openRecords() => Navigator.of(context)
      .push(MaterialPageRoute<void>(builder: (_) => const PilotAboutPage()))
      .then((_) => _loadOverview());


  static String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

/// 气泡里「在听但还没听到字」: 跟着音量跳的竖条 (自己每帧刷新)
class _LiveLevel extends StatefulWidget {
  const _LiveLevel();

  @override
  State<_LiveLevel> createState() => _LiveLevelState();
}

class _LiveLevelState extends State<_LiveLevel> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 120), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const PilotLevelBars(level: 0.5);
}
