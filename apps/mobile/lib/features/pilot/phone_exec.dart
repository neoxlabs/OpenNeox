/// phone_exec.dart — 电脑上的 Pilot 借这台手机办事 (2026-10-01).
///
/// Pilot 跑在电脑 (容器) 上, 它的 phone 工具把动作推过来: `phone.exec` {req_id, tool, args}。
/// 这里用的就是手机本地 agent 那套工具 (core/local_agent/tools/phone_tools.dart), 一份实现两边用;
/// 跑完回 `phone.exec_result` {req_id, ok, output}。
///
/// 确认: 发不发确认卡由脑子 (容器 / 配对桌面) 按审批档决定, 这里不再弹第二遍。
/// 但写动作 (发短信 / 打电话 / 定闹钟 / 改日历 / 点按填字) 必须带脑子用通道密钥签的批准令牌 ——
/// 以前这里 confirm 恒为 true, 谁推什么就执行什么 (2026-10-18 pilot:D-01)。见 core/pilot/safety/approval_token.dart。
/// 系统授权框 (第一次用到某项权限) 照常弹。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../../core/local_agent/tools/phone_tools.dart';
import '../../core/local_agent/tools/shot_retention.dart';
import '../../core/pilot/safety/approval_token.dart';

typedef DesktopCall = Future<dynamic> Function(String method, Map<String, Object?> params);

/// [key] 是这条通道跟大脑共享的中继会话密钥 (云端通道: relay_session_key;
/// 配对电脑通道: paired_desktops.relaySessionKey), 用来验写动作的批准令牌。
Future<void> handlePhoneExec(Map<String, dynamic> params, DesktopCall reply, {List<int>? key}) async {
  final reqId = params['req_id'];
  final name = params['tool'] as String?;
  final args = params['args'] is Map ? Map<String, Object?>.from(params['args'] as Map) : <String, Object?>{};

  /* 写动作没有有效批准令牌 → 节点直接拒, 不碰设备 (needs_approval) */
  final problem = approvalProblem(action: name, args: args, approval: params['approval'], key: key);
  if (problem != null) {
    try {
      await reply('phone.exec_result', {'req_id': reqId, 'ok': false, 'output': problem});
    } catch (_) {/* 回不去: 对面超时, 如实当没办 */}
    return;
  }

  sdk.ToolResult r;
  final tools = buildPhoneTools((_, __) async => true);
  if (tools.isEmpty) {
    r = const sdk.ToolResult.error('这台手机不是安卓, 系统不让 App 打电话 / 定闹钟');
  } else {
    final tool = tools.where((t) => t.spec.name == name).firstOrNull;
    if (tool == null) {
      r = sdk.ToolResult.error('手机上没有这个能力: $name (手机 App 可能要更新)');
    } else {
      try {
        r = await tool.run(args, sdk.ToolContext(cancel: sdk.AgentCancelToken()));
      } catch (e) {
        r = sdk.ToolResult.error(e.toString());
      }
    }
  }
  /* 拍照: 结果里只有本机路径, 电脑上的 Pilot 看不到 —— 把图片本身带回去 (base64 JPEG, 长边已压到 1280) */
  Map<String, Object?>? image;
  if (!r.isError && (name == 'camera' || name == 'phone_ui') && r.output.contains('"photo_path"')) {
    try {
      final path = (jsonDecode(r.output) as Map)['photo_path'] as String;
      final file = File(path);
      image = {'data': base64Encode(await file.readAsBytes()), 'media_type': 'image/jpeg'};
      unawaited(file.delete().catchError((_) => file));
    } catch (_) {/* 读不到就只回文字 */}
  }
  try {
    await reply('phone.exec_result', {'req_id': reqId, 'ok': !r.isError, 'output': r.output, if (image != null) 'image': image});
  } catch (_) {
    /* 回不去 (刚断线): 电脑那头会超时, 如实告诉模型手机没回话 */
  }
  /* 这一次办完就把本轮截的图删掉 (pilot:D-08); 要回传的 image 上面已经读进内存 */
  unawaited(endRoundShots());
}
