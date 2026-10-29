/// voice_chat_page.dart — Chat 的语音对话 (2026-10-05)。
///
/// 用户: 「Pilot 要云端能力, 为了让普通用户也能方便地对话, 普通 Chat 也能切 Voice 模式 ——
/// 一个圆球波浪, 直接语音对话。Chat 依然保持它的准确度和响应。」
///
/// 所以这里不另起一个脑子: 说的话走手机 Chat 同一条路 (PhoneLocalAgent, 同一个会话、同一个模型、
/// 同样的工具), 只多带一个 voice_mode 让它用口语答; 回复边写边按句念。退出后对话都在 Chat 里能看到。
///
///   听   startPilotEars —— 按语音设置挑识别 (订阅用户默认网关流式)
///        说完 = 识别结果 1.2 秒没变
///   想   sendInput(voice_mode) 一轮跑完; textDeltas 边到边切句
///   说   PilotVoice 合成 (订阅 / 阿里云 / 本地) → neox.pilot/voice 播, 下一句提前合成
///   打断 点球: 停播放、停这一轮, 马上接着听
library;

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:go_router/go_router.dart';

import '../../core/local_agent/phone_local_agent.dart';
import '../../core/local_llm/local_model_catalog.dart';
import '../../core/models/model_store.dart';
import '../../core/voice/hosted_asr.dart';
import '../../core/voice/local_tts.dart';
import '../../core/privacy/ai_consent.dart';
import '../../core/voice/pilot_voice.dart';
import '../../core/voice/voice_settings.dart';
import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import '../home/state/current_session_provider.dart';
import '../home/state/selected_model_provider.dart';
import '../pilot/pilot_ears.dart';
import '../pilot/spoken_lead.dart';
import '../../shared/clay/clay.dart';
import 'inline_voice.dart';
import 'package:neox_app/core/i18n/tr.dart';

const _player = MethodChannel('neox.pilot/voice');

/// 自动模式下这一段话里音量峰值不到它 = 当成背景声丢掉 (离手机近的人声明显更响)。
/// 声级是 0..1 (网关识别 = PCM RMS×6: 正常距离说话 0.2~0.6, 几米外的电视 / 旁人 0.05~0.12)。
/// 宁可放过一点背景声也别吞掉小声说的话 —— 吞了就是「说了没反应」, 比答错更让人抓狂。
const double _kNoiseGate = 0.15;
const String _kHoldModeKey = 'voice_chat.hold_to_talk';
const String _kTranscriptKey = 'voice_chat.transcript';

/// idle = 按住说话模式下等你按
enum _Phase { starting, idle, listening, thinking, speaking, paused }

/// 一轮: 你说的 + 它答的 (边写边显示)。页面上一轮一轮列出来, 不再只闪一句。
class _Round {
  _Round(this.user);
  String user;
  String reply = '';
  String? tool;
  bool done = false;
  String? error;
}

class VoiceChatPage extends ConsumerStatefulWidget {
  const VoiceChatPage({super.key});

  @override
  ConsumerState<VoiceChatPage> createState() => _VoiceChatPageState();
}

