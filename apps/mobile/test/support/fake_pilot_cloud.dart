/// fake_pilot_cloud.dart — 测试用的云端 Pilot 替身.
///
/// 只实现页面真正会调的那几个方法: 读记录 / 连上 / 发一句。其它方法在页面路径上
/// 不该被调用 —— 一旦被调用就让测试红, 而不是悄悄返回一个假值把问题藏起来。
library;

import 'dart:async';

import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';

class FakePilotCloud implements PilotCloud {
  FakePilotCloud({
    this.messagesRows = const [],
    this.sendError,
    this.attachBusy = false,
    this.attachStep,
    this.liveController,
    this.actionsByState = const {},
    this.handleInterrupt = false,
    this.interruptGate,
  });

  /// messages() 返回的账本行, 旧 → 新
  List<Map<String, dynamic>> messagesRows;

  /// send() 要抛的错; null = 发成功
  Object? sendError;

  bool attachBusy;
  String? attachStep;

  /// 发成功的句子 (按顺序)
  final List<String> sent = [];

  /// 发出去的附件
  final List<List<Map<String, Object?>>> sentAttachments = [];

  int messageCalls = 0;
  int attachCalls = 0;

  /// 实时流 (聊天页 live 那一层); null = 什么都不推
  final StreamController<PilotLive>? liveController;

  /// actions(state) 的返回: pending / approved / done / failed
  Map<String, List<Map<String, dynamic>>> actionsByState;

  /// ✓ 真的答了哪张卡
  final List<({String id, String answer})> answers = [];

  /// 让 interrupt 真的走 (否则被调到就报错: 不该调的地方调了要能看见)
  bool handleInterrupt;

  /// 卡住 interrupt 不返回 (测「点停止立刻冻结画面」)
  Completer<void>? interruptGate;
  final List<String> interrupts = [];

  /// 推一条 live 事件
  void emit(String kind, {String text = '', String? step}) =>
      liveController?.add(PilotLive(kind, text: text, step: step));

  @override
  PilotRecordsApi get records => throw UnimplementedError('测试不该读个人记录');

  @override
  bool? get cachedEnabled => true;

  @override
  Future<bool> enabled({bool refresh = false}) async => true;

  @override
  Future<List<Map<String, dynamic>>> pilots() async => const [];

  @override
  Future<Map<String, dynamic>> board(String pilotId) async => const {'reports': [], 'reminders': []};

  @override
  Future<void> answerReport(String reportId, String answer) async => answers.add((id: reportId, answer: answer));

  @override
  Future<void> markReportsRead(String pilotId) async {}

  @override
  Future<List<Map<String, dynamic>>> actions(String pilotId, String state) async =>
      actionsByState[state] ?? const [];

  @override
  Future<String> ask(
    String pilotId,
    String text, {
    List<Map<String, Object?>> attachments = const [],
    void Function(String chunk, bool tool)? onDelta,
  }) async =>
      throw UnimplementedError('聊天页走 send/live, 不走 ask');

  @override
  Future<void> setModel(String pilotId, String modelId) async =>
      throw UnimplementedError('测试不该换模型');

  @override
  Future<void> interrupt(String pilotId) async {
    if (!handleInterrupt && interruptGate == null) throw UnimplementedError('测试不该打断');
    interrupts.add(pilotId);
    final gate = interruptGate;
    if (gate != null) await gate.future;
  }

  @override
  Future<List<Map<String, dynamic>>> messages(
    String pilotId, {
    int limit = 60,
    int? before,
  }) async {
    messageCalls++;
    return messagesRows;
  }

  @override
  Future<void> send(
    String pilotId,
    String text, {
    String? clientId,
    List<Map<String, Object?>> attachments = const [],
  }) async {
    final err = sendError;
    if (err != null) throw err;
    sent.add(text);
    sentAttachments.add(attachments);
  }

  @override
  Future<({bool busy, String? step})> attach(String pilotId) async {
    attachCalls++;
    return (busy: attachBusy, step: attachStep);
  }

  @override
  Stream<PilotLive> get live => liveController?.stream ?? const Stream.empty();
}
