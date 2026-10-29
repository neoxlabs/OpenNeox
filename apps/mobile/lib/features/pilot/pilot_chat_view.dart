/// pilot_chat_view.dart — 跟 Pilot 的聊天模式 (2026-10-11)。
///
/// 用户: 「界面可以切换成类似 iMessage 聊天的感觉」「人家可以分一条、两条回复 …… 光对话, 他在后台却在默默干活」。
///
///   一段一个气泡  它干活是「说一句 → 动一次手 → 再说一句」, 每段话单独一条 (云端也按段记账, 换设备看还是分开的)
///   后台干活      活在云端容器里跑, 跟这页开没开无关; 这页只是窗: 底下一行「正在做: 查记录…」
///   随时插话      它正在干活也能发, 插进那一轮, 它做完手上这一步就看到、当场改
///   小细节        `代码名` 灰底等宽小块; 成品链接变成「打开成品」卡; 「- 」开头的行排成列表; 同一人连发靠得近, 隔久了标时间
library;

import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart' show PilotSpecialist;
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_toast.dart';
import '../voice/inline_voice.dart';
import 'pilot_ears.dart';
import 'pilot_im.dart';
import 'pilot_action_cards.dart';
import 'pilot_capability_page.dart';
import 'pilot_chat_merge.dart';
import 'pilot_link.dart';
import 'pilot_receipt.dart';
import 'pilot_specialist_starter.dart';
import 'pilot_stage.dart' show PilotThinkingDots;
import 'pilot_starter.dart';

/// 工具名 → 「正在做」那行的人话; 不在表里的统一叫「在干活」
String pilotStepLabel(String? tool) => switch (tool) {
  null => '在想',
  'phone' => '用手机',
  'schedule_reminder' => '定提醒',
  'report_to_user' => '写汇报',
  'call_user' => '打给你',
  'remember' => '记住',
  'pilot_log' => '记下来',
  'pilot_query' => '查记录',
  'pilot_metric' => '看走势',
  'pilot_insights' => '找规律',
  'ask_specialist' => '交给专员',
  'deliver_file' => '交成品',
  'web_search' => '搜索',
  'web_fetch' => '看网页',
  'execute_shell' => '跑命令',
  'readfile' || 'list_directory' || 'search_files' => '翻文件',
  'write_file' || 'edit' => '写文件',
  _ => '在干活',
};

class _Msg {
  _Msg({this.id, required this.role, required this.text, required this.at, this.atts = const []});

  /// 账本里的 id; live 写出来、还没落账的气泡是 null
  int? id;

  /// user / assistant / event
  final String role;
  final String text;
  final DateTime at;

  /// 这次在手机上发的图 / 文件 (历史里只剩一行「📷 图片 ×2 · 📎 报价单.pdf」)
  final List<_Att> atts;

  /// 没发出去 (点红色感叹号重发)
  bool failed = false;

  /// 它正在干活时带了图 / 文件: 先挂着, 这一轮做完自动发出去 (下面一行灰字「等它做完就发」)
  bool queued = false;
}

/// 一个要发的附件
class _Att {
  const _Att({required this.name, required this.mime, required this.bytes, required this.image});
  final String name;
  final String mime;
  final Uint8List bytes;
  final bool image;

  Map<String, Object?> toPayload() => {
    'kind': image ? 'image' : 'file',
    'name': name,
    'mime': mime,
    'data_base64': base64Encode(bytes),
    'size_bytes': bytes.length,
  };
}

/// 单个文件上限: 走中继一条消息带过去, 太大的让它别从这儿发
const _maxFileBytes = 10 * 1024 * 1024;

String _mimeOf(String name) {
  final ext = name.toLowerCase().split('.').last;
  return const {
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'txt': 'text/plain',
        'md': 'text/markdown',
        'csv': 'text/csv',
        'json': 'application/json',
        'zip': 'application/zip',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'webp': 'image/webp',
        'heic': 'image/heic',
      }[ext] ??
      'application/octet-stream';
}

class PilotChatView extends ConsumerStatefulWidget {
  const PilotChatView({super.key, required this.thread, this.team = const [], this.openCamera = false, this.draft});

  /// 哪个窗口 (单聊 / 群 / 专员), 决定从账本里看哪些、发出去带不带 @
  final PilotThread thread;

  /// 团队 (群里 / 专员单聊里给专员配头像)
  final List<PilotSpecialist> team;

  /// 一打开就拍
  final bool openCamera;

  /// 打开时先填进输入框的一句 (能力页 / 开场示例点了带过来), 不自动发
  final String? draft;

  @override
  ConsumerState<PilotChatView> createState() => PilotChatViewState();
}

class PilotChatViewState extends ConsumerState<PilotChatView> with WidgetsBindingObserver {
  PilotContact get _pilot => widget.thread.pilot;
  bool get _group => widget.thread.kind == PilotThreadKind.group;
  bool get _specialist => widget.thread.kind == PilotThreadKind.specialist;

  /// 这一轮是不是在这个窗口里发起的 (专员单聊只接自己 @ 出去的那轮回话)
  bool _mine = false;

  /// 资料页「现在做一次」之类: 替你在这个窗口说一句
  Future<void> sendText(String text) async {
    _input.text = text;
    await _send();
  }

  /// 只填进输入框, 不发送 (能力页 / 开场示例点了先用这个)
  void prefill(String text) {
    _input.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    _focus.requestFocus();
  }
  final _msgs = <_Msg>[];
  StreamSubscription<List<ConnectivityResult>>? _net;
  bool _wasOnline = true;

