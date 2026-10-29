/// Pilot 住在云端 (2026-10-03) 时, 手机跟它打交道的那根线。
///
/// 它的东西 (对话 / 记忆 / 汇报 / 提醒) 按账号存在云端账本里, 脑子在云端容器里跑:
/// 手机只管说话、听它说、替它动手 (打电话 / 定闹钟…), 不再自己想、不再跟电脑同步。
///
/// 云端是托管服务, 由发行版提供 (core/edition/edition.dart 的 pilotCloud):
/// 商业版注册 NeoxCloud 的实现; 没有的发行版拿到 null, 也就没有 Pilot (Pilot 只住在云端)。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';
import 'pilot_records.dart';

abstract class PilotCloud {
  /// 个人记录 (体重 / 花销 / 随手记…), 跟它的对话记忆是同一个账号下的一本账
  PilotRecordsApi get records;

  /// 这个账号的 Pilot 住在云端 (登录了、并且开通了)。结果会缓存, [refresh] 强制重问。
  Future<bool> enabled({bool refresh = false});

  /// 上次问到的答案 (本进程或上次启动记在本地的), 同步可读; 从没问到过 = null。
  /// 入口先按它画出来, [enabled] 回来再纠正 —— 不然有权限的人每次都要等一趟网络 Pilot 才「慢一步」冒出来。
  bool? get cachedEnabled;

  /// 联系人: [{id, name, avatar, persona, patrolMinutes, updatedAt}]
  Future<List<Map<String, dynamic>>> pilots();

  /// 任务板: {reports: [...], reminders: [...]}
  Future<Map<String, dynamic>> board(String pilotId);

  Future<void> answerReport(String reportId, String answer);
  Future<void> markReportsRead(String pilotId);

  /// 动作卡 (它要用你的名义对外发的东西, 等你点头): state = pending | approved | done | failed | rejected
  /// 每张: {id, title, summary, options, at, action: {tool, action, args, preview}, actionState, actionResult}
  Future<List<Map<String, dynamic>>> actions(String pilotId, String state);

  /// 跟它说一句。[onDelta] 流式回调: (文字片段, false) 或 (工具名, true)。返回它这一轮说出来的话。
  /// 脑子只在云端 (core/pilot/pilot_brain.dart, 2026-10-18 起没有本机大脑); 连不上就抛错, 调用方如实显示。
  Future<String> ask(
    String pilotId,
    String text, {
    List<Map<String, Object?>> attachments = const [],
    void Function(String chunk, bool tool)? onDelta,
  });

  /// 换它用的模型 (连着就当场换, 别的窗口下一句起用)
  Future<void> setModel(String pilotId, String modelId);

  /// 打断它正在说 / 正在做的
  Future<void> interrupt(String pilotId);

  // ───────── 聊天模式 (2026-10-11): 说话和干活分开 ─────────
  //
  // 活在云端容器里一步一步跑, 跟手机开没开无关; 聊天页只是一扇窗:
  //   [send] 发了就走 —— 它正在干活也能发, 插进那一轮, 它做完手上这一步就看到
  //   [live] 它那边发生的事: 一段话在写 / 写完一段 (一个气泡) / 在做哪一步 / 一轮做完
  //   [attach] 打开聊天时连上, 顺便问它此刻在不在干活、干到哪步
  //   [messages] 对话记录 (每段话各一条, 旧 → 新)

  /// 对话记录, 旧 → 新: [{id, role: user | assistant | event, text, device, at}]; [before] = 往前翻 (消息 id)
  Future<List<Map<String, dynamic>>> messages(String pilotId, {int limit = 60, int? before});

  /// [attachments]: [{kind: image | file, name, mime, data_base64, size_bytes}] —— 图它直接看, 文件存到它的工作区它自己打开。
  /// 它正在干活时只能插字, 带附件会被拒 (StateError 说清楚)
  Future<void> send(String pilotId, String text, {String? clientId, List<Map<String, Object?>> attachments = const []});

  Future<({bool busy, String? step})> attach(String pilotId);

  Stream<PilotLive> get live;
}

/// 它那边发生的一件事
class PilotLive {
  const PilotLive(this.kind, {this.text = '', this.step});

  /// delta = 正在写的一段又多了几个字 (text) / segment = 一段写完 (该收成一个气泡) /
  /// step = 开始做一步 (step = 工具名) / done = 这一轮做完 / busy = 开始干活 /
  /// conn = 连接状态 (step = waking 在叫醒它 / reconnecting 掉线了在接回来 / null 连着)
  final String kind;
  final String text;
  final String? step;
}

final pilotCloudProvider = Provider<PilotCloud?>(
  (ref) => ref.watch(editionProvider).pilotCloud(ref),
);
