/// current_session_provider.dart — 首页当前活跃 session.
///
/// 设计:
///   - null = 没活跃 session → 首页显 GreetingHero (问候 + 输入)
///   - 非 null = 有 session → 首页显 TimelineMessageList(id) + 输入
///
/// 流转:
///   - 用户在 StageInput 发第一条消息 → 创建 session → setCurrent(id)
///   - 抽屉点 recent session → setCurrent(id)
///   - 抽屉点 "+ 新会话" 或顶 bar "+" → setCurrent(null)
///
/// **冷启动不恢复** (2026-09-22 用户: 「默认进来编码页面…不应该默认显示 timeline;
/// 如果断开连接其实还显示不合理。Claude 的客户端 app 就是先进入一个空白页, 会话在列表里」)。
///
/// 原来存最后的 sessionId, 重启直接打开它。而那一刻电脑多半还没连上 (自动连接在
/// 首帧之后才开始), 于是一进来就是一屏旧 timeline —— 看着像能用, 其实发不出去,
/// 换过电脑的话显示的还是另一台上的对话。现在一律从空白首页进, 会话在抽屉里挑。
/// 通知点进来 (app.dart) 会显式 set, 不受影响。
///
/// 连接断了 / 换了电脑时离开会话的逻辑在 connection_guard.dart。
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

/// 老版本存下的"上次会话"键 —— 不再读, 启动时顺手删掉, 别留一份没人用的状态。
const String _kLegacyKey = 'home_current_session_id';

/// 上次停在哪个会话 (2026-10-12 起恢复)。
///
/// 9-22 定的是冷启动一律进空白首页 (怕一进来一屏旧 timeline 却发不出去)。10-12 用户改口:
/// 「每次进来就应该是上一次的电脑连接和会话」—— 现在电脑会先连上次那台 (ws_client_provider
/// currentDesktopId), 连接没好时会话页顶上有连接条, 不再是「看着能用其实发不出去」。
const String _kLastKey = 'home_last_session_v2';

class CurrentSessionController extends StateNotifier<String?> {
  CurrentSessionController(this._prefs) : super(_prefs.getString(_kLastKey)) {
    _prefs.remove(_kLegacyKey);
  }

  final SharedPreferences _prefs;

  void set(String? sessionId) {
    state = (sessionId == null || sessionId.isEmpty) ? null : sessionId;
    final s = state;
    if (s == null) {
      _prefs.remove(_kLastKey);
    } else {
      _prefs.setString(_kLastKey, s);
    }
  }
}

final currentSessionProvider =
    StateNotifierProvider<CurrentSessionController, String?>((ref) {
      return CurrentSessionController(ref.watch(sharedPreferencesProvider));
    });

/// 从任意页面打开一个 session — 设为首页当前会话并回到 `/`.
///
/// 2026-06-28 单页重构后不存在 `/timeline/:id` 路由了; cloud / workspace /
/// 设备等二级页要进会话, 统一走这里, 别再 push 死路由.
void openSessionOnHome(BuildContext context, WidgetRef ref, String sessionId) {
  if (sessionId.isEmpty) return;
  ref.read(currentSessionProvider.notifier).set(sessionId);
  if (context.mounted) GoRouter.of(context).go('/');
}
