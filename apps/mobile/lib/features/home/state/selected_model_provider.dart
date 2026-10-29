/// selected_model_provider.dart — 用户在主输入框选的 model id (全局默认).
///
/// 设计:
///   - 持久化 model id 到 SharedPreferences ('neox_default_model')
///   - 默认值 'auto' (server auto pool, 后端没配的话 phone-local 会 fallback listModels)
///   - StageInput chip 显示当前选中 model 的 friendly name
///   - Tap chip 弹 popup 选其他 model (从 listModels 拉真实可用列表)
///
/// 单 session vs 全局:
///   - 这里只管"全局默认", 影响新建 session
///   - 每个 session 自己的 model 通过 phoneLocalAgent.updateModel / wsClient.updateSessionModel 改
library;

import 'dart:async';
import 'dart:math' show min;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/byok/byok_models.dart' show ByokModelRef;
import '../../../core/byok/byok_store.dart';
import '../../../core/edition/edition.dart' show accountStatusProvider, planModelsProvider;
import '../../../core/errors/friendly_error.dart';
import '../../../core/local_agent/model_gateway_client.dart';
import '../../../core/local_agent/phone_local_agent.dart';
import '../../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'home_mode_provider.dart';
import '../../../core/local_llm/local_model_catalog.dart';
import 'package:neox_app/core/i18n/tr.dart';

const String _kKey = 'neox_default_model';

/// 不进 picker 的模型 —— 自动路由这类"占位模型"不该和真模型并列。
///
/// 2026-09-22 用户: 「把 auto 取消…不要用 auto, auto 没有意义」+
/// 「这有个 or-free-auto, 我觉得没有必要显示」。
/// 两个都是同一种东西: 它们不是一个模型, 而是"让别人挑"。列在真模型里,
/// 用户没法判断自己这一发会落到哪儿、要花多少 —— 那就别列。
const Set<String> kHiddenModelIds = {'auto', 'or-free-auto'};

/// 可选模型 —— 滤掉占位模型和出图模型。
///
/// 2026-09-22 用户: 「这个模型本来应该展示, 但是却在那个编码的模型里也显示了
/// 图片的模型, 这个是不合理的」。
/// 判据走 [GatewayModel.canChat] (服务端 image_generation 字段 + modalities):
/// 光看 modalities 判不出来 —— nano-banana-2 走 gemini-generate-content 协议,
/// 按协议算出来是 'chat', 于是它混进了对话/编码的选择器, 真机实测就漏了它。
/// 出图模型在图片工作台选 (见 image_image_model_pick / imageModelPrefProvider)。
List<GatewayModel> selectableModels(List<GatewayModel> all) => all
    .where((m) => !kHiddenModelIds.contains(m.id))
    .where((m) => m.canChat)
    .toList(growable: false);

/// 图片工作台能用的出图模型 —— 与 [selectableModels] 互补。
///
/// 图片页要能选模型 (2026-09-22 用户: 「图片生成连个模型都不展示, 实际上是有模型的」),
/// 而它该列的就是被对话侧滤掉的那些。
List<GatewayModel> imageModels(List<GatewayModel> all) =>
    all.where((m) => !kHiddenModelIds.contains(m.id) && !m.canChat).toList(
      growable: false,
    );

/// 消耗最小的那个模型 id (按 relativeCost 升序); 排不出就取第一个。
///
/// relativeCost 是服务端算好的"额度烧速", 跟模型面板里那根消耗条同一个口径
/// (见 membership 的 buildRelativeCostMap), 所以"选最省"和"看到的最省"一致。
/// relativeCost 缺省的排在后面 —— "不知道烧多少"不该冒充"最省"。
String? cheapestModelId(List<GatewayModel> models) {
  if (models.isEmpty) return null;
  GatewayModel? best;
  for (final m in models) {
    /* 按量模型扣的是余额, 没选过不能默认落到它身上 */
    if (m.payAsYouGo) continue;
    final c = m.relativeCost;
    if (c == null) continue;
    final bc = best?.relativeCost;
    if (best == null || bc == null || c < bc) best = m;
  }
  return (best ?? models.first).id;
}

/// 低延迟档的模型 —— 型号名里带 flash / mini / lite / haiku / nano 的那一类。
///
/// 注意「Fast」不是一个 effort / 思考档位, 而是选哪个 model id:
/// `schemas/models/deepseek-v4-flash.yaml` 写明「Flash / Pro 均支持 thinking 开关」,
/// 想要快就选 Flash 这个模型本身 (chat:C8-01)。
final RegExp _kLowLatencyModelRe =
    RegExp(r'(^|[-_.:/])(flash|mini|lite|haiku|nano)([-_.:/]|$)');

bool isLowLatencyModelId(String id) =>
    _kLowLatencyModelRe.hasMatch(id.toLowerCase());

/// 用户没选过时默认用的模型: 优先这几个 (走 DeepSeek 官方, 稳、中文好、便宜)。
///
/// 只按「最省」挑会落到最不稳的: 2026-10-05 最省的是促销期的 gpt-6-luna (0.01×), 它的上游渠道
/// 一个 503、一个不收「工具 + 推理」的 Chat Completions, 用户第一句就「模型服务暂不可用」。
const List<String> kPreferredDefaultModels = ['deepseek-v4.1-flash'];

