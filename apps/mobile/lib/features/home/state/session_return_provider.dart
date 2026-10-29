/// session_return_provider.dart — 记住"这条会话是从设备列表点进来的" (2026-10-12).
///
/// **为什么需要**: 会话内容是渲染在**根路由的首页**里的 (`currentSessionProvider`),
/// 不是一条自己的路由。所以从「某台设备的会话列表」点进一条会话只能 `go('/')` ——
/// 那条 push 栈 (设备页 + 这台设备的会话列表) 被整个替换掉, 用户按系统返回直接退出
/// app, 想再看别的会话只能重开抽屉一路点回来。
///
/// 用户原话: 「电脑点进去不就是会话吗? 会话点进去这时候应该有返回键或者返回到这个
/// 页面的, 结果现在没有, 就导致我基本上是链路中断的。」
/// 以及: 「这个返回应该是到电脑手机页面 主页面了, 结果现在到了空白页。」
///
/// 所以顶栏那颗返回键**回到「工作 / 编码」的设备页** (那一屏的主页面: 手机 + 各台电脑),
/// 不是这条会话所在设备的会话列表 —— 做法跟抽屉点「工作 / 编码」一样, 换模式 + 清会话。
///
/// 首页顶栏左边第二格原来是给右边运行位置图标**配重的空白** (标题靠它居中) ——
/// 现在正好拿来放这颗返回键, 几何完全不变。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'current_session_provider.dart';
import 'home_mode_provider.dart';

/// null = 不是从设备列表点进来的 (抽屉点会话 / 新会话), 顶栏不给返回键.
final sessionReturnTargetProvider = StateProvider<HomeMode?>((ref) => null);

/// 从「某台电脑」页点进的会话 (2026-10-15): 返回 = 回到那台电脑的会话列表 (`/remote/<id>`),
/// 不是回空首页 —— 在手机上翻电脑上的活, 看完一条接着看下一条。
///
/// 绑着会话 id: 别处 (抽屉 / Pilot / 通知) 换了会话, 这条自动不作数, 不会把无关会话的 ☰ 变成 ←。
final sessionReturnRouteProvider = StateProvider<({String sessionId, String route})?>((ref) => null);

/// 当前会话的返回路由 (不是从电脑页进来的 = null)
final currentSessionReturnRouteProvider = Provider<String?>((ref) {
  final r = ref.watch(sessionReturnRouteProvider);
  final sid = ref.watch(currentSessionProvider);
  return (r != null && r.sessionId == sid) ? r.route : null;
});
