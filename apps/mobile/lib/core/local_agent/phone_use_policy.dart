/// Phone Use 的 App 名单 (2026-10-12) —— 哪些 App 能让 Agent 读屏 / 点按。
///
/// 用户: 「我们有应用程序白名单…让 Agent 能操作的, 那些需要加你就加, 风险你自理」。
/// 跟桌面 computerPolicy.ts 同一个口径:
///   open (默认)  除了禁止名单都能碰 —— 不改设置就跟以前一样能点外卖、叫车
///   allowlist    只有允许名单里的能碰
/// 禁止名单永远优先。判定在原生那边按前台包名做 (PhoneToolsBridge.policyBlock), 这里只存。
/// 硬线在原生里写死、这里改不动: Agent 不能在 Neox 自己的界面里点按; 聊天 App 里点「发送」、
/// 任何 App 里点付款都要用户确认 (NeoxAccessibilityService)。
library;

import 'package:shared_preferences/shared_preferences.dart';

class PhoneUsePolicy {
  const PhoneUsePolicy({required this.mode, required this.allow, required this.deny});

  /// 'open' | 'allowlist'
  final String mode;
  final List<String> allow;
  final List<String> deny;

  /// 默认允许名单: 聊天 / 办公 / 外卖 / 出行 / 购物 / 地图 —— Agent 最常要进去的
  static const defaultAllow = <String>[
    'com.tencent.mm', // 微信
    'com.tencent.mobileqq', // QQ
    'com.tencent.tim', // TIM
    'com.tencent.wework', // 企业微信
    'com.alibaba.android.rimet', // 钉钉
    'com.ss.android.lark', // 飞书
    'com.sankuai.meituan', // 美团
    'com.sankuai.meituan.takeoutnew', // 美团外卖
    'me.ele', // 饿了么
    'com.sdu.didi.psnger', // 滴滴
    'com.autonavi.minimap', // 高德地图
    'com.baidu.BaiduMap', // 百度地图
    'com.taobao.taobao', // 淘宝
    'com.jingdong.app.mall', // 京东
    'com.xunmeng.pinduoduo', // 拼多多
    'com.xingin.xhs', // 小红书
    'com.ss.android.ugc.aweme', // 抖音
    'com.android.mms', // 短信
    'com.google.android.apps.messaging', // 短信 (Google)
  ];

  static const _kMode = 'phone_use_mode_v1';
  static const _kAllow = 'phone_use_allow_v1';
  static const _kDeny = 'phone_use_deny_v1';

  static Future<PhoneUsePolicy> load() async {
    final p = await SharedPreferences.getInstance();
    return PhoneUsePolicy(
      mode: p.getString(_kMode) == 'allowlist' ? 'allowlist' : 'open',
      allow: p.getStringList(_kAllow) ?? defaultAllow,
      deny: p.getStringList(_kDeny) ?? const [],
    );
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kMode, mode);
    await p.setStringList(_kAllow, allow);
    await p.setStringList(_kDeny, deny);
  }

  PhoneUsePolicy copyWith({String? mode, List<String>? allow, List<String>? deny}) =>
      PhoneUsePolicy(mode: mode ?? this.mode, allow: allow ?? this.allow, deny: deny ?? this.deny);

  static bool _same(String a, String b) => a.toLowerCase() == b.toLowerCase();

  /// 用户拒绝了「允许操作这个 App」→ 记进禁止名单, 以后不再弹, 也直接拦住 (pilot:D-11)。
  /// 同时从允许名单里拿掉, 免得两个名单同时有它。
  PhoneUsePolicy refused(String pkg) {
    final has = deny.any((e) => _same(e, pkg));
    return PhoneUsePolicy(
      mode: mode,
      allow: allow.where((e) => !_same(e, pkg)).toList(),
      deny: has ? deny : [...deny, pkg],
    );
  }

  /// 一次移出多个 (设置页的批量移除)。两个名单一起清, 返回新对象, 不改自己。
  PhoneUsePolicy withoutPackages(Iterable<String> packages) {
    final drop = packages.toList();
    bool keep(String e) => !drop.any((p) => _same(p, e));
    return PhoneUsePolicy(mode: mode, allow: allow.where(keep).toList(), deny: deny.where(keep).toList());
  }

  /// 带给原生 ui 调用的参数
  Map<String, Object?> toArgs() => {'policy': mode, 'allow': allow, 'deny': deny};
}