  Future<void> _resendFailed() async {
    /* 等网络真的通一下 (刚切回来那一秒 DNS 常常还没好) */
    await Future<void>.delayed(const Duration(seconds: 2));
    for (final m in _msgs.where((m) => m.failed && m.role == 'user').toList()) {
      if (!mounted) return;
      await _send(m);
    }
  }
  final _cardsKey = GlobalKey<PilotActionCardsState>();
  final _scroll = ScrollController();
  final _input = TextEditingController();
  final _focus = FocusNode();
  StreamSubscription<PilotLive>? _sub;

  /// 干活时带图 / 文件发的, 等这一轮做完依次发 (见 _send / _onLive 'done')
  final List<_Msg> _queued = [];

  /// 正在写的那一段 (还没收成气泡)
  String _draft = '';
  bool _busy = false;
  String? _step;

  /// 点过停止: 这一轮不再往屏幕上写字 (pilot:U-07); 下次发话解冻
  bool _stopped = false;

  /// 停的这一轮已经收尾 (收到 done): 之后云端再开新一轮就解冻, 正常显示增量
  bool _stopSettled = false;

  /// 连接状态: waking 在叫醒它 / reconnecting 掉线在接回来 / null 连着 (见 PilotLive conn)
  String? _conn;
  bool _loading = true;
  String? _error;

  /// 云端连不上 (断网 / 叫不醒容器): 输入条上面一直挂一条, 说清楚现在发不出去。
  /// 脑子只在云端 (2026-10-18 起手机上那份大脑已删) —— 连不上就是连不上, 不回落本机。
  bool _cloudDown = false;

  /// 要跟这句话一起发的图 / 文件
  final _atts = <_Att>[];

  /// 正在听写: 说的字实时写进输入框 (接在已经打了的字后面), 再点一下停, 改完再发
  InlineVoiceController? _voice;
  bool _listening = false;
  String _voicePrefix = '';

