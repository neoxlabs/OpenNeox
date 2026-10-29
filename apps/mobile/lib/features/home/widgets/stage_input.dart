/// stage_input.dart — 首页统一输入框, 极简单行 (寸土寸金).
///
/// 视觉 (2026-07-20 用户拍板"只保留发送和语音"):
///   ╭───────────────────────────────────────────╮
///   │ [+]  让 Neox 做…                  🎙  ➤   │
///   ╰───────────────────────────────────────────╯
///
///   左 [+] = 统一菜单: 附件 (相册/拍照/文件) + 模型 + 运行位置 + 审批模式
///   中 TextField
///   右 🎙 = 语音;  ➤ = 发送 (有内容时) / ⏹ = 停止 (agent 跑时)
///
/// 发送反馈链:
///   点发送 → streamBuffer.setPendingUserText (timeline 秒渲 user bubble)
///          → timelineState.markAgentStarting (send 键切 stop, 显思考中)
///          → sessionRouter.sendMessage (按运行位置路由)
///   失败   → clearPendingUserText + markAgentIdle + snackbar
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show File, Platform;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../core/local_llm/local_model_catalog.dart';
import '../../../core/privacy/ai_consent.dart';
import '../../../core/composer/approval_mode_pref.dart';
import '../../../core/composer/chat_mode_pref.dart';
import '../../../core/edition/edition.dart';
import '../../../core/image/image_model_pick.dart';
import '../../../core/image/image_size_pref.dart';
import '../../image/image_size_sheet.dart';
import '../../image/state/image_model_pref.dart';
import 'new_session_project.dart';
import '../../../core/errors/friendly_error.dart';
import '../../../core/execution/inference_params_provider.dart';
import '../../../core/execution/run_target.dart';
import '../../../core/execution/run_target_provider.dart';
import '../../../core/local_agent/attachment_text.dart';
import '../../../core/local_agent/model_gateway_client.dart';
import '../../../core/local_agent/phone_local_agent.dart';
import '../../../core/network/session_context_provider.dart';
import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../core/notifications/local_notifications.dart';
import '../../../core/execution/cloud_agent_access.dart';
import '../../../core/local_agent/linux_env.dart';
import 'local_linux_offer.dart';
import '../../../core/session_routing/send_failure_note.dart';
import '../../../core/session_routing/session_router.dart';
import '../../../core/startup/setup_readiness.dart';
import '../../../core/startup/startup_coordinator.dart';
import '../../../core/storage/database.dart';
import '../../../core/storage/paired_desktop_kind.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../image/state/image_studio_providers.dart';
import '../state/composer_pending_provider.dart';
import '../../timeline/state/timeline_state.dart';
import '../../voice/inline_voice.dart';
import '../../voice/voice_setup_sheet.dart';
import '../../../core/models/model_store.dart';
import '../../../core/voice/hosted_asr.dart';
import '../../../core/voice/voice_settings.dart';
import '../../../core/voice/voice_warmup.dart';
import '../state/current_session_provider.dart';
import '../state/home_mode_provider.dart';
import '../state/home_mode_switch.dart';
import '../state/selected_model_provider.dart';
import '../state/submitting_provider.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/widgets/provider_brand_icon.dart';
import 'context_gauge.dart';
import 'model_sheet_body.dart';
import 'where_sheet.dart';
import 'setup_guide.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 附件大小上限 — 跟 desktop mobileAttachments.MAX_UPLOAD_BYTES 对齐 (大的走分片上传).
const int _kMaxImageAttachmentBytes = 10 * 1024 * 1024; // 10 MB
const int _kMaxFileAttachmentBytes = 20 * 1024 * 1024; // 20 MB

class _AttachmentItem {
  _AttachmentItem({
    required this.kind,
    required this.name,
    required this.mime,
    required this.bytes,
  });
  final String kind; // 'image' | 'file'
  final String name;
  final String mime;
  final Uint8List bytes;
  int get sizeBytes => bytes.length;
}