class _VoiceChatPageState extends ConsumerState<VoiceChatPage> with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 4))..repeat();

  _Phase _phase = _Phase.starting;
  double _level = 0;
  String? _sessionId;
  InlineVoiceController? _ears;
  String _heard = '';
  String? _error;
  Timer? _silence;
  bool _closed = false;

  final List<_Round> _rounds = [];
  final ScrollController _scroll = ScrollController();

  /// 按住说话: 嘈杂的地方用 —— 按住球才收音, 松手就发, 周围的声音不会被当成你说的
  bool _hold = false;

  /// 这一段话里听到的最大音量 (自动模式的噪音门)
  double _peak = 0;

  /// 刚被噪音门丢掉的那段 —— 状态行亮一下, 不让人以为它没在听
  String? _ignored;
  Timer? _ignoredTimer;

  /// 正在念的那句 (光球下面的字幕)
  String _speaking = '';

  /// 这一轮有句子合成失败 (重试过) —— 字在屏幕上, 只是没念出来
  String? _speakError;

  /// 识别连不上时已经自动重连过几次 (说出字就清零)
  int _earsRetries = 0;

  /// 默认只有光球; 点右上角切到对话文字 (2026-10-05 用户: 「默认就是一个圆球, 不应该圆球再加上对话, 它俩可以切换」)
  bool _transcript = false;

  /* 这一轮: 回复切出来的句子排队念; 合成提前开始, 播放一句接一句 */
  int _turn = 0;
  final List<({String text, Future<({Uint8List audio, String format})?> audio})> _queue = [];
  bool _turnDone = false;
  bool _speakingLoop = false;
  StreamSubscription<({String sessionId, String text, bool tool})>? _deltas;

  @override
  void initState() {
    super.initState();
    final prefs = ref.read(sharedPreferencesProvider);
    _hold = prefs.getBool(_kHoldModeKey) ?? false;
    _transcript = prefs.getBool(_kTranscriptKey) ?? false;
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  /// 不在听 / 不在说的时候该回到哪: 自动模式接着听, 按住说话模式等你按
  Future<void> _next() async {
    if (_closed) return;
    if (_hold) {
      if (mounted) setState(() => _phase = _Phase.idle);
    } else {
      await _listen();
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    });
  }

  @override
  void dispose() {
    _closed = true;
    _silence?.cancel();
    _ignoredTimer?.cancel();
    _deltas?.cancel();
    final ears = _ears;
    _ears = null;
    if (ears != null) unawaited(ears.cancel().whenComplete(ears.dispose));
    unawaited(_player.invokeMethod('stop').catchError((_) => null));
    _anim.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    /* 第一次发给 AI 之前问一次 (App Store 5.1.2(i)); 不同意就退出语音对话 */
    if (!await ensureAiDataConsent(context)) {
      if (mounted) Navigator.of(context).maybePop();
      return;
    }
    if (!mounted) return;
    /* 接着当前的手机 Chat 会话说; 没有 (或者当前是电脑 / 云端会话) 就开一个新的手机会话 */
    final current = ref.read(currentSessionProvider);
    final agent = ref.read(phoneLocalAgentProvider);
    final model = ref.read(effectiveModelProvider);
    /* 当前会话跑在本机小模型上而订阅模型可用时不接着它: 语音对话要的是 Chat 的准确度,
     * 270M 的本机模型答两句就挂 (2026-10-05 真机) */
    var reuse = current != null && current.startsWith('phone-');
    if (reuse && localLlmForModelId(await agent.currentModelId(current)) != null && localLlmForModelId(model) == null) {
      reuse = false;
    }
    if (reuse) {
      _sessionId = current;
    } else {
      try {
        _sessionId = await agent.createSession(title: tr('语音对话'), modelHint: model.isEmpty ? null : model);
        if (!mounted) return;
        ref.read(currentSessionProvider.notifier).set(_sessionId);
      } catch (e) {
        _fail('$e');
        return;
      }
    }
    await _next();
  }

  // ───────── 听 ─────────

  Future<void> _listen() async {
    if (_closed) return;
    _heard = '';
    _error = null;
    _peak = 0;
    setState(() => _phase = _Phase.listening);
    try {
      _ears = await startPilotEars(
        ref,
        onText: (t) {
          if (_phase != _Phase.listening) return;
          _earsRetries = 0;
          setState(() => _heard = t.trim());
          _scrollToEnd();
          /* 说完 = 识别结果一阵子没变 (各家识别都是边说边改字, 停了才不再变)。按住说话模式等松手 */
          _silence?.cancel();
          if (_heard.isNotEmpty && !_hold) _silence = Timer(const Duration(milliseconds: 1200), _endOfUtterance);
        },
        onError: (m) {
          /* 识别连不上 (网关连阿里云偶尔握手挂住): 自己重连一次, 再不行才停下报错 */
          if (_earsRetries < 1 && !_closed && _phase == _Phase.listening) {
            _earsRetries++;
            debugPrint('[voice-chat] 识别出错, 重连: $m');
            unawaited(_stopEars(keepResult: false).then((_) => _listen()));
            return;
          }
          _fail(m);
        },
        /* 系统识别会自己停 (几秒没声音): 说过话就当说完, 没说就接着听 */
        onState: (listening) {
          if (listening || _phase != _Phase.listening || _ears == null || _hold) return;
          if (_heard.isNotEmpty) {
            unawaited(_endOfUtterance());
          } else {
            unawaited(_stopEars(keepResult: false).then((_) => _listen()));
          }
        },
      );
    } catch (e) {
      _fail('$e');
    }
  }

  Future<void> _stopEars({bool keepResult = true}) async {
    _silence?.cancel();
    final ears = _ears;
    _ears = null;
    if (ears == null) return;
    try {
      if (keepResult) {
        await ears.stop();
      } else {
        await ears.cancel();
      }
    } finally {
      ears.dispose();
    }
  }

  /// [manual] = 按住说话松手 / 点球说完 —— 用户亲口确认过, 不过噪音门
  Future<void> _endOfUtterance({bool manual = false}) async {
    if (_phase != _Phase.listening) return;
    final said = _heard;
    /* 噪音门: 自动模式下这段话一直没响过 (旁边的人 / 电视 / 广告) → 当没听见, 接着听 */
    if (!manual && (said.length < 2 || _peak < _kNoiseGate)) {
      debugPrint('[voice-chat] 丢掉疑似背景声 peak=${_peak.toStringAsFixed(2)} "$said"');
      await _stopEars(keepResult: false);
      _ignoredTimer?.cancel();
      _ignoredTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _ignored = null);
      });
      setState(() {
        _heard = '';
        _ignored = said;
      });
      return _listen();
    }
    if (said.isEmpty) {
      await _stopEars(keepResult: false);
      return _next();
    }
    /* 你说的这句马上落到列表上, 思考 / 回答期间一直在 —— 以前一进入思考就清空了 */
    setState(() {
      _rounds.add(_Round(said));
      _heard = '';
      _phase = _Phase.thinking;
    });
    _scrollToEnd();
    await _stopEars(keepResult: false);
    await _ask(said);
  }

  // ───────── 想 + 说 ─────────

  Future<void> _ask(String text) async {
    final sid = _sessionId;
    if (sid == null || _closed) return;
    final turn = ++_turn;
    final round = _rounds.last;
    _queue.clear();
    _turnDone = false;
    _speaking = '';
    _speakError = null;
    var buf = StringBuffer();
    var spokeAnything = false;

    void enqueue(String raw) {
      final s = speakable(raw).trim();
      if (s.isEmpty) return;
      spokeAnything = true;
      _queue.add((text: s, audio: _synth(s, turn)));
      unawaited(_drain(turn));
    }

    /* 句子边界: 句号问号叹号分号、换行; 太长的逗号也切 (念第一句不用等整段写完) */
    final boundary = RegExp(r'[。！？!?；;\n]|[.](?=\s)|[，,]');
    await _deltas?.cancel();
    _deltas = ref.read(phoneLocalAgentProvider).textDeltas.where((d) => d.sessionId == sid).listen((d) {
      if (turn != _turn || !mounted) return;
      if (d.tool) {
        /* 一个字没说就去调工具 (查网页要几秒): 先垫一句, 不让人干等; 界面上也写明在干嘛 */
        if (!spokeAnything && buf.isEmpty) enqueue(d.text == 'web_search' ? tr('我查一下。') : tr('好, 我看看。'));
        if (buf.isNotEmpty) enqueue(buf.toString());
        buf = StringBuffer();
        setState(() => round.tool = d.text);
        return;
      }
      /* 回复边到边显示整段, 不再只闪正在念的那一句 */
      setState(() {
        round.tool = null;
        round.reply += d.text;
      });
      _scrollToEnd();
      buf.write(d.text);
      while (true) {
        final s = buf.toString();
        final m = boundary.allMatches(s).where((m) {
          final ch = s.substring(m.start, m.end);
          /* 逗号只在已经够长时才切, 不然一句话被切得一顿一顿; 但这一轮的第一句 6 字就切 ——
           * 越早有第一段去合成, 越早出声 (合成一段 ~1s, 等整句写完再合成又多 1~2s) */
          return !(ch == '，' || ch == ',') || m.start >= (spokeAnything ? 24 : 6);
        }).firstOrNull;
        if (m == null) break;
        enqueue(s.substring(0, m.end));
        buf = StringBuffer(s.substring(m.end));
      }
    });

    try {
      await ref.read(phoneLocalAgentProvider).sendInput(
            sessionId: sid,
            kind: 'user_message',
            payload: {'text': text, 'voice_mode': true},
          );
    } catch (e) {
      if (turn == _turn) {
        if (mounted) setState(() => round.error = e.toString().replaceFirst('Bad state: ', ''));
        _fail(e.toString().replaceFirst('Bad state: ', ''));
      }
      return;
    }
    if (turn != _turn) return;
    if (buf.isNotEmpty) enqueue(buf.toString());
    if (mounted) setState(() => round.done = true);
    _turnDone = true;
    await _deltas?.cancel();
    _deltas = null;
    /* 什么都没说 (空回复) 也要回到听 */
    unawaited(_drain(turn));
  }

  /// 合成一句。失败重试一次 (网关连阿里云偶尔握手挂住, 再来一次通常就好);
  /// 还不行就跳过这句 —— 字已经在屏幕上了, 不为一句话把整个对话停掉 (以前会直接暂停, 看起来像哑了)。
  Future<({Uint8List audio, String format})?> _synth(String sentence, int turn) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (turn != _turn || _closed) return null;
      try {
        final r = await ref.read(pilotVoiceProvider.notifier).synth(sentence);
        return turn == _turn ? r : null;
      } catch (e) {
        debugPrint('[voice-chat] 合成失败 (第 ${attempt + 1} 次): $e');
        if (attempt == 1 && turn == _turn && mounted) {
          setState(() => _speakError = e.toString().replaceFirst('Bad state: ', ''));
        }
      }
    }
    return null;
  }

  Future<void> _drain(int turn) async {
    if (_speakingLoop) return;
    _speakingLoop = true;
    try {
      while (!_closed && turn == _turn) {
        if (_queue.isEmpty) {
          if (_turnDone) break;
          await Future<void>.delayed(const Duration(milliseconds: 80));
          continue;
        }
        final next = _queue.removeAt(0);
        final audio = await next.audio;
        if (audio == null || turn != _turn || _closed) continue;
        if (mounted) {
          setState(() {
            _phase = _Phase.speaking;
            _speaking = next.text;
          });
        }
        /* media: 外放 + 媒体音量。默认的通话用途在不少机型上走听筒, 拿在手上听不见 */
        await _player.invokeMethod<bool>('play', {'audio': audio.audio, 'format': audio.format, 'media': true});
      }
    } finally {
      _speakingLoop = false;
    }
    if (!_closed && turn == _turn && _phase != _Phase.paused) await _next();
  }

  // ───────── 操作 ─────────

  /// 点球: 在说 / 在想 → 打断, 马上接着听; 在听 → 当作说完了; 暂停 / 出错 → 重新听。
  /// 按住说话模式下点一下 = 提示要按住 (真正的收音在长按里)
  Future<void> _tapOrb() async {
    HapticFeedback.lightImpact();
    switch (_phase) {
      case _Phase.speaking:
      case _Phase.thinking:
        await _interrupt();
        await _next();
      case _Phase.listening:
        if (_heard.isNotEmpty) await _endOfUtterance(manual: true);
      case _Phase.idle:
        if (mounted) {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text(tr('按住球说话, 松开发送')), duration: const Duration(seconds: 2)));
        }
      case _Phase.paused:
      case _Phase.starting:
        await _next();
    }
  }

  /// 按住说话: 按下 = 打断正在说的 + 开始收音; 松开 = 发出去
  Future<void> _holdStart() async {
    if (!_hold) return;
    HapticFeedback.mediumImpact();
    if (_phase == _Phase.speaking || _phase == _Phase.thinking) await _interrupt();
    if (_phase == _Phase.listening) return;
    await _listen();
  }

  Future<void> _holdEnd() async {
    if (!_hold || _phase != _Phase.listening) return;
    HapticFeedback.selectionClick();
    /* 松手时最后几个字可能还在路上: 等一下网关 / 系统识别把定稿吐出来 */
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (_phase != _Phase.listening) return;
    if (_heard.isEmpty) {
      await _stopEars(keepResult: false);
      if (mounted) setState(() => _phase = _Phase.idle);
      return;
    }
    await _endOfUtterance(manual: true);
  }

  Future<void> _toggleTranscript() async {
    HapticFeedback.selectionClick();
    final v = !_transcript;
    setState(() => _transcript = v);
    if (v) _scrollToEnd();
    await ref.read(sharedPreferencesProvider).setBool(_kTranscriptKey, v);
  }

  Future<void> _toggleHold() async {
    HapticFeedback.selectionClick();
    final hold = !_hold;
    await ref.read(sharedPreferencesProvider).setBool(_kHoldModeKey, hold);
    if (!mounted) return;
    setState(() => _hold = hold);
    /* 切成按住说话: 正在自动听的那段停掉; 切回自动: 空着就开始听 */
    if (hold && _phase == _Phase.listening) {
      await _stopEars(keepResult: false);
      if (mounted) setState(() => _phase = _Phase.idle);
    } else if (!hold && _phase == _Phase.idle) {
      await _listen();
    }
  }

  Future<void> _interrupt() async {
    _turn++;
    _queue.clear();
    await _deltas?.cancel();
    _deltas = null;
    await _player.invokeMethod('stop').catchError((_) => null);
    final sid = _sessionId;
    if (sid != null) {
      unawaited(ref.read(phoneLocalAgentProvider).sendInput(sessionId: sid, kind: 'control:cancel', payload: const {})
          .catchError((_) {}));
    }
  }

  Future<void> _togglePause() async {
    HapticFeedback.selectionClick();
    if (_phase == _Phase.paused) return _next();
    await _interrupt();
    await _stopEars(keepResult: false);
    if (mounted) setState(() => _phase = _Phase.paused);
  }

  // ───────── 云端 / 本地 ─────────
  //
  // 用户: 「订阅用户可以用云端, 也提供可以切换的本地的能力」。切的是耳朵和嘴 (识别 + 声音),
  // 脑子还是 Chat 的模型。云端 = 订阅附带的网关识别 + CosyVoice; 本地 = 手机上的识别模型 + MeloTTS, 不联网。
  // 跟设置 → 语音里那两项是同一份设置, 这里只是一键把两样一起切。

  bool _usingLocal() {
    final hosted = ref.read(hostedAsrProvider);
    final engine = ref.read(voiceSettingsProvider).effectiveEngine(subscriptionUsable: hosted?.available ?? false);
    return engine == VoiceEngine.local && ref.read(pilotVoiceProvider.notifier).source == PilotVoiceSource.local;
  }

  Future<void> _chooseSource() async {
    final local = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.cloud_outlined),
              title: Text(tr('云端')),
              subtitle: Text(tr('识别更准、声音更自然 · 订阅附带')),
              trailing: _usingLocal() ? null : const Icon(Icons.check),
              onTap: () => Navigator.pop(ctx, false),
            ),
            ListTile(
              leading: const Icon(Icons.offline_bolt_outlined),
              title: Text(tr('本地')),
              subtitle: Text(tr('不联网 · 声音和识别都在手机上')),
              trailing: _usingLocal() ? const Icon(Icons.check) : null,
              onTap: () => Navigator.pop(ctx, true),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (local == null || !mounted) return;
    final settings = ref.read(voiceSettingsProvider.notifier);
    final voice = ref.read(pilotVoiceProvider.notifier);
    if (local) {
      final store = ref.read(modelStoreProvider.notifier);
      final ready = await store.isInstalled(kAsrStreamingPack) && await store.isInstalled(kTtsMeloPack);
      if (!mounted) return;
      if (!ready) {
        /* 模型没下就先去下, 不在这里偷偷退回云端 */
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('先下载本地识别和声音模型'))));
        context.push('/settings/voice');
        return;
      }
      await settings.setEngine(VoiceEngine.local);
      await voice.choose(PilotVoiceSource.local);
    } else {
      if (!(ref.read(hostedAsrProvider)?.available ?? false)) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('登录订阅账号后可用'))));
        return;
      }
      await settings.setEngine(VoiceEngine.subscription);
      await voice.choose(PilotVoiceSource.subscription);
    }
    if (!mounted) return;
    /* 换了耳朵: 正在听的那段停掉, 用新的重新听 */
    await _interrupt();
    await _stopEars(keepResult: false);
    setState(() {});
    await _next();
  }

  void _fail(String message) {
    if (!mounted || _closed) return;
    unawaited(_stopEars(keepResult: false));
    setState(() {
      _error = message;
      _phase = _Phase.paused;
    });
  }

  // ───────── 界面 ─────────

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final tool = _rounds.isEmpty ? null : _rounds.last.tool;
    final status = switch (_phase) {
      _Phase.starting => tr('准备中'),
      _Phase.idle => tr('按住球说话, 松开发送'),
      _Phase.listening when _ignored != null => tr('周围声音太远, 已忽略'),
      _Phase.listening => _hold ? tr('在听, 松开发送') : (_heard.isEmpty ? tr('在听, 请说话') : tr('在听')),
      _Phase.thinking => tool == 'web_search'
          ? tr('正在搜索')
          : tool != null
              ? tr('正在处理')
              : (_rounds.isNotEmpty && _rounds.last.reply.isNotEmpty ? tr('正在回答') : tr('正在想')),
      _Phase.speaking when _speakError != null => tr('有一句没念出来, 文字照常显示'),
      _Phase.speaking => _hold ? tr('按住球可以打断') : tr('点球可以打断'),
      _Phase.paused => _error ?? tr('已暂停, 点球继续'),
    };
    /* 正在进行的动作后面跟跳动的点: 让人看得出它没卡住 */
    final busy = _phase == _Phase.thinking || _phase == _Phase.starting || (_phase == _Phase.listening && _ignored == null);
    final hasTalk = _rounds.isNotEmpty || _heard.isNotEmpty;
    final list = _transcript && hasTalk;
    /* 光球模式下面只留一行字幕: 听的时候是你正在说的, 想的时候是你刚说的, 说的时候是正在念的那句 */
    final caption = switch (_phase) {
      _Phase.listening => _heard,
      _Phase.thinking => _rounds.isEmpty ? '' : _rounds.last.user,
      _Phase.speaking => _speaking,
      _ => '',
    };
    final orb = GestureDetector(
      onTap: _tapOrb,
      onLongPressStart: _hold ? (_) => _holdStart() : null,
      onLongPressEnd: _hold ? (_) => _holdEnd() : null,
      child: AnimatedBuilder(
        animation: _anim,
        builder: (_, __) {
          /* 音量每帧平滑一下: 原始声级一跳一跳, 球会抖 */
          final raw = _ears == null || _ears!.levels.isEmpty ? 0.0 : _ears!.levels.last;
          if (_phase == _Phase.listening && raw > _peak) _peak = raw;
          _level += (raw - _level) * (raw > _level ? 0.35 : 0.08);
          return FittedBox(child: _Orb(t: _anim.value, phase: _phase, level: _level));
        },
      ),
    );
    /* 中间的大钮: 说的时候是「打断」, 听的时候是「说完了 / 松开发送」, 其余时候是「说话」 */
    final speakingNow = _phase == _Phase.speaking || _phase == _Phase.thinking;
    final centerLabel = switch (_phase) {
      _Phase.speaking || _Phase.thinking => _hold ? tr('按住可以打断') : tr('点一下打断'),
      _Phase.listening => _hold ? tr('松开发送') : tr('说完了'),
      _ => _hold ? tr('按住说话') : tr('点一下继续'),
    };
    return ClayPage(
      topBar: ClayTopBar(
        center: true,
        leading: ClayRoundButton(
          flat: true,
          size: 44,
          icon: null,
          tooltip: tr('回到文字'),
          onTap: () => Navigator.of(context).maybePop(),
          child: Icon(Icons.arrow_back_rounded, size: 24, color: c.ink),
        ),
        titleWidget: _SourceChip(local: _usingLocal(), onTap: _chooseSource),
        actions: [
          ClayRoundButton(
            flat: true,
            size: 44,
            icon: _transcript ? Icons.blur_on : Icons.text_fields,
            tooltip: _transcript ? tr('只看光球') : tr('显示对话文字'),
            onTap: _toggleTranscript,
          ),
          ClayRoundButton(
            flat: true,
            size: 44,
            icon: _hold ? Icons.touch_app_outlined : Icons.hearing,
            tooltip: _hold ? tr('按住说话') : tr('自动听'),
            onTap: _toggleHold,
          ),
        ],
      ),
      body: Column(
        children: [
          if (list) ...[
            /* 对话文字模式: 球缩到上面, 下面一轮一轮列出来 */
            SizedBox(height: 150, child: Center(child: orb)),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                children: [
                  for (final r in _rounds) ...[
                    _Bubble(text: r.user, mine: true),
                    if (r.reply.isNotEmpty || r.error != null)
                      _Bubble(text: r.error ?? r.reply, mine: false, error: r.error != null),
                  ],
                  if (_phase == _Phase.listening && _heard.isNotEmpty) _Bubble(text: _heard, mine: true, live: true),
                ],
              ),
            ),
          ] else
            /* 光球模式 (默认): 球 + 状态 + 一行字幕 */
            Expanded(child: Center(child: orb)),
          /* 状态大字在上, 灰色字幕在下 (稿: 在听, 松开发送 / 你刚说的那句) */
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    status,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      height: 1.4,
                      color: _error != null && _phase == _Phase.paused ? c.red : c.ink,
                    ),
                  ),
                ),
                if (busy) _Dots(anim: _anim, color: c.grey),
              ],
            ),
          ),
          if (!list)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: SizedBox(
                height: 48,
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: Text(
                    caption,
                    key: ValueKey(caption),
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      height: 1.4,
                      color: _phase == _Phase.thinking ? c.faint : c.grey,
                    ),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 16),
        ],
      ),
      bottom: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _RoundButton(
            icon: _phase == _Phase.paused ? Icons.mic : Icons.pause_rounded,
            label: _phase == _Phase.paused ? tr('继续') : tr('暂停'),
            onTap: _togglePause,
          ),
          /* 按住模式下长按 = 按住收音 / 松开发送; 自动模式点一下 */
          GestureDetector(
            onLongPressStart: _hold ? (_) => _holdStart() : null,
            onLongPressEnd: _hold ? (_) => _holdEnd() : null,
            child: _RoundButton(
              icon: speakingNow ? Icons.stop_rounded : Icons.mic,
              label: centerLabel,
              onTap: _tapOrb,
              size: 84,
              ink: true,
            ),
          ),
          _RoundButton(
            icon: Icons.keyboard_alt_outlined,
            label: tr('回到文字'),
            onTap: () => Navigator.of(context).maybePop(),
          ),
        ],
      ),
    );
  }
}