  PilotCloud? get _cloud => ref.read(pilotCloudProvider);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sub = _cloud?.live.listen(_onLive);
    /* 待发箱: 没网时发失败的那几条, 网一回来按顺序自动重发 (不用一条条去点) */
    _net = Connectivity().onConnectivityChanged.listen((r) {
      final online = r.isNotEmpty && r.any((x) => x != ConnectivityResult.none);
      if (online && !_wasOnline) {
        /* 网回来了: 没发出去的按顺序重发, 再重新连一次云端 (连上就撤掉「连不上云端」那条) */
        unawaited(_resendFailed());
        unawaited(_load(quiet: true));
      }
      _wasOnline = online;
    });
    unawaited(_load());
    _input.addListener(() => setState(() {}));
    final draft = widget.draft?.trim();
    if (draft != null && draft.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) prefill(draft);
      });
    }
    if (widget.openCamera) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_pick('camera'));
      });
    }
  }

  /* 空状态里点「看全部能力」: 选中的那句填进输入框, 不直接发 */
  Future<void> _openCapabilities() async {
    final pick = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const PilotCapabilityPage()),
    );
    if (!mounted || pick == null) return;
    prefill(pick);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _voice?.dispose();
    _sub?.cancel();
    _net?.cancel();
    _scroll.dispose();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 回到前台: 关着的这段时间它可能又说了好几段 (后台一直在干), 重拉一遍
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load(quiet: true));
  }

  Future<void> _load({bool quiet = false}) async {
    final cloud = _cloud;
    if (cloud == null) return;
    if (!quiet) setState(() => _loading = true);
    try {
      /* 专员单聊是从主管账本里筛出来的, 多拉一些才够看 */
      final rows = await cloud.messages(_pilot.sessionId, limit: _specialist ? 240 : 100);
      if (!mounted) return;
      final all = [
        for (final m in rows)
          if ('${m['text'] ?? ''}'.trim().isNotEmpty && !pilotInternalLine('${m['role']}', '${m['text']}'.trim()))
            _Msg(
              id: (m['id'] as num?)?.toInt(),
              role: '${m['role']}',
              text: '${m['text']}'.trim(),
              at: DateTime.fromMillisecondsSinceEpoch((m['at'] as num?)?.toInt() ?? 0),
            ),
      ];
      final ledger = pilotFilterThread(widget.thread, all, role: (m) => m.role, text: (m) => m.text);
      /* live 写出来的气泡和账本回读的是同一句话: 并起来, 不出现两个一样的气泡 (pilot:U-08) */
      final merged = mergePilotChatLines<_Msg>(
        local: List<_Msg>.of(_msgs),
        ledger: ledger,
        idOf: (m) => m.id,
        roleOf: (m) => m.role,
        textOf: (m) => m.text,
        atOf: (m) => m.at,
        matched: (mine, row) {
          mine.id = row.id;
          return mine;
        },
      );
      setState(() {
        _msgs
          ..clear()
          ..addAll(merged);
        _loading = false;
        _error = null;
        _cloudDown = false;
      });
      _toBottom(jump: true);
      /* 看到了 = 读了: 列表上的未读角标回去就消失 (原来只有旧版首页会标已读, 2026-10-14 实测角标一直挂着) */
      if (!_specialist) unawaited(ref.read(pilotLinkProvider).markRead(_pilot.sessionId));
      /* 连上它: 顺便知道它是不是还在干活 (你关掉 App 的时候它可能一直在做) */
      final s = await cloud.attach(_pilot.sessionId);
      if (mounted && s.busy && !_specialist) {
        setState(() {
          _busy = true;
          _step = s.step;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e'.replaceFirst('Bad state: ', '');
          _cloudDown = _cloudUnreachable(e);
        });
      }
    }
  }

  void _onLive(PilotLive e) {
    if (!mounted) return;
    /* 专员单聊: 主管别的话不进来, 只接你在这里 @ 出去的那一轮 */
    if (_specialist && !_mine) return;
    /* 点了停 (pilot:U-07): 这一轮剩下的增量一个字都不再往屏幕上写。
     * 等这一轮真的收尾 (done) 之后, 云端若自己又开了新一轮 (busy / step, 或直接来增量),
     * 解冻照常显示 —— 停的是这一轮, 不是把它关掉。 */
    if (_stopped && e.kind != 'conn') {
      final fresh = _stopSettled && (e.kind == 'busy' || e.kind == 'step' || e.kind == 'delta' || e.kind == 'segment');
      if (fresh) {
        setState(() {
          _stopped = false;
          _stopSettled = false;
        });
      } else {
        if (e.kind == 'done') _stopSettled = true;
        /* 停着的这一轮还没收尾: 增量 / 步骤都不画 */
        if (e.kind != 'done') return;
      }
    }
    switch (e.kind) {
      case 'delta':
        setState(() {
          _draft += e.text;
          _busy = true;
        });
        _toBottom();
      case 'segment':
        _flushDraft();
      case 'step':
        _flushDraft();
        setState(() {
          _busy = true;
          _step = e.step;
        });
      case 'busy':
        setState(() => _busy = true);
      case 'conn':
        setState(() {
          _conn = e.step;
          /* 接上了 (step = null): 云端又能用了 */
          if (e.step == null) _cloudDown = false;
        });
      case 'done':
        _flushDraft();
        /* 干活时挂起的图 / 文件: 这一轮做完了, 按顺序发出去 */
        if (_queued.isNotEmpty) {
          final next = _queued.removeAt(0);
          next.queued = false;
          Future<void>.delayed(const Duration(milliseconds: 300), () { if (mounted) unawaited(_send(next)); });
        }
        /* 这一轮可能刚挂了一张卡 / 办完了一张 */
        _cardsKey.currentState?.refresh();
        setState(() {
          _busy = false;
          _step = null;
          _mine = false;
        });
        /* 这一轮里专员可能交了东西 (事件不走实时流): 群 / 专员窗口重拉一遍 */
        if (_group || _specialist) unawaited(_load(quiet: true));
    }
  }

  void _flushDraft() {
    final t = _draft.trim();
    if (t.isEmpty) {
      _draft = '';
      return;
    }
    setState(() {
      _msgs.add(_Msg(role: 'assistant', text: t, at: DateTime.now()));
      _draft = '';
    });
    _toBottom();
  }

  /// 列表是倒着排的 (最新的在 0): 到底 = 回到 0, 不用等长消息量完高度
  void _toBottom({bool jump = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      if (jump) {
        _scroll.jumpTo(0);
      } else {
        unawaited(_scroll.animateTo(0, duration: const Duration(milliseconds: 220), curve: Curves.easeOut));
      }
    });
  }

  Future<void> _send([_Msg? retry]) async {
    final cloud = _cloud;
    if (_listening) await _stopListening();
    final text = retry?.text ?? _input.text.trim();
    final atts = retry?.atts ?? List<_Att>.of(_atts);
    if (cloud == null || (text.isEmpty && atts.isEmpty)) return;
    HapticFeedback.selectionClick();
    /* 专员单聊里说的话 = 发进主管会话, 前面带「@名字 」(主管派给它); 历史里也这样存, 筛得回来 */
    final out = retry != null ? retry.text : widget.thread.outgoing(text);
    final m = retry ?? _Msg(role: 'user', text: out, at: DateTime.now(), atts: atts);
    setState(() {
      m.failed = false;
      if (retry == null) _msgs.add(m);
      _input.clear();
      _atts.clear();
      _busy = true;
      _mine = true;
      _stopped = false;
      _stopSettled = false;
    });
    _toBottom();
    try {
      await cloud.send(_pilot.sessionId, out, attachments: [for (final a in atts) a.toPayload()]);
      if (mounted && _cloudDown) setState(() => _cloudDown = false);
    } catch (e) {
      if (!mounted) return;
      /* 它正在干活, 图 / 文件插不进这一轮 (云端 409 busy_attachments): 不算失败, 挂起来, 这一轮做完自动发
       * —— 原来弹一句「等这件做完再发」, 用户得自己记着回来重发 */
      if ('$e'.contains('它正在干活') && atts.isNotEmpty) {
        setState(() {
          m.queued = true;
          _queued.add(m);
        });
        return;
      }
      setState(() {
        m.failed = true;
        _busy = false;
      });
      final net = await Connectivity().checkConnectivity();
      final offline = net.isEmpty || net.every((x) => x == ConnectivityResult.none);
      /* 连不上云端: 输入条上面挂一条, 说清楚恢复后再发 (脑子只在云端, 不回落本机) */
      if ((offline || _cloudUnreachable(e)) && mounted) setState(() => _cloudDown = true);
      /* 断网就直说断网 —— 原来报的是底层异常 (SocketException …), 看不懂 */
      if (offline) {
        NeoxToast.show(tr('手机没网，有网了自动发出去'));
        return;
      }
      /* 原因多半是 pilot cloud 抛的中文句子 (「连不上它，等一下再试」): 认得的也翻一下 */
      /* 超时不甩 "TimeoutException after 0:01:00" 这种英文: 说人话 */
      final why = e is TimeoutException
          ? tr('它那边太久没回应，点重试再发一次')
          : tr('$e'.replaceFirst('Bad state: ', ''));
      NeoxToast.show(tr('没发出去：$why'));
    }
  }

  /// 这个失败是不是「云端连不上」(断网 / 超时 / 叫不醒容器), 而不是它明确回了一句什么
  static bool _cloudUnreachable(Object e) {
    if (e is TimeoutException) return true;
    final s = '$e';
    return s.contains('连不上') ||
        s.contains('SocketException') ||
        s.contains('ClientException') ||
        s.contains('HandshakeException') ||
        s.contains('Connection closed') ||
        s.contains('timed out');
  }

  // ───────── 附件 ─────────

  /// 相机键: 直接拍; 长按 = 拍照 / 相册 / 文件 三选一
  Future<void> _pick([String? preset]) async {
    _focus.unfocus();
    final how = preset ??
        await showClaySheet<String>(
          context,
          builder: (c) => Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ClaySheetHeader(title: tr('发给${widget.thread.title}')),
                ClayGroup(margin: EdgeInsets.zero, children: [
                  ClayRow(icon: Icons.photo_camera_outlined, title: tr('拍照'), onTap: () => Navigator.pop(c, 'camera')),
                  ClayRow(icon: Icons.photo_library_outlined, title: tr('相册'), onTap: () => Navigator.pop(c, 'gallery')),
                  ClayRow(icon: Icons.description_outlined, title: tr('文件（PDF、Word、表格…）'), onTap: () => Navigator.pop(c, 'file')),
                ]),
              ],
            ),
          ),
        );
    if (how == null) return;
    try {
      final picked = <_Att>[];
      if (how == 'camera' || how == 'gallery') {
        final picker = ImagePicker();
        final xs = how == 'camera'
            ? [if (await picker.pickImage(source: ImageSource.camera, maxWidth: 1600, imageQuality: 85) case final x?) x]
            : await picker.pickMultiImage(maxWidth: 1600, imageQuality: 85, limit: 6);
        for (final x in xs) {
          picked.add(_Att(name: x.name, mime: x.mimeType ?? _mimeOf(x.name), bytes: await x.readAsBytes(), image: true));
        }
      } else {
        final r = await FilePicker.platform.pickFiles(allowMultiple: true, withData: true);
        for (final f in r?.files ?? const <PlatformFile>[]) {
          final bytes = f.bytes;
          if (bytes == null) continue;
          if (bytes.length > _maxFileBytes) {
            NeoxToast.show(tr('${f.name} 超过 10MB，先别从这儿发'));
            continue;
          }
          final mime = _mimeOf(f.name);
          picked.add(_Att(name: f.name, mime: mime, bytes: bytes, image: mime.startsWith('image/')));
        }
      }
      if (picked.isNotEmpty && mounted) setState(() => _atts.addAll(picked));
    } catch (e) {
      NeoxToast.show(tr('没选上：$e'));
    }
  }

  // ───────── 听写 ─────────

  Future<void> _mic() async {
    if (_listening) return _stopListening();
    HapticFeedback.mediumImpact();
    _voicePrefix = _input.text.trim().isEmpty ? '' : '${_input.text.trim()} ';
    setState(() => _listening = true);
    _voice?.dispose();
    try {
      _voice = await startPilotEars(
        ref,
        onText: (t) {
          if (!mounted) return;
          _input.value = TextEditingValue(
            text: '$_voicePrefix$t',
            selection: TextSelection.collapsed(offset: '$_voicePrefix$t'.length),
          );
        },
        onError: (msg) {
          NeoxToast.show(msg);
          if (mounted) setState(() => _listening = false);
        },
      );
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _listening = false);
    }
  }

  Future<void> _stopListening() async {
    await _voice?.stop();
    if (mounted) setState(() => _listening = false);
  }

  Future<void> _stop() async {
    if (_stopped) return;
    HapticFeedback.mediumImpact();
    /* 先冻结画面再谈打断: interrupt 要过一趟网络, 等它回来屏幕上又长了两行字 (pilot:U-07)。
     * 手上这点字当场收成一个气泡; 之后的 delta / segment / step 一律不再画, 显示「已停」。 */
    setState(() {
      _stopped = true;
      _stopSettled = false;
      _busy = false;
      _step = null;
    });
    _flushDraft();
    /* 念稿也当场静音 —— 界面和声音两层一起停 (H-11) */
    unawaited(ref.read(pilotLinkProvider).stopSpeaking());
    try {
      await _cloud?.interrupt(_pilot.sessionId);
    } catch (_) {/* 没送到也不改「已停」: 云端这一轮自己会收尾 */}
  }

  // ───────── 画 ─────────

  static String _when(DateTime t) {
    final now = DateTime.now();
    final days = DateTime(now.year, now.month, now.day).difference(DateTime(t.year, t.month, t.day)).inDays;
    final hm = '${t.hour}:${t.minute.toString().padLeft(2, '0')}';
    if (days == 0) return tr('今天 $hm');
    if (days == 1) return tr('昨天 $hm');
    if (days < 7) return '${trWeekday(t.weekday)} $hm';
    return tr('${t.month} 月 ${t.day} 日 $hm');
  }

  /// 不是我说的那条是谁说的: 专员交付 → 那个专员; 其它 → 这个 Pilot
  ({String name, Widget face}) _sender(_Msg m) {
    final post = m.role == 'event' ? specialistPost(m.text) : null;
    if (post != null) {
      for (final s in widget.team) {
        if (s.name == post.name) return (name: s.name, face: PilotFace.specialist(s, size: 36));
      }
      return (name: post.name, face: const _UnknownFace());
    }
    return (name: _pilot.name, face: PilotFace.pilot(_pilot, size: 36));
  }

  /// 我在专员单聊里说的话, 账本里带着「@名字 」—— 这个窗口里不用再显示
  String _shown(_Msg m) {
    if (_specialist && m.role == 'user') {
      final p = '@${widget.thread.specialist!.name}';
      if (m.text.startsWith(p)) return m.text.substring(p.length).trimLeft();
    }
    return m.text;
  }

  /// 它这边的一行: [头像 36] [群里头一条带名字 + 内容]; 同一个人连着说, 只有第一条带头像
  Widget _theirs({required String name, required Widget face, required bool first, required Widget child}) {
    final c = ClayInk.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 36, child: first ? face : null),
        const SizedBox(width: 10),
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (first && _group)
                Padding(
                  padding: const EdgeInsets.only(left: 2, bottom: 4),
                  child: Text(name, style: TextStyle(fontSize: 12, color: c.grey)),
                ),
              child,
            ],
          ),
        ),
        const SizedBox(width: 36),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final items = <Widget>[];
    String? lastSpeaker;
    for (var i = 0; i < _msgs.length; i++) {
      final m = _msgs[i];
      final prev = i > 0 ? _msgs[i - 1] : null;
      /* 隔了 20 分钟以上: 中间标一次时间 */
      final gap = prev == null || m.at.difference(prev.at).inMinutes >= 20;
      if (gap) {
        lastSpeaker = null;
        items.add(
          Padding(
            padding: const EdgeInsets.only(top: 14, bottom: 4),
            child: Center(child: Text(_when(m.at), style: TextStyle(fontSize: 12, color: c.faint))),
          ),
        );
      }
      final post = m.role == 'event' ? specialistPost(m.text) : null;
      final lines = m.text.split('\n').where((l) => l.trim().isNotEmpty).toList();

      /* 发生的小事 (到点提醒了 / 设好了): 居中一行回执 */
      if (m.role == 'event' && post == null && lines.length <= 1 && m.text.length <= 48) {
        lastSpeaker = null;
        items.add(Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Center(child: PilotReceiptCard(receipt: PilotReceipt.fromEvent(m.text, at: m.at))),
        ));
        continue;
      }

      if (m.role == 'user') {
        final sameAsPrev = lastSpeaker == '\u0000me';
        lastSpeaker = '\u0000me';
        final text = _shown(m);
        items.add(
          Padding(
            padding: EdgeInsets.only(top: sameAsPrev ? 4 : 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (m.atts.isNotEmpty) _AttStrip(atts: m.atts),
                if (m.atts.isNotEmpty && text.isNotEmpty) const SizedBox(height: 4),
                if (text.isNotEmpty || m.atts.isEmpty)
                  _Bubble(text: text, mine: true, first: !sameAsPrev, failed: m.failed, onRetry: m.failed ? () => _send(m) : null),
                if (m.queued)
                  Padding(
                    padding: const EdgeInsets.only(top: 4, right: 4),
                    child: Text(tr('等它做完手上这件就发'), style: TextStyle(fontSize: 12, color: ClayInk.of(context).grey)),
                  ),
              ],
            ),
          ),
        );
        continue;
      }

      final who = _sender(m);
      final first = lastSpeaker != who.name;
      lastSpeaker = who.name;
      items.add(
        Padding(
          padding: EdgeInsets.only(top: first ? 12 : 4),
          child: _theirs(
            name: who.name,
            face: who.face,
            first: first,
            child: m.role == 'event'
                ? _PostCard(
                    title: post?.title ?? lines.first.replaceAll(RegExp(r'^[✅✓☑️\s]+'), ''),
                    body: post?.body ?? lines.skip(1).join('\n'),
                  )
                : _Bubble(text: m.text, mine: false, first: first),
          ),
        ),
      );
    }
    final drafting = _draft.trim().isNotEmpty;
    /* 等的时候说清在等什么: 连接状态优先于「在想 / 在查记录」 */
    final waitLabel = switch (_conn) {
      'waking' => '正在叫醒它',
      'reconnecting' => '网断了，正在接回来',
      _ => pilotStepLabel(_step),
    };
    if (_stopped) {
      items.add(Padding(padding: const EdgeInsets.only(top: 10), child: Center(child: _StoppedPill())));
    }
    if (!_stopped && (drafting || _busy || _conn != null)) {
      final first = lastSpeaker != _pilot.name;
      items.add(
        Padding(
          padding: EdgeInsets.only(top: first ? 12 : 4),
          child: _theirs(
            name: _pilot.name,
            face: PilotFace.pilot(_pilot, size: 36),
            first: first,
            /* 它在后台干活: 一个小气泡跳三个点, 下面一行灰字「在查记录」 */
            child: drafting
                ? _Bubble(text: _draft.trim(), mine: false, first: first)
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _Bubble.child(first: first, child: const PilotThinkingDots()),
                      Padding(
                        padding: const EdgeInsets.only(left: 4, top: 4),
                        child: Text(tr(waitLabel), style: TextStyle(fontSize: 12, color: c.grey)),
                      ),
                    ],
                  ),
          ),
        ),
      );
    }

    return Column(
      children: [
        /* 动作卡: 它要用你的名义发出去的东西, 摆在对话顶上等你点 (跟电脑上同一张, 谁先点算谁的) */
        if (!_specialist) PilotActionCards(key: _cardsKey, pilotId: _pilot.sessionId, onSettled: () => unawaited(_load(quiet: true))),
        Expanded(
          child: _loading
              ? const Center(child: ClaySpinner(size: 20))
              : _error != null && _msgs.isEmpty
              ? Center(
                  child: ClayButton(label: tr('没连上，点一下重试'), kind: ClayButtonKind.clay, onTap: _load),
                )
              /* 第一次来、一句话还没说: 不给空白 —— 它先打个招呼, 列出能替你办的几件事, 点一下填进输入框 (10-15 用户: "不知道干什么") */
              : _msgs.isEmpty && !_busy && !_group && _draft.trim().isEmpty
              /* 专员窗口也一样: 一句「我是谁、管哪摊」+ 三条它管得着的示例 (2026-10-18: 原来专员窗口是一片白) */
              ? (_specialist
                  ? PilotStarter(
                      name: _pilot.name,
                      intro: specialistIntro(widget.thread.specialist!),
                      subtitle: '专管这一摊。有事直接跟我说，点一句试试，填好你改一下再发：',
                      examples: specialistStarterExamples(widget.thread.specialist!),
                      onPick: prefill,
                      onCamera: () => _pick('camera'),
                    )
                  : PilotStarter(
                      name: _pilot.name,
                      onPick: prefill,
                      onCamera: () => _pick('camera'),
                      onAll: () => unawaited(_openCapabilities()),
                    ))
              : GestureDetector(
                  onTap: () => _focus.unfocus(),
                  /* 倒着排: 打开就停在最新一条, 新消息进来也贴着底 */
                  child: ListView(
                    controller: _scroll,
                    reverse: true,
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                    children: items.reversed.toList(),
                  ),
                ),
        ),
        if (_cloudDown)
          _CloudDownBar(
            onRetry: () {
              unawaited(_load(quiet: true));
              unawaited(_resendFailed());
            },
          ),
        _InputBar(
          controller: _input,
          focus: _focus,
          busy: _busy,
          hint: _group ? tr('说一句，或 @ 某个成员') : tr('跟${widget.thread.title}说…'),
          atts: _atts,
          listening: _listening,
          levels: _voice?.levels,
          onSend: _send,
          onStop: _stop,
          onPlus: _pick,
          onCamera: () => _pick('camera'),
          onMic: _mic,
          onRemove: (a) => setState(() => _atts.remove(a)),
        ),
      ],
    );
  }
}



