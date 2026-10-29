/// pilot_call_page.dart — 跟 Pilot 通话 (2026-10-01).
///
/// 两个状态:
///   来电: 头像 + 名字 + 一句原因, 接 / 挂 (从通知点进来时)
///   通话: 先说开场白 → 听你说 → 停顿 1.3 秒算说完 → 发进这个 Pilot 的会话 → 等它说完 → 说出来 → 再听
///
/// 识别用输入框同一套 (本地 sherpa / 系统 / 云端, 按语音设置); Pilot 的声音按设置 (订阅 / 自己的阿里云 Key / 本地模型, core/voice/pilot_voice.dart)。
/// 它说话的时候不听, 外放不会把自己的声音当成你的话。
library;

import 'dart:async';
import 'dart:convert';

import 'package:camera/camera.dart';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../../core/notifications/local_notifications.dart';
import '../../../shared/clay/clay.dart';
import '../../voice/inline_voice.dart';
import '../pilot_ears.dart';
import '../pilot_link.dart';
import '../pilot_talk.dart';
import '../spoken_lead.dart';
import 'pilot_call_controller.dart';

enum _Phase { ringing, connecting, speaking, listening, thinking, ended }

/// 一句话说完的判定: 识别到字以后安静这么久
const _endOfTurn = Duration(milliseconds: 1300);


class PilotCallPage extends ConsumerStatefulWidget {
  const PilotCallPage({super.key, required this.call, required this.ringing});

  final PilotCall call;
  final bool ringing;

  @override
  ConsumerState<PilotCallPage> createState() => _PilotCallPageState();
}

class _PilotCallPageState extends ConsumerState<PilotCallPage> {
  late _Phase _phase = widget.ringing ? _Phase.ringing : _Phase.connecting;
  String _caption = '';
  String? _voiceIssue;
  String _heard = '';
  DateTime _lastHeard = DateTime.now();
  InlineVoiceController? _voice;
  Timer? _endTimer;
  Timer? _clock;
  DateTime? _answeredAt;
  bool _closing = false;

  /// 📷 通话开摄像头 (前置, 让它看见你): 不推视频, 每说完一句拍一张跟着这句发 —— 跟电脑通话条同一个做法
  CameraController? _cam;
  String? _camIssue;

  Future<void> _toggleCam() async {
    if (_cam != null) {
      final c = _cam;
      setState(() => _cam = null);
      await c?.dispose();
      return;
    }
    try {
      final cams = await availableCameras();
      /* 视频通话 = 让它看见你, 用前置 (2026-10-02 用户真机反馈) */
      final front = cams.where((c) => c.lensDirection == CameraLensDirection.front).firstOrNull ?? cams.firstOrNull;
      if (front == null) {
        setState(() => _camIssue = tr('没有摄像头'));
        return;
      }
      final c = CameraController(front, ResolutionPreset.medium, enableAudio: false);
      await c.initialize();
      if (!mounted || _closing) { await c.dispose(); return; }
      setState(() { _cam = c; _camIssue = null; });
    } catch (e) {
      /* 没给相机权限 / 相机被别的 App 占着: 按钮上说清楚, 通话照常 */
      if (mounted) setState(() => _camIssue = '$e'.contains('ermission') ? tr('没有相机权限') : tr('摄像头打不开'));
    }
  }

  /// 这句话说完那一刻的画面 (JPEG); 没开或拍不到返回 null —— 拍不到就只发字, 不卡住这一轮
  Future<Map<String, Object?>?> _snap() async {
    final c = _cam;
    if (c == null || !c.value.isInitialized || c.value.isTakingPicture) return null;
    try {
      final bytes = await (await c.takePicture()).readAsBytes();
      return {'kind': 'image', 'name': 'camera.jpg', 'mime': 'image/jpeg', 'data_base64': base64Encode(bytes), 'size_bytes': bytes.length};
    } catch (_) {
      return null;
    }
  }

  /* initState 里先拿住: dispose 时 ref 已经不能用了 (挂断就抛「Cannot use ref after disposed」, 真机实录) */
  late final PilotCallController _ctl;
  late final PilotLink _link;
  late final PilotTalk _talk;
  String? get _sid => widget.call.sessionId;

  @override
  void initState() {
    super.initState();
    _ctl = ref.read(pilotCallControllerProvider);
    _link = ref.read(pilotLinkProvider);
    _talk = ref.read(pilotTalkProvider);
    _ctl.endedCallId.addListener(_onRemoteEnd);
    _ctl.answeredCallId.addListener(_onAnsweredElsewhere);
    /* 已经在通知上接了 (推送叫醒冷启动时, 控制器先收到接听、这一页后挂上监听) —— 直接转通话 */
    if (!widget.ringing || _ctl.answeredCallId.value == widget.call.id) unawaited(_begin());
  }

