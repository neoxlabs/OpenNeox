/// phone_local_agent.dart — 手机本机运行模式。
///
/// Android 本地 Agent 闭环 (agentsdk 接入后):
///   - 会话和消息存在手机本地 Drift
///   - 推理两条路: 订阅 (NeoxCloud /n1, JWT 计费) 或 BYOK (byok/ 前缀模型,
///     直连厂商, 零账号可用) — 按 modelId 前缀路由, 计费彻底隔离
///   - OpenAI 协议链路 (订阅网关 + BYOK openai-compat) 走 neox_agent_sdk 的
///     工具调用循环 — 联网/工作区文件/计算/时间 四个内置工具, 脱离桌面能干活
///   - Anthropic / Gemini BYOK 暂走纯聊天 (工具 wire 格式不同, 下版本接)
library;

import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'dart:io';
import 'dart:math';

import 'package:drift/drift.dart' show Value;
import 'package:http/http.dart' as http show ClientException;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:path_provider/path_provider.dart';

import '../../features/timeline/state/timeline_state.dart';
import '../attachments/local_attachment_store.dart';
import '../edition/edition.dart' show planModelsProvider;
import '../byok/byok_models.dart';
import '../image/image_model_pick.dart' show looksLikeImageModel;
import '../byok/byok_service.dart';
import '../byok/byok_store.dart';
import '../composer/chat_mode_pref.dart';
import '../execution/inference_params_provider.dart';
import '../execution/run_target.dart';
import '../llm/chat_backend.dart';
import '../llm/llm_http.dart';
import '../llm/sse.dart';
import '../local_llm/local_llm_engine.dart';
import '../local_llm/local_model_catalog.dart';
import '../models/model_store.dart';
import '../network/stream_buffer_provider.dart';
import '../session_routing/send_failure_note.dart' show kClientErrorKind;
import '../storage/database.dart';
import 'answer_versions.dart';
import 'send_retry.dart';
import 'session_title.dart';
import '../telemetry/chat_metric.dart';
import '../telemetry/chat_metrics.dart';
import 'agent_environment.dart';
import 'anthropic_tool_connector.dart';
import 'attachment_text.dart';
import 'uploaded_images.dart';
import 'office/office_doc.dart' show officeKindOf;
import 'tools/office_edit_tool.dart';
import 'tools/shell_tool.dart';
import 'tools/phone_control.dart';
import 'tools/shot_retention.dart';
import 'tools/image_tool.dart';
import 'hosted_web_search.dart';
import 'chat_light_prompt.dart';
import 'chat_budget.dart';
import 'chat_repeat_guard.dart';
import 'chat_send_prep.dart';
import 'current_time_tag.dart';
import 'model_gateway_client.dart';
import '../session_routing/chat_session_mode.dart' show isChatSession, kChatAgentMode;
import '../../features/home/state/selected_model_provider.dart'
    show availableModelsProvider, effectiveModelProvider, liveModelId;
import '../network/session_context_provider.dart' show sessionContextProvider;
import 'openai_tool_connector.dart';
import 'tools/phone_tools.dart';
import 'tools/reminder_tool.dart';
import 'package:flutter/material.dart';
import '../composer/approval_mode_pref.dart';
import '../router.dart' show rootNavigatorKey;
import 'package:neox_app/core/i18n/tr.dart';

/// 兜底 model id — 当 server 端 model gateway 已配 `auto` 池 alias 时直接用,
/// 没配则 createSession 会调 listModels() 选第一个 fallback.
const String kDefaultPhoneLocalModelId = 'auto';

/// 把一个可能带**桌面命名空间**的 model id 收拾成手机网关认识的样子.
///
/// 2026-08-11 模拟器实录, 跟下面 createSession 里那个 'auto' 的 P0 是同一个家族:
///   1. 用户在一个**电脑会话**里打开模型选择器 → 走的是桌面 `model.list`, id 形如
///      `neox-cloud:deepseek-v4-flash` (`<providerId>:<model>`);
///   2. 选中后写进 selectedModelProvider —— 那是**全局**默认, 不分运行位置;
///   3. 之后新建一个**手机本地**会话, modelHint 就是那个带前缀的 id;
///   4. 手机网关 `/n1/chat/completions` 不认前缀, 回 `该模型已停用, 请选择其他模型`。
/// 症状是手机本地每一条消息都发不出去, 而模型选择器里那个模型看着完全正常
/// (实测同一个 `deepseek-v4-flash`, 去掉前缀立刻就通)。
///
/// BYOK 的 `byok/<provider>/<model>` 是手机自己的格式, 原样放行。
String normalizePhoneLocalModelId(String raw) {
  final id = raw.trim();
  if (id.isEmpty) return id;
  if (ByokModelRef.isByok(id)) return id;
  /* 本机模型 local:<id> —— 命名空间就是路由依据, 不能剥 */
  if (localLlmForModelId(id) != null) return id;
  final colon = id.indexOf(':');
  /* 冒号在开头/结尾都不是合法命名空间, 不动它 */
  if (colon <= 0 || colon == id.length - 1) return id;
  return id.substring(colon + 1);
}

class PhoneLocalSessionInfo {
  const PhoneLocalSessionInfo({
    required this.id,
    required this.title,
    required this.modelId,
    required this.workspaceName,
  });

  final String id;
  final String title;
  final String modelId;
  final String workspaceName;
}

/// 手机本地会话送给模型的历史 —— 窗口 + 单条截断.
///
/// 2026-08-08: 这里原来**完全没有上限** —— session 的全部事件依次拼进 messages,
/// 没有条数限制、没有 token 预算、没有压缩。桌面侧有上下文压缩 (timeline 上那条
/// compaction 分隔线), 手机本地这条路一直没有对应机制。
///
/// 后果渐进且不可逆: 聊到几十轮后每次发送都在重传整段历史 → 越来越慢、越来越贵,
/// 最后撞上模型上下文上限直接报错, 而且从此这个会话**每一次**发送都会再撞一次
/// —— 会话被永久聊废, 用户毫无补救手段 (以前连删都删不掉)。
///
/// 取舍: 做"滑动窗口"而不是"摘要压缩"。摘要要额外调一次 LLM, 在手机上既慢又要
/// 额外计费, 且它失败时反而把这一轮也拖垮。窗口保底能发出去。真正的压缩等对齐
/// 桌面那套 compaction 协议时再做。
///
/// 截断只作用于**送给模型的副本**, drift 里的原文一个字都不动。
List<Map<String, Object?>> clampPhoneLocalHistory(
  List<({String role, String text})> history, {
  int maxMessages = kPhoneLocalMaxHistoryMessages,
  int maxCharsPerMessage = kPhoneLocalMaxHistoryCharsPerMessage,
}) {
  /* 从**末尾**取窗口 —— 最近的对话最相关。不做"保留开头 N 条"之类的花活:
   * 开头几条往往是寒暄, 模型真正需要的上下文几乎总在最近这几轮里。 */
  var windowed = history.length > maxMessages
      ? history.sublist(history.length - maxMessages)
      : history;
  /* 窗口首条若是 assistant, 说明它对应的 user 提问被切掉了 —— 模型会看到一句
   * 没有来由的回答。丢掉它, 让窗口从一次完整的问答开始。 */
  if (windowed.isNotEmpty && windowed.first.role == 'assistant') {
    windowed = windowed.sublist(1);
  }
  return [
    for (final m in windowed)
      {
        'role': m.role,
        'content': clampHistoryText(m.text, maxChars: maxCharsPerMessage),
      },
  ];
}

/// 单条历史的条数上限 (一问一答算两条).
const int kPhoneLocalMaxHistoryMessages = 40;

/// 单条历史消息的字符上限 —— 一条超长粘贴 (整份日志/整个文件) 能顶掉全部预算.
const int kPhoneLocalMaxHistoryCharsPerMessage = 4000;

/// 单条过长时从**中间**截断, 头尾都留住.
///
/// 只截头部的话, 粘贴一份日志再问"最后报的什么错"就必然答不上来; 只截尾部同理。
/// 中间挖空并留一句明示, 模型至少知道自己看到的是节选、不会拿残片当全部。
String clampHistoryText(
  String text, {
  int maxChars = kPhoneLocalMaxHistoryCharsPerMessage,
}) {
  if (text.length <= maxChars) return text;
  final keep = maxChars ~/ 2;
  final head = text.substring(0, keep);
  final tail = text.substring(text.length - keep);
  final omitted = text.length - keep * 2;
  return '$head\n\n…(此处省略 $omitted 字，为节省上下文)…\n\n$tail';
}

/// 手机本地这一轮**到底有没有工具**.
///
/// 2026-08-08: 这个判据原来只写死在 sendInput 里, 而 UI 那边的运行位置面板
/// 给手机档无条件挂了个「Agent」角标、说明写着"联网 / 文件 / 计算"。
/// 于是用 Gemini Key 的人按描述以为有这些能力, 实际拿到的是没有任何工具的裸聊
/// —— 而 system prompt 还会让模型主动说"切换到电脑或云端才能干活"。
/// 抽成一处共用, UI 和运行时不可能再各说各话。
///
/// Anthropic / OpenAI 兼容协议 (含订阅网关) 都走 SDK 工具循环;
/// Gemini 的工具 wire 格式不同, 暂走纯聊天。
bool phoneLocalUsesToolLoop({
  ByokModelRef? byokRef,
  ByokProviderConfig? provider,
}) {
  /* byokRef == null = 走订阅网关 (OpenAI 协议), 一定有工具 */
  if (byokRef == null) return true;
  if (provider == null) return false;
  return provider.protocol != ByokProtocol.gemini;
}

class PhoneLocalAgent {
  PhoneLocalAgent(this._ref);

  final Ref _ref;

  /// 这一轮模型逐字写出的正文 (tool=true 表示这里开始调工具, 前面那段话说完了; 这时 text 是工具名)。
  /// Pilot 的语音据此写出第一句就念, 不等整轮跑完 (features/pilot/pilot_local.dart ask.onLead)
  final _textDeltas = StreamController<({String sessionId, String text, bool tool})>.broadcast();
  Stream<({String sessionId, String text, bool tool})> get textDeltas => _textDeltas.stream;