/// 气泡 (平的): 我的 = 墨色实底靠右; 它的 = 泥板色靠左。一组的头一条, 贴头像 / 贴右边那个角收成 6
class _Bubble extends StatelessWidget {
  const _Bubble({required String this.text, required this.mine, required this.first, this.failed = false, this.onRetry}) : child = null;
  const _Bubble.child({required Widget this.child, required this.first})
      : text = null,
        mine = false,
        failed = false,
        onRetry = null;

  final String? text;
  final Widget? child;
  final bool mine;
  final bool first;
  final bool failed;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final body = child ??
        GestureDetector(
          onLongPress: () {
            HapticFeedback.selectionClick();
            Clipboard.setData(ClipboardData(text: text!));
            NeoxToast.show(tr('已复制'));
          },
          child: _RichText(text: text!, color: mine ? c.onPrimary : c.ink, mine: mine),
        );
    const big = Radius.circular(20);
    const small = Radius.circular(6);
    final shape = BorderRadius.only(
      topLeft: !mine && first ? small : big,
      topRight: mine && first ? small : big,
      bottomLeft: big,
      bottomRight: big,
    );
    return Row(
      mainAxisAlignment: mine ? MainAxisAlignment.end : MainAxisAlignment.start,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (failed)
          GestureDetector(
            onTap: onRetry,
            child: Padding(
              padding: const EdgeInsets.only(right: 6, bottom: 10),
              child: Icon(Icons.error_outline, size: 20, color: c.red),
            ),
          ),
        Flexible(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * (mine ? 0.74 : 0.7)),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(color: mine ? c.primary : c.slab, borderRadius: shape),
              child: body,
            ),
          ),
        ),
      ],
    );
  }
}