/// 光球: 渲染出来的素材 (gpt-image-2 出的玻璃流光球, 白底 / 黑底两张预先去底成透明),
/// 不是代码画的渐变 —— 2026-10-05 用户: 「中间的应该出素材, 不要 SVG 化, 要更灵动」。
///
/// 灵动靠三层同一张图: 底下一层模糊放大当光晕; 中间一层慢慢转; 上面一层镜像、反着转得更快、
/// 半透明 —— 两层里的光带交错, 看起来是球里的流体在流。
///   听: 跟着音量鼓起来、变亮    想: 内部转快、轻轻呼吸    说: 一拍一拍地脉动、光晕变大
class _Orb extends StatelessWidget {
  const _Orb({required this.t, required this.phase, required this.level});
  final double t;
  final _Phase phase;
  final double level;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final asset = dark ? 'assets/voice/orb-dark.webp' : 'assets/voice/orb-light.webp';
    final lv = level.clamp(0.0, 1.0);
    final breathe = math.sin(t * math.pi * 2);
    final pulse = (math.sin(t * math.pi * 14) + 1) / 2; // 说话时 ~3.5 拍/秒
    final dim = phase == _Phase.paused || phase == _Phase.starting;
    final scale = switch (phase) {
      _Phase.listening => 1.0 + lv * 0.16 + breathe * 0.012,
      _Phase.thinking => 0.96 + breathe * 0.025,
      _Phase.speaking => 1.0 + pulse * 0.05,
      _ => 0.9,
    };
    /* 内部流速: 想的时候最快 (在琢磨), 说的时候中等, 听的时候慢 */
    final spin = switch (phase) {
      _Phase.thinking => 3.0,
      _Phase.speaking => 1.6,
      _ => 0.7,
    };
    final glow = switch (phase) {
      _Phase.listening => 0.35 + lv * 0.5,
      _Phase.speaking => 0.45 + pulse * 0.35,
      _Phase.thinking => 0.4 + breathe * 0.1,
      _ => 0.15,
    };
    final img = Image.asset(asset, width: 230, height: 230, fit: BoxFit.contain, filterQuality: FilterQuality.medium);
    return SizedBox(
      width: 300,
      height: 300,
      child: Opacity(
        opacity: dim ? 0.5 : 1,
        child: Transform.scale(
          scale: scale,
          child: Stack(
            alignment: Alignment.center,
            children: [
              /* 球底下的水波圈 (稿上的同心椭圆): 只是装饰, 听 / 说的时候往外扩 */
              if (phase != _Phase.paused && phase != _Phase.starting)
                CustomPaint(
                  size: const Size(300, 300),
                  painter: _RipplePainter(
                    t: t,
                    color: ClayInk.of(context).cobalt,
                    strength: phase == _Phase.thinking ? 0.5 : (0.6 + lv * 0.4),
                  ),
                ),
              /* 光晕: 同一张图模糊放大 */
              Opacity(
                opacity: glow.clamp(0.0, 1.0),
                child: Transform.scale(
                  scale: 1.25,
                  child: ImageFiltered(imageFilter: ImageFilter.blur(sigmaX: 28, sigmaY: 28), child: img),
                ),
              ),
              Transform.rotate(angle: t * math.pi * 2 * 0.25 * spin, child: img),
              /* 镜像反转的一层: 光带交错 = 流动 */
              Opacity(
                opacity: 0.5,
                child: Transform.rotate(
                  angle: -t * math.pi * 2 * 0.4 * spin,
                  child: Transform.flip(flipX: true, child: img),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 水波圈: 四圈同心椭圆从球底往外扩, 越扩越淡 (稿上球底下那几道淡蓝线)
class _RipplePainter extends CustomPainter {
  const _RipplePainter({required this.t, required this.color, required this.strength});
  final double t;
  final Color color;
  final double strength;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height * 0.84);
    for (var i = 0; i < 4; i++) {
      final k = (t + i / 4) % 1.0;
      final w = size.width * (0.42 + k * 0.5);
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = color.withValues(alpha: ((1 - k) * 0.4 * strength).clamp(0.0, 1.0));
      canvas.drawOval(Rect.fromCenter(center: center, width: w, height: w * 0.22), paint);
    }
  }

  @override
  bool shouldRepaint(_RipplePainter old) => old.t != t || old.color != color || old.strength != strength;
}

/// 一句话: 你说的靠右、带底色; 它答的靠左、纯文字。[live] = 正在听的那句, 半透明
class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, required this.mine, this.live = false, this.error = false});
  final String text;
  final bool mine;
  final bool live;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final style = TextStyle(
      fontSize: 16,
      height: 1.45,
      /* 正在听的那句: 墨色淡一点就行 —— 灰字压在半透明底上, 夜陶里几乎看不见 (模拟器实测) */
      color: error ? c.red : (live ? c.ink.withValues(alpha: 0.72) : c.ink),
    );
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * (mine ? 0.78 : 0.9)),
        padding: mine ? const EdgeInsets.symmetric(horizontal: 14, vertical: 9) : const EdgeInsets.symmetric(vertical: 4),
        decoration: mine
            ? BoxDecoration(
                color: c.tint,
                borderRadius: BorderRadius.circular(18),
              )
            : null,
        child: Text(text, style: style),
      ),
    );
  }
}