  @override
  void dispose() {
    _ctl.endedCallId.removeListener(_onRemoteEnd);
    _ctl.answeredCallId.removeListener(_onAnsweredElsewhere);
    unawaited(_cam?.dispose());
    _endTimer?.cancel();
    _clock?.cancel();
    _voice?.dispose();
    unawaited(_link.stopSpeaking());
    super.dispose();
  }

  void _onRemoteEnd() {
    if (_ctl.endedCallId.value == widget.call.id) _close();
  }

  /// 在通知横幅上点了接听: 这一页从来电转成通话
  void _onAnsweredElsewhere() {
    if (_ctl.answeredCallId.value == widget.call.id && _phase == _Phase.ringing) unawaited(_begin());
  }

  void _set(_Phase p, [String? caption]) {
    if (!mounted) return;
    setState(() {
      _phase = p;
      if (caption != null) _caption = caption;
    });
  }

  // ───────── 接 / 挂 ─────────

  Future<void> _answer() async {
    if (!_ctl.isRinging(widget.call.id)) { _close(); return; }
    _set(_Phase.connecting);
    /* 就在这一页里接通 —— 不另开一页 (另开再 pop 会把新开的那页弹掉) */
    if (await _ctl.accept(widget.call, openPage: false)) {
      await _begin();
    } else {
      _close();
    }
  }