/// 专员交的东西 / 它主动说的一整段 (简报、周报): 一张卡 —— 标题加粗一行, 正文, 长的折起来
class _PostCard extends StatefulWidget {
  const _PostCard({required this.title, required this.body});
  final String title;
  final String body;
  @override
  State<_PostCard> createState() => _PostCardState();
}

class _PostCardState extends State<_PostCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final long = widget.body.length > 160 || '\n'.allMatches(widget.body).length > 4;
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.74),
      child: GestureDetector(
        onTap: long ? () => setState(() => _open = !_open) : null,
        child: Container(
          decoration: BoxDecoration(
            color: c.slab,
            borderRadius: const BorderRadius.only(topLeft: Radius.circular(6), topRight: Radius.circular(20), bottomLeft: Radius.circular(20), bottomRight: Radius.circular(20)),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              /* 只有一句的 (晨间简报一行): 当普通话说, 不加粗 */
              Text(widget.title, style: TextStyle(fontSize: 15, fontWeight: widget.body.isEmpty ? FontWeight.w400 : FontWeight.w600, color: c.ink, height: 1.5)),
              if (widget.body.isNotEmpty) ...[
                const SizedBox(height: 4),
                _open || !long
                    ? _RichText(text: widget.body, color: c.ink, mine: false, small: true)
                    : Text(widget.body, maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: c.ink, height: 1.5)),
              ],
              if (long)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(_open ? tr('收起') : tr('展开全文'), style: TextStyle(fontSize: 13, color: c.grey, fontWeight: FontWeight.w500)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 点过停止: 一行平的小条, 说清楚停在哪 (pilot:U-07)
class _StoppedPill extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 5, 12, 5),
      decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(14)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.stop_rounded, size: 13, color: c.grey),
          const SizedBox(width: 5),
          Text(tr('已停'), style: TextStyle(fontSize: 12.5, color: c.grey)),
        ],
      ),
    );
  }
}

