/// home_mode_provider.dart — 对话 / 工作 / 编码 三模式.
///
/// 桌面架构 (2026-07-10 拍板): 模式不是"藏按钮"级差异, 是"渲染不同组件树"级分化。
/// 移动端落地面:
///   - 空态首屏: 各模式自己的问候 + 开场插画
///   - 输入框 placeholder 按模式换
///   - 抽屉里的会话列表按模式分开
///
/// **对话 (2026-09-24 重新加回, 跟 09-23 删掉的那个不是一回事)**
/// 09-23 删的「对话」(原 Life, wire 'assistant') 是跑在**电脑**上的助手模式, 跟桌面一起删了。
/// 这次加回的是**手机自己跑**的对话: 会话建在手机本地 (phoneLocal), 模型走订阅网关或
/// 用户自己的 Key, 联网搜索 / 计算这几样手机工具照常带着 —— 一步都不经过电脑。
/// 用户原话: 「对话的需求是很强烈的…它可以不依赖于电脑…尽可能增强手机的能力」。
/// 工作 / 编码仍然只在电脑上跑 (「扣的是肯定需要电脑的…Work 模式下暂时也是需要电脑的」)。
///
/// wire 值: 'chat' 只记在手机本地会话上, 不会发给电脑; 'work' | 'code' 对齐桌面
/// Session.agentMode。持久化 SharedPreferences, 重启保留。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/execution/run_target.dart' show isPhoneLocalDeviceId;
import '../../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

enum HomeMode { chat, work, code }

/// 会话上记的 wire 值 → 模式. 存量 'assistant' 归 Work; 没记 (null) 的不猜.
HomeMode? homeModeFromWire(String? wire) => switch (wire) {
  'chat' => HomeMode.chat,
  'code' => HomeMode.code,
  'work' || 'assistant' => HomeMode.work,
  _ => null,
};

/// 这条会话归哪个模式 —— 抽屉分列表、点开会话时切模式都用它.
///
/// 跑在手机本地的一律算对话, 不看它记的 wire 值: 以前「运行位置 = 自动」连不上电脑时
/// 会落到手机上, 那些会话记的是 work, 但它们实际就是一段手机上的聊天。
///
/// 2026-10-11: 工作可以选「本机」跑了 (手机上的 Agent 带联网 / 文件 / 手机工具) —— 手机本地且明确记着
/// work 的归工作; 其余手机本地会话照旧算对话。
HomeMode? homeModeOfSession({String? agentMode, String? desktopDeviceId}) =>
    isPhoneLocalDeviceId(desktopDeviceId)
    /* 2026-10-12 编码也能在本机跑 —— 漏了 code, 本机编码会话一打开就被当成对话 (输入框变「有什么想聊的」) */
    ? (agentMode == 'work' ? HomeMode.work : agentMode == 'code' ? HomeMode.code : HomeMode.chat)
    : homeModeFromWire(agentMode);

extension HomeModeX on HomeMode {
  /// 会话上记的 wire 值 (work/code 同桌面 Session.agentMode).
  String get wireValue {
    switch (this) {
      case HomeMode.chat:
        return 'chat';
      case HomeMode.work:
        return 'work';
      case HomeMode.code:
        return 'code';
    }
  }

  /// 新会话可能去电脑 (要不要先把电脑连上)。
  /// 2026-10-14 陶土稿 v5: 工作 / 编码都由输入框里「在哪干」决定跑在手机 / 某台电脑 / 云端 ——
  /// 进这两个模式就把电脑连上, 那颗签和弹层里的在线状态才是真的; 只有对话固定在手机上。
  bool get needsDesktop => this != HomeMode.chat;

  /// 界面上的名字.
  String get label {
    switch (this) {
      case HomeMode.chat:
        return tr('对话');
      case HomeMode.work:
        return tr('工作');
      case HomeMode.code:
        return tr('编码');
    }
  }

  /// 输入框 placeholder (对齐桌面 composerPlaceholder).
  String get composerHint {
    switch (this) {
      case HomeMode.chat:
        return tr('有什么想聊的？');
      case HomeMode.work:
        return tr('描述要做的事…');
      case HomeMode.code:
        return tr('描述任务，或贴代码/报错…');
    }
  }
}

const _kPref = 'neox_home_mode';

class HomeModeController extends StateNotifier<HomeMode> {
  HomeModeController(this._prefs) : super(_decode(_prefs.getString(_kPref)));
  final SharedPreferences _prefs;

  void set(HomeMode m) {
    state = m;
    _prefs.setString(_kPref, m.name);
  }

  /// 没存过 (新装) 落到对话 —— 登录就能用, 不用先去配电脑;
  /// 存量的 'life' 跟桌面 normalizeAgentMode 同口径归工作。
  static HomeMode _decode(String? raw) => switch (raw) {
    'chat' => HomeMode.chat,
    'code' => HomeMode.code,
    null => HomeMode.chat,
    _ => HomeMode.work,
  };
}

final homeModeProvider = StateNotifierProvider<HomeModeController, HomeMode>(
  (ref) => HomeModeController(ref.watch(sharedPreferencesProvider)),
);