String _guessImageMime(String name) {
  final n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.heic') || n.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}

/// 顶栏 ✎ 点一下 +1: 输入框清空草稿、聚焦 (见 _StageInputState.build)
final stageNewSessionTickProvider = StateProvider<int>((_) => 0);

class StageInput extends ConsumerStatefulWidget {
  const StageInput({super.key, this.imageMode = false, this.onPickLocation});

  /// true = 图片工作台: 发送走本机直连出图, 不跑 Agent.
  final bool imageMode;

  /// 已有会话时点「运行位置」chip: 打开会话上下文面板 (住在 home_stage_page,
  /// 那边已经 import 了本文件, 反向 import 会成环, 所以走回调)。
  /// 还没有会话时 chip 直接开本文件里的运行位置选择, 不经过它。
  final VoidCallback? onPickLocation;

  @override
  ConsumerState<StageInput> createState() => _StageInputState();
}

class _StageInputState extends ConsumerState<StageInput> {
  late final TextEditingController _ctrl;
  late final FocusNode _focus;
  bool _sending = false;

  final List<_AttachmentItem> _attachments = [];

  /// 内联语音 — 波浪显示在输入框 pill 内, 转写实时写入 TextField (不弹窗).
  late final InlineVoiceController _voice;
  bool _listening = false;

  /// 开始听时输入框已有的文字 — partial 结果拼接在它后面.
  String _voiceBaseText = '';

  @override
  void initState() {
    super.initState();
    _ctrl = TextEditingController();
    _focus = FocusNode();
    _ctrl.addListener(_onTextChange);
    /* 本地语音预热: 输入框出来后空闲时把识别模型先建好, 点麦克风就是立刻开录 */
    Future<void>.delayed(const Duration(milliseconds: 1500), () {
      if (mounted) unawaited(warmUpLocalAsr(ref));
    });
    _voice = InlineVoiceController(
      onText: (words) {
        if (!mounted || words.isEmpty) return;
        final joined = _voiceBaseText.isEmpty
            ? words
            : '$_voiceBaseText $words';
        _ctrl.text = joined;
        _ctrl.selection = TextSelection.collapsed(offset: joined.length);
      },
      onStateChange: (listening) {
        if (mounted) setState(() => _listening = listening);
      },
      onError: (msg) => _toast(msg),
    )..onTranscribing = (busy) {
        if (mounted) setState(() => _transcribing = busy);
      };
  }

  /// 云端识别: 录完在等服务器返回
  bool _transcribing = false;

  @override
  void dispose() {
    _voice.dispose();
    _ctrl.removeListener(_onTextChange);
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 文本框"有没有内容"的上一次取值 —— 只在它翻转时才重建 (见 [_onTextChange])。
  bool _lastHasContent = false;

  /// 文本变化 —— 只在**有没有内容**这个状态真的翻转时才重建.
  ///
  /// 2026-09-22: 原来是无条件 `setState(() {})`, 每敲一个字就重建整个 StageInput
  /// (这个文件 2460 行, 里面还有 composer chips / 上下文用量 / 模型名 / 各档状态)。
  /// 而 build 里真正依赖文本的只有发送按钮的可用态 (`_hasContent`), 它是个布尔值:
  /// 从"空"到"有字"要变一次, 之后继续打字**没有任何东西需要重建**。
  /// 在 120Hz 上, 每字符一次全子树重建是打字手感的直接杀手。
  /// (附件变化有自己的 setState, 不走这里。)
  void _onTextChange() {
    if (!mounted) return;
    final now = _hasContent;
    if (now == _lastHasContent) return;
    _lastHasContent = now;
    setState(() {});
  }

  bool get _hasText => _ctrl.text.trim().isNotEmpty;
  bool get _hasContent => _hasText || _attachments.isNotEmpty;

  /* ─── 附件 ────────────────────────────────────────────────── */

  Future<void> _pickImage(ImageSource source) async {
    try {
      final picker = ImagePicker();
      final x = await picker.pickImage(
        source: source,
        imageQuality: 85,
        maxWidth: 2048,
      );
      if (x == null) return;
      final bytes = await x.readAsBytes();
      if (bytes.length > _kMaxImageAttachmentBytes) {
        _toast(tr('图片超过 10 MB，请压缩后再发送'));
        return;
      }
      if (!mounted) return;
      setState(() {
        _attachments.add(
          _AttachmentItem(
            kind: 'image',
            name: x.name,
            mime: _guessImageMime(x.name),
            bytes: bytes,
          ),
        );
      });
      /* 贴上了再看看当前模型认不认图 —— 不挡住贴图本身, 只是提醒 */
      unawaited(_warnIfModelCannotSeeImages());
    } catch (e) {
      _toast(friendlyError(e, fallback: tr('取图失败，请重试')));
    }
  }

  /// 当前模型不支持视觉时提醒一句 —— **在贴图这一刻**, 不是发完之后.
  ///
  /// 真机实录: 用 deepseek-v4-flash 贴了张图问"这是什么", 全程没有任何提示 ——
  /// 选图正常、缩略图正常、发送正常, 一轮跑完模型才说
  /// "I can't see the image — this model doesn't support image input"。
  /// 用户白等一轮、白花一次额度, 而"当前模型是谁"和"它支不支持视觉"这两件事
  /// App 一直都知道: 桌面 model.list 每条都带 supports_vision, 手机端
  /// ModelInfo.supportsVision 也早就解析好了 —— **只是从来没有人用过它**。
  ///
  /// 放在贴图后而不是发送前: 这时候用户刚从相册回来、手还在屏幕上, 换个模型或
  /// 撤掉图都顺手; 等到发送那一刻再拦, 打断的是"我已经想好要发了"这个动作。
  /// 也不硬拦 —— 万一能力表滞后于服务端, 拦死了用户就没辙了; 给事实, 让他选。
  Future<void> _warnIfModelCannotSeeImages() async {
    try {
      final sid = ref.read(currentSessionProvider);
      if (sid == null || await _sessionIsPhoneLocal(sid)) return;
      final sessionCtx = ref.read(sessionContextProvider(sid));
      final currentId = (sessionCtx != null && sessionCtx.modelId.isNotEmpty)
          ? sessionCtx.modelId
          : ref.read(effectiveModelProvider);
      if (currentId.isEmpty) return;
      final models = await ref
          .read(wsClientProvider.notifier)
          .fetchAvailableModels();
      if (models.isEmpty) return;
      final cur = models.where((m) => m.id == currentId).firstOrNull;
      /* 列表里找不到这个模型 = 我们对它一无所知, 不能凭猜测去警告 */
      if (cur == null || cur.supportsVision) return;
      if (!mounted) return;
      final name = cur.name.isNotEmpty ? cur.name : cur.id;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(tr('$name 看不了图片，发过去它只会收到文字')),
          duration: const Duration(seconds: 6),
          action: SnackBarAction(label: tr('换模型'), onPressed: _openModelSheet),
        ),
      );
    } catch (_) {
      /* 查不到能力就不提醒 —— 提醒错了比不提醒更糟 */
    }
  }

  Future<void> _pickFile() async {
    try {
      final r = await FilePicker.platform.pickFiles(
        allowMultiple: false,
        withData: true,
      );
      if (r == null || r.files.isEmpty) return;
      final f = r.files.first;
      if (f.bytes == null) return;
      if (f.bytes!.length > _kMaxFileAttachmentBytes) {
        _toast(tr('文件超过 20 MB，请选择更小的文件'));
        return;
      }
      /* 手机本地直接读得出文字的: Excel / Word / PPT / PDF / 文本。其它 (压缩包 / 音视频 / 图纸 ...)
       * 原件存进工作区交给工具包处理 —— 没装工具包就在选上这一刻引导下载, 别等发出去 Agent 才说做不了;
       * 电脑会话什么都能收, 不拦 (2026-10-16 之前一律拦掉) */
      if (await _willRunOnPhone() && !attachmentReadableOnPhone(f.name)) {
        final st = Platform.isAndroid ? await LinuxEnv.status() : LinuxStatus.none;
        if (!st.installed) {
          if (!mounted) return;
          final started = st.supported &&
              await offerLocalLinux(
                context,
                reason: tr('这种文件手机要用「工具包」才能处理 (解压、转格式、剪音视频等)。下载一次约 200MB, 装好后再发一次就行。'),
              );
          if (!started) {
            _toast(st.supported
                ? tr('先下载工具包才能在手机上处理这种文件 (设置 → 工具包)；或者连上电脑处理')
                : tr('手机上处理不了这种文件，支持 Excel / Word / PPT / PDF / 文本；连上电脑可以处理更多类型'));
          }
          return;
        }
      }
      if (!mounted) return;
      setState(() {
        _attachments.add(
          _AttachmentItem(
            kind: 'file',
            name: f.name,
            mime: 'application/octet-stream',
            bytes: f.bytes!,
          ),
        );
      });
    } catch (e) {
      _toast(friendlyError(e, fallback: tr('选文件失败，请重试')));
    }
  }

  /// 当前会话的上下文占用 — 没会话/没数据返 null (调用方据此不渲染).
  ContextUsage? _contextUsage() {
    final sid = ref.watch(currentSessionProvider);
    if (sid == null) return null;
    return ContextUsage.from(ref.watch(sessionContextProvider(sid)));
  }

  /// composer 第二行的 chip —— 这句话**要怎么被处理**: 用哪个模型, 跑在哪.
  ///
  /// 模式 (对话/工作/编码) 不在这里。2026-09-17 用户: 「输入框里面其实不应该有工作和
  /// 编码的切换, 感觉好别扭」。模式是**去哪个页面**, 属于抽屉导航; 模型和运行位置
  /// 才是下一条消息的属性。
  ///
  /// 图片模式不给 chip: 出图不跑 Agent, 运行位置对它没有意义。
  ({_ComposerChip? mode, _ComposerChip? model, _ComposerChip? location, _ComposerChip? size}) _composerChips(
    BuildContext context, {
    bool compact = false,
  }) {
    if (widget.imageMode) {
      /* 图片模式给**模型** chip, 但**不给运行位置** —— 2026-09-22.
       *
       * 原来这里是一条都不给, 理由写的是「出图不跑 Agent, 运行位置对它没有意义」。
       * 运行位置确实没意义, 但**模型有意义**: 出图用哪个模型正是用户要选的, 而这个
       * chip 是图片页上唯一能看见"这图归谁画"的地方 —— 不给它, 用户只能盲发。
       * 用户原话: 「图片生成连个模型都不展示, 实际上是有模型的」。
       *
       * 显示的必须是**真正会用的那个**: 这里调的 `pickImageModel` 跟出图链路
       * (image_studio_providers) 是同一个函数、同一份 preferred. 自己写一句"自动"
       * 或者自己挑一个, 都会让界面说的和实际画的对不上 —— 那正是要修的毛病。 */
      final models =
          ref.watch(availableModelsProvider).valueOrNull ??
          const <GatewayModel>[];
      final chosen = pickImageModel(
        models.map((m) => m.id).toList(growable: false),
        preferred: ref.watch(imageModelPrefProvider),
      );
      return (
        mode: null,
        model: chosen == null
            ? null
            : _ComposerChip(
                label: modelRowName(chosen, modelDisplayName(chosen, models)),
                trailingChevron: !compact,
                onTap: () => openModelSheet(context, ref, imageOnly: true),
              ),
        location: null,
        /* chat:C4-07: 方 / 横 / 竖。没选过显示「自动」—— 那是模型按场景判断,
         * 不是固定的方图, 写「方图」会骗人。 */
        size: _ComposerChip(
          label: ref.watch(imageSizePrefProvider)?.label ?? tr('自动'),
          icon: _sizeIcon(ref.watch(imageSizePrefProvider)),
          trailingChevron: !compact,
          onTap: () => openImageSizeSheet(context, ref),
        ),
      );
    }
    /* compact (chip 区很窄): 不画下拉小箭头 —— 省下的宽度全给模型名, 否则只剩 "de…" 认不出 */
    final chevron = !compact;
    final sid = ref.watch(currentSessionProvider);
    final sessionCtx = sid == null
        ? null
        : ref.watch(sessionContextProvider(sid));
    final models =
        ref.watch(availableModelsProvider).valueOrNull ??
        const <GatewayModel>[];
    /* 有会话时显示会话的真实模型, 没有才显示待用的默认值 —— 两者不一致时
     * 显示后者会骗人 (界面写 A, 实际发给 B)。 */
    /* 会话模型名也要过 modelDisplayName: 手机本地会话存的是 id, 自动档会原样显示成 "auto" */
    /* 会话记的模型已下架时显示这一轮实际会用的那个 (跟发送同一个 liveModelId), 不显示下架的名字 */
    final effective = ref.watch(effectiveModelProvider);
    final modelSourceId =
        (sessionCtx != null && sessionCtx.modelName.isNotEmpty)
        ? liveModelId(sessionCtx.modelName, models, effective)
        : effective;
    /* chip 上只放模型名, 服务商那一截去掉 —— 带着前缀实拍是「m5x:deep…」, 模型名全被挤没。
     * 服务商在模型面板里各行右边写着 (见 modelRowProvider)。 */
    final modelName = modelRowName(
      modelSourceId,
      modelDisplayName(modelSourceId, models),
    );
    /* 运行位置不再占输入框一颗 chip (2026-10-12 用户: 「底部 Mac 没必要了, 顶部给个 icon 显示电脑还是手机,
     * 可点击显示详情」) —— 搬到顶栏右上 (home_stage_page _RunPlaceIcon), 输入框只留模型。 */
    final inChat = ref.watch(homeModeProvider) == HomeMode.chat;
    const _ComposerChip? location = null;

    /* 聊天模式 chip: 点一下回 Agent (跟桌面输入框同一个位置、同一个行为) */
    final chatOn = !inChat && ref.watch(chatModeProvider).isOn(sid);
    /* 「思考」开关在模型面板顶部 (2026-10-08 用户: 单独一颗按钮太奢侈, 跟模型放一起) */
    return (
      mode: chatOn
          ? _ComposerChip(
              label: tr('聊天'),
              onTap: () => ref.read(chatModeProvider.notifier).set(sid, false),
            )
          : null,
      /* 列表还没到 / 拉失败时也给 chip —— 原来这时整颗不画, 用户找不到在哪选模型 (2026-10-09 iPhone)。
       * 点开面板会如实说为什么空, 并能重拉。 */
      model: _ComposerChip(
        label: modelName.isEmpty ? tr('选择模型') : modelName,
        /* 厂商原色标 (4.0.2 用户: 要显示模型自己的图标, 比如 DeepSeek 的大鲸鱼, 不要我们自己的); 窄了省掉, 宽度给名字 */
        leading: compact || modelSourceId.isEmpty
            ? null
            : ProviderBrandIcon(
                id: modelSourceId.startsWith(GatewayModel.paygPrefix)
                    ? modelSourceId.substring(GatewayModel.paygPrefix.length)
                    : modelSourceId,
                name: modelName,
                size: 16,
              ),
        /* 按量的模型跟订阅里同名的那个长得一样 —— 签上标出来, 知道这一轮扣的是余额 */
        tag: modelSourceId.startsWith(GatewayModel.paygPrefix) ? tr('按量') : null,
        trailingChevron: chevron,
        onTap: () => openModelSheet(context, ref),
      ),
      location: location,
      /* 2026-10-21 用户: 对话输入框模型右边不挂「出图尺寸」签 —— 要改尺寸走 [+] 菜单。 */
      size: null,
    );
  }

  static IconData _sizeIcon(ImageSize? size) => switch (size) {
    ImageSize.landscape => Icons.crop_landscape_rounded,
    ImageSize.portrait => Icons.crop_portrait_rounded,
    ImageSize.square => Icons.square_rounded,
    null => Icons.crop_free_rounded,
  };

  /// 手动压缩上下文 — 走 control:compact 落到桌面 AgentBridge.compactSession.
  ///
  /// 先确认再压: 压缩把历史换成摘要, 不可逆, 且正在跑的时候压会打断节奏。
  /// 结果由桌面的 context_compaction 事件推回 timeline ("已压缩 · 省 N tokens")。
  Future<void> _compactContext() async {
    final sid = ref.read(currentSessionProvider);
    if (sid == null) return;
    final u = _contextUsage();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: Text(tr('压缩上下文?')),
        content: Text(
          u == null
              ? tr('把之前的对话压成摘要，释放上下文空间。压缩不可逆。')
              : tr('当前 ${u.label}。\n\n把之前的对话压成摘要，释放上下文空间。压缩不可逆。'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dctx, false),
            child: Text(tr('取消')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dctx, true),
            child: Text(tr('压缩')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await ref
          .read(sessionRouterProvider)
          .sendControl(sessionId: sid, kind: 'control:compact');
      messenger?.showSnackBar(
        SnackBar(content: Text(tr('已请求压缩，完成后会在时间轴上显示'))),
      );
    } catch (e) {
      messenger?.showSnackBar(SnackBar(content: Text(tr('压缩失败: $e'))));
    }
  }

  /* ─── [+] 统一菜单: 附件 + 模型 + 运行位置 + 审批 ──────────── */

  /// ＋ 菜单 (陶土稿 v5): 上排四个大方块 (拍照 / 相册 / 文件 / 出图), 下面是这条消息 / 这个会话的设置行.
  void _openPlusMenu() {
    unawaited(showClaySheet<void>(
      context,
      builder: (ctx) => Consumer(builder: (ctx, menuRef, _) {
        final c = ClayInk.of(ctx);
        final inChat = menuRef.watch(homeModeProvider) == HomeMode.chat;
        final sid = menuRef.watch(currentSessionProvider);
        final approval = menuRef.watch(approvalModeProvider);
        final sessionModel = sid == null ? null : menuRef.watch(sessionContextProvider(sid));
        final usage = ContextUsage.from(sessionModel);
        final runStatus = sid == null ? 'idle' : menuRef.watch(timelineStateProvider(sid)).runStatus;
        final agentActive = sid != null &&
            (menuRef.watch(timelineStateProvider(sid)).agentRunning || runStatus == 'paused' || runStatus == 'running');
        final chatOn = menuRef.watch(chatModeProvider).isOn(sid);
        void close(VoidCallback f) {
          Navigator.pop(ctx);
          f();
        }

        Widget bigTile(IconData icon, String label, VoidCallback onTap) => Expanded(
              child: ClaySlab(
                radius: 18,
                padding: const EdgeInsets.symmetric(vertical: 16),
                onTap: onTap,
                child: Column(
                  children: [
                    Icon(icon, size: 26, color: c.ink),
                    const SizedBox(height: 8),
                    Text(label, style: TextStyle(fontSize: 13.5, color: c.ink, fontWeight: FontWeight.w500)),
                  ],
                ),
              ),
            );
        Widget row(IconData icon, String title, {String? value, Widget? trailing, VoidCallback? onTap}) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: ClayRow(icon: icon, title: title, value: value, trailing: trailing, onTap: onTap, minHeight: 52),
            );

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  bigTile(Icons.photo_camera_outlined, tr('拍照'), () => close(() => _pickImage(ImageSource.camera))),
                  const SizedBox(width: 10),
                  bigTile(Icons.photo_library_outlined, tr('相册'), () => close(() => _pickImage(ImageSource.gallery))),
                  const SizedBox(width: 10),
                  bigTile(Icons.insert_drive_file_outlined, tr('文件'), () => close(_pickFile)),
                  if (!widget.imageMode) ...[
                    const SizedBox(width: 10),
                    bigTile(Icons.auto_awesome_outlined, tr('出图'), () => close(() => context.push('/image'))),
                  ],
                ],
              ),
            ),
            if (widget.imageMode)
              row(Icons.image_outlined, tr('图像模型'),
                  value: () {
                    final pref = menuRef.watch(imageModelPrefProvider);
                    if (pref == null || pref.isEmpty) return tr('自动');
                    final models = menuRef.watch(availableModelsProvider).valueOrNull ?? const <GatewayModel>[];
                    return modelRowName(pref, modelDisplayName(pref, models));
                  }(),
                  onTap: () => close(() => openModelSheet(context, ref, imageOnly: true))),
            /* chat:C4-07 方 / 横 / 竖 —— 出图页和对话都在 [+] 菜单里选 (对话输入框上不挂签, 2026-10-21 用户) */
            if (widget.imageMode || inChat)
              row(
                menuRef.watch(imageSizePrefProvider) == ImageSize.landscape
                    ? Icons.crop_landscape_rounded
                    : menuRef.watch(imageSizePrefProvider) == ImageSize.portrait
                        ? Icons.crop_portrait_rounded
                        : Icons.crop_square_rounded,
                tr('出图尺寸'),
                value: menuRef.watch(imageSizePrefProvider)?.label ?? tr('自动'),
                onTap: () => close(() => openImageSizeSheet(context, ref)),
              ),
            if (!widget.imageMode) ...[
              if (Platform.isAndroid && (inChat || sid == null))
                row(Icons.touch_app_outlined, tr('操作这台手机'), onTap: () => close(() => context.push('/settings/phone-use'))),
              /* 开新会话时才给「项目」—— 会话建好之后工作目录就定了 */
              if (sid == null && !inChat && ref.read(runTargetPrefProvider) != RunTargetPref.phone)
                row(Icons.folder_open_outlined, tr('在电脑上的项目里做'), onTap: () => close(() => pickProjectAndStartSession(context, ref))),
              if (!inChat && !chatOn)
                row(approval == ApprovalMode.yolo ? Icons.bolt_outlined : Icons.verified_user_outlined, tr('审批'),
                    value: approval.label, onTap: () => close(_openApprovalSheet)),
              if (usage != null)
                row(Icons.data_usage_rounded, tr('上下文'),
                    trailing: Text(usage.label, style: TextStyle(fontSize: 13.5, color: usage.ratio >= 0.8 ? c.amberInk : c.grey))),
              if (sid != null && !inChat)
                row(Icons.compress_rounded, tr('压缩上下文'), value: tr('把历史压成摘要'), onTap: () => close(_compactContext)),
              if (!inChat && agentActive) ...[
                if (runStatus == 'paused')
                  row(Icons.play_circle_outline, tr('继续'), onTap: () => close(() => _sendControl(sid, 'control:resume')))
                else
                  row(Icons.pause_circle_outline, tr('暂停'), onTap: () => close(() => _sendControl(sid, 'control:pause'))),
                row(Icons.swap_horiz, tr('接管任务'), onTap: () => close(() => _sendControl(sid, 'control:takeover'))),
              ],
            ],
            const SizedBox(height: 12),
          ],
        );
      }),
    ));
  }

  Future<void> _sendControl(String sessionId, String kind) async {
    final timeline = ref.read(timelineStateProvider(sessionId).notifier);
    if (kind == 'control:pause') timeline.markAgentIdle();
    if (kind == 'control:resume') timeline.markAgentStarting();
    try {
      await ref
          .read(sessionRouterProvider)
          .sendControl(sessionId: sessionId, kind: kind);
    } catch (e) {
      _toast(friendlyError(e, fallback: tr('操作失败，请稍后重试')));
    }
  }

  /* ─── 模型选择 sheet ─────────────────────────────────────── */

  Future<bool> _sessionIsPhoneLocal(String sessionId) async {
    final mirror = await ref
        .read(appDatabaseProvider)
        .sessionMirrorDao
        .findById(sessionId);
    return mirror != null && isPhoneLocalDeviceId(mirror.desktopDeviceId);
  }

  /// 下一条消息会不会在手机本地跑 —— 有会话看会话, 没会话看首页模式 (对话 = 手机本地, 见 _send)
  Future<bool> _willRunOnPhone() async {
    final sid = ref.read(currentSessionProvider);
    if (sid != null) return _sessionIsPhoneLocal(sid);
    /* 对话在手机上; 工作 / 编码看「在哪干」 */
    return ref.read(homeModeProvider) == HomeMode.chat ||
        ref.read(runTargetPrefProvider) == RunTargetPref.phone;
  }

  Future<void> _openModelSheet() => openModelSheet(context, ref);

  /* 运行位置 (「在哪干」) 的选择面板在 where_sheet.dart */

  /// 存着的偏好在当前模式下真正生效的那一档: 云端没开 / 编码选了本机 → 自动
  RunTargetPref _effectivePref(WidgetRef r, RunTargetPref pref, {required HomeMode mode, required bool phoneCan}) {
    if (pref == RunTargetPref.cloud && !r.read(cloudEntriesVisibleProvider)) return RunTargetPref.auto;
    /* 编码选本机: 2026-10-12 起可以 (补全本地能力后有 Node / Python / git)。没装工具包时手机编不了,
     * 「本机」(多半是工作模式里选的, 两个模式共用一个设置) 按自动走 —— 电脑在线用电脑; 首页小字和输入框签同一判据
     * (见 where_sheet.effectiveRunTarget) */
    return effectiveRunTarget(pref, mode: mode, phoneCanCode: phoneCan);
  }

  /* ─── 审批模式 sheet ─────────────────────────────────────── */

  Future<void> _openApprovalSheet() async {
    final theme = Theme.of(context);
    final picked = await showModalBottomSheet<ApprovalMode>(
      context: context,
      backgroundColor: theme.colorScheme.surface,
      showDragHandle: true,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        final current = ref.read(approvalModeProvider);
        Widget tile(ApprovalMode m, IconData icon) => ListTile(
          leading: Icon(icon, size: 20),
          title: Text(m.label, style: const TextStyle(fontSize: 15.5)),
          subtitle: Text(
            m.subtitle,
            style: TextStyle(
              fontSize: 13,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          trailing: m == current
              ? Icon(Icons.check, size: 18, color: theme.colorScheme.primary)
              : null,
          onTap: () => Navigator.pop(ctx, m),
        );
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(ctx).height * 0.85,
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  tile(ApprovalMode.auto, Icons.verified_user_outlined),
                  tile(ApprovalMode.plan, Icons.fact_check_outlined),
                  tile(ApprovalMode.yolo, Icons.bolt_outlined),
                  const SizedBox(height: 6),
                ],
              ),
            ),
          ),
        );
      },
    );
    if (picked != null) {
      await ref.read(approvalModeProvider.notifier).set(picked);
    }
  }

  /* ─── 发送 / 停止 ─────────────────────────────────────────── */

  Future<void> _send() async {
    final text = _ctrl.text.trim();
    if (!_hasContent || _sending) return;

    /* 发出去之前先关麦克风、丢掉还没到的识别结果 (2026-10-05 用户: 「发送完一条它一直存在,
     * 还会导致重复说话」—— 以前发送不碰语音, 识别继续往输入框写、把念出来的回复也录进去) */
    if (_listening || _transcribing) {
      await _voice.cancel();
      if (!mounted) return;
    }
    _voiceBaseText = '';

    /* 第一次发给 AI 之前问一次 (App Store 5.1.2(i)); 不同意就不发, 字留在输入框 */
    if (!await ensureAiDataConsent(context) || !mounted) return;

    /* 图片工作台 — 本机直连出图, 不走 Agent / 桌面 */
    if (widget.imageMode) {
      await _sendImageDirect(text);
      return;
    }

    /* 三条起步路径一条都没通 → 在这里拦下, 不要往下走。
     *
     * 往下走会发生的事 (2026-08-08 修的就是这条链):
     *   createBestSession(auto) 先把 session 落库 → 发送时 modelGateway 抛
     *   `请先登录账户后使用手机模式` → 一条没有按钮的 SnackBar, 外加抽屉里
     *   多一条删不掉的空「新任务」。用户第一次用这个产品的第一个动作, 得到的
     *   是一句无路可走的话和一坨垃圾。
     *
     * 拦在**建会话之前**同时解决两件事: 给出路 + 不留幽灵会话。
     * 文本不清空 (走的不是 catch 分支, _ctrl 没被动过), 用户配好回来直接发。 */
    if ((await readSetupReadiness(ref)).isBlank && mounted) {
      await showSetupSheet(context, draft: text);
      return;
    }

    /* 工作/编码只在电脑上跑 (2026-09-24)。一台可连的电脑都没配对时, 在建会话之前拦下 ——
     * 跟上面同一个道理: 给出路, 不留空会话, 字留在输入框里。 */
    final mode = ref.read(homeModeProvider);
    /* 本机能接的就不拦: 工作在本机 / 自动都能落手机; 编码要补全了本地能力才能落手机 (2026-10-12) */
    final phoneCan = mode == HomeMode.work ||
        (mode == HomeMode.code && Platform.isAndroid && (await LinuxEnv.status()).installed);
    final pref = _effectivePref(ref, ref.read(runTargetPrefProvider), mode: mode, phoneCan: phoneCan);
    if (ref.read(currentSessionProvider) == null &&
        mode != HomeMode.chat &&
        !(phoneCan && pref != RunTargetPref.desktop && pref != RunTargetPref.cloud) &&
        !await _hasConnectableDesktop()) {
      if (mounted) await _showNeedsDesktopSheet(mode);
      return;
    }

    setState(() => _sending = true);
    /* 先把气泡亮出来, 再去连电脑/建会话 (2026-09-18 用户: 「发送应该就产生气泡」)。
     * 这行的代价是 0 —— 它只是把用户刚打的那句话放进一个 provider, 首页立刻渲染成气泡;
     * 会话建好、真 pending 气泡接手时清掉 (见 finally)。 */
    ref.read(composerSubmittingTextProvider.notifier).state = text.isEmpty
        ? tr('（附件）')
        : text;

    final attachmentsSnapshot = List<_AttachmentItem>.of(_attachments);
    /* 发出去就从输入框拿走 (2026-10-11 真机: 连电脑建会话那几秒, 气泡里一份字、输入框里还留一份字和图)。
     * 失败时下面 catch 原样放回。图跟着进占位气泡。 */
    _ctrl.clear();
    setState(_attachments.clear);
    if (attachmentsSnapshot.isNotEmpty) {
      unawaited(LocalAttachmentStore.instance
          .preview([for (final a in attachmentsSnapshot) (kind: a.kind, name: a.name, mime: a.mime, bytes: a.bytes)])
          .then((refs) {
        if (ref.read(composerSubmittingTextProvider) != null) {
          ref.read(composerSubmittingAttachmentsProvider.notifier).state = refs;
        }
      }));
    }
    final attachmentsCopy = attachmentsSnapshot
        .map(
          (a) => <String, Object?>{
            'kind': a.kind,
            'name': a.name,
            'mime': a.mime,
            'data_base64': base64Encode(a.bytes),
            'size_bytes': a.sizeBytes,
          },
        )
        .toList();
    final approval = ref.read(approvalModeProvider);

    String? sessionId = ref.read(currentSessionProvider);
    /* 这一次发送是否**顺带新建**了会话 —— 决定失败时要不要把它回滚掉.
     * 已有会话里发送失败不能删 (那是用户真在用的会话), 只有"新建 + 首发失败"
     * 这一种组合下的会话才是纯垃圾: 里面一条消息都没有。 */
    var createdHere = false;
    var createdCloud = false;
    final buf = ref.read(streamBufferProvider.notifier);
    try {
      final router = ref.read(sessionRouterProvider);

      /* 没有当前 session → 按模式建:
       *   对话 → 手机本地 (一步都不经过电脑, 电脑连没连着都一样)
       *   工作/编码 → 按运行位置 (2026-10-11): 自动 = 电脑在线用电脑, 不在线上云端, 都没有时工作落本机;
       *              显式选了哪档就锁哪档 (不可用时如实报错, 不悄悄换地方)
       * agentMode 按当前首页模式记在会话上 (抽屉按它分列表). */
      if (sessionId == null) {
        /* 陶土稿 v5 (2026-10-14): 工作 / 编码都按输入框里「在哪干」那颗签建 (手机 / 某台电脑 / 云端 / 自动);
         * 对话只在手机上。 */
        final RunTargetPref target = mode == HomeMode.chat
            ? RunTargetPref.phone
            : pref;
        final result = await router.createBestSession(
          target: target,
          agentMode: mode.wireValue,
        );
        if (!mounted) return;
        /* 云端任务没有电脑那边的自动起标题: 不起的话抽屉里一排「云端任务」分不清 (2026-10-11 模拟器)。
         * 跟手机本地会话同一个规则 —— 第一句话的前 28 个字 */
        if (result.kind == 'cloud' && text.trim().isNotEmpty) {
          final t = text.trim().replaceAll(RegExp(r'\s+'), ' ');
          await ref.read(appDatabaseProvider).sessionMirrorDao
              .setTitle(result.sessionId, t.length > 28 ? '${t.substring(0, 28)}…' : t);
        }
        if (!mounted) return;
        ref.read(currentSessionProvider.notifier).set(result.sessionId);
        sessionId = result.sessionId;
        createdHere = true;
        createdCloud = result.kind == 'cloud';
        /* auto 模式降级了就说一声 —— 用户交了个需要工具的任务却落到手机本地,
         * 不说的话他会拿回一段"看起来像干了活"的文本还不知道为什么。 */
        final notice = result.degradedNotice;
        if (notice != null) _toast(notice);
      }

      /* 附件留底 (图片 / 文件字节写到本地, 时间线按此渲染缩略图; 电脑回显里没有图) */
      final localRefs = await LocalAttachmentStore.instance.save(
        sessionId,
        text,
        [
          for (final a in attachmentsSnapshot)
            (kind: a.kind, name: a.name, mime: a.mime, bytes: a.bytes),
        ],
      );
      /* 秒级反馈: user bubble 占位 + send 键切 stop. */
      if (text.isNotEmpty || localRefs.isNotEmpty) {
        buf.setPendingUserText(sessionId, text, attachments: localRefs);
      }
      /* 上一次的失败卡先擦掉 —— 用户重发时关心的是这一次的结果, 不是
       * 「失败卡 → 气泡 → 失败卡」堆成一摞。只清末尾连续的那几条。
       * 必须在 markAgentStarting 之前: 删掉了会重建投影, 放后面「思考中」会被一起重置。 */
      await clearTrailingFailureNotes(ref, sessionId);
      ref.read(timelineStateProvider(sessionId).notifier).markAgentStarting();

      /* 通知权限就在这一刻要 (2026-08-08) —— 用户刚派出一个任务、正等着结果,
       * "跑完通知你"是他真的想听的话。原来是在 main() 冷启动第一帧要的, 用户
       * 还没看懂这是什么 app 就被弹框, 通过率极低且拒绝后不可逆。
       * 不 await: 权限框弹出与消息发送互不阻塞。 */
      unawaited(LocalNotifications.ensurePermission());

      await _sendWithReconnectRetry(
        router: router,
        sessionId: sessionId,
        text: text,
        attachments: attachmentsCopy,
        approvalMode: approval.wireValue,
        /* 钉住这个会话的模式 (第一次发送时), 返回这一条该用的。
         * 对话模式不走这个开关: 那个开关管的是"电脑会话带不带工具", 而手机上的对话
         * 要带着联网/计算这几样手机工具 (像 Claude App 那样能搜能算)。 */
        /* 菜单里的「聊天」切换已拿掉: 新会话一律 Agent; 只有以前就钉成聊天的老会话照旧 */
        chatMode: mode != HomeMode.chat &&
            (ref.read(chatModeProvider).bySession[sessionId] ?? false),
      );
    } catch (e) {
      if (sessionId != null) {
        buf.clearPendingUserText(sessionId);
        ref.read(timelineStateProvider(sessionId).notifier).markAgentIdle();
        /* 刚建的会话 + 首发失败 → 回滚, 别在抽屉里留一条空「新任务」.
         *
         * 原来失败后会话照样留着, 而会话又删不掉 —— 用户多试两次就攒下几条
         * 空壳。回滚只针对 createdHere: 已有会话发送失败绝不能碰。 */
        /* 只有真的删掉了才当会话不在了: 用户那句已经落进 timeline 的 (手机本地对话先写气泡
         * 再调模型, 模型报错时气泡早在了), 会话要留着 —— 气泡 + 错误卡 + 重试, 而不是
         * 删掉会话、把字塞回输入框、弹一句 toast (2026-10-05 用户: 「timeline 为什么不显示」)。 */
        if (createdHere && await _rollbackEmptySession(sessionId, cloud: createdCloud)) {
          sessionId = null;
        }
      }
      /* 那句话已经作为气泡留在 timeline 上了吗 —— 留了就由错误卡的「重试」重发, 不往输入框塞 */
      final landed = sessionId != null && await _userMessageLanded(sessionId, text);
      /* 失败在 timeline 留一条持久的错误卡 (带「重试」/「换个模型」).
       *
       * 2026-08-11 模拟器实录: 之前这里只有下面那句 toast。服务端把当前模型下线
       * 后, 用户看到的是自己那条气泡孤零零挂在屏幕底部 —— 没有占位、没有回复、
       * 没有错误、没有出路; 而唯一那句解释还会被网络层的 toast 抢占。
       *
       * 只在会话仍然存在时写 —— createdHere 回滚掉的空会话已经没了, 往一个刚删
       * 掉的 session 里插事件会把它从抽屉里"复活"成一条只有错误卡的僵尸。 */
      if (sessionId != null) {
        final friendly = friendlyError(e, fallback: tr('发送失败，请稍后重试'));
        final detail = errorDetail(e);
        await writeSendFailureNote(
          ref,
          sessionId: sessionId,
          message: friendly,
          /* 原话跟友好文案不一样时放进小字: 下次再出问题, 截图就能看出是哪一步 */
          suggestion: detail.isEmpty || detail == friendly ? null : detail,
        );
      }
      /* 用户的字不能丢 (2026-07-20 真机实锤: 息屏断连后发送静默失败, 文本被
       * clear 掉, 用户重打一遍) — 没落进 timeline 时原样恢复输入框, 并弹一句说明
       * (这时候没有错误卡可看)。落进去了就只有错误卡: 弹窗会挡住输入框, 还跟卡片说同一件事。 */
      if (!landed) {
        if (mounted && _ctrl.text.trim().isEmpty) {
          _ctrl.text = text;
          _ctrl.selection = TextSelection.collapsed(offset: text.length);
          if (_attachments.isEmpty && attachmentsSnapshot.isNotEmpty) {
            setState(() => _attachments.addAll(attachmentsSnapshot));
          }
        }
        _toast(friendlyError(e, fallback: tr('发送失败，请稍后重试')));
      }
    } finally {
      /* 占位气泡交班: 成功时真 pending 气泡已经在了, 失败时文本已回到输入框 —— 两种情况都该清掉 */
      ref.read(composerSubmittingTextProvider.notifier).state = null;
      ref.read(composerSubmittingAttachmentsProvider.notifier).state = const [];
      if (mounted) setState(() => _sending = false);
    }
  }

  /// 回滚一条"刚建出来、首发就失败"的空会话.
  ///
  /// 防御性地先确认它**真的**是空的 —— 只有 session_meta 之类的元事件, 没有任何
  /// user_message / agent_text。发送链路上有自动重连重试, 理论上可能在失败前已经
  /// 落了半条; 那种情况下宁可留着也不删, 删掉用户内容比留个空壳糟糕得多。
  ///
  /// 桌面/云端会话必须走 ws.deleteSession 而不是只删本地: 本地删了, 下次
  /// session.list 同步又会把它拉回抽屉, 等于没删。
  /// 返回 true = 会话确实删掉了; 有内容 / 找不到 / 删失败都返回 false (会话还在)。
  Future<bool> _rollbackEmptySession(String sessionId, {bool cloud = false}) async {
    try {
      final db = ref.read(appDatabaseProvider);
      final events = await db.sessionEventsDao.getBySessionId(sessionId);
      final hasRealContent = events.any(
        (e) => e.kind == 'user_message' || e.kind == 'agent_text',
      );
      if (hasRealContent) return false;

      final mirror = await db.sessionMirrorDao.findById(sessionId);
      if (mirror == null) return false;

      if (cloud) {
        /* 云端会话的真身在服务端, 走电脑那条连接删不到它 —— 原来只清了本地, 服务端留下一条
         * 没标题、一秒没跑过的「云端会话」, 电脑侧栏里堆了一排 (2026-10-12 用户实拍)。
         * 关不掉 (断网) 也照样清本地: 服务端那条没标题没跑过, 电脑侧栏不显示它。 */
        await ref.read(cloudAgentAccessProvider)?.terminateSession(sessionId);
        await db.sessionEventsDao.deleteBySessionId(sessionId);
        await db.sessionMirrorDao.deleteById(sessionId);
      } else if (isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
        await ref.read(phoneLocalAgentProvider).deleteSession(sessionId);
      } else {
        /* best-effort: 连接已经断了的话删不掉远端, 那就退回只清本地 —— 至少
         * 当下抽屉是干净的, 真同步回来再说。 */
        final ok = await ref
            .read(wsClientProvider.notifier)
            .deleteSession(sessionId);
        if (!ok) {
          await db.sessionEventsDao.deleteBySessionId(sessionId);
          await db.sessionMirrorDao.deleteById(sessionId);
        }
      }
      if (mounted) {
        ref.read(currentSessionProvider.notifier).set(null);
      }
      return true;
    } catch (e) {
      /* 回滚失败不能盖住真正的发送错误 — 那才是用户要看的 */
      debugPrint('[stage_input] rollback empty session failed: $e');
      return false;
    }
  }

  /// [text] 这句是不是已经作为 user_message 写进了这个会话 (最后一条用户消息就是它)。
  Future<bool> _userMessageLanded(String sessionId, String text) async {
    try {
      final events = await ref.read(appDatabaseProvider).sessionEventsDao.getBySessionId(sessionId);
      final users = events.where((e) => e.kind == 'user_message');
      if (users.isEmpty) return false;
      final payload = jsonDecode(users.last.payload);
      return payload is Map && '${payload['text'] ?? ''}'.trim() == text.trim();
    } catch (_) {
      return false;
    }
  }

  /// 有没有一台配过、能连的电脑 (连没连上不管 —— 没连上的建会话时会去连).
  Future<bool> _hasConnectableDesktop() async {
    final all = await ref
        .read(appDatabaseProvider)
        .pairedDesktopsDao
        .getAll();
    return all.any((d) => isRealPairedDesktop(d) && canConnectPairedDesktop(d));
  }

  /// 工作/编码却没有电脑 —— 两条出路: 去连一台, 或者这句话改在对话里问.
  ///
  /// 改去对话时输入框里的字原样留着, 切过去直接点发送就行。
  Future<void> _showNeedsDesktopSheet(HomeMode mode) async {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: scheme.surface,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                mode == HomeMode.code
                    ? tr('编码在电脑上运行')
                    : tr('工作在电脑上运行'),
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 6),
              Text(
                tr('读写文件、跑命令都在电脑那头。先在电脑上打开 Neox，用手机扫码配对。只想聊聊的话，对话在手机上就能用。'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 18),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, 'connect'),
                child: Text(tr('连接电脑')),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () => Navigator.pop(ctx, 'chat'),
                child: Text(tr('改在对话里问')),
              ),
            ],
          ),
        ),
      ),
    );
    if (!mounted) return;
    switch (picked) {
      case 'connect':
        await context.push('/settings/devices');
      case 'chat':
        /* chat:C1-03 — 在工作 / 编码会话里点「改在对话里问」: 新开一条对话, 并把原来的会话留在原处。 */
        final leftBehind = await switchHomeMode(ref, HomeMode.chat);
        if (!mounted) return;
        _focus.requestFocus();
        if (leftBehind != null) {
          _toast(tr('已新开一条对话 —— 刚才那条是「${leftBehind.label}」会话'));
        }
    }
  }

  Future<void> _sendImageDirect(String text) async {
    setState(() => _sending = true);
    final attachmentsSnapshot = List<_AttachmentItem>.of(_attachments);
    final refs = <String>[
      for (final a in attachmentsSnapshot)
        if (a.kind == 'image') 'data:${a.mime};base64,${base64Encode(a.bytes)}',
    ];
    try {
      _ctrl.clear();
      setState(_attachments.clear);
      await ref
          .read(imageStudioSenderProvider)
          .send(prompt: text, referenceDataUrls: refs);
    } catch (e) {
      if (mounted && _ctrl.text.trim().isEmpty) {
        _ctrl.text = text;
        _ctrl.selection = TextSelection.collapsed(offset: text.length);
        if (_attachments.isEmpty && attachmentsSnapshot.isNotEmpty) {
          setState(() => _attachments.addAll(attachmentsSnapshot));
        }
      }
      _toast(friendlyError(e, fallback: tr('生图失败，请稍后重试')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// 发送 + 连接类失败自动重连重试一次.
  ///
  /// 真机场景: 手机息屏 WS 被系统断掉, 回前台立刻点发送 → "当前任务未连接"
  /// 静默失败. 自动重连是无感的正确行为; 只重试一次, 再失败把错误抛给用户.
  Future<void> _sendWithReconnectRetry({
    required SessionRouter router,
    required String sessionId,
    required String text,
    required List<Map<String, Object?>> attachments,
    required String approvalMode,
    required bool chatMode,
  }) async {
    try {
      await router.sendMessage(
        sessionId: sessionId,
        text: text,
        attachments: attachments,
        approvalMode: approvalMode,
        chatMode: chatMode,
      );
    } on StateError catch (e) {
      final msg = e.message;
      final isConnectionIssue =
          msg.contains('未连接') || msg.contains('连不上') || msg.contains('重新进入') ||
          /* 英文界面下这些错误已被 tr() 翻译 */
          msg.contains('not connected') || msg.contains("isn't connected") ||
          msg.contains("can't reach");
      if (!isConnectionIssue) rethrow;
      /* 触发前台重连 (内部有 de-dupe), 给 8s 窗口等连接建立 */
      final ws = ref.read(wsClientProvider.notifier);
      final coordinator = ref.read(startupCoordinatorProvider);
      /* 不走 reconnectOnForeground: 那条在对话模式下不连, 而这里发的就是一条电脑会话 */
      await coordinator.connectDesktopIfNeeded();
      for (var i = 0; i < 16; i++) {
        if (ref.read(wsClientProvider).connection ==
            WsConnectionState.connected) {
          break;
        }
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
      /* 重连后 re-subscribe 当前会话再重发 */
      await ws.subscribeSession(sessionId);
      await router.sendMessage(
        sessionId: sessionId,
        text: text,
        attachments: attachments,
        approvalMode: approvalMode,
        chatMode: chatMode,
      );
    }
  }

  Future<void> _stop() async {
    final sessionId = ref.read(currentSessionProvider);
    if (sessionId == null) return;
    /* 乐观切 idle + 上取消闩 — 在 desktop 确认 (session_interrupted) 之前,
     * 在途的 delta/tool_running 不许把"运行中"顶回来, 否则停止按钮会闪回去,
     * 用户以为没按上就再按一次 (真实反馈: "暂停有时候要按两次"). */
    ref.read(timelineStateProvider(sessionId).notifier).markCancelRequested();
    try {
      await ref
          .read(sessionRouterProvider)
          .sendControl(sessionId: sessionId, kind: 'control:cancel');
    } catch (e) {
      _toast(friendlyError(e, fallback: tr('停止失败，请稍后重试')));
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// 语音输入开关 — 内联模式: 再点一次停止.
  Future<void> _toggleVoice() async {
    if (_listening) {
      await _voice.stop();
      _focus.requestFocus();
      return;
    }
    _voiceBaseText = _ctrl.text.trim();
    final settingsCtl = ref.read(voiceSettingsProvider.notifier);
    await settingsCtl.ready;
    var settings = ref.read(voiceSettingsProvider);
    final store = ref.read(modelStoreProvider.notifier);
    final hosted = ref.read(hostedAsrProvider);
    final subscriptionUsable = hosted?.available ?? false;
    var engine = settings.effectiveEngine(subscriptionUsable: subscriptionUsable);

    /* 本地没装 / 云端没配齐 → 引导弹窗, 选完按新的设置继续。订阅用户没选过时直接走订阅, 不弹 */
    final localReady = await store.isInstalled(kAsrStreamingPack);
    final needsSetup = (engine == VoiceEngine.local && !localReady) ||
        (engine == VoiceEngine.cloud && !settings.cloud.ready);
    if (needsSetup) {
      if (!mounted) return;
      final r = await showVoiceSetupSheet(context);
      if (r == VoiceSetupResult.dismissed || r == VoiceSetupResult.openedSettings) return;
      settings = ref.read(voiceSettingsProvider);
      engine = settings.effectiveEngine(subscriptionUsable: subscriptionUsable);
    }

    LocalAsrPaths? local;
    if (engine == VoiceEngine.local) {
      final refine = await store.isInstalled(kAsrRefinePack);
      local = (
        model: await store.pathOf(kAsrStreamingPack, 'model.int8.onnx'),
        tokens: await store.pathOf(kAsrStreamingPack, 'tokens.txt'),
        refineModel: refine ? await store.pathOf(kAsrRefinePack, 'model.int8.onnx') : null,
        refineTokens: refine ? await store.pathOf(kAsrRefinePack, 'tokens.txt') : null,
      );
    }
    await _voice.start(engine: engine, local: local, cloud: settings.cloud, hosted: hosted);
  }

  /* ─── build ──────────────────────────────────────────────── */

  @override
  Widget build(BuildContext context) {
    /* 顶栏 ✎「新会话」(2026-10-14): 首页本来就没开着会话, 以前点了等于什么都没做 (用户: 点了没反应)。
     * 现在: 清掉草稿和附件, 光标进输入框、弹键盘 —— 一眼看出「可以开始说新的了」 */
    ref.listen<int>(stageNewSessionTickProvider, (prev, next) {
      _ctrl.clear();
      setState(() => _attachments.clear());
      _focus.requestFocus();
    });
    /* 🎭 Life dashboard 卡点击 → composerPendingTextProvider 写入 → 这里 listen 消费. */
    ref.listen<String?>(composerPendingTextProvider, (prev, next) {
      if (next == null || next.isEmpty) return;
      _ctrl.text = next;
      _ctrl.selection = TextSelection.collapsed(offset: next.length);
      _focus.requestFocus();
      Future.microtask(
        () => ref.read(composerPendingTextProvider.notifier).state = null,
      );
    });

    /* 长按生成的图 →「继续改这张」: 挂成参考图, 光标进输入框等着写改法 */
    ref.listen<String?>(composerPendingImageProvider, (prev, next) {
      if (next == null || next.isEmpty) return;
      Future.microtask(() => ref.read(composerPendingImageProvider.notifier).state = null);
      unawaited(() async {
        try {
          final bytes = await File(next).readAsBytes();
          if (!mounted) return;
          final name = next.split('/').last;
          setState(() {
            _attachments
              ..removeWhere((a) => a.kind == 'image' && a.name == name)
              ..add(_AttachmentItem(kind: 'image', name: name, mime: _guessImageMime(name), bytes: bytes));
          });
          _focus.requestFocus();
        } catch (e) {
          _toast(friendlyError(e, fallback: tr('取图失败，请重试')));
        }
      }());
    });

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    /* agent 是否在跑 — 有当前 session 才 watch (family provider 不能 watch null). */
    final sessionId = ref.watch(currentSessionProvider);
    var agentBusy = false;
    if (sessionId != null) {
      final snap = ref.watch(timelineStateProvider(sessionId));
      final pending = ref.watch(pendingUserTextProvider(sessionId));
      agentBusy = snap.agentRunning || pending != null;
    }

    /* 陶土稿 v5: 输入框是一块釉面泥板 (圆角 24) —— 渐变 + 顶边高光 + 两层暖色软影, 不描边。
     * 进了会话收成单行「补一句…」, 首页是两行 (上输入、下 ＋ / 在哪干 / 模型 / 麦 / 发送)。 */
    return ClaySlab(
      radius: 24,
      padding: EdgeInsets.zero,
      lift: 1.2,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          /* 审批挪到输入框上方的独立小板 (ApprovalDock, home_stage_page 里摆) */
          /* 图片页输入框里原来有一颗「创建图片」角标 —— 页面标题已经是「图片」, 删了 */
          if (_attachments.isNotEmpty)
            _AttachmentStrip(
              items: _attachments,
              onRemove: (i) => setState(() => _attachments.removeAt(i)),
            ),
          /* 内联声纹 — 听的时候显示在 pill 内输入行上方, 不弹窗 */
          if (_listening)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.lg,
                NeoxSpace.sm + 2,
                NeoxSpace.lg,
                0,
              ),
              child: InlineWaveform(levels: _voice.levels),
            ),
          if (_transcribing)
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, NeoxSpace.sm + 2, NeoxSpace.lg, 0),
              child: Row(
                children: [
                  const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: NeoxSpace.sm),
                  Text(tr('识别中…'), style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
          /* ── 第一行: 只有文字 ───────────────────────────────────
           * 原来是单行 [+] [文字] [🎙] [⬆] 挤在一条 51pt 高的 pill 里。
           * 用户拿豆包和 Claude 手机端对比后判词"每个组件都不协调"。量下来
           * (都换算成占屏宽的百分比, 跨设备可比):
           *
           *   输入区总高:  Claude 30.9%  ·  豆包 19.7%  ·  我们 12.7%
           *
           * 差的不是细节是**结构**: 人家的 composer 是两行 —— 文字一行,
           * 控件一行, 而且控件全都坐在填充形状 (药丸/圆) 上。所以它一个人
           * 就填实了屏幕下方三分之一, 整页才不空。
           * 拆成两行之后文字这一行也终于能拉满宽度, 不再被左右四个按钮夹着。 */
          /* 会话里也是两行 (4.0.2): 收成单行 [＋] 补一句… [发送] 之后模型签没地方放, 聊着聊着
           * 不知道是哪个模型在答 (用户:「对话的时候无法看到模型了」)。 */
          _textRow(
            false,
            agentBusy,
            /* 回车直接发 (2026-10-12 用户: 「要支持回车发送」)。
             *
             * 多行 TextField 里物理键盘的回车走的是框架默认那条「插换行」快捷键,
             * `textInputAction` 只管软键盘那颗动作键, 够不着它 —— 所以就近拦一道。
             * 仍保留折行输入: maxLines 6 时文字照样自动折行, 只是敲回车不再是换行。 */
            CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.enter): () =>
                    unawaited(_send()),
              },
              child: TextField(
              controller: _ctrl,
              focusNode: _focus,
              enabled: !_sending,
              maxLines: 6,
              minLines: 1,
              /* 回车直接发 (2026-10-12 用户: 「要支持回车发送」)。原来是 newline,
               * 敲回车只换行不发 —— 之前还闹过"打了字看到的是语音键"那种状态错位。
               * 代价: 手机软键盘上不再有换行键 (长文本照样自动折行)。 */
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _send(),
              style: theme.textTheme.bodyMedium,
              decoration: InputDecoration(
                isCollapsed: true,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                fillColor: Colors.transparent,
                hintText: widget.imageMode
                    ? tr('描述画面，或选图来改')
                    /* 进了会话: 「补一句…」(陶土稿) */
                    : sessionId != null
                    ? (agentBusy ? tr('补一句…') : tr('继续说…'))
                    : ref.watch(homeModeProvider) == HomeMode.chat
                    ? HomeMode.chat.composerHint
                    : ref.watch(chatModeProvider).isOn(ref.watch(currentSessionProvider))
                    ? tr('随便聊聊，问点什么…')
                    : ref.watch(homeModeProvider).composerHint,
                /* 占位文字原来是 onSurfaceVariant × 0.55 —— 又一处"在已经
                 * 够浅的色上再乘一次 alpha", 实测对白底只有 2.24, 而 WCAG
                 * 正文要求 4.5。这条跟边框那处是同一个病: 稀释叠稀释。
                 * 直接取 hintInk (4.95), 不再自己乘。 */
                hintStyle: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.hintInk,
                ),
                contentPadding: EdgeInsets.zero,
              ),
            ),
            ),
          ),
          /* ── 第二行: 控件 ───────────────────────────────────────
           * [+] [模型] [位置] ─── [🎙] [发送]   (模式在抽屉, 不在这里)
           *
           * 模式和运行位置**从顶栏搬下来的**。顶栏那个 logo+chevron 是我审计
           * 里就记过的问题 (发现性差: logo 看着像标识不像按钮), 而这三件事
           * ——模式 / 模型 / 跑在哪—— 回答的是同一个问题: 这句话怎么被处理。
           * 它们属于**下一条消息**, 不属于页面导航, 所以该长在 composer 上。
           *
           * chip 左侧横向可滚: 机器名一长 (「MacBook Pro · neox」) 就会溢出,
           * 而右边发送键绝不能被挤走。 */
          /* ── 第二行 (首页 / 图片页): [＋] [在哪干] [模型] ··· [🎙] [发送] ──
           * 陶土稿 v5: ＋ 和麦克风是陶土圆, 两颗签是陶土胶囊, 发送是一颗钴蓝圆。
           * 进了会话收成单行 (见 [_textRow]), 这一行不画。 */
          Padding(
              padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
              child: Row(
                children: [
                  _plusButton(),
                  const SizedBox(width: _kComposerGap),
                  /* 签区不横向滚动: 窄屏先截模型名, 再不够收起「在哪干」(LayoutBuilder 里按宽度判) */
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, box) {
                        final mode = ref.watch(homeModeProvider);
                        /* 会话里不挂「在哪干」: 已经在跑的会话换不了地方, 跑在哪看顶栏那行小字 */
                        final where = (!widget.imageMode && mode != HomeMode.chat && sessionId == null)
                            ? whereChipOf(ref)
                            : null;
                        /* 旁边还挤着一颗「在哪干」时, 模型签更早进紧凑样式 */
                        final chips = _composerChips(context, compact: box.maxWidth < (where != null ? 300 : _kCompactChipRowWidth));
                        return Row(
                          children: [
                            if (chips.mode != null) ...[chips.mode!, const SizedBox(width: _kComposerGap)],
                            if (where != null && box.maxWidth >= 180) ...[
                              _ComposerChip(
                                /* 窄了先把「Phone / MacBook」收成只剩图标, 模型名要完整
                                 * (2026-10-14 实测: 两颗签都在时模型被截成「DeepSe…」, 看不出用的哪个) */
                                label: box.maxWidth < 300 ? '' : where.label,
                                icon: where.icon,
                                trailingChevron: true,
                                onTap: () => showWhereSheet(context, ref),
                              ),
                              const SizedBox(width: _kComposerGap),
                            ],
                            if (chips.model != null) Flexible(child: chips.model!),
                            if (chips.size != null) ...[
                              const SizedBox(width: _kComposerGap),
                              /* 尺寸签比模型名短, 不抢模型名的宽度 (它已经在 Flexible 里) */
                              chips.size!,
                            ],
                          ],
                        );
                      },
                    ),
                  ),
                  const SizedBox(width: _kComposerGap),
                  ClayRoundButton(
                    icon: Icons.mic_none_rounded,
                    size: _kComposerControl,
                    tooltip: tr('语音输入'),
                    onTap: _toggleVoice,
                    child: Icon(
                      _listening ? Icons.mic_rounded : Icons.mic_none_rounded,
                      size: 19,
                      color: _listening ? ClayInk.of(context).redInk : ClayInk.of(context).ink,
                    ),
                  ),
                  const SizedBox(width: _kComposerGap),
                  _sendSlot(agentBusy),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 输入那一行. 会话里 ([compact]) 是单行: [＋] 补一句… [发送]; 首页只放文字 (控件在第二行).
  Widget _textRow(bool compact, bool agentBusy, Widget field) {
    if (!compact) {
      return Padding(padding: const EdgeInsets.fromLTRB(18, 16, 18, 4), child: field);
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          _plusButton(),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: field),
          ),
          const SizedBox(width: 6),
          _sendSlot(agentBusy),
        ],
      ),
    );
  }

  /// [＋] —— 外圈那道环 = 上下文占用 (没数据时不画).
  Widget _plusButton() => Stack(
        alignment: Alignment.center,
        children: [
          ClayRoundButton(
            icon: Icons.add_rounded,
            size: _kComposerControl,
            tooltip: tr('更多'),
            onTap: _openPlusMenu,
          ),
          IgnorePointer(child: ContextRing(usage: _contextUsage(), size: _kComposerControl + 4)),
        ],
      );

  /// 发送 / 停止 / 语音对话 那一颗.
  ///
  /// 发送键的**形状和可用态都跟着输入框的实时值走** (2026-10-12): 按钮子树直接监听 controller,
  /// 没有中间状态可错开 (之前出过"打了字还是语音键, 一点就进了语音页")。
  Widget _sendSlot(bool agentBusy) {
    if (agentBusy) return _StopButton(onTap: _stop);
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _ctrl,
      builder: (context, value, _) {
        final hasContent = value.text.trim().isNotEmpty || _attachments.isNotEmpty;
        /* 没打字时发送键变成「语音对话」(跟 ChatGPT 同一个位置): 只在对话首页、安卓 */
        if (!hasContent &&
            !_sending &&
            !widget.imageMode &&
            Platform.isAndroid &&
            ref.watch(currentSessionProvider) == null &&
            ref.watch(homeModeProvider) == HomeMode.chat) {
          return _VoiceChatButton(onTap: () {
            if (_listening) unawaited(_voice.cancel());
            context.push('/voice-chat');
          });
        }
        return _SendButton(enabled: hasContent && !_sending, sending: _sending, onTap: _send);
      },
    );
  }
}