/// 团队目录里还没有的专员 (改名了 / 刚加): 填色方块 + 团队图标
class _UnknownFace extends StatelessWidget {
  const _UnknownFace();

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(12)),
      child: Icon(Icons.groups_2_outlined, size: 20, color: c.grey),
    );
  }
}

/// 消息里的小细节: `代码` 灰底等宽; 链接变成小块 (成品链接 = 「打开成品」); 「- 」/「1. 」开头的行排成列表; **粗**
class _RichText extends StatelessWidget {
  const _RichText({required this.text, required this.color, required this.mine, this.small = false});
  final String text;
  final Color color;
  final bool mine;
  final bool small;

  static final _token = RegExp(r'(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?://[^\s，。）)]+)');
  static final _bullet = RegExp(r'^\s*(?:[-•·]|\d+[.、)])\s+');

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = (small ? theme.textTheme.bodySmall : theme.textTheme.bodyLarge)?.copyWith(color: color, height: 1.42);
    final lines = text.split('\n');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (i, raw) in lines.indexed)
          if (raw.trim().isEmpty)
            SizedBox(height: i == 0 ? 0 : 6)
          else if (_bullet.hasMatch(raw))
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 8, right: 8, left: 2),
                    child: Container(
                      width: 4,
                      height: 4,
                      decoration: BoxDecoration(color: color.withValues(alpha: 0.7), shape: BoxShape.circle),
                    ),
                  ),
                  Expanded(
                    child: Text.rich(TextSpan(children: _spans(context, raw.replaceFirst(_bullet, ''), base)), style: base),
                  ),
                ],
              ),
            )
          else
            Text.rich(TextSpan(children: _spans(context, raw, base)), style: base),
      ],
    );
  }

  List<InlineSpan> _spans(BuildContext context, String s, TextStyle? base) {
    final out = <InlineSpan>[];
    var at = 0;
    for (final m in _token.allMatches(s)) {
      if (m.start > at) out.add(TextSpan(text: s.substring(at, m.start)));
      final t = m[0]!;
      if (m[1] != null) {
        out.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 2),
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              decoration: BoxDecoration(
                color: (mine ? Colors.white : Colors.black).withValues(alpha: mine ? 0.18 : 0.06),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(
                t.substring(1, t.length - 1),
                style: base?.copyWith(
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                  fontSize: (base.fontSize ?? 15) * 0.88,
                ),
              ),
            ),
          ),
        );
      } else if (m[2] != null) {
        out.add(
          TextSpan(
            text: t.substring(2, t.length - 2),
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        );
      } else {
        out.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: _LinkChip(url: t, mine: mine),
          ),
        );
      }
      at = m.end;
    }
    if (at < s.length) out.add(TextSpan(text: s.substring(at)));
    return out;
  }
}