/// 会话记的模型 [sessionModel] 已经下架时, 这一轮实际该用哪个 —— 输入框上显示的和发出去的都走这一个函数,
/// 两边才不会一个写 luna、一个发 deepseek (2026-10-05 用户: 「为什么不是一致的」)。
///
/// 本机模型 / BYOK 不在网关列表里, 原样返回; [models] 为空 (还没拉到 / 断网) 也原样返回, 不拿空列表下结论。
String liveModelId(String sessionModel, List<GatewayModel> models, String preferred) {
  if (sessionModel.isEmpty) return sessionModel;
  if (localLlmForModelId(sessionModel) != null || ByokModelRef.isByok(sessionModel)) return sessionModel;
  final selectable = selectableModels(models);
  if (selectable.isEmpty || selectable.any((m) => m.id == sessionModel)) return sessionModel;
  if (selectable.any((m) => m.id == preferred)) return preferred;
  return defaultModelId(selectable) ?? sessionModel;
}

/// 默认模型: 先试 [kPreferredDefaultModels], 再在低延迟档 (Flash / Mini …) 里挑最省的,
/// 最后才在全部模型里挑最省。
///
/// 为什么不直接从「最省」开始: 价格最低的不一定快, 也不一定稳 (见上面那段)。
/// 聊天要的是「打开就能问」, 所以中间加一层低延迟档 (chat:C8-01)。
String? defaultModelId(List<GatewayModel> models) {
  for (final id in kPreferredDefaultModels) {
    final m = models.where((m) => m.id == id && !m.payAsYouGo).firstOrNull;
    if (m != null) return m.id;
  }
  final lowLatency = models
      .where((m) => !m.payAsYouGo && isLowLatencyModelId(m.id))
      .toList(growable: false);
  if (lowLatency.isNotEmpty) return cheapestModelId(lowLatency);
  return cheapestModelId(models);
}

/// 对话 (手机上跑) 的模型单独记一份 (2026-09-26 用户: 普通聊天跟电脑的聊天应该分开)。
///
/// 原来全局只有一个 [_kKey]: 在对话里挑了个便宜的聊天模型, 切到工作/编码新建的电脑会话
/// 也用它; 在电脑那边为干活挑了个强模型, 回到对话每句闲聊都烧它。两边用途不同, 各记各的。
const String _kChatKey = 'neox_chat_model';

class SelectedModelController extends StateNotifier<String> {
  SelectedModelController(this._prefs, {required bool chat})
    : _key = chat ? _kChatKey : _kKey,
      super(_load(_prefs, chat: chat));

  final SharedPreferences _prefs;
  final String _key;

  /// 空串 = 用户还没选过 (首装 / 清数据)。
  ///
  /// 2026-09-22: 原来这里回落成 'auto'。现在没有 auto 了 —— 没选过时的默认值
  /// 由 [effectiveModelProvider] 拿真实列表算 (消耗最小的那个)。
  ///
  /// 对话那份第一次读时沿用原来的全局选择 —— 升级后不该让人发现"模型被换了"。
  static String _load(SharedPreferences prefs, {required bool chat}) {
    final own = prefs.getString(chat ? _kChatKey : _kKey)?.trim();
    if (own != null && own.isNotEmpty) return own;
    return chat ? (prefs.getString(_kKey)?.trim() ?? '') : '';
  }

  /// [explicitLocal]: 本机模型是不是用户亲手点的「用它聊天」(false = 下载完自动设的)。
  void set(String modelId, {bool explicitLocal = true}) {
    state = modelId;
    _prefs.setString(_key, modelId);
    _prefs.setBool(kChatLocalExplicitKey, localLlmForModelId(modelId) != null && explicitLocal);
  }
}

/// 对话默认的本机模型是不是用户亲手选的。没这个标记 (老版本自动设的) 一律当「不是」。
const String kChatLocalExplicitKey = 'neox_chat_model_local_explicit';

/// 对话那一份 (不管当前在哪个模式) —— 「本机模型」页的「用它聊天」只该改对话,
/// 本机模型跑不了电脑会话。
final chatModelProvider = StateNotifierProvider<SelectedModelController, String>((ref) {
  return SelectedModelController(ref.watch(sharedPreferencesProvider), chat: true);
});

/// 当前模式那一份: 对话读 [_kChatKey], 工作/编码读 [_kKey]。模式一切, 这里跟着换。
final selectedModelProvider =
    StateNotifierProvider<SelectedModelController, String>((ref) {
      return SelectedModelController(
        ref.watch(sharedPreferencesProvider),
        chat: ref.watch(homeModeProvider) == HomeMode.chat,
      );
    });