  Future<void> _hangup() async {
    if (_phase == _Phase.ringing) {
      _ctl.decline(widget.call);
    } else {
      await _ctl.hangup(widget.call);
    }
    _close();
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    _phase = _Phase.ended;
    _endTimer?.cancel();
    unawaited(_voice?.stop());
    unawaited(_link.stopSpeaking());
    /* pop 而不是 maybePop: PopScope 拦的是返回键, 这里是我们自己要关 */
    if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  // ───────── 通话循环 ─────────

  Future<void> _begin() async {
    _answeredAt = DateTime.now();
    _clock = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
    final opening = widget.call.opening.trim();
    if (opening.isNotEmpty) await _say(opening, _link.narration());
    await _listen();
  }

  Future<void> _say(String text, PilotNarration say) async {
    if (_closing || say.stopped) return;
    _set(_Phase.speaking, text);
    final issue = await say.say(_spoken(text), sessionId: _sid);
    /* 挂断 / 点了停: 这不是「声音坏了」, 不要把提示挂到界面上 */
    if (mounted && !say.stopped) setState(() => _voiceIssue = issue);
  }

  Future<void> _listen() async {
    if (_closing) return;
    _heard = '';
    _set(_Phase.listening, '');
    _voice?.dispose();
    _voice = await startPilotEars(
      ref,
      onText: (t) {
        if (t.trim() == _heard.trim()) return;
        _heard = t;
        _lastHeard = DateTime.now();
        if (mounted) setState(() => _caption = t);
      },
      onError: (msg) {
        /* 「没听到说话」不是错: 系统识别十来秒没人说话就自己收工, 下面 onState 会重新开听, 不弹提示 */
        if (RegExp(r'no.?match|speech.?timeout|NO_SPEECH|没听到', caseSensitive: false).hasMatch(msg)) return;
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      },
      /* 系统识别没人说话一阵就自己停了 (模拟器实测 NO_SPEECH_DETECTED), 以前通话页就一直挂在「在听」却什么都听不见 ——
       * 停了而且还没听到字: 重新开听; 听到了字的交给下面的收口计时 */
      onState: (listening) {
        if (listening || _closing || _phase != _Phase.listening || _heard.trim().isNotEmpty) return;
        Future<void>.delayed(const Duration(milliseconds: 300), () {
          if (mounted && !_closing && _phase == _Phase.listening && _heard.trim().isEmpty) unawaited(_listen());
        });
      },
    );

    _endTimer?.cancel();
    _endTimer = Timer.periodic(const Duration(milliseconds: 200), (t) {
      if (_phase != _Phase.listening || _heard.trim().isEmpty) return;
      if (DateTime.now().difference(_lastHeard) < _endOfTurn) return;
      t.cancel();
      unawaited(_turn());
    });
  }

  Future<void> _turn() async {
    await _voice?.stop(); /* 云端识别在 stop 时才出整段, onText 会再来一次 */
    final text = _heard.trim();
    final sid = _sid;
    if (text.isEmpty || sid == null || _closing) { await _listen(); return; }
    _set(_Phase.thinking, text);

    final shot = await _snap();
    /* 话交给云端的它, 第一句写完就开口 */
    String answer;
    var early = '';
    Future<void>? firstSay;
    /* 这一轮念稿的凭证: 挂断 / 点停后, 合成回来的和后面那句都不再出声 (pilot:U-20) */
    final say = _link.narration();
    try {
      answer = await _talk.ask(
        await _contact(sid),
        shot == null
            ? text
            : '$text\n\n<neox-directive>用户开着摄像头, 附图是他说这句话时摄像头里的画面。他让你看什么就看图回答; 没提就别主动描述画面。</neox-directive>',
        attachments: [if (shot != null) shot],
        /* 第一句写完就开口, 不等整轮 */
        onLead: (lead) { early = lead; firstSay = _say(lead, say); },
      );
    } catch (_) {
      _set(_Phase.thinking, tr('没听清, 再说一次'));
      await _listen();
      return;
    }
    if (firstSay != null) await firstSay;
    if (_closing) return;
    final rest = answer.isEmpty ? '' : leadRemainder(early, _spoken(answer));
    if (rest.isNotEmpty) await _say(rest, say);
    await _listen();
  }

  /// 这通电话是哪个 Pilot (人设 / 分工): 联系人列表里找, 找不到就按来电上的名字
  PilotContact? _who;
  Future<PilotContact> _contact(String sid) async {
    if (_who != null) return _who!;
    try {
      _who = (await _link.listPilots()).where((p) => p.sessionId == sid).firstOrNull;
    } catch (_) {/* 连不上且没缓存 */}
    return _who ??= PilotContact.fromJson({'session_id': sid, 'name': widget.call.pilotName});
  }

  /// 说之前去掉 markdown 记号, 不然 ** # ` 会被原样念出来
  String _spoken(String s) => s
      .replaceAll(RegExp(r'```[\s\S]*?```'), '')
      .replaceAll(RegExp(r'[*_`#>|]'), '')
      .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1] ?? '')
      .replaceAll(RegExp(r'\n{2,}'), '\n')
      .trim();

  // ───────── 界面 ─────────

  String get _status {
    switch (_phase) {
      case _Phase.ringing:
        return widget.call.reason.isEmpty ? tr('来电') : widget.call.reason;
      case _Phase.connecting:
        return tr('接通中…');
      case _Phase.speaking:
      case _Phase.listening:
      case _Phase.thinking:
        final at = _answeredAt;
        if (at == null) return '';
        final s = DateTime.now().difference(at).inSeconds;
        return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
      case _Phase.ended:
        return tr('已结束');
    }
  }

  String get _hint {
    switch (_phase) {
      case _Phase.listening:
        return tr('你说, 停一下它就回');
      case _Phase.thinking:
        return tr('它在想…');
      case _Phase.speaking:
        return tr('它在说');
      default:
        return '';
    }
  }

  /// 稍后: 这通先挂, 10 分钟后它再找你 (本机提醒响一下, 点开就是 Pilot)
  Future<void> _later() async {
    final reason = widget.call.reason.isEmpty ? tr('刚才那件事') : widget.call.reason;
    try {
      await LocalNotifications.scheduleReminder(
        title: tr('${widget.call.pilotName}找你：$reason'),
        at: DateTime.now().add(const Duration(minutes: 10)),
      );
    } catch (_) {/* 排不上也照样挂 */}
    _ctl.decline(widget.call);
    _close();
  }

  /// 陶土稿 v5「它打给你」: 猫拿着手机, 三圈泥纹往外荡; 名字 + 为什么打; 一张泥板写依据;
  /// 左「稍后」, 右绿色「接听」(可以滑动接听)。绿色只在这里用一次, 跟系统来电一致。
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final ringing = _phase == _Phase.ringing;
    final live = _phase == _Phase.speaking || _phase == _Phase.listening || _phase == _Phase.thinking;
    final opening = widget.call.opening.trim();
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: c.canvas,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
            child: Column(
              children: [
                /* 开着摄像头: 它看到的画面就在猫的位置, 你对准了再说 */
                SizedBox(
                  height: 300,
                  child: _cam != null && _cam!.value.isInitialized
                      ? Center(
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(24),
                            child: SizedBox(width: 220, height: 220 * _cam!.value.aspectRatio.clamp(1.0, 1.3), child: CameraPreview(_cam!)),
                          ),
                        )
                      : _Ripples(active: ringing || _phase == _Phase.speaking, child: const ClayArt('pilot-call', width: 240, height: 240)),
                ),
                const SizedBox(height: 8),
                Text(
                  ringing ? tr('${widget.call.pilotName}来电') : widget.call.pilotName,
                  style: TextStyle(fontSize: 28, color: c.ink, fontWeight: FontWeight.w700, letterSpacing: -0.3),
                ),
                const SizedBox(height: 8),
                Text(_status, textAlign: TextAlign.center, style: TextStyle(fontSize: 15.5, color: c.grey)),
                const SizedBox(height: 24),
                if (ringing && opening.isNotEmpty)
                  ClaySlab(
                    radius: 20,
                    padding: const EdgeInsets.fromLTRB(14, 14, 16, 14),
                    child: Row(
                      children: [
                        ClayTile(icon: Icons.notifications_active_outlined, size: 48, bead: c.cobalt),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(opening, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, height: 1.45, color: c.ink, fontWeight: FontWeight.w500)),
                        ),
                      ],
                    ),
                  ),
                Expanded(
                  child: SingleChildScrollView(
                    reverse: true,
                    child: Text(
                      ringing ? '' : _caption,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 19, height: 1.5, color: _phase == _Phase.speaking ? c.ink : c.grey),
                    ),
                  ),
                ),
                if (_voiceIssue != null && live) ...[
                  Text(tr('它的声音没出来, 先看字'), style: TextStyle(fontSize: 12, color: c.amberInk)),
                  const SizedBox(height: 8),
                ],
                if (_hint.isNotEmpty) ...[
                  Text(_hint, style: TextStyle(fontSize: 13, color: c.grey)),
                  const SizedBox(height: 12),
                ],
                if (_phase == _Phase.listening && _voice != null)
                  SizedBox(height: 36, child: InlineWaveform(levels: _voice!.levels, height: 36, color: c.cobalt)),
                const SizedBox(height: 20),
                if (ringing)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _CallKey(icon: Icons.schedule_rounded, label: tr('稍后'), onTap: () => unawaited(_later())),
                      Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(tr('滑动接听'), style: TextStyle(fontSize: 12, color: c.grey)),
                          const SizedBox(height: 4),
                          Text('›››', style: TextStyle(fontSize: 18, color: c.faint, letterSpacing: 2)),
                        ],
                      ),
                      GestureDetector(
                        onHorizontalDragEnd: (d) {
                          if ((d.primaryVelocity ?? 0) > 200) unawaited(_answer());
                        },
                        child: _CallKey(icon: Icons.call_rounded, label: tr('接听'), green: true, onTap: () => unawaited(_answer())),
                      ),
                    ],
                  )
                else
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      if (live) ...[
                        _CallKey(
                          icon: _cam != null ? Icons.videocam_rounded : Icons.videocam_outlined,
                          label: _camIssue ?? (_cam != null ? tr('关摄像头') : tr('让它看')),
                          onTap: () => unawaited(_toggleCam()),
                        ),
                        const SizedBox(width: 48),
                      ],
                      _CallKey(icon: Icons.call_end_rounded, label: tr('结束'), red: true, onTap: _hangup),
                    ],
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 来电页的大圆键: 陶土 (稍后 / 让它看) · 绿 (接听, 全 App 只在这用) · 红 (结束)
class _CallKey extends StatelessWidget {
  const _CallKey({required this.icon, required this.label, required this.onTap, this.green = false, this.red = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool green;
  final bool red;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final solid = green ? const Color(0xFF5E9C76) : (red ? c.red : null);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onTap: onTap,
          child: Container(
            width: 76,
            height: 76,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: solid ?? c.fill,
            ),
            child: Icon(icon, size: 30, color: solid == null ? c.ink : Colors.white),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: TextStyle(color: c.ink, fontSize: 13.5)),
      ],
    );
  }
}

/// 三圈泥纹一圈圈往外荡 (来电 / 它在说)
class _Ripples extends StatefulWidget {
  const _Ripples({required this.child, required this.active});
  final Widget child;
  final bool active;

  @override
  State<_Ripples> createState() => _RipplesState();
}

class _RipplesState extends State<_Ripples> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..repeat();

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
      builder: (_, child) => Stack(
        alignment: Alignment.center,
        children: [
          if (widget.active)
            for (var i = 0; i < 3; i++)
              Builder(builder: (_) {
                final t = (_c.value + i / 3) % 1.0;
                final d = 180 + 120 * t;
                return Container(
                  width: d,
                  height: d,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: c.line.withValues(alpha: (1 - t) * 0.9), width: 1.6),
                    color: c.slab.withValues(alpha: (1 - t) * 0.18),
                  ),
                );
              }),
          child!,
        ],
      ),
      child: widget.child,
    );
  }
}