// ────────────────────────────────────────────────────────────────
//  附件预览条 (pill 内顶部)
// ────────────────────────────────────────────────────────────────
class _AttachmentStrip extends StatelessWidget {
  const _AttachmentStrip({required this.items, required this.onRemove});

  final List<_AttachmentItem> items;
  final void Function(int index) onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.md,
        NeoxSpace.sm + 2,
        NeoxSpace.md,
        0,
      ),
      child: SizedBox(
        height: 56,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: items.length,
          separatorBuilder: (_, __) => const SizedBox(width: NeoxSpace.sm),
          itemBuilder: (context, i) {
            final a = items[i];
            return Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  width: 56,
                  height: 56,
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    borderRadius: NeoxRadius.chipR,
                    border: Border.all(
                      color: scheme.outline,
                      width: NeoxStroke.hair,
                    ),
                    color: scheme.surface,
                  ),
                  child: a.kind == 'image'
                      ? Image.memory(
                          a.bytes,
                          fit: BoxFit.cover,
                          gaplessPlayback: true,
                        )
                      : Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              Icons.insert_drive_file_outlined,
                              size: 18,
                              color: scheme.onSurfaceVariant,
                            ),
                            const SizedBox(height: 2),
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 4,
                              ),
                              child: Text(
                                a.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 9,
                                  color: scheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ],
                        ),
                ),
                Positioned(
                  top: -6,
                  right: -6,
                  child: GestureDetector(
                    onTap: () => onRemove(i),
                    child: Container(
                      width: 18,
                      height: 18,
                      decoration: BoxDecoration(
                        color: scheme.onSurface,
                        shape: BoxShape.circle,
                        border: Border.all(color: scheme.surface, width: 1.5),
                      ),
                      child: Icon(Icons.close, size: 11, color: scheme.surface),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
//  Send (钴蓝圆) / 语音对话
// ────────────────────────────────────────────────────────────────
/// 语音对话键: 空心描边 + 声波, 跟实心黑圆的发送键一眼分开; 刚出现的半秒内不接点击
/// (发送后字清空、它冒出来的那一刻, 手指的第二下还在路上)。
class _VoiceChatButton extends StatefulWidget {
  const _VoiceChatButton({required this.onTap});
  final VoidCallback onTap;

  @override
  State<_VoiceChatButton> createState() => _VoiceChatButtonState();
}

class _VoiceChatButtonState extends State<_VoiceChatButton> {
  final _shownAt = DateTime.now();

  /// 刚冒出来的这一小段里不接点击 —— 发送后字清空、它出现的那一刻, 手指的第二下
  /// 还在路上 (双击间隔一般 100~300ms)。
  ///
  /// 这道闸**必须在这儿**, 不能在调用方按墙钟算: 调用方算的时候拿不到"它是什么时候
  /// 出现的", 只能拿"上次发送到现在多久", 两者错开就会出现按钮形状和文本对不上
  /// (2026-10-12 用户报的那个 bug)。
  static const Duration _deadZone = Duration(milliseconds: 1200);

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: tr('语音对话'),
      button: true,
      child: Tooltip(
        message: tr('语音对话'),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: () {
              if (DateTime.now().difference(_shownAt) < _deadZone) return;
              widget.onTap();
            },
            child: Container(
              width: _kComposerControl + 4,
              height: _kComposerControl + 4,
              decoration: BoxDecoration(shape: BoxShape.circle, color: ClayInk.of(context).cobalt),
              child: const Icon(Icons.graphic_eq, size: 19, color: Colors.white),
            ),
          ),
        ),
      ),
    );
  }
}

