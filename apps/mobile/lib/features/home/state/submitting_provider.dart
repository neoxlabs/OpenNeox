/// submitting_provider.dart — 「刚按下发送、会话还没建好」那几百毫秒里要显示的那句话.
///
/// 2026-09-18 用户实录: 「发送应该就产生气泡, 但实际好像是建立连接后气泡才会产生,
/// 然后才开始『思考中』, 体验非常差」+ 发完有一段空白屏。
///
/// 为什么会这样: 气泡挂在**会话**上 (pendingUserTextProvider(sessionId)), 而按下发送那一刻
/// 还没有会话 —— 要先连电脑 (远程一个来回 0.4~0.8s)、再 session.create、拿到 id 才有地方挂。
/// 这期间首页要么还是问候页 (看着像没反应), 要么已经切进空会话 (「还没有消息」白屏)。
///
/// 这个 provider 是那段空档的临时住处: 按下发送就写入, 真气泡出现 (或失败回填输入框) 就清掉。
/// 只存文本, 不存会话 id —— 它存在的理由正是"还没有会话 id"。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/attachments/local_attachment_store.dart';

final composerSubmittingTextProvider = StateProvider<String?>((ref) => null);

/// 同一段空档里这句话带的图 / 文件 (2026-10-11 真机: 发图时占位只有字、图没了, 输入框里还留着一份)
final composerSubmittingAttachmentsProvider = StateProvider<List<LocalAttachmentRef>>((ref) => const []);