/// 实际生效的 model id —— 用户选过就用他的, 没选过就用 [defaultModelId] (DeepSeek Flash 优先, 再按最省)。
///
/// 两个例外保持空串: 用户选了一个已经下架的模型, 或者列表压根没拉下来。
/// 空串由调用方处理 (picker 的空态会如实说明原因), **不再**悄悄回落到一个占位模型。
final effectiveModelProvider = Provider<String>((ref) {
  final chosen = ref.watch(selectedModelProvider);
  final models = selectableModels(
    ref.watch(availableModelsProvider).valueOrNull ?? const <GatewayModel>[],
  );
  if (chosen.isNotEmpty) {
    /* 本机模型不在网关列表里, 也不受登录 / 网络影响 —— 亲手选的就是它。
     * 不是亲手选的 (老版本下载完自动设成默认) 且有订阅模型可用: 用订阅的 ——
     * 订阅用户的对话被一个 270M 小模型接管、答两句就报不可用 (2026-10-05 真机)。 */
    if (localLlmForModelId(chosen) != null) {
      final explicit = ref.watch(sharedPreferencesProvider).getBool(kChatLocalExplicitKey) ?? false;
      final cloud = models.where((m) => localLlmForModelId(m.id) == null).toList();
      if (explicit || cloud.isEmpty) return chosen;
      return defaultModelId(cloud) ?? chosen;
    }
    /* 用户选的那个还在列表里 → 就用它; 已下架 → 换成最省的, 别把一个不存在的
     * id 发上去 (那时候报错信息会离用户的选择远得莫名其妙)。 */
    if (models.isEmpty || models.any((m) => m.id == chosen)) return chosen;
  }
  return defaultModelId(models) ?? '';
});

/// 可用模型列表 — 订阅模型 (网关) + BYOK 模型合并.
/// BYOK 配置变化 (加 Key/加模型) 自动重算; 网关失败也不阻塞 BYOK (零账号).
/// 最近一次拉订阅模型失败的原因 —— 供 UI 如实显示 (2026-09-22).
///
/// 原来 [availableModelsProvider] 把一切异常吞成空列表, 而 model picker 的空态
/// 只会说「登录使用订阅模型」: 网络超时 / token 失效 / 服务端 5xx 全被说成
/// "你没登录", 用户只能一遍遍去登。用户原话「我登录后都没有默认模型…
/// 是什么就是什么」。
///
/// 单独放一个 provider 而不是让 [availableModelsProvider] 抛错: 图片页
/// (image_studio_providers) 直接 await 它, 抛错会连带把出图也挂掉。
final modelFetchErrorProvider = StateProvider<String?>((ref) => null);

final availableModelsProvider = FutureProvider<List<GatewayModel>>((ref) async {
  /* watch BYOK store — 用户加完 provider 回到输入框, 列表即时出现 */
  ref.watch(byokStoreProvider);
  /* 登录 / 登出 / 换账号就重拉 —— 不 watch 的话刚登录完还是登录前那份 (空的或别的账号的):
   * 输入框不出模型, 第一句发出去的模型这个账号用不了 (2026-10-08 iOS 真机)。
   * 只看身份, token 刷新不触发重拉。 */
  final signedIn = ref.watch(accountStatusProvider.select((a) => (a.signedIn, a.promptName))).$1;
  /* 会员拉到了也重拉一次: 列表按套餐筛, 会员没到时那份是没筛过的 (免费号会混进发不了的 deepseek) */
  ref.watch(planModelsProvider.select((m) => m != null));
  final err = ref.read(modelFetchErrorProvider.notifier);
  try {
    final list = await ref
        .read(phoneLocalAgentProvider)
        .listModels()
        /* 15s (原 5s): 内层 modelGatewayClient 自己就有 10s 超时, 外层那个 5s 会
         * **先**把它掐掉 —— 而掐断的表现是"空列表", 空列表在 UI 上又等于
         * "你没登录"。弱网 / 模拟器上光这一条就足以让模型面板永远是空的。 */
        .timeout(const Duration(seconds: 15));
    err.state = null;
    _modelFetchRetries = 0;
    return list;
  } catch (e) {
    err.state = friendlyError(e, fallback: tr('模型列表没能拉下来'));
    /* 失败了要自己再拉: 原来失败一次就定格成空列表, 只有换账号才重拉 ——
     * iOS 真机冷启动那一下取 token 失败 (请求都没发出去), 对话页从此没有模型 (2026-10-09)。
     * 已登录才重试, 2/4/8…秒退避, 封顶 60 秒。 */
    if (signedIn) {
      final delay = Duration(seconds: min(60, 2 << min(_modelFetchRetries, 5)));
      _modelFetchRetries++;
      final t = Timer(delay, ref.invalidateSelf);
      ref.onDispose(t.cancel);
    }
    return const <GatewayModel>[];
  }
});

int _modelFetchRetries = 0;

/// 给 model id 找 friendly display name. fallback: 直接显 id.
String modelDisplayName(String id, List<GatewayModel> models) {
  for (final m in models) {
    if (m.id == id) return m.name;
  }
  /* 本机模型不在网关列表里 —— 用目录里的名字, 不露 local:<id> */
  final local = localLlmForModelId(id);
  if (local != null) return local.name;
  return id;
}