/// 状态后面三个依次跳的点
class _Dots extends StatelessWidget {
  const _Dots({required this.anim, required this.color});
  final Animation<double> anim;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: anim,
      builder: (_, __) {
        /* _anim 一圈 4 秒, ×4 = 每秒跳一轮 */
        final t = (anim.value * 4) % 1.0;
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++)
              Padding(
                padding: const EdgeInsets.only(left: 3),
                child: Transform.translate(
                  offset: Offset(0, -3 * math.max(0, math.sin((t - i * 0.15) * math.pi * 2))),
                  child: Container(
                    width: 4,
                    height: 4,
                    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// 顶栏中间的胶囊: 「本地 · 不联网 ▾」 / 「云端 ▾」, 点开切换
class _SourceChip extends StatelessWidget {
  const _SourceChip({required this.local, required this.onTap});
  final bool local;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return ClayChip(
      label: local ? tr('本地 · 不联网') : tr('云端'),
      trailing: Icon(Icons.expand_more, size: 16, color: c.ink),
      onTap: onTap,
    );
  }
}

/// 底部一颗圆钮 + 一行字。[ink] = 中间那颗主钮 (墨色实底, 大一号)
class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.size = 64,
    this.ink = false,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final double size;
  final bool ink;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ClayRoundButton(icon: icon, size: size, ink: ink, onTap: onTap),
        const SizedBox(height: 8),
        Text(label, style: TextStyle(fontSize: 13, height: 1.3, color: c.grey)),
      ],
    );
  }
}