/// 链接小块: 成品 (pilot-data 分享链接) 叫「打开成品」, 其它显示域名
class _LinkChip extends StatelessWidget {
  const _LinkChip({required this.url, required this.mine});
  final String url;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final deliverable = url.contains('/pilot/data/s/');
    final host = Uri.tryParse(url)?.host.replaceFirst('www.', '') ?? url;
    return GestureDetector(
      onTap: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
        padding: const EdgeInsets.fromLTRB(4, 3, 10, 3),
        decoration: BoxDecoration(color: mine ? Colors.white.withValues(alpha: 0.2) : theme.colorScheme.surface, borderRadius: NeoxRadius.pillR),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(NeoxClay.of(deliverable ? 'i-doc' : 'i-search'), width: 20, height: 20, filterQuality: FilterQuality.medium),
            const SizedBox(width: 4),
            Text(
              deliverable ? tr('打开成品') : host,
              style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700, color: mine ? Colors.white : NeoxBrand.blue),
            ),
          ],
        ),
      ),
    );
  }
}

/// 连不上云端: 输入条上面一条 —— 说清楚发不出去、恢复后再发, 并给个重试。
/// 2026-10-18 起 Pilot 的脑子只在云端, 这里没有「换成本机」这个退路。
class _CloudDownBar extends StatelessWidget {
  const _CloudDownBar({required this.onRetry});
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 2, 12, 0),
      padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
      decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(14)),
      child: Row(
        children: [
          Icon(Icons.cloud_off_rounded, size: 16, color: c.grey),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              tr('连不上云端，恢复后再发'),
              style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.3),
            ),
          ),
          TextButton(
            onPressed: onRetry,
            style: TextButton.styleFrom(foregroundColor: c.cobalt, minimumSize: const Size(44, 32), padding: const EdgeInsets.symmetric(horizontal: 10)),
            child: Text(tr('重试'), style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}

class _Dots extends StatefulWidget {
  const _Dots();
  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return AnimatedBuilder(
      animation: _c,
      builder: (c, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++)
            Container(
              width: 4,
              height: 4,
              margin: const EdgeInsets.symmetric(horizontal: 1.5),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.25 + 0.75 * (0.5 + 0.5 * (1 - ((_c.value * 3 - i) % 3).clamp(0, 1)))),
              ),
            ),
        ],
      ),
    );
  }
}