class _SendButton extends StatelessWidget {
  const _SendButton({
    required this.enabled,
    required this.sending,
    required this.onTap,
  });

  final bool enabled;
  final bool sending;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    /* 陶土稿 v5: 发送是整屏一颗钴蓝 (纸飞机), 一直是钴蓝 —— 没内容时只是轻一点 (点了不发) */
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 140),
        opacity: enabled || sending ? 1 : 0.55,
        child: Container(
          width: _kComposerControl + 4,
          height: _kComposerControl + 4,
          /* 平的一颗钴蓝 (控件不做立体, 跟桌面发送键一样) */
          decoration: BoxDecoration(shape: BoxShape.circle, color: c.cobalt),
          child: Center(
            child: sending
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 1.8, color: Colors.white),
                  )
                : const Icon(Icons.send_rounded, size: 18, color: Colors.white),
          ),
        ),
      ),
    );
  }
}

/// composer 控件行的统一尺寸: [+] / chip / 🎙 / 发送 同高, 同间距.
const double _kComposerControl = 36;
const double _kComposerGap = 6;

/// chip 区窄于此值时去掉下拉箭头 (320dp 屏 + 系统字体放大时约 170)。
const double _kCompactChipRowWidth = 200;

/// composer 第二行的 chip —— 药丸底 + 文字 (+ 可选的下拉小箭头).
///
/// 它存在的理由不只是"好看": 用户判词"每一个组件都不协调", 真因是我们整屏几乎
/// 没有**面**, 只有线和字。裸露的图标和文字之间没有可比的东西 —— 它们不是不协调,
/// 是压根没进同一套词汇。给能点的东西一个填充形状, 它们才成为一个家族。
class _ComposerChip extends StatelessWidget {
  const _ComposerChip({
    required this.label,
    required this.onTap,
    this.trailingChevron = false,
    this.icon,
    this.leading,
    this.tag,
  });