  Future<String> createSession({String? title, String? modelHint}) async {
    final db = _ref.read(appDatabaseProvider);
    final now = DateTime.now().millisecondsSinceEpoch;
    final id =
        'phone-$now-${Random.secure().nextInt(0xffffff).toRadixString(16)}';

    /* 选用 model id —
     * 1) 调用方传了**具体**模型 (user 在 StageInput 选的) → 用它
     * 2) 传的是 'auto' 这个哨兵值 (= "系统你看着办") 或什么都没传 → 现场解析
     *
     * 2026-08-09 真机实测修的 P0: 这里原来是 `modelHint 非空就直接用`, 而
     * selectedModelProvider 的默认值恰恰是硬编码的 'auto' —— 于是 hint 永远非空,
     * `_pickInitialModelId()` 那条"后端没配 auto 池就退回真实模型"的 fallback
     * **从来没跑过**, 是死代码。
     * 而生产网关并没有配 auto 池, 结果就是**每个订阅用户发的每条消息都失败**,
     * 错误是 503「Auto 模型池暂未配置」。截图为证。
     * 'auto' 是"让系统挑"的意思, 不是一个真实模型 id —— 必须解析成真的那个。 */
    final hint =
        modelHint == null ? null : normalizePhoneLocalModelId(modelHint);
    final hintIsConcrete =
        hint != null && hint.isNotEmpty && hint != kDefaultPhoneLocalModelId;
    final modelId = hintIsConcrete ? hint : await _pickInitialModelId();

    await db.sessionMirrorDao.upsert(
      SessionMirrorCompanion(
        id: Value(id),
        desktopDeviceId: const Value(kPhoneLocalDeviceId),
        title: Value((title == null || title.trim().isEmpty) ? '新会话' : title),
        workspaceName: const Value('手机'),
        lastMessageAt: Value(now),
        lastSeq: const Value(1),
        createdAt: Value(now),
      ),
    );
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(id),
        seq: const Value(1),
        ts: Value(now),
        kind: const Value('session_meta'),
        payload: Value(
          jsonEncode({
            'run_target': 'phoneLocal',
            'model_id': modelId,
          }),
        ),
      ),
    );
    _ref.read(streamBufferProvider.notifier).updateLatestDriftSeq(id, 1);
    return id;
  }

  /// 启动时为新 session 选 model id.
  /// 优先调 server `/n1/models` 拿真实可用的, 取第一个;
  /// 网关不可用 (未登录/断网) 时 fallback 用户的第一个 BYOK 模型 —
  /// 零账号 BYOK 用户也能直接开聊;
  /// 都没有 → `kDefaultPhoneLocalModelId` ('auto').
  Future<String> _pickInitialModelId() async {
    try {
      final models = await _ref
          .read(modelGatewayClientProvider)
          .listModels()
          .timeout(const Duration(seconds: 5));
      if (models.isNotEmpty) {
        /* 服务端**真的**提供 auto 池时才用它 —— 那种情况下让服务端选路更好
         * (它知道当前哪个后端更空)。列表里没有就老老实实挑第一个真实模型。 */
        final hasAutoPool =
            models.any((m) => m.id == kDefaultPhoneLocalModelId);
        return hasAutoPool ? kDefaultPhoneLocalModelId : models.first.id;
      }
    } catch (_) {
      /* 网络 / auth / 超时 — fallback BYOK */
    }
    final byok = _ref.read(byokModelsProvider);
    if (byok.isNotEmpty) {
      final first = byok.first;
      return ByokModelRef(
        providerId: first.provider.id,
        modelId: first.modelId,
      ).fullId;
    }
    return kDefaultPhoneLocalModelId;
  }

  Future<PhoneLocalSessionInfo?> fetchSessionInfo(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null || !isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
      return null;
    }
    return PhoneLocalSessionInfo(
      id: mirror.id,
      title: mirror.title ?? '新会话',
      modelId: await currentModelId(sessionId),
      workspaceName: mirror.workspaceName ?? '手机',
    );
  }

  /// 模型列表 = 订阅模型 (网关) + 用户 BYOK 模型.
  /// 网关拉失败 (未登录/断网) 不阻塞 — BYOK 模型永远可用 (零账号原则).
  Future<List<GatewayModel>> listModels() async {
    var gatewayModels = const <GatewayModel>[];
    Object? gatewayError;
    try {
      gatewayModels = await _ref.read(modelGatewayClientProvider).listModels();
    } catch (e) {
      gatewayError = e;
    }
    final byok = [
      for (final e in _ref.read(byokModelsProvider))
        GatewayModel(
          id: ByokModelRef(providerId: e.provider.id, modelId: e.modelId)
              .fullId,
          name: '${_shortModelName(e.modelId)} · ${e.provider.name}',
          family: e.provider.name,
          isByok: true,
        ),
    ];
    /* 两边都空且网关报错 → 上抛让 UI 显示原因 (登录提示等) */
    if (gatewayModels.isEmpty && byok.isEmpty && gatewayError != null) {
      Error.throwWithStackTrace(gatewayError, StackTrace.current);
    }
    /* 返回**全量**列表 (网关 + BYOK) —— 不过滤、不插哨兵。
     *
     * 2026-09-22 修。这里原来做了两件事, 两件都错:
     *
     *   1. 按 canChat 滤掉出图模型 (nano-banana-2 / gpt-image-2 / grok-image),
     *      理由是「混在对话的模型选择器里选中了也只会失败」。判断本身对, 但**层次**
     *      错了: 这个函数是 availableModelsProvider 的唯一数据源, **图片工作台也走它**
     *      (图片页 pickImageModel() 从同一份列表里挑出图模型)。在源头滤掉 = 图片页
     *      永远挑不到任何模型 —— 真机实拍: 图片页模型选择器是空态、输入框上的模型
     *      chip 不显示。过滤该由**展示层**按用途各做各的: 对话侧 selectableModels
     *      (canChat), 图片侧 imageModels (!canChat)。
     *
     *   2. 往列表头插一个 id = 'auto' 的哨兵。用户明确要求过「把 auto 取消, 默认
     *      就是消耗最小的模型, auto 没有意义」—— 'auto' 不是一个模型, 不该占着列表
     *      位。需要"自动"的语义时, 由 effectiveModelProvider 按 relativeCost 挑一个
     *      **真实**模型。(建会话时仍可用它当哨兵, 见 _pickInitialModelId —— 那跟
     *      列表里显示什么无关。) */
    /* 「订阅」组只列套餐里的 (跟桌面同一份 membership.models)。
     * 网关 /n1/models 对有余额的账号会把套餐外的也按「余额自费」放进来 (withCreditFallback),
     * 于是 26 个套餐模型的人在手机上看到 54 个「订阅」(2026-09-30 真机) —— 多出来的那些归按量组。
     * 出图模型不在这里筛: 图片工作台吃的是同一份列表。会员没拉到时不筛, 别把列表清空。 */
    final plan = _ref.read(planModelsProvider);
    if (plan != null && plan.isNotEmpty) {
      final inPlan = {for (final m in plan) if (m.allowed) m.modelId};
      /* 网关目录只有 id, 正式名在会员权益里 —— 不换的话输入框上写的是「neox-free」 */
      final names = {for (final m in plan) if (m.displayName.isNotEmpty) m.modelId: m.displayName};
      gatewayModels = [
        for (final m in gatewayModels)
          if (!m.canChat || inPlan.contains(m.id) || m.id == kDefaultPhoneLocalModelId)
            names[m.id] == null
                ? m
                : GatewayModel(
                    id: m.id,
                    name: names[m.id]!,
                    family: m.family,
                    isByok: m.isByok,
                    modalities: m.modalities,
                    isImageGeneration: m.isImageGeneration,
                    relativeCost: m.relativeCost,
                    payAsYouGo: m.payAsYouGo,
                  ),
      ];
    }
    /* 按量目录只收聊天模型: 出图走图片工作台自己的计费, 不接按量 */
    final payg = gatewayModels.isEmpty
        ? const <GatewayModel>[]
        : (await _ref.read(modelGatewayClientProvider).listPayAsYouGoModels())
            .where((m) => !looksLikeImageModel(m.id.substring(GatewayModel.paygPrefix.length)))
            .toList();
    return [...gatewayModels, ...payg, ...byok];
  }

  String _shortModelName(String id) {
    final slash = id.lastIndexOf('/');
    return slash >= 0 && slash < id.length - 1 ? id.substring(slash + 1) : id;
  }

  /// 改手机本地会话的标题 — 没有远端, 直接写镜像.
  Future<bool> renameSession(String sessionId, String title) async {
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null || !isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
      return false;
    }
    await db.sessionMirrorDao.upsert(
      SessionMirrorCompanion(
        id: Value(sessionId),
        desktopDeviceId: Value(mirror.desktopDeviceId),
        title: Value(title),
        createdAt: Value(mirror.createdAt),
      ),
    );
    return true;
  }

  Future<bool> updateModel(String sessionId, String modelId) async {
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null || !isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
      return false;
    }
    await _insertEvent(
      sessionId: sessionId,
      kind: 'session_meta',
      payload: {
        'run_target': 'phoneLocal',
        /* 用户可能是在电脑会话的模型表里选的 (id 带 `neox-cloud:` 命名空间) */
        'model_id': normalizePhoneLocalModelId(modelId),
      },
    );
    return true;
  }

  Future<void> deleteSession(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    await db.sessionEventsDao.deleteBySessionId(sessionId);
    await db.sessionMirrorDao.deleteById(sessionId);
    await LocalAttachmentStore.instance.deleteSession(sessionId);
  }

  /// 重新生成最后一条回答 —— 对话里最后一条回复底下的 ↻ (对齐 Claude App).
  ///
  /// 做法: 删掉最后一条提问之后的回答 / 工具记录, 用同一句话再问一次。
  /// session_meta (中途换过模型) 留着 —— 重新生成就该用现在选的模型。
  /// 删完要让 timeline 从库里重新回放一遍: 它是增量 apply 的, 库里删了行屏上不会自己消失。
  ///
  /// 带图片的那一轮不支持: 图片没落库, 再问一次模型就看不到图了, 答案会驴唇不对马嘴。
  Future<void> regenerateLast(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    SessionEvent? lastUser;
    for (final ev in events.reversed) {
      if (ev.kind == 'user_message') {
        lastUser = ev;
        break;
      }
    }
    if (lastUser == null) throw StateError(tr('没有可重新生成的消息'));
    try {
      final p = jsonDecode(lastUser.payload);
      if (p is Map && p['has_attachments'] == true) {
        throw StateError(tr('带图片的消息暂不支持重新生成，请重新发送图片'));
      }
    } on FormatException {/* payload 坏了就按纯文本处理 */}
    final text = _textFromPayload(lastUser.payload);
    if (text.isEmpty) throw StateError(tr('没有可重新生成的消息'));

    /* 删之前先把这一轮的答案记进旧版本 —— 新答案出来以后还能切回来 (chat:C1-06) */
    final captured = await captureAnswerVersionForRegenerate(db, sessionId);
    final stale = [
      for (final ev in events)
        if (ev.seq > lastUser.seq && ev.kind != 'session_meta') ev.seq,
    ];
    await db.sessionEventsDao.deleteSeqs(sessionId, stale);
    _ref.invalidate(timelineStateProvider(sessionId));
    /* 跟 composer 发送同一个秒级反馈: 立刻出「思考中」, 不等第一个 token */
    _ref.read(timelineStateProvider(sessionId).notifier).markAgentStarting();
    try {
      /* 最后一条非 meta 事件现在就是这句提问 —— sendInput 的"同文重试"分支会复用它, 不再插第二条 */
      await sendInput(
        sessionId: sessionId,
        kind: 'user_message',
        payload: {'text': text},
      );
    } catch (_) {
      /* 失败的重新生成不该把旧答案一起弄丢: 把刚记下的那版放回时间线,
       * 再从旧版本列表里撤掉 (它现在就是当前显示的答案)。 */
      if (captured != null && captured.isNotEmpty) {
        await _insertEvent(
          sessionId: sessionId,
          kind: 'agent_text',
          payload: {
            'text': captured,
            'turn_id': 'restored-${DateTime.now().millisecondsSinceEpoch}',
          },
        );
        await revertCapturedAnswerVersion(db, sessionId, captured);
      }
      _ref.read(timelineStateProvider(sessionId).notifier).markAgentIdle();
      rethrow;
    }
  }

  /// 切回某一版旧答案 (chat:C1-06) — 当前答案和选中的旧答案对调.
  ///
  /// 只在手机本地 / 对话里露出入口; 运行中不给切 (会跟正在写的回答打架)。
  Future<void> selectAnswerVersion(
    String sessionId,
    int anchorSeq,
    int index,
  ) async {
    final db = _ref.read(appDatabaseProvider);
    final changed = await selectAnswerVersionOn(db, sessionId, anchorSeq, index);
    if (!changed) return;
    /* 时间线是增量 apply 的, 库里改了 payload 要整条重放才能看见 */
    _ref.invalidate(timelineStateProvider(sessionId));
  }

  /// 每 session 一个 in-flight 取消令牌 — stop 按钮真正掐断 HTTP 流,
  /// 不再只是 UI 侧标记 (流在后台白跑白计费).
  final Map<String, CancelToken> _inflight = {};

  /// SDK 工具循环的取消令牌 (与 _inflight 并行维护 — SDK 有自己的 token 类型).
  final Map<String, sdk.AgentCancelToken> _inflightSdk = {};

  /// 工具注册表 — 惰性初始化 (workspace 目录要 async 建).
  sdk.ToolRegistry? _toolRegistry;

  /// workspace 工具单独留引用 — 环境上下文要报告空间用量.
  sdk.WorkspaceFilesTool? _workspaceTool;

  /// 环境上下文段缓存 (C8-04): 有上一轮那份就直接用, 首轮最多等 300ms.
  /// 整段复用是为了 system 前缀逐字节稳定, 见 chat_send_prep.dart.
  final ChatEnvironmentCache _envCache = ChatEnvironmentCache();

  /// 打电话 / 发短信 / 加日程前问一句 —— 「全部放行」档不问 (跟桌面 dangerous 一个意思)。
  /// 界面不在前台 (没有可弹的地方) 就当没同意: 宁可这次没办成, 不在用户看不见时替他拨号。
  Future<bool> _confirmPhoneAction(String title, String detail) async {
    if (_ref.read(approvalModeProvider) == ApprovalMode.yolo) return true;
    final ctx = rootNavigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) return false;
    final ok = await showDialog<bool>(
      context: ctx,
      builder: (c) => AlertDialog(
        title: Text(tr(title)),
        content: Text(tr(detail)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
          TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('好'))),
        ],
      ),
    );
    return ok == true;
  }

  /// 某个会话专属的身份 + 工具 (Pilot 在手机上独立干活时: 它是谁、它现在的处境、「留给电脑」这类只有它用的工具)。
  /// context 是函数: 每一轮现场算 (电脑这一秒连没连上、有没有网), 不是建会话时的快照。
  final Map<String, ({Future<String> Function() context, List<sdk.AgentTool> tools, bool quick})> _sessionExtras = {};

  /// [quick]: 这个会话要快嘴 —— 关掉模型的思考 (Pilot 跟人说话 / 打电话: 先想十秒再开口没法用)
  void setSessionExtras(String sessionId, {required Future<String> Function() context, List<sdk.AgentTool> tools = const [], bool quick = false}) {
    _sessionExtras[sessionId] = (context: context, tools: tools, quick: quick);
  }

  Future<String> _extraContext(String sessionId) async {
    final x = _sessionExtras[sessionId];
    if (x == null) return '';
    try {
      return await x.context().timeout(const Duration(seconds: 3));
    } catch (_) {
      return '';
    }
  }

  /// 会话记的模式 ('chat' / 'work' / 'code' / null). 读不到就按 agent 走, 不挡这一轮.
  Future<String?> _sessionAgentMode(String sessionId) async {
    try {
      return (await _ref.read(appDatabaseProvider).sessionMirrorDao.findById(sessionId))?.agentMode;
    } catch (_) {
      return null;
    }
  }

  /// 这一轮的环境上下文段 —— 走缓存: 命中直接返回 (不等待), 首轮最多等 300ms,
  /// 超时先不带环境发, 后台采完下一轮带上. 采集本身不再设 3 秒硬超时:
  /// 让它在后台跑完比掐掉更划算 (每一项内部已有 0.8~1.2s 的单项上限).
  Future<String> _environmentForTurn({required String modelId, required bool lightChat}) {
    return _envCache.acquire(
      key: '$modelId|${lightChat ? 'chat' : 'work'}',
      build: () => buildAgentEnvironment(
        ref: _ref,
        modelId: modelId,
        workspace: _workspaceTool,
        withWorkTools: !lightChat,
      ),
    );
  }

  Future<sdk.ToolRegistry> _toolsFor(String sessionId) async {
    final base = await _ensureTools();
    final extra = _sessionExtras[sessionId]?.tools ?? const [];
    if (extra.isEmpty) return base;
    /* 专属工具跟基础工具同名时专属的赢 (Pilot 的 schedule_reminder 是闹钟级的) */
    final own = {for (final t in extra) t.spec.name};
    return sdk.ToolRegistry([for (final s in base.specs) if (!own.contains(s.name)) base.find(s.name)!, ...extra]);
  }

  Future<sdk.ToolRegistry> _ensureTools() async {
    final existing = _toolRegistry;
    if (existing != null) return existing;
    final docs = await getApplicationDocumentsDirectory();
    final workspace = Directory('${docs.path}/agent_workspace');
    await workspace.create(recursive: true);
    final wsTool = sdk.WorkspaceFilesTool(rootDir: workspace);
    _workspaceTool = wsTool;
    final search = _ref.read(hostedWebSearchProvider);
    final reg = sdk.ToolRegistry([
      /* 联网搜索走订阅网关 —— 没有它模型只能自己拼网站搜索页去 http_fetch, 撞验证码 */
      if (search != null) WebSearchTool(search),
      sdk.HttpFetchTool(),
      sdk.ClockTool(),
      sdk.CalculatorTool(),
      wsTool,
      /* 改 / 新建 PPT、Word、Excel —— 原件在工作区 uploads/ 下 */
      OfficeEditTool(rootDir: workspace),
      /* 画图 / 改图 —— 跟图片页同一条出图通道 */
      GenerateImageTool(_ref, rootDir: workspace),
      /* 手机里的 Linux (用户补全后才真能跑; 没装时它会让模型去提醒用户) —— 仅安卓 */
      if (Platform.isAndroid) ShellTool(rootDir: workspace),
      /* 定时提醒 —— Life 场景卡的 prompt 一直在调它, 而它以前根本不存在,
       * 模型只能幻觉一句"已为你设置提醒"。走系统闹钟, 不依赖推送和电脑。 */
      ReminderTool(),
      /* 手机的手脚: 打电话 / 短信 / 联系人 / 日历 / 闹钟 / 定位 / 开 App / 看通知 (仅安卓) */
      ...buildPhoneTools(_confirmPhoneAction),
    ]);
    _toolRegistry = reg;
    unawaited(_backfillArtifactsOnce());
    return reg;
  }

  Future<void> sendInput({
    required String sessionId,
    required String kind,
    required Map<String, Object?> payload,
  }) async {
    if (kind == 'control:cancel') {
      _inflight.remove(sessionId)?.cancel();
      _inflightSdk.remove(sessionId)?.cancel();
      unawaited(LocalLlmEngine.instance.stop());
      _ref
          .read(timelineStateProvider(sessionId).notifier)
          .applyStreaming('session_interrupted', const {});
      return;
    }
    if (kind == 'control:retry') {
      /* 手机本地模式: 取最近 user_message 原文再发 — sendInput 自带同文 dedup */
      final text = await retryTextFor(_ref.read(appDatabaseProvider), sessionId);
      if (text == null || text.isEmpty) {
        throw StateError(tr('没有可重试的消息'));
      }
      /* 对话模式的会话 (agentMode='chat') 始终带手机工具, 不看 Agent/聊天 开关 ——
       * 那个开关管的是电脑会话; 跟发送时 (stage_input._send) 同一个口径 */
      final mirror = await _ref
          .read(appDatabaseProvider)
          .sessionMirrorDao
          .findById(sessionId);
      final plainChat =
          mirror?.agentMode != 'chat' &&
          _ref.read(chatModeProvider).isOn(sessionId);
      /* 跟发送 / 重新生成同一个秒级反馈: 点了重试立刻出「思考中」 (原来这里没有, 点完屏幕没反应) */
      _ref.read(timelineStateProvider(sessionId).notifier).markAgentStarting();
      try {
        await sendInput(
          sessionId: sessionId,
          kind: 'user_message',
          payload: {
            'text': text,
            /* 重试沿用这个会话的模式 —— 聊天模式里重试不能突然带上工具 */
            if (plainChat) 'chat_mode': true,
          },
        );
      } catch (_) {
        _ref.read(timelineStateProvider(sessionId).notifier).markAgentIdle();
        rethrow;
      }
      return;
    }
    if (kind.startsWith('control:')) return;
    if (kind != 'user_message') {
      throw StateError(tr('手机模式暂不支持这个操作'));
    }

    /* 「点发送 → 首字」的天花板从这里开始算: 附件解码 / 历史装配 / 环境采集
     * 都算发送前的准备 (C8-03 / C8-04)。算完除了打 `[chat-ttft]` 日志,
     * 还给 _recordChatMetric 一份写进本地表 (chat:C8-11)。 */
    final timing = ChatTurnTiming(
      sessionId: sessionId,
      onMetric: _recordChatMetric,
    );

    final attachments = _attachmentsOf(payload);
    /* 文件附件在手机上自己解成文本 (Excel / Word / PPT / 文本, 见 attachment_text.dart)。
     * 解不了的在这里就报人话, 不进历史、不扣额度。 */
    final documents = <({String name, String text})>[];
    final withTools = payload['chat_mode'] != true;
    for (final a in attachments.where((a) => a.kind == 'file')) {
      final bytes = base64Decode(a.dataBase64);
      /* 原件一律存进工作区 (工作模式): Office 用 office_edit 改, PDF / 压缩包 / 音视频交给工具包处理
       * (2026-10-11 用户: 「用户传给他一个 PPT, 让他改一改, 他可以改」; 10-16: 只认 Office / 文本, 其它直接拦)。 */
      final rel = withTools ? await _saveUpload(a.name, bytes) : null;
      String text;
      try {
        text = await extractAttachmentTextAsync(a.name, bytes);
      } on AttachmentTextError catch (e) {
        /* 读不出文字: 聊天模式没工具只能拒; 工作模式原件已在工作区, 交给 agent 想办法 */
        if (rel == null) throw StateError(e.message);
        text = '(${e.message})';
      }
      if (rel != null) {
        text = '$text\n\n(原文件已存到工作区 $rel —— '
            '${officeKindOf(a.name) != null ? '要改它用 office_edit, 改完另存新文件给用户下载' : '要处理原件 (转格式 / 解压 / 剪辑 ...) 用 execute_shell 操作这个路径'})';
      }
      documents.add((name: a.name, text: text));
    }
    final images = attachments.where((a) => a.kind == 'image').toList();
    /* 照片一律存进工作区 —— 「把这张图放进 PPT 封面」要文件路径 (2026-10-16 实测:
     * 模型说工作区里没有这张图), 「改成水彩」也要 (chat:C4-09)。
     *
     * 以前只在 withTools (非 chat_mode) 时存: 对话模式的图不落盘, 而对话模式恰恰是
     * 用户最常发图改图的地方 —— 于是模型只能回一句「请给我图片路径」。 */
    final savedImages = await persistUploadedImages(
      [
        for (final a in images)
          (name: a.name, bytes: base64Decode(a.dataBase64)),
      ],
      save: _saveUpload,
    );

    final text = (payload['text'] as String?)?.trim() ?? '';
    if (text.isEmpty && attachments.isEmpty) return;

    final turnId = 'turn-${DateTime.now().millisecondsSinceEpoch}';
    /* 失败重发去重 — 上一条事件就是同文本 user_message (中间无 agent 输出) 说明
     * 这是"发送失败后原文重试": 复用已落库的那条, 不再插第二条 (真机实锤:
     * LLM 请求失败 → 文本恢复输入框 → 重发 → timeline 出现两条一样的 user 气泡). */
    /* 没打字只发了文件: 气泡上写文件名, 不写"图片" */
    final displayText = text.isNotEmpty
        ? text
        : documents.isNotEmpty
            ? documents.map((d) => '📎 ${d.name}').join('\n')
            : '图片';
    final lastEv = await _lastNonMetaEvent(sessionId);
    final isRetry = lastEv != null &&
        lastEv.kind == 'user_message' &&
        _textFromPayload(lastEv.payload) == displayText;
    if (!isRetry) {
      await _insertEvent(
        sessionId: sessionId,
        kind: 'user_message',
        payload: {
          'text': displayText,
          'turn_id': turnId,
          /* 图片本身不落库 —— 记一笔, 「重新生成」据此知道这一轮拿不回原图 */
          if (images.isNotEmpty) 'has_attachments': true,
          /* 文档解出来的文本落库: 下一轮再问"第二列求和"时模型还得看得见这张表 */
          if (documents.isNotEmpty)
            'documents': [
              for (final d in documents) {'name': d.name, 'text': d.text},
            ],
          /* 照片原件路径: 后面几轮还要用 (「再把这张图放到第三页」) */
          if (savedImages.isNotEmpty)
            'saved_images': [
              for (final s in savedImages) {'name': s.name, 'path': s.path},
            ],
        },
        clearPendingUser: true,
      );
    } else {
      _ref
          .read(streamBufferProvider.notifier)
          .clearPendingUserText(sessionId);
    }
    await _maybeTitleFromFirstMessage(sessionId, text);

    /* 发送前的准备一起等 (C8-03): 历史装配 / BYOK 就绪 / 模型 / 会话模式 / 身份
     * 互不依赖, 以前一项接一项 await, 弱网下光排队就白等几百毫秒.
     *
     * 冷启动首发竞态也没丢: ByokStore 从 FlutterSecureStorage 异步加载, app 刚起时
     * 列表还是空 → byId 拿不到 provider → 首次发送必失败, 第二次就好. 等 store 就绪. */
    final personaFuture = _extraContext(sessionId);
    final prep = await prepareChatSend(
      byokReady: _ref.read(byokStoreProvider.notifier).ready,
      modelId: _liveModelFor(sessionId),
      agentMode: _sessionAgentMode(sessionId),
      messages: _buildMessages(
        sessionId: sessionId,
        currentText: text,
        attachments: images,
        persona: personaFuture,
      ),
      persona: personaFuture,
    );
    final messages = prep.messages;
    final modelId = prep.modelId;

    /* 本机模型 (llama.cpp): 纯对话, 不走网络 */
    final localLlm = localLlmForModelId(modelId);
    if (localLlm != null) {
      await _runLocalLlm(
        sessionId: sessionId,
        turnId: turnId,
        messages: messages,
        model: localLlm,
        timing: timing,
      );
      return;
    }

    final byokRef = ByokModelRef.parse(modelId);

    /* 路由: 订阅网关 / BYOK openai-compat / BYOK anthropic → SDK 工具循环;
     * Gemini BYOK → 纯聊天 (工具 wire 下版本接). */
    ByokProviderConfig? byokProvider;
    if (byokRef != null) {
      byokProvider =
          _ref.read(byokStoreProvider.notifier).byId(byokRef.providerId);
    }
    final useToolLoop = phoneLocalUsesToolLoop(
      byokRef: byokRef,
      provider: byokProvider,
    );
    /* 轻聊天 = Chat 标签 / 电脑会话的「聊天」开关: 只有搜索 + 画图, 一份短提示词。
     *
     * 以前只认 payload 里的 chat_mode, 而手机首页 Chat 发出来的消息一条都不带它
     * (见 stage_input._send), 于是「对话」跑的是完整 agent 工具集 + agent 那段提示词,
     * 也就是用户说的「把 Chat 做成了 agent 的聊天」(2026-10-17)。现在按会话自己记的
     * 模式判: 手机本地会话 agentMode 不是 work / code 就是对话 (跟 homeModeOfSession
     * 同一个口径); 带专属工具 / 身份的会话 (Pilot) 不算。 */
    final chatMode = payload['chat_mode'] == true;
    final agentMode = prep.agentMode;
    /* 判据只有一份 (chat:C1-02): core/session_routing/chat_session_mode.dart, 跟桌面
     * chatSessionMode.ts 同一张真值表。手机本地会话没记模式时 (存量 / 语音) 按对话算 ——
     * 这是解析步骤, 跟 homeModeOfSession 的本机口径一致, 不埋进判据。 */
    final inChatSession = isChatSession(agentMode: agentMode ?? kChatAgentMode);
    /* 语音对话页发来的: 回复会被念出来 (见 _kVoiceModeHint) */
    final voiceMode = payload['voice_mode'] == true;
    /* 语音对话的会话 agentMode 也是空 (= 对话), 但它要能打电话 / 发短信 / 定闹钟, 不走轻聊天 */
    final lightChat =
        chatMode || (inChatSession && _sessionExtras[sessionId] == null && !voiceMode);

    /* 走到这里必然是 BYOK 且非工具协议 (Gemini) 才走下面的纯聊天 ——
     * phoneLocalUsesToolLoop 对 byokRef == null (订阅网关) 一律返回 true。
     * 判据抽成函数后类型推断带不过来, 显式兜一层: 真出现意料外的组合就退回
     * 工具循环, 而不是崩掉这一轮。 */
    if (useToolLoop || byokRef == null) {
      /* 工具表顺带建好工作区 (画的图存那里); 环境段走缓存, 命中时零等待 */
      final fullTools = await _toolsFor(sessionId);
      await _runToolLoop(
        sessionId: sessionId,
        turnId: turnId,
        messages: messages,
        modelId: modelId,
        byokRef: byokRef,
        byokProvider: byokProvider,
        lightChat: lightChat,
        voiceMode: voiceMode,
        agentMode: agentMode,
        fullTools: fullTools,
        persona: prep.persona,
        environment: _environmentForTurn(modelId: modelId, lightChat: lightChat),
        timing: timing,
      );
      return;
    }
    await _runPlainChat(
      sessionId: sessionId,
      turnId: turnId,
      messages: messages,
      modelId: modelId,
      byokRef: byokRef,
      timing: timing,
    );
  }

  /// Chat 首字打点入库 (chat:C8-11) —— 写失败只丢一条统计, 不能影响这一轮对话。
  void _recordChatMetric(ChatTurnMetric metric) {
    unawaited(
      ChatMetricsStore(_ref.read(appDatabaseProvider))
          .record(metric)
          .catchError((Object _) => 0),
    );
  }

  /// 轻聊天 (Chat 标签) 的工具 —— 联网搜索 + 画图, 就这两个。
  ///
  /// 搜索一轮最多 [kChatSearchLimit] 次 (10 是防跑飞的保险丝; 多个搜索由 AgentRunner
  /// 并发跑, 不是排队 10 轮)。画图不限张数 —— 一轮里多张不同的图并发生成。
  /// 防跑飞靠行为判据: 同工具同参数重复调用由 [ChatRepeatGuard] 直接拦。
  /// 每次发送新建一份, 计数不跨轮累加。
  sdk.ToolRegistry _lightChatTools() {
    final search = _ref.read(hostedWebSearchProvider);
    return sdk.ToolRegistry([
      /* 没登录时 hostedWebSearchProvider 为 null —— 没搜索就只剩画图, 不靠假工具 */
      if (search != null)
        ChatRepeatGuard(
          CappedWebSearchTool(WebSearchTool(search), maxCalls: kChatSearchLimit),
        ),
      ChatRepeatGuard(
        GenerateImageTool(_ref, rootDir: _workspaceTool!.rootDir),
      ),
    ]);
  }

  /// SDK 工具调用循环 — 事件对齐 timeline 协议直接灌渲染, tool/text 落 drift.
  ///
  /// [fullTools] / [persona] / [environment] 由 sendInput 跟其它前置步骤并行算好传进来
  /// (C8-03): 工具表跟环境采集不再在该等的时候才串着等。[environment] 走缓存,
  /// 命中时零等待 (C8-04)。
  Future<void> _runToolLoop({
    required String sessionId,
    required String turnId,
    required List<Map<String, Object?>> messages,
    required String modelId,
    required ByokModelRef? byokRef,
    required ByokProviderConfig? byokProvider,
    required sdk.ToolRegistry fullTools,
    required String persona,
    required Future<String> environment,
    String? agentMode,
    bool lightChat = false,
    bool voiceMode = false,
    ChatTurnTiming? timing,
  }) async {
    final timeline = _ref.read(timelineStateProvider(sessionId).notifier);
    /* 轻聊天: 只有联网搜索 (一轮最多 10 次, 多个搜索并发跑) 和画图 (不限张数), 不给动手机 / 文件 / 办公文件的工具。
     * 那些工具是工作 / 编码模式的事, Chat 一次都用不上, 但以前每条消息都要把它们
     * 的说明 (二十多个工具) 一并发给模型 —— 输入 token 的大头在这里。 */
    /* 本轮真有的搜索工具 —— 没登录时 hostedWebSearchProvider 为 null, 提示词里就不能声称能搜
     * (chat:C2-05 共用同一份人设源后, 手机也按真实工具选变体, 跟桌面一个口径)。 */
    final chatSearchAvailable = _ref.read(hostedWebSearchProvider) != null;
    final tools = lightChat ? _lightChatTools() : fullTools;
    if (timing != null) {
      timing.modelId = modelId;
      timing.lightChat = lightChat;
    }
    final http = _ref.read(llmHttpProvider);
    /* 推理参数偏好 — 用户在 [+] 菜单里调, 三协议统一生效 */
    final params = _ref.read(inferenceParamsProvider);
    /* 关思考: Pilot 快嘴会话、语音对话 (要马上开口) 一律关; 其它手机会话 (= Chat, 工作/编码只在电脑跑)
     * 跟着输入框的「思考」开关, 默认关 (Chat 因此默认不开长思考)。
     * 轻聊天不在这里强制关: 用户自己开了就照他的。只对能关的模型生效 (connector 里判)。 */
    final noThinking = (_sessionExtras[sessionId]?.quick ?? false) ||
        voiceMode ||
        !_ref.read(chatThinkingProvider.notifier).isOn(modelId);

    final sdk.LlmConnector connector;
    if (byokRef != null &&
        byokProvider != null &&
        byokProvider.protocol == ByokProtocol.anthropic) {
      /* Anthropic 协议 (官方 Claude / 兼容中转站) — 独立工具 wire */
      connector = AnthropicToolConnector(
        http: http,
        provider: byokProvider,
        modelId: byokRef.modelId,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        sessionId: sessionId,
        onRequestSent: timing?.markRequestSent,
      );
    } else if (byokRef != null && byokProvider != null) {
      final provider = byokProvider;
      connector = OpenAiToolConnector(
        http: http,
        providerName: provider.name,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        noThinking: noThinking,
        onRequestSent: timing?.markRequestSent,
        endpoint: () async => (
          url: '${provider.baseUrl}/chat/completions',
          headers: {
            'Authorization': 'Bearer ${provider.apiKey}',
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            /* 会话头: opencode (Zen / Go) 不带就 400 MissingSessionID —— 手机上用这类 Key 一句都发不出去
             * (2026-10-02 模拟器实测)。桌面 openai.ts 早就发, 认不出的上游忽略它 */
            'session_id': sessionId,
            ...provider.extraHeaders,
          },
          model: byokRef.modelId,
        ),
      );
    } else {
      final gateway = _ref.read(modelGatewayClientProvider);
      connector = OpenAiToolConnector(
        http: http,
        providerName: 'Neox 云端',
        errorTextBuilder: gateway.gatewayErrorText,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        noThinking: noThinking,
        viaGateway: true,
        reasoningEffort: _ref.read(chatThinkingProvider.notifier).level(modelId).effort,
        onRequestSent: timing?.markRequestSent,
        endpoint: () async {
          /* 按量模型: 去掉前缀发真实模型名, 头里标按量 */
          final payg = modelId.startsWith(GatewayModel.paygPrefix);
          final auth = await gateway.streamAuth(payg: payg);
          return (
            url: auth.url,
            /* X-Neox-Session: 网关按它把同一个会话钉在同一条上游 (2026-10-12 后台实拍: 手机不带, 同一会话
             * 在 a6 / DeepSeek 直连之间来回跳, 一换上游缓存从 90% 掉到 2%)。跟桌面 openai.ts 同一个头 */
            headers: {...auth.headers, 'X-Neox-Session': sessionId},
            model: payg ? modelId.substring(GatewayModel.paygPrefix.length) : modelId,
          );
        },
      );
    }

    /* 环境上下文 — 时间/设备/网络/用户/模型/工作区用量.
     * 缓存命中直接拿上一轮那份 (不重新采集 → system 前缀逐字节稳定); 首轮最多等
     * 300ms, 超时就先不带环境发, 后台采完下一轮带上 (见 chat_send_prep.dart)。 */
    var envContext = '';
    try {
      envContext = await environment;
    } catch (_) {/* 环境采集失败不阻塞发消息 */}
    envContext = voiceMode ? '$envContext\n$_kVoiceModeHint' : '$envContext\n$_kRichCardsHint';
    if (agentMode == 'code') envContext = '$envContext\n$_kCodeModeHint';

    /* 有专属身份的会话 (Pilot) 用它自己的系统提示, 不用通用助手那段 */
    final runner = sdk.AgentRunner(
      connector: connector,
      tools: tools,
      config: sdk.AgentRunConfig(
        environmentContext: envContext,
        /* 轮次上限只是保险丝 (总控裁决第六节): 一轮里互不依赖的工具调用并发跑,
         * 「搜 10 次 + 画 3 张」也只占工具轮 + 作答轮两轮。20 远大于正常所需,
         * 防的是模型原地打转 —— 同工具同参数重复调用另有 ChatRepeatGuard 直接拦。 */
        maxTurns: lightChat ? kChatLightMaxTurns : null,
        /* 没有专属身份时用 Chat 助手那段, 不用 SDK 默认的「你是手机 Agent … 完成任务」——
         * 那段是给干活的 agent 写的, 回答像交任务报告 (2026-10-06 用户: 「普通 chat 还不如豆包,
         * 问它不舒服」)。同题 A/B: 新版更短、先接住情绪、给明确建议、会追问一句要紧的。 */
        systemPrompt: persona.isEmpty
            ? (lightChat
                ? chatLightPersona(search: chatSearchAvailable)
                : _chatPersona)
            : persona,
        /* 断网 / 超时 / 5xx / 限流 → 退避重发这一轮, 不让整夜的任务因为一次抖动挂掉 (2026-10-16) */
        isTransientError: _isTransientModelError,
      ),
    );

    final cancel = sdk.AgentCancelToken();
    _inflight.remove(sessionId)?.cancel();
    _inflightSdk[sessionId]?.cancel();
    _inflightSdk[sessionId] = cancel;
    /* 悬浮层上点「停止」= 跟输入框里点停止一样 (control:cancel) */
    PhoneControl.onStop = () => unawaited(sendInput(sessionId: sessionId, kind: 'control:cancel', payload: const {}));

    /* SDK 的 history 不含 system (它自己注) — 剥掉我们 _buildMessages 的 system */
    final history = [
      for (final m in messages)
        if (m['role'] != 'system') m,
    ];

    String? agentError;
    /* callId → args —— SDK 的 tool_result 事件不带 args (只有 tool_running 带),
     * 而判断"这次写的是不是产物"要看 args.path。实测漏了这一步, 卡片不出现。 */
    final toolArgsByCallId = <String, Map<String, Object?>>{};
    /* 这一段 (上一个工具之后) 说的话。SDK 最后那条 agent_text 是整轮全文 —— 原样落库的话,
     * 工具前那句会在工具卡上下各出现一次 (2026-10-11 模拟器实拍「I'll look at the file structure first.」两遍)。
     * 改成按段落库: 工具前那段在 tool_call 之前落, 最后只落工具之后那段。 */
    final segment = StringBuffer();
    /* 思考也按段落库 —— 原来只活在内存里, 重开会话「5 步 · 13 秒」变成「2 步 · 7 秒」(2026-10-14 模拟器实拍)。
     * 一段思考在下一段正文 / 工具开始时收口, 带上真实用时 (回放时摘要才算得出「想了 N 秒」)。 */
    final thinkSeg = StringBuffer();
    int? thinkStartMs;
    Future<void> flushThinking() async {
      final t = thinkSeg.toString().trim();
      final started = thinkStartMs;
      thinkSeg.clear();
      thinkStartMs = null;
      if (t.isEmpty) return;
      await _insertEvent(
        sessionId: sessionId,
        kind: 'agent_thinking',
        payload: {
          'thinking': t,
          'turn_id': turnId,
          if (started != null) 'duration_ms': DateTime.now().millisecondsSinceEpoch - started,
        },
      );
    }
    /* 工作区快照: 每个工具结果回来时跟上一份比, 新建 / 改过的文件就是这个工具做出来的 (见 tool_result) */
    var wsSnap = _workspaceSnapshot();
    try {
      await for (final ev in runner.run(
        history: history,
        cancel: cancel,
        sessionId: sessionId,
      )) {
        final p = ev.payload;
        switch (ev.kind) {
          case 'agent_text_delta':
          case 'agent_thinking_delta':
            timeline.applyStreaming(ev.kind, {...p, 'turn_id': turnId});
            if (ev.kind == 'agent_thinking_delta' && p['content'] is String) {
              thinkStartMs ??= DateTime.now().millisecondsSinceEpoch;
              thinkSeg.write(p['content'] as String);
            }
            if (ev.kind == 'agent_text_delta' && thinkSeg.isNotEmpty) await flushThinking();
            if (ev.kind == 'agent_text_delta' && p['content'] is String) {
              segment.write(p['content'] as String);
              _textDeltas.add((sessionId: sessionId, text: p['content'] as String, tool: false));
              /* 用户看到的第一个字 —— 「发出请求 → 首字」这一段到这里结束 */
              timing?.markFirstToken();
            }
            break;
          case 'tool_running':
            /* 工具前那段正文收口 —— 不收的话工具后的下一段接在它末尾、排在工具卡之前:
             * 实拍「aren't stale.# 3 Days in Tokyo」(2026-10-09)。桌面那条本来就发 agent_text_done。 */
            timeline.applyStreaming('agent_text_done', {'turn_id': turnId});
            await flushThinking();
            if (segment.toString().trim().isNotEmpty) {
              await _insertEvent(
                sessionId: sessionId,
                kind: 'agent_text',
                payload: {'text': segment.toString().trim(), 'turn_id': turnId},
              );
            }
            segment.clear();
            _textDeltas.add((sessionId: sessionId, text: '${p['tool_name'] ?? p['name'] ?? ''}', tool: true));
            {
              final cid = p['tool_call_id'];
              final a = p['args'];
              if (cid is String && a is Map) {
                toolArgsByCallId[cid] = Map<String, Object?>.from(a);
              }
            }
            timeline.applyStreaming('tool_running', {...p, 'turn_id': turnId});
            await _insertEvent(
              sessionId: sessionId,
              kind: 'tool_call',
              payload: {
                'tool_call_id': p['tool_call_id'],
                'tool_name': p['tool_name'],
                'args': p['args'],
                'turn_id': turnId,
              },
            );
            break;
          case 'tool_done':
            timeline.applyStreaming('tool_done', {...p, 'turn_id': turnId});
            break;
          case 'tool_result':
            /* 手机本地也给产物挂下载卡 —— 沙箱文件就在本机, 不用走网络.
             * 桌面那条是 artifactRegistry + file.fetch, 这条直接给 local_path,
             * ArtifactDownloader 看到 local_path 就跳过 RPC 直接拷贝。 */
            /* 产物以「工作区里真变了的文件」为准 (2026-10-12 用户: 「文件找不到的必须彻底解决」):
             * 原来只从工具回执里抠文件名, 回执格式一变就挂不上 —— 新建 PPT 的「(27 页)」就没认出来。
             * 工具是一个个顺序跑的, 两次结果之间工作区的变化就是这个工具做的。回执解析留着兜底。 */
            final now = _workspaceSnapshot();
            final changed = [
              for (final e in now.entries)
                if (wsSnap[e.key] != e.value && !e.key.startsWith('uploads/')) e.key,
            ]..sort();
            wsSnap = now;
            final cards = <String, Map<String, Object?>>{};
            for (final rel in changed.take(8)) {
              final c = await _artifactCard(rel);
              if (c != null) cards['${c['id']}'] = c;
            }
            for (final c in await _localArtifactsOf(p, toolArgsByCallId[p['tool_call_id']]) ?? const <Map<String, Object?>>[]) {
              cards['${c['id']}'] = c;
            }
            final localArtifacts = cards.isEmpty ? null : cards.values.toList();
            await _insertEvent(
              sessionId: sessionId,
              kind: 'tool_result',
              payload: {
                'tool_call_id': p['tool_call_id'],
                'tool_name': p['tool_name'],
                'text': p['output'],
                'ok': p['ok'],
                'turn_id': turnId,
                if (localArtifacts != null) 'artifacts': localArtifacts,
              },
            );
            break;
          case 'agent_text':
            /* 只落最后一段 (工具前的已经在 tool_running 时落过); 没流式过 (极少) 才用全文兜底 */
            await flushThinking();
            final hadSegments = segment.isNotEmpty || toolArgsByCallId.isNotEmpty;
            final text = hadSegments ? segment.toString().trim() : ((p['text'] as String?) ?? '');
            segment.clear();
            if (text.trim().isNotEmpty) {
              await _insertEvent(
                sessionId: sessionId,
                kind: 'agent_text',
                payload: {'text': text, 'turn_id': turnId},
              );
            }
            break;
          case 'agent_turn_done':
            timeline.applyStreaming('agent_turn_done', {'turn_id': turnId});
            break;
          case 'session_interrupted':
            timeline.applyStreaming('session_interrupted', {'turn_id': turnId});
            break;
          case 'stream_retry':
            /* 重发会从头生成这一轮 —— 已经拼进 segment 的半截删掉, 不然落库会重复一段 */
            final discard = p['discard'];
            if (discard is String && discard.isNotEmpty) {
              final s = segment.toString();
              if (s.endsWith(discard)) {
                segment
                  ..clear()
                  ..write(s.substring(0, s.length - discard.length));
              }
            }
            timeline.applyStreaming('stream_retry', {...p, 'turn_id': turnId});
            break;
          case 'stream_recovered':
            timeline.applyStreaming('stream_recovered', {'turn_id': turnId});
            break;
          case 'agent_error':
            agentError = (p['message'] as String?) ?? '未知错误';
            break;
        }
      }
    } finally {
      if (identical(_inflightSdk[sessionId], cancel)) {
        _inflightSdk.remove(sessionId);
      }
      /* 这一轮在别的 App 里操作过 (Phone Use 悬浮层亮着) → 收起, 带用户回到 Neox 看结果 */
      unawaited(PhoneControl.end());
      /* 本轮截的图用完就删 (pilot:D-08), 不在 cacheDir 里躺半小时 */
      unawaited(endRoundShots());
      /* 到结束还没出过字 (报错 / 空回复 / 被取消): 也记一条 -1, 别让失败轮次没数 */
      timing?.logIfUnfinished();
    }
    /* 非用户取消的错误 → 上抛给 composer toast (文本/工具产物已落库不丢) */
    if (agentError != null && !cancel.isCancelled) {
      throw StateError(agentError);
    }
  }

  /// 纯聊天路径 (Anthropic / Gemini BYOK — 无工具).
  Future<void> _runPlainChat({
    required String sessionId,
    required String turnId,
    required List<Map<String, Object?>> messages,
    required String modelId,
    required ByokModelRef byokRef,
    ChatTurnTiming? timing,
  }) async {
    final cancel = CancelToken();
    _inflight[sessionId]?.cancel(); /* 同 session 上一条还在流 → 掐掉 */
    _inflight[sessionId] = cancel;

    final timeline = _ref.read(timelineStateProvider(sessionId).notifier);
    final full = StringBuffer();

    final params = _ref.read(inferenceParamsProvider);
    try {
      final backend = _ref.read(byokServiceProvider).backendFor(
            byokRef.providerId,
          );
      await for (final delta in backend.streamChat(
        ChatRequest(
          modelId: byokRef.modelId,
          messages: messages,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
        ),
        cancel: cancel,
      )) {
        if (delta.text != null && delta.text!.isNotEmpty) {
          full.write(delta.text);
          /* 纯聊天链路没有 connector 的 onRequestSent 钩子 — 至少把首字记上 */
          timing?.markFirstToken();
          timeline.applyStreaming('agent_text_delta', {
            'turn_id': turnId,
            'content': delta.text,
          });
          _textDeltas.add((sessionId: sessionId, text: delta.text!, tool: false));
        }
        if (delta.thinking != null && delta.thinking!.isNotEmpty) {
          timeline.applyStreaming('agent_thinking_delta', {
            'turn_id': turnId,
            'content': delta.thinking,
          });
        }
      }
      timeline.applyStreaming('agent_thinking_done', {'turn_id': turnId});

      final finalText = full.toString();
      if (finalText.trim().isNotEmpty) {
        await _insertEvent(
          sessionId: sessionId,
          kind: 'agent_text',
          payload: {'text': finalText, 'turn_id': turnId},
        );
      }
      timeline.applyStreaming('agent_turn_done', {'turn_id': turnId});
    } on ChatCancelled {
      /* 用户主动停止 — 已流出的部分照常落库, 跟桌面 stop 行为一致 */
      final partial = full.toString();
      if (partial.trim().isNotEmpty) {
        await _insertEvent(
          sessionId: sessionId,
          kind: 'agent_text',
          payload: {'text': partial, 'turn_id': turnId},
        );
      }
      timeline.applyStreaming('session_interrupted', {'turn_id': turnId});
    } catch (e) {
      timeline.applyStreaming('session_interrupted', {'turn_id': turnId});
      rethrow;
    } finally {
      if (identical(_inflight[sessionId], cancel)) {
        _inflight.remove(sessionId);
      }
      /* 没出过字 (报错 / 空回复 / 被取消) 也记一条 -1, 别让失败轮次没数 */
      timing?.logIfUnfinished();
    }
  }

  /// 本机模型一轮: 跟 [_runPlainChat] 同样的事件节奏 (流式 delta → 落库 agent_text → turn_done),
  /// 只是 token 来自 llama.cpp。图片 / 多模态块一律只取文字 —— 这几个小模型看不了图。
  Future<void> _runLocalLlm({
    required String sessionId,
    required String turnId,
    required List<Map<String, Object?>> messages,
    required LocalLlm model,
    ChatTurnTiming? timing,
  }) async {
    final timeline = _ref.read(timelineStateProvider(sessionId).notifier);
    final params = _ref.read(inferenceParamsProvider);
    final full = StringBuffer();
    final plain = <({String role, String content})>[];
    for (final m in messages) {
      final c = m['content'];
      final text = c is String
          ? c
          : c is List
              ? c.whereType<Map>().where((p) => p['type'] == 'text').map((p) => p['text']).join('\n')
              : '';
      if (text.trim().isEmpty) continue;
      final role = (m['role'] as String?) ?? 'user';
      /* 云端那段「没有工具、要用工具就切到电脑」对 1~4B 小模型是纯噪音, 还会被原样复述; 换成一句 */
      plain.add((role: role, content: role == 'system' ? _kLocalSystemPrompt : text));
    }
    /* NPU 预编译模型的上下文是编译时定死的 (ekv1280 = 输入输出合计 1280 token), 输入要压得更狠 */
    _fitLocalContext(plain, model.isNpu ? 700 : _kLocalPromptChars);
    var stopped = false;
    final cancel = CancelToken();
    _inflight[sessionId]?.cancel();
    _inflight[sessionId] = cancel;
    unawaited(cancel.whenCancelled.then((_) {
      stopped = true;
      LocalLlmEngine.instance.stop();
    }));
    try {
      /* 本机模型没有「请求」这一步 —— 开始推理就算请求发出 (chat:C8-11) */
      timing?.markRequestSent();
      await for (final tok in LocalLlmEngine.instance.chat(
        model: model,
        store: _ref.read(modelStoreProvider.notifier),
        messages: plain,
        maxTokens: params.maxTokens.clamp(64, model.isNpu ? 480 : 2048),
        temperature: params.temperature ?? 0.7,
      )) {
        if (stopped) break;
        full.write(tok);
        timing?.markFirstToken();
        timeline.applyStreaming('agent_text_delta', {'turn_id': turnId, 'content': tok});
        _textDeltas.add((sessionId: sessionId, text: tok, tool: false));
      }
      final text = full.toString();
      if (text.trim().isNotEmpty) {
        await _insertEvent(
          sessionId: sessionId,
          kind: 'agent_text',
          payload: {'text': text, 'turn_id': turnId},
        );
      }
      timeline.applyStreaming(stopped ? 'session_interrupted' : 'agent_turn_done', {'turn_id': turnId});
    } catch (e) {
      timeline.applyStreaming('session_interrupted', {'turn_id': turnId});
      rethrow;
    } finally {
      if (identical(_inflight[sessionId], cancel)) _inflight.remove(sessionId);
      /* 本机模型也要有一条数: 没出字 (加载失败 / 被取消) 记 -1 */
      timing?.logIfUnfinished();
    }
  }

  /// 本机模型上下文只有 4096 token (中文约 1 字 1 token), 还要给回答留出 1k —— 输入按字数封顶。
  /// 原来整段历史 + 附件全文 (一个 Excel 解析出来几万字) 原样喂进去, 超了 llama.cpp 直接报错。
  /// 先丢最早的对话 (system 和最后一条保留), 最后一条本身还超就截它的尾巴并注明。
  static const int _kLocalPromptChars = 2800;
  static const String _kLocalSystemPrompt = '你是 Neox 助手。用用户的语言回答, 简洁直接。';

  static void _fitLocalContext(List<({String role, String content})> msgs, int budget) {
    int total() => msgs.fold(0, (a, m) => a + m.content.length);
    while (total() > budget && msgs.length > 2) {
      final i = msgs.first.role == 'system' ? 1 : 0;
      if (i >= msgs.length - 1) break;
      msgs.removeAt(i);
    }
    final over = total() - budget;
    if (over > 0 && msgs.isNotEmpty) {
      final last = msgs.last;
      final keep = (last.content.length - over).clamp(200, last.content.length);
      msgs[msgs.length - 1] = (
        role: last.role,
        content: '${last.content.substring(0, keep)}\n…[本机模型装不下全文, 只看了前 $keep 字]',
      );
    }
  }

  /// 最后一条"真内容"事件 — session_meta 和客户端失败卡都不算.
  ///
  /// client_error 必须跳过, 否则两处都会坏 (都靠这个函数看清上一条是不是
  /// user_message):
  ///   - control:retry → 看到失败卡就抛「没有可重试的消息」, 错误卡上的重试
  ///     按钮点了必然失败;
  ///   - 失败重发去重 → isRetry 判 false, timeline 上多出一条一模一样的用户气泡。
  Future<SessionEvent?> _lastNonMetaEvent(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    for (final ev in events.reversed) {
      if (ev.kind == 'session_meta' || ev.kind == kClientErrorKind) continue;
      return ev;
    }
    return null;
  }

  /// 这个会话这一轮实际用哪个模型: 会话建的时候记下的那个已经下架了, 就换成现在的默认并记回会话。
  ///
  /// 2026-10-05 用户: 「手机端为什么还有 GPT-6 Luna, 为什么不一致」—— 服务端下架了 luna, 但会话
  /// 建时记的 model_id 还是它: 输入框照样显示 luna, 发出去照样「模型服务暂不可用」。
  /// 本机模型 / BYOK 不在网关列表里, 不动; 列表没拉到 (断网 / 未登录) 也不动, 不拿空列表下结论。
  Future<String> _liveModelFor(String sessionId) async {
    final modelId = await currentModelId(sessionId);
    final live = liveModelId(
      modelId,
      _ref.read(availableModelsProvider).valueOrNull ?? const <GatewayModel>[],
      _ref.read(effectiveModelProvider),
    );
    if (live == modelId) return modelId;
    debugPrint('[phone-local] 会话 $sessionId 的模型 $modelId 已下架, 换成 $live');
    /* 记回会话, 输入框的模型名跟着变 */
    await updateModel(sessionId, live);
    unawaited(_ref.read(sessionContextProvider(sessionId).notifier).refresh());
    return live;
  }

  Future<String> currentModelId(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    for (final ev in events.reversed) {
      if (ev.kind != 'session_meta') continue;
      try {
        final parsed = jsonDecode(ev.payload);
        if (parsed is Map && parsed['model_id'] is String) {
          /* 读的时候也归一 —— 已经带着坏 id 落库的老会话 (本机实测就有一条)
           * 不该永久发不出消息, 打开就该自愈。 */
          final model = normalizePhoneLocalModelId(parsed['model_id'] as String);
          if (model.isNotEmpty) return model;
        }
      } catch (_) {}
    }
    return kDefaultPhoneLocalModelId;
  }

  /// 语音对话页 (voice_chat_page.dart) 发来的这一轮, 回复会被逐句念出来。
  /// 只改说法不改本事: 工具照用, 只是答案要能听。
  static const String _kVoiceModeHint =
      '<voice-mode>用户正在用语音跟你对话, 你的回复会被直接念出来。用口语回答: 先说结论, '
      '一般一到三句; 不要 Markdown、列表、表格、代码块、链接和表情; 数字和单位按念出来的样子写。'
      '内容确实很多时先说最要紧的, 再问要不要接着讲。</voice-mode>';

  /// 手机普通 Chat 的身份 —— 聊天助手, 不是任务 agent。工具照用, 但不提工具。
  static const String _kChatPersona =
      '你是 Neox, 用户手机上的 AI 助手。像一个聪明、靠谱、说话自然的朋友那样跟用户聊天。\n\n'
      '怎么回答:\n'
      '- 先给答案或结论, 再补必要的解释。闲聊和简单问题一两句话就好, 复杂问题才分点、用小标题或表格。\n'
      '- 语言和语气跟着用户走。用户随口一问你也轻松一点; 用户在倾诉或情绪不好, 先接住情绪, 少讲大道理, 别急着列清单。\n'
      '- 有立场。用户问"选哪个""好不好", 给明确建议和一句理由, 不要只罗列各有优劣。\n'
      '- 不确定就直说, 别编。数字、日期、价格、地址、营业时间要么来自工具结果, 要么明说是你的印象。\n'
      '- 不复述问题, 不说"好的我来帮你""作为 AI"这类开场白, 结尾不要套话; 确实有用时可以用一句话提一个自然的后续。\n\n'
      '什么时候用工具 (有就用, 不用告诉用户用了什么工具):\n'
      '- 跟"现在"有关的 —— 新闻、天气、价格、比分、营业时间、最新版本、政策: 先 web_search 再答, 不凭记忆。\n'
      '- 跟"这里"有关的 —— 附近、怎么去、本地推荐: 先 get_location 拿位置再搜。\n'
      '- 算数用 calculator, 时间日期用 clock; 提醒、闹钟、日程直接帮用户办, 办完一句话确认。\n'
      '- 常识、写作、翻译、解释概念、出主意、聊天: 直接答, 不用搜。\n'
      '- 正文里别说"我将调用某某工具""根据搜索结果"; 直接说内容, 来源界面会自动展示。';

  static const String _kLocationLine = '- 跟"这里"有关的 —— 附近、怎么去、本地推荐: 先 get_location 拿位置再搜。\n';

  /// get_location 是安卓手机工具 (phone_tools.dart), iOS 工具表里没有 —— 照抄这句模型会去调一个不存在的工具
  static String get _chatPersona => Platform.isAndroid
      ? _kChatPersona
      : _kChatPersona.replaceFirst(
          _kLocationLine,
          '- 跟"这里"有关的 —— 附近、怎么去、本地推荐: 用对话里提到的地点去搜, 没提就先问一句在哪。\n',
        );

  /// 编码模式在手机本地跑 (2026-10-12) —— 告诉模型它手上是什么: 工作区 + 手机里的 Linux
  static const String _kCodeModeHint =
      '<code-mode>这是编码模式, 在用户手机本地跑 (不是电脑)。项目放在工作区 (execute_shell 里是 /workspace): '
      '拉代码用 git clone, 读写改文件用 workspace 工具或 shell, 装依赖跑测试用 npm / node / python / pip。'
      '改代码前先看懂现有结构, 改完跑一遍验证 (测试 / 构建 / 直接运行), 把命令输出里的关键结果告诉用户。'
      'Java / Kotlin 项目在手机上编译不了 (安卓不让 App 里的 JVM 运行), 只能读改代码, 编译运行请用户连电脑。</code-mode>';

  /// 手机能画的富卡片 (rich_cards.dart) —— 不告诉模型, 它就只会写一段段文字 (2026-10-06 用户:
  /// 「Chat 只能对话」)。字段名跟桌面 NeoxCards 同一份协议。搜索来源和定位由工具结果自动出卡,
  /// 这里不用模型再抄一遍链接。
  static const String _kRichCardsHint =
      '<rich-cards>手机会把 ```neox-card:<kind> + JSON 渲染成卡片。信息是下面这些形状时用卡片, 其余写正文:\n'
      '- weather 天气: {"location","current":{"temp","feels_like","text","wind","humidity"},"forecast":[{"day","high","low","text","rain_chance"}]}\n'
      '- restaurant 店铺/景点/地点推荐: {"title","items":[{"name","cuisine","priceRange","rating","address","phone","highlight"}]} (卡片自带导航和拨号按钮)\n'
      '- news 新闻: {"title","items":[{"title","source","timestamp","summary","url","tag"}]}\n'
      '- steps 操作步骤: {"title","items":[{"title","desc","status":"done|todo"}]}\n'
      '- chart 一组可比的数: {"title","series":[{"label","value"}],"unit"}\n'
      '- callout 一句要紧的提醒: {"tone":"info|good|warn|bad","text"}\n'
      '卡片里的事实必须来自工具结果或用户, 不知道的字段不写, 别编地址电话。搜索来源和定位结果界面已经自动出卡, 正文里不用再列链接。</rich-cards>';

  /// phone-local 的 system prompt — 明确能力边界.
  /// 真机实锤 (2026-07-19): 不声明的话模型会裸输出 `<web_search>` 等工具调用
  /// XML 标签 (它以为自己有工具), 用户看到一坨标签当没有工具循环的笑话.
  static const String _kSystemPrompt =
      '你是 Neox 手机快聊助手。当前是纯对话模式, 没有任何工具可用 — 不能搜索网页、'
      '不能读写文件、不能执行代码或命令。请直接基于你的知识回答, 绝不要输出工具调用'
      '标签或 XML (如 <web_search>)。如果用户的任务需要工具 (搜索/文件/自动化), '
      '简短告诉他: 切换到「我的电脑」或「云端」运行位置可以用完整 Agent 干活。'
      '回答用用户的语言, 简洁直接。';

  Future<List<Map<String, Object?>>> _buildMessages({
    required String sessionId,
    required String currentText,
    required List<_LocalAttachment> attachments,
    /// 会话专属身份. 跟发送前那批准备并行采集 (传 Future 进来, 不重复采).
    required Future<String> persona,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    /* 本机模型 / 纯聊天走这条 system (工具循环那条会剥掉它, 用 AgentRunConfig 的) */
    final p = await persona;
    final messages = <Map<String, Object?>>[
      {'role': 'system', 'content': p.isEmpty ? _kSystemPrompt : p},
    ];

    final history = <({String role, String text})>[];
    for (final ev in events) {
      if (ev.kind != 'user_message' && ev.kind != 'agent_text') continue;
      var text = _textFromPayload(ev.payload);
      /* 文档附件的文本跟着那条消息一起给模型 (当前这轮刚落库的那条也在这里面),
       * 格式跟桌面 prepareTaskInputText 一致: 文件名 header + fence, 模型分得清"问题"和"附件" */
      text = _appendDocuments(text, ev.payload);
      if (text.trim().isEmpty) continue;
      final role = ev.kind == 'user_message' ? 'user' : 'assistant';
      /* 用户消息尾部挂上**它自己落库那一刻**的 <current-time> (C2-16): 下一轮请求会把
       * 这段历史原样重建一遍, 标签必须逐字节相同, 前缀缓存才能从上一轮接着命中。 */
      final line = role == 'user'
          ? userMessageWithTimeTag(
              text,
              DateTime.fromMillisecondsSinceEpoch(ev.ts),
            )
          : text;
      /* 一轮里隔着工具的几段正文分条落库 —— 给模型时并回一条, 不出现连着两条 assistant */
      if (role == 'assistant' && history.isNotEmpty && history.last.role == 'assistant') {
        history[history.length - 1] = (role: role, text: '${history.last.text}\n\n$line');
        continue;
      }
      history.add((role: role, text: line));
    }
    messages.addAll(clampPhoneLocalHistory(history));
    if (attachments.isNotEmpty) {
      /* 图片 + 文档同发: 文本部分也要带上文档 (只发图时 currentText 为空, 保持不塞"图片"二字) */
      final lastUser = events.lastWhere(
        (ev) => ev.kind == 'user_message',
        orElse: () => events.first,
      );
      final lastText = _appendDocuments(currentText, lastUser.payload);
      final parts = <Map<String, Object?>>[
        /* 只发图 / 只发文档时也要有 text 块 (OpenAI 协议里 text 在前、图在后),
         * 时刻标签就挂在这里 —— 跟纯文本路径同一个 [userMessageWithTimeTag]。 */
        {
          'type': 'text',
          'text': userMessageWithTimeTag(
            lastText,
            DateTime.fromMillisecondsSinceEpoch(lastUser.ts),
          ),
        },
        for (final a in attachments)
          {
            'type': 'image_url',
            'image_url': {'url': 'data:${a.mime};base64,${a.dataBase64}'},
          },
      ];
      if (messages.isNotEmpty && messages.last['role'] == 'user') {
        messages[messages.length - 1] = {'role': 'user', 'content': parts};
      }
    }
    return messages;
  }


  /// 手机本地沙箱里刚写出来的产物 → 下载卡用的清单.
  ///
  /// 只认 workspace_files 的 write/append —— 那是手机本地 agent 唯一能造文件的
  /// 工具 (它只写文本, 所以实际能出的是 .csv/.md 这类)。图片走 direct_image
  /// 自己的卡, 不在这里。
  ///
  /// 扩展名白名单跟桌面一致: 不然 agent 每写一个 .txt 草稿都弹张卡。
  static const Set<String> _localArtifactExts = {
    '.csv', '.pdf', '.zip', '.png', '.jpg', '.jpeg', '.webp', '.svg',
    '.pptx', '.docx', '.xlsx', '.md', '.txt', '.html',
    /* 本地 Linux 跑出来的音视频 / 表格 / 数据 */
    '.mp3', '.mp4', '.m4a', '.wav', '.gif', '.xls', '.json',
  };

  /// 用户发来的文件存进工作区 uploads/, 返回相对路径。重名不覆盖 (同名的上一版可能正被改着)。
  Future<String?> _saveUpload(String name, List<int> bytes) async {
    try {
      await _ensureTools();
      final root = _workspaceTool?.rootDir;
      if (root == null) return null;
      final safe = name.replaceAll(RegExp(r'[/\\:*?"<>|]'), '_');
      final dot = safe.lastIndexOf('.');
      final base = dot > 0 ? safe.substring(0, dot) : safe;
      final ext = dot > 0 ? safe.substring(dot) : '';
      var rel = 'uploads/$safe';
      for (var i = 2; await File('${root.absolute.path}/$rel').exists(); i++) {
        rel = 'uploads/$base ($i)$ext';
      }
      final f = File('${root.absolute.path}/$rel');
      await f.parent.create(recursive: true);
      await f.writeAsBytes(bytes, flush: true);
      return rel;
    } catch (_) {
      return null; /* 存不下也不挡这一轮, 照样能读 */
    }
  }

  Future<List<Map<String, Object?>>?> _localArtifactsOf(
    Map<String, Object?> p,
    Map<String, Object?>? callArgs,
  ) async {
    try {
      /* 本地 Linux 的命令: 工具回执末尾列了这条命令新建 / 改过的文件 (ShellTool.producedMarker), 每个挂一张卡。
       * 命令失败也照挂 —— 常见的是脚本最后一步报错, 前面已经把文件写出来了 */
      /* 画的图: 回执里每张一行「图片: images/xxx.png」 */
      if (p['tool_name'] == 'generate_image') {
        final cards = <Map<String, Object?>>[];
        for (final line in '${p['output'] ?? ''}'.split('\n')) {
          if (!line.startsWith(GenerateImageTool.linePrefix)) continue;
          final c = await _artifactCard(line.substring(GenerateImageTool.linePrefix.length).trim());
          if (c != null) cards.add(c);
        }
        return cards.isEmpty ? null : cards;
      }
      if (p['tool_name'] == 'execute_shell') {
        final out = '${p['output'] ?? ''}';
        final at = out.lastIndexOf(ShellTool.producedMarker);
        if (at < 0) return null;
        final cards = <Map<String, Object?>>[];
        for (final line in out.substring(at + ShellTool.producedMarker.length).split('\n')) {
          final c = await _artifactCard(line.trim());
          if (c != null) cards.add(c);
          if (cards.length >= 6) break;
        }
        return cards.isEmpty ? null : cards;
      }
      if (p['ok'] == false) return null;
      String? rel;
      if (p['tool_name'] == 'office_edit') {
        /* 改完 / 新建的 Office 文件: 路径以工具回执为准 (save_as 没填时是「-修改版」) */
        /* 回执末尾可能带「(N 行)」(Excel) 或「(N 页)」(PPT) —— 第一版只认「行」, 新建的 PPT 一直挂不上卡 */
        rel = RegExp(r'(?:已保存为|已新建) (.+?)(?: \(\d+ [行页]\))?$', multiLine: true)
            .firstMatch('${p['output'] ?? ''}')?[1]
            ?.trim();
      } else if (p['tool_name'] == 'workspace_files') {
        final args = callArgs ?? p['args'];
        if (args is! Map) return null;
        final op = (args['op'] as String?)?.trim();
        if (op != 'write' && op != 'append') return null;
        rel = (args['path'] as String?)?.trim();
      }
      if (rel == null || rel.isEmpty) return null;
      final card = await _artifactCard(rel);
      return card == null ? null : [card];
    } catch (_) {
      return null; /* 挂不上卡不影响这一轮 */
    }
  }

  /// 一次性补卡 (2026-10-12): 旧版本里文件明明做出来了、卡没挂上的那些工具结果 (新建 PPT 回执带「(N 页)」没认出),
  /// 用现在的规则重算一遍写回。每台手机只跑一次。
  Future<void> _backfillArtifactsOnce() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool('local_artifact_backfill_v1') == true) return;
      await prefs.setBool('local_artifact_backfill_v1', true);
      final dao = _ref.read(appDatabaseProvider).sessionEventsDao;
      final calls = <String, Map<String, Object?>>{};
      for (final e in await dao.getByKind('tool_call')) {
        final m = jsonDecode(e.payload);
        if (m is Map && m['tool_call_id'] is String && m['args'] is Map) {
          calls[m['tool_call_id'] as String] = Map<String, Object?>.from(m['args'] as Map);
        }
      }
      for (final e in await dao.getByKind('tool_result')) {
        final m = jsonDecode(e.payload);
        if (m is! Map || m['artifacts'] != null) continue;
        if (!const {'office_edit', 'workspace_files', 'generate_image', 'execute_shell'}.contains(m['tool_name'])) continue;
        final cards = await _localArtifactsOf(
          {'tool_name': m['tool_name'], 'output': m['text'], 'ok': m['ok']},
          calls[m['tool_call_id']],
        );
        if (cards == null) continue;
        await dao.updatePayload(e.sessionId, e.seq, jsonEncode({...m, 'artifacts': cards}));
      }
    } catch (_) {/* 补不上就算了, 不挡正常使用 */}
  }

  /// 工作区文件 → 修改时间 (最多 3000 个, 不进隐藏目录)
  Map<String, int> _workspaceSnapshot() {
    final root = _workspaceTool?.rootDir;
    final out = <String, int>{};
    if (root == null || !root.existsSync()) return out;
    final base = root.absolute.path;
    try {
      for (final e in root.listSync(recursive: true, followLinks: false)) {
        if (out.length >= 3000) break;
        if (e is! File) continue;
        final rel = e.path.substring(base.length + 1);
        if (rel.split('/').any((s) => s.startsWith('.'))) continue;
        out[rel] = e.statSync().modified.millisecondsSinceEpoch;
      }
    } catch (_) {}
    return out;
  }

  /// 工作区里一个文件 → 下载卡; 扩展名不在名单 / 越界 / 空文件 → null
  Future<Map<String, Object?>?> _artifactCard(String rel) async {
    if (rel.isEmpty) return null;
    final ext = rel.contains('.') ? rel.substring(rel.lastIndexOf('.')).toLowerCase() : '';
    if (!_localArtifactExts.contains(ext)) return null;
    final root = _workspaceTool?.rootDir;
    if (root == null) return null;
    final f = File('${root.absolute.path}/$rel');
    /* 越界防御: 沙箱工具自己已经拦过, 这里再确认一次解析后仍在根下 */
    final resolved = Uri.file(f.absolute.path).normalizePath().toFilePath();
    if (!resolved.startsWith('${root.absolute.path}/')) return null;
    if (!await f.exists()) return null;
    final size = await f.length();
    if (size <= 0) return null;
    return {
      /* 本地产物没有服务端 id, 用路径做稳定 id (同一文件重写不刷新卡) */
      'id': 'local:$rel',
      'name': rel.split('/').last,
      'size_bytes': size,
      'mime': 'application/octet-stream',
      'local_path': resolved,
    };
  }

  Future<void> _insertEvent({
    required String sessionId,
    required String kind,
    required Map<String, Object?> payload,
    bool clearPendingUser = false,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    final nextSeq = (await db.sessionEventsDao.getMaxSeq(sessionId) ?? 0) + 1;
    final now = DateTime.now().millisecondsSinceEpoch;
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(nextSeq),
        ts: Value(now),
        kind: Value(kind),
        payload: Value(jsonEncode(payload)),
      ),
    );
    await db.sessionMirrorDao.updateLastSeq(sessionId, nextSeq, now);
    final stream = _ref.read(streamBufferProvider.notifier);
    stream.updateLatestDriftSeq(sessionId, nextSeq);
    if (clearPendingUser) stream.clearPendingUserText(sessionId);
  }

  Future<void> _maybeTitleFromFirstMessage(
    String sessionId,
    String text,
  ) async {
    if (text.trim().isEmpty) return;
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null) return;
    /* 3~12 字摘要; 用户/桌面已经起过名的不覆盖 (默认标题判定见 kDefaultSessionTitles) */
    final title = improvedSessionTitle(mirror.title, text);
    if (title == null) return;
    await db.sessionMirrorDao.upsert(
      SessionMirrorCompanion(
        id: Value(sessionId),
        desktopDeviceId: const Value(kPhoneLocalDeviceId),
        title: Value(title),
        workspaceName: const Value('手机'),
        lastMessageAt: Value(DateTime.now().millisecondsSinceEpoch),
        createdAt: Value(mirror.createdAt),
        lastSeq: Value(mirror.lastSeq),
      ),
    );
  }

  String _textFromPayload(String raw) {
    try {
      final parsed = jsonDecode(raw);
      if (parsed is Map && parsed['text'] is String) {
        return parsed['text'] as String;
      }
      if (parsed is Map && parsed['content'] is String) {
        return parsed['content'] as String;
      }
    } catch (_) {}
    return '';
  }

  List<_LocalAttachment> _attachmentsOf(Map<String, Object?> payload) {
    final raw = payload['attachments'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((m) {
          return _LocalAttachment(
            kind: (m['kind'] as String?) ?? '',
            name: (m['name'] as String?) ?? '',
            mime: (m['mime'] as String?) ?? 'application/octet-stream',
            dataBase64: (m['data_base64'] as String?) ?? '',
          );
        })
        .where((a) => a.kind.isNotEmpty && a.dataBase64.isNotEmpty)
        .toList();
  }

  /// 落库 payload 里的 documents[] (文件附件解出的文本) 拼到消息正文后面.
  String _appendDocuments(String text, String payloadJson) {
    try {
      final p = jsonDecode(payloadJson);
      final docs = p is Map ? p['documents'] : null;
      final imgs = p is Map ? p['saved_images'] : null;
      if ((docs is! List || docs.isEmpty) && (imgs is! List || imgs.isEmpty)) return text;
      final sections = <String>[
        if (docs is List)
          for (final d in docs.whereType<Map>())
            '[已上传文档: ${d['name'] ?? 'document'}]\n```\n${d['text'] ?? ''}\n```',
        if (imgs is List && imgs.isNotEmpty)
          '[用户发来的图片已存到工作区: ${imgs.whereType<Map>().map((m) => m['path']).join('、')} —— 要放进 PPT / Word 或改图就用这个路径]',
      ];
      return text.isEmpty ? sections.join('\n\n') : '$text\n\n${sections.join('\n\n')}';
    } on FormatException {
      return text;
    }
  }
}

class _LocalAttachment {
  const _LocalAttachment({
    required this.kind,
    required this.name,
    required this.mime,
    required this.dataBase64,
  });

  final String kind;
  final String name;
  final String mime;
  final String dataBase64;
}

/// 模型请求的错误是不是"等等就好" —— 交给 SDK 的断网耐心退避重发, 不终止整轮。
/// 401/402/403/400 这类 (登录 / 额度 / 请求本身) 重发也一样, 不算。
bool _isTransientModelError(Object e) {
  if (e is ChatBackendException) return e.retryable;
  return e is SocketException ||
      e is TimeoutException ||
      e is HandshakeException ||
      e is HttpException ||
      e is http.ClientException;
}

final phoneLocalAgentProvider = Provider<PhoneLocalAgent>(
  (ref) => PhoneLocalAgent(ref),
);