/// 发出去的消息上面那排: 图是小方块缩略图, 文件是带名字的小卡
class _AttStrip extends StatelessWidget {
  const _AttStrip({required this.atts, this.onRemove});
  final List<_Att> atts;
  final void Function(_Att)? onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      alignment: WrapAlignment.end,
      children: [
        for (final a in atts)
          Stack(
            clipBehavior: Clip.none,
            children: [
              a.image
                  ? ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: Image.memory(
                        a.bytes,
                        width: onRemove == null ? 120 : 64,
                        height: onRemove == null ? 120 : 64,
                        fit: BoxFit.cover,
                        gaplessPlayback: true,
                      ),
                    )
                  : Container(
                      constraints: const BoxConstraints(maxWidth: 200),
                      padding: const EdgeInsets.fromLTRB(8, 8, 12, 8),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surface,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Image.asset(NeoxClay.of('i-doc'), width: 28, height: 28, filterQuality: FilterQuality.medium),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  a.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700),
                                ),
                                Text(
                                  '${(a.bytes.length / 1024).ceil()} KB',
                                  style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
              if (onRemove != null)
                Positioned(
                  right: -6,
                  top: -6,
                  child: GestureDetector(
                    onTap: () => onRemove!(a),
                    child: Container(
                      width: 20,
                      height: 20,
                      decoration: BoxDecoration(color: theme.colorScheme.onSurface.withValues(alpha: 0.75), shape: BoxShape.circle),
                      child: const Icon(Icons.close_rounded, size: 14, color: Colors.white),
                    ),
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

/// 输入条 (稿: 三件同高 46 · 同一填色 · 底边对齐):
///   [＋]  [ 跟小航说… ]  [🎤]
/// 右边那颗原地换: 有字 / 有附件 = 墨色发送; 没字且它在干活 = 停; 在听写 = 钴蓝勾 (点一下停, 字留在框里)。
/// 多行时框往上长, 两边的键贴底不动。＋ = 拍照 / 相册 / 文件。
class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.focus,
    required this.busy,
    required this.hint,
    required this.atts,
    required this.listening,
    required this.levels,
    required this.onSend,
    required this.onStop,
    required this.onPlus,
    required this.onCamera,
    required this.onMic,
    required this.onRemove,
  });
  final VoidCallback onCamera;
  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final String hint;
  final List<_Att> atts;
  final bool listening;
  final List<double>? levels;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback onPlus;
  final VoidCallback onMic;
  final void Function(_Att) onRemove;

  static const double _h = 46;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final hasText = controller.text.trim().isNotEmpty || atts.isNotEmpty;
    Widget key({required Widget child, required VoidCallback onTap, Color? color, required String tip, VoidCallback? onLongPress}) => Tooltip(
          message: tip,
          child: GestureDetector(
            onTap: onTap,
            onLongPress: onLongPress,
            child: Container(
              width: _h,
              height: _h,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: color ?? c.fill),
              child: child,
            ),
          ),
        );
    final Widget right;
    if (listening) {
      right = key(tip: tr('停'), onTap: onMic, child: Icon(Icons.check_rounded, color: c.cobalt, size: 24));
    } else if (hasText) {
      right = key(tip: tr('发送'), onTap: onSend, color: c.primary, child: Icon(Icons.arrow_upward_rounded, color: c.onPrimary, size: 22));
    } else if (busy) {
      right = key(tip: tr('让它停下'), onTap: onStop, color: c.primary, child: Icon(Icons.stop_rounded, color: c.onPrimary, size: 22));
    } else {
      right = key(tip: tr('说话'), onTap: onMic, child: Icon(Icons.mic_none_rounded, color: c.ink, size: 23));
    }
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (atts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 6, 4, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: _AttStrip(atts: atts, onRemove: onRemove),
                ),
              ),
            /* 听写中: 一条声纹, 说的字实时进下面的输入框 */
            if (listening && levels != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                child: InlineWaveform(levels: levels!, height: 22, color: c.cobalt),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                key(tip: tr('拍照、相册、文件；长按直接拍'), onTap: onPlus, onLongPress: onCamera, child: Icon(Icons.add_rounded, color: c.ink, size: 24)),
                const SizedBox(width: 8),
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(minHeight: _h),
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    alignment: Alignment.centerLeft,
                    decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(_h / 2)),
                    child: TextField(
                      controller: controller,
                      focusNode: focus,
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.newline,
                      style: TextStyle(fontSize: 15.5, color: c.ink, height: 1.35),
                      cursorColor: c.cobalt,
                      /* 全局输入框主题带描边和底色: 外面这条就是框, 里面全部清掉 */
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        filled: false,
                        isDense: true,
                        /* 一行字的框不能超过 46 (实测 12.5 时高出 1dp): 留 11, 外面 minHeight 46 撑齐两边的键 */
                        contentPadding: const EdgeInsets.symmetric(vertical: 11),
                        hintStyle: TextStyle(fontSize: 15.5, color: c.faint, height: 1.35),
                        hintText: listening ? tr('在听…') : (busy ? tr('补一句，它接着改') : hint),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                right,
              ],
            ),
          ],
        ),
      ),
    );
  }
}