  final String label;
  final VoidCallback? onTap;

  /// 前面的小线条图标 (设备签: 手机 / 电脑 / 云)
  final IconData? icon;

  /// 前面的自定义部件 (模型签: 厂商原色标), 有它就不画 [icon]
  final Widget? leading;

  /// 名字后面一颗小标 (模型签: 「按量」)
  final String? tag;

  /// 有下拉箭头 = 点了会弹选择面板. 纯状态展示的 chip 不带.
  final bool trailingChevron;

  /// 这颗 chip 不截断时的宽度 —— 跟 [build] 里的内边距/圆点/箭头一一对应.
  double estimateWidth(BuildContext context) {
    final style = Theme.of(
      context,
    ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w500);
    final painter = TextPainter(
      text: TextSpan(text: label, style: style),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    const left = 12.0;
    final right = trailingChevron ? 6.0 + 16 : 12.0;
    return left + painter.width + right;
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    /* 高度固定 = _kComposerControl, 跟 [+] / 🎙 / 发送三颗圆同高。陶土胶囊: 上浅下深 + 轻影。
     * 文字可省略: 放在 Flexible 里时长模型名截成 "deepseek-v4…", 不把整行撑出屏幕。 */
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: _kComposerControl,
        padding: EdgeInsets.fromLTRB(icon != null || leading != null ? 10 : 12, 0, trailingChevron ? 8 : 12, 0),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(_kComposerControl / 2),
          color: c.fill,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (leading != null)
              ...[leading!, if (label.isNotEmpty) const SizedBox(width: 6)]
            else if (icon != null)
              ...[Icon(icon, size: 16, color: c.ink), if (label.isNotEmpty) const SizedBox(width: 5)],
            if (label.isNotEmpty)
              Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                softWrap: false,
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: c.ink, height: 1.2),
              ),
            ),
            if (tag != null) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(5),
                  color: c.ink.withValues(alpha: 0.08),
                ),
                child: Text(tag!, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.grey, height: 1.3)),
              ),
            ],
            if (trailingChevron) ...[
              const SizedBox(width: 2),
              Icon(Icons.keyboard_arrow_down_rounded, size: 17, color: c.grey),
            ],
          ],
        ),
      ),
    );
  }
}

