/// account_status.dart — 共享代码眼里的"账号"只有这么多.
///
/// 登录、会员、计费都是发行版的事 (见 edition.dart)。共享代码只需要知道:
/// 登没登录 (起步引导、发送前拦截)、登录态有没有坏 (错误药丸)、
/// 以及写进手机 agent 环境块里的那个名字。
library;

class AccountStatus {
  const AccountStatus({
    this.signedIn = false,
    this.authBroken = false,
    this.promptName,
  });

  /// 已登录且凭证已从存储里读出来。
  final bool signedIn;

  /// 登录态坏了 (服务端明确拒绝了这条会话 / 在线通道连续鉴权失败) ——
  /// 唯一有用的动作是重新登录。
  final bool authBroken;

  /// 给手机本地 agent 的"用户: xxx"那一行。null = 不写。
  final String? promptName;

  /// 没有账号体系, 或者没登录。
  static const signedOut = AccountStatus();

  @override
  bool operator ==(Object other) =>
      other is AccountStatus &&
      other.signedIn == signedIn &&
      other.authBroken == authBroken &&
      other.promptName == promptName;

  @override
  int get hashCode => Object.hash(signedIn, authBroken, promptName);
}
