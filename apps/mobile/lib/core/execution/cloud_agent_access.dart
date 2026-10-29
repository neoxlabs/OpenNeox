/// cloud_agent_access.dart — 云端沙箱会话 (RunTargetPref.cloud) 的契约.
///
/// 云端执行是托管服务, 由发行版提供; 没有时 [cloudAgentAccessProvider] 是 null,
/// 会话路由把 cloud 档当成"不可用"处理 (跟商业版未登录时一样)。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';

abstract class CloudAgentAccess {
  /// 现在能不能新建云端会话 (服务端开关 + 登录)。
  bool get canCreate;

  /// 新建并登记一个云端会话。连接由调用方发起 (connectToDesktop(agentDeviceId))。
  /// [agentMode] 'work' | 'code' —— 云端容器按它换提示词和工具档。
  Future<({String sessionId, String agentDeviceId})> createSession({
    String? modelHint,
    String? agentMode,
  });

  /// 进已有云端会话前恢复它 (确认沙箱活着 + 拿新的会话密钥)。
  /// null = 服务端说恢复不了。
  Future<({String relaySessionKeyB64, String state})?> resumeSession(
    String sessionId,
  );

  /// 关掉服务端的云端会话。新建后首发就失败的空壳要关掉, 不然服务端留着一条
  /// 没标题、一秒没跑过的「云端会话」, 电脑侧栏里一排 (2026-10-12 用户实拍)。
  Future<bool> terminateSession(String sessionId);
}

final cloudAgentAccessProvider = Provider<CloudAgentAccess?>(
  (ref) => ref.watch(editionProvider).cloudAgent(ref),
);