/// 模型行要显示的模型名 —— 去掉服务商那一截.
///
/// BYOK 模型的名字有两种来源, 都带着服务商:
///   · 手机网关拼的 `deepseek-v4 · 我的中转`  (listModels 里拼的)
///   · 电脑列表给的 `m5x:deepseek-v4`        (providerId 前缀)
/// 两种都会把模型名挤没 (输入框 chip 上实拍是「m5x:deep…」)。
String modelRowName(String id, String name) {
  final dot = name.indexOf(' · ');
  if (dot > 0) return name.substring(0, dot).trim();
  final colon = name.indexOf(':');
  if (colon > 0) return name.substring(colon + 1).trim();
  final idColon = id.indexOf(':');
  if (idColon > 0 && name == id) return name.substring(idColon + 1).trim();
  return name;
}

/// 模型行右边那个服务商名 —— 取不到就返回 null (不编).
String? modelRowProvider(String id, String name) {
  final dot = name.indexOf(' · ');
  if (dot > 0) {
    final p = name.substring(dot + 3).trim();
    return p.isEmpty ? null : p;
  }
  final colon = name.indexOf(':');
  if (colon > 0) {
    final p = name.substring(0, colon).trim();
    return p.isEmpty ? null : p;
  }
  final idColon = id.indexOf(':');
  if (idColon > 0) {
    final p = id.substring(0, idColon).trim();
    return p.isEmpty ? null : p;
  }
  return null;
}

/// 模型选择 sheet — 输入框 [+] 面板和 timeline 错误卡的「换个模型」共用.
///
/// 提成顶层函数是因为错误卡在 TimelineMessageList 里, 拿不到 StageInput 的
/// State。而"模型被服务端停用"恰恰是最需要就地换模型的场景 —— 之前
/// home_stage_page 根本没给 onPickModel, 那个按钮永远不长出来。
/// 模型选择 sheet.
///
/// [imageOnly] = 图片工作台那条路 (2026-09-18 用户: 「图片工作台没有显示模型列表
/// 显示的还是文字的」)。这个 sheet 原来只有一种模式, 于是图片页点开「图像模型」
/// 列出来的全是文字模型, 选完写的也是聊天模型 —— 而出图那条路根本不读它,
/// 它自己 pickImageModel() 自动挑。点了等于没点, 但看起来是能选的。
///
/// 开了 [imageOnly] 之后: 只列出图模型 (looksLikeImageModel), 选中写
/// imageModelPrefProvider, 不碰聊天模型和会话模型。
Future<void> openModelSheet(
  BuildContext context,
  WidgetRef ref, {
  bool imageOnly = false,
}) async {
  /* 打开选择器就顺手重拉一次列表 —— 服务端上下架模型, 这里要跟着变。
   * ⚠️ 先读缓存再 invalidate, 且下面有缓存就用缓存弹: 0b8a40779 加这行之后, 下面那句
   * `await availableModelsProvider.future` 等的就变成了**这次重拉** —— 每点一次都要等一整轮
   * 网关请求 (最长 18s) 才弹面板 (2026-10-06 用户: 「模型点击非常慢才弹出」)。
   * 重拉结果下次打开就用上; 下架的模型在发送时还有 liveModelId 兜着。 */
  final cachedGatewayModels = ref.read(availableModelsProvider).valueOrNull;
  ref.invalidate(availableModelsProvider);
  void toast(String msg) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<bool> sessionIsPhoneLocal(String sessionId) async {
    final mirror = await ref
        .read(appDatabaseProvider)
        .sessionMirrorDao
        .findById(sessionId);
    return mirror != null && isPhoneLocalDeviceId(mirror.desktopDeviceId);
  }

  /* 图片模式下「当前会话」无关: 出图不走会话模型, 而且图片页的会话是
   * img-* 本地会话。sid 置空, 下面那些改会话模型的分支自然都不走。 */
  final sid = imageOnly ? null : ref.read(currentSessionProvider);
  final selectedId = ref.read(effectiveModelProvider);
  final sessionCtx = sid == null ? null : ref.read(sessionContextProvider(sid));
  final currentId = imageOnly
      ? ref.read(imageModelPrefProvider)
      : (sessionCtx != null && sessionCtx.modelId.isNotEmpty)
      ? liveModelId(sessionCtx.modelId, cachedGatewayModels ?? const <GatewayModel>[], selectedId)
      : selectedId;

  /* 电脑/云端会话优先用桌面 model.list; 失败再回落手机网关列表 */
  var useDesktopList = false;
  List<({String id, String name, bool isByok, bool payg, double? relativeCost})> entries =
      [];
  final phoneLocalSession = sid != null && await sessionIsPhoneLocal(sid);
  if (sid != null && !phoneLocalSession) {
    /* 电脑列表同理: 有上次的就先用, 后台刷新; 第一次才等 (最多 6s, 超了退回手机网关列表) */
    final ws = ref.read(wsClientProvider.notifier);
    final cachedDesk = ws.cachedAvailableModels;
    final List<ModelInfo> desk;
    if (cachedDesk.isNotEmpty) {
      desk = cachedDesk;
      unawaited(ws.fetchAvailableModels());
    } else {
      desk = await ws.fetchAvailableModels()
          .timeout(const Duration(seconds: 6), onTimeout: () => const <ModelInfo>[]);
    }
    if (desk.isNotEmpty) {
      useDesktopList = true;
      /* 桌面会话这条路也要过滤 —— 2026-09-22 真机实拍: 这个 picker 里混着
       * 出图模型 (gpt-image-2 / nano-banana-2 / gpt-image-2-pro / grok-image)
       * 和占位模型 (or-free-auto)。用户原话:「为什么出图模型在编码里面还存在?
       * 没有过滤?」「or-free-auto 我说禁用为什么还有?」
       *
       * 桌面 model.list 的条目**不带 canChat / isImageGeneration** (那是手机网关
       * 的字段), 所以这里只能按**名字**认 —— 用跟出图链路同一个 looksLikeImageModel,
       * 免得两套判据对不上。 */
      entries = desk
          .where((m) => !kHiddenModelIds.contains(m.id))
          .where((m) => !looksLikeImageModel(m.id))
          .map(
            (m) => (
              id: m.id,
              name: m.name.isNotEmpty ? m.name : m.id,
              isByok: !m.isSubscription && !m.payAsYouGo,
              payg: m.payAsYouGo,
              relativeCost: m.relativeCost,
            ),
          )
          .toList();
    }
  }
  if (entries.isEmpty) {
    /* await future, 不能用 valueOrNull.
       *
       * 2026-08-11 实测: 从 timeline 错误卡的「换个模型」进来时, 这个 provider
       * 从没被 watch 过 —— valueOrNull 是 null, sheet 直接空着弹出来, 只剩一句
       * 「登录用订阅模型，或接入自己的 Key」。而这条路径恰恰是模型不可用时用户
       * 唯一的出路, 空列表等于死路。
       * 输入框 [+] 面板那条路径是 watch 过的所以一直看不出问题。 */
    List<GatewayModel> models;
    if (cachedGatewayModels != null && cachedGatewayModels.isNotEmpty) {
      models = cachedGatewayModels;
    } else {
      try {
        models = await ref
            .read(availableModelsProvider.future)
            /* 18s > provider 内部的 15s —— 让它自己超时并把原因写进
             * modelFetchErrorProvider; 这里再短一点就变成"外层先掉断, 原因还来不及记"。 */
            .timeout(const Duration(seconds: 18));
      } catch (_) {
        models =
            ref.read(availableModelsProvider).valueOrNull ??
            const <GatewayModel>[];
      }
    }
    /* 滤掉占位模型 (auto / or-free-auto) —— 2026-09-22 用户:
     * 「把 auto 取消…不要用 auto, auto 没有意义」「这有个 or-free-auto,
     * 我觉得没有必要显示」。它们不是一个模型, 而是"让别人挑": 列在真模型里
     * 用户没法判断这一发会落到谁身上、要花多少额度。 */
    /* imageOnly 时**不能**走 selectableModels —— 2026-09-22.
     *
     * selectableModels 按 canChat 滤掉出图模型 (那正是对话/编码侧要的), 但图片
     * picker 要的就是那些。两边共用同一个过滤的话, 图片这边过滤完一个都不剩,
     * 弹出来是一句「登录使用订阅模型」的空态 —— 真机实拍就是这样。
     * 图片侧该走的是下面那层 looksLikeImageModel。 */
    entries = (imageOnly ? models : selectableModels(models))
        .map(
          (m) => (
            id: m.id,
            name: m.name,
            isByok: m.isByok,
            payg: m.payAsYouGo,
            relativeCost: m.relativeCost,
          ),
        )
        .toList();
  }

  if (imageOnly) {
    /* 只留出图模型。判据跟真正发请求时用的是同一个 (looksLikeImageModel) ——
     * 两套判据的话, 列表里能选到的模型发过去会被服务端拒掉。按量组不接出图。 */
    entries = entries.where((m) => !m.payg && looksLikeImageModel(m.id)).toList();
  }

  /* subscription / byok 两组挪进了下面的 sheet builder —— 它们要跟着搜索框的输入
   * 实时变化 (见 openModelSheet 里的 ValueListenableBuilder)。 */

  /* 本机模型 (llama.cpp) 只给手机上跑的会话 —— 电脑会话 / 工作编码模式跑不了它,
   * 列出来选了就是一条发不出去的会话。已下载的才列, 没下载的走「下载本机模型」。 */
  /* 还没会话: 对话 = 手机; 工作 / 编码看「在哪干」那颗签 */
  final phoneContext = !imageOnly &&
      (sid != null
          ? phoneLocalSession
          : (ref.read(homeModeProvider) == HomeMode.chat ||
              ref.read(runTargetPrefProvider) == RunTargetPref.phone));
  final installedLocal = <LocalLlm>[];
  /* 组一直在 (2026-09-30 用户:「好像没有本地模型」) —— 电脑会话里列出来但点不了, 说明只在对话里用 */
  if (!imageOnly && kLocalLlmSupported) {
    final store = ref.read(modelStoreProvider.notifier);
    for (final m in kLocalLlms) {
      if (await store.isInstalled(m.pack)) installedLocal.add(m);
    }
  }

  /* 陶土稿 v5「模型」弹层: 思考四档 + 订阅 / 按量 / 自己的 Key (+ 本机), 不折叠、不写价格。
   * 长相在 model_sheet_body.dart, 这里只给数据。 */
  /* 思考跟着当前这个模型记; 只对手机上跑的会话生效 (电脑会话的思考由电脑管) */
  final thinkId = currentId ?? '';
  if (!context.mounted) return;
  final picked = await showClaySheet<String>(
    context,
    maxHeightFactor: 0.82,
    builder: (ctx) => ModelSheetBody(
      entries: entries,
      installedLocal: installedLocal,
      currentId: currentId,
      phoneContext: phoneContext,
      useDesktopList: useDesktopList,
      imageOnly: imageOnly,
      fetchError: ref.read(modelFetchErrorProvider),
      hasAccounts: ref.read(editionProvider).hasAccounts,
      thinkId: thinkId,
      showThinking: phoneContext && localLlmForModelId(thinkId) == null,
      thinkToggleable: canToggleThinking(thinkId),
      rowName: modelRowName,
      rowProvider: modelRowProvider,
      onRetry: () {
        ref.invalidate(availableModelsProvider);
        Navigator.pop(ctx);
      },
    ),
  );

  if (!context.mounted || picked == null) return;
  const addKeySentinel = ModelSheetBody.addKeySentinel;
  const loginSentinel = ModelSheetBody.loginSentinel;
  const localModelsSentinel = ModelSheetBody.localModelsSentinel;
  if (picked == ModelSheetBody.manageSentinel) {
    GoRouter.of(context).push('/settings/models');
    return;
  }
  if (picked == addKeySentinel) {
    GoRouter.of(context).push('/settings/providers');
    return;
  }
  if (picked == loginSentinel) {
    GoRouter.of(context).push('/login');
    return;
  }
  if (picked == localModelsSentinel) {
    GoRouter.of(context).push('/settings/models/local');
    return;
  }
  if (imageOnly) {
    /* 出图模型单独存 —— 写 selectedModelProvider 会把用户的聊天模型改掉,
     * 而出图那条路又不读它 (原来就是这么"点了没反应"的)。 */
    ref.read(imageModelPrefProvider.notifier).set(picked);
    toast(tr('已切换图像模型'));
    return;
  }
  /* 全局默认 — 影响之后新建会话 */
  ref.read(selectedModelProvider.notifier).set(picked);
  /* 当前会话 — 手机本地 / 电脑会话分别改 session model */
  if (sid != null) {
    final phoneLocal = await sessionIsPhoneLocal(sid);
    var ok = false;
    if (phoneLocal) {
      ok = await ref.read(phoneLocalAgentProvider).updateModel(sid, picked);
    } else {
      ok = await ref
          .read(wsClientProvider.notifier)
          .updateSessionModel(sid, picked);
    }
    if (ok) {
      /* 成功不弹提示: 输入框上的模型名已经变了, SnackBar 只会盖住输入框 (2026-10-05 用户: 弹窗影响正常输入) */
      unawaited(ref.read(sessionContextProvider(sid).notifier).refresh());
    } else {
      toast(phoneLocal ? tr('切换失败') : tr('已记为默认; 当前会话切换失败, 请确认已连接电脑'));
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Stop (agent 在跑时替换 send)
// ────────────────────────────────────────────────────────────────
class _StopButton extends StatelessWidget {
  const _StopButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ClayRoundButton(
      icon: Icons.stop_rounded,
      ink: true,
      size: _kComposerControl + 4,
      tooltip: tr('停止'),
      onTap: onTap,
    );
  }
}

