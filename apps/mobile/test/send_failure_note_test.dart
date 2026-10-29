/// send_failure_note_test.dart — 发送失败在 timeline 留痕的行为约束.
///
/// 背景 (2026-08-11 模拟器实录): 服务端把当前模型下线后, 发送失败只弹了一个
/// 4 秒 toast, 而且被网络层的 toast 抢占 —— 用户看到的是自己那条气泡孤零零挂
/// 在屏幕底部, 没有任何解释和出路。修法是往 drift 落一条 client_error。
///
/// 这里锁三件事 (每一件坏掉都会让那个修复失效):
///   1. client_error 能被 TimelineState 还原成带 args 的 entry —— 错误卡的
///      「换个模型」按钮由 args.model_unavailable 决定, 走 default 分支就没了;
///   2. clearTrailingFailureNotes 只清末尾连续的那几条, 不碰历史里更早的失败;
///   3. client_error 不进 phone-local 的对话历史 —— 否则错误信封会被当成
///      assistant 消息喂回模型。
library;

import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/phone_local_agent.dart';
import 'package:neox_app/core/session_routing/send_failure_note.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/timeline/state/timeline_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;
  late AppDatabase db;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    container = ProviderContainer(
      overrides: [appDatabaseProvider.overrideWithValue(db)],
    );
  });

  tearDown(() async {
    container.dispose();
    await db.close();
  });

  Future<void> insert(
    String sid,
    int seq,
    String kind,
    String payload, {
    int ts = 1000,
  }) {
    return db.sessionEventsDao.insertEvent(
      SessionEventsCompanion.insert(
        sessionId: sid,
        seq: seq,
        ts: ts + seq,
        kind: kind,
        payload: payload,
      ),
    );
  }

  group('client_error → timeline entry', () {
    test('payload 整包进 entry.args (错误卡靠它决定长哪几个按钮)', () async {
      await insert(
        's1',
        1,
        'user_message',
        '{"text":"帮我看看"}',
      );
      await insert(
        's1',
        2,
        kClientErrorKind,
        '{"text":"❌ 该模型已停用, 请选择其他模型",'
            '"suggestion":"换一个模型再试","model_unavailable":true}',
      );

      /* 首次 read 触发 hydrate */
      container.read(timelineStateProvider('s1'));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final s = container.read(timelineStateProvider('s1'));

      final err = s.entries.firstWhere((e) => e.kind == kClientErrorKind);
      expect(err.text, '❌ 该模型已停用, 请选择其他模型');
      expect(err.args, isNotNull);
      expect(err.args!['model_unavailable'], isTrue);
      expect(err.args!['suggestion'], '换一个模型再试');
      /* 用户那条消息不能被顶掉 */
      expect(s.entries.any((e) => e.kind == 'user_message'), isTrue);
    });
  });

  group('clearTrailingFailureNotes', () {
    test('只清末尾连续的失败卡, 历史里更早的那条保留', () async {
      await insert('s2', 1, 'user_message', '{"text":"第一次"}');
      await insert('s2', 2, kClientErrorKind, '{"text":"❌ 旧的失败"}');
      await insert('s2', 3, 'agent_text', '{"text":"后来成功了"}');
      await insert('s2', 4, 'user_message', '{"text":"第二次"}');
      await insert('s2', 5, kClientErrorKind, '{"text":"❌ 刚刚的失败 A"}');
      await insert('s2', 6, kClientErrorKind, '{"text":"❌ 刚刚的失败 B"}');

      await clearTrailingFailureNotesOn(db, 's2');

      final left = await db.sessionEventsDao.getBySessionId('s2');
      expect(left.map((e) => e.seq), [1, 2, 3, 4]);
      /* seq=2 那条是历史上真发生过的失败, 属于会话记录, 不能顺手删掉 */
      expect(left.last.kind, 'user_message');
      expect(
        left.where((e) => e.kind == kClientErrorKind).length,
        1,
        reason: '只应剩下历史里那条',
      );
    });

    test('末尾不是失败卡时什么都不删', () async {
      await insert('s3', 1, 'user_message', '{"text":"hi"}');
      await insert('s3', 2, kClientErrorKind, '{"text":"❌ 失败"}');
      await insert('s3', 3, 'agent_text', '{"text":"成功"}');

      await clearTrailingFailureNotesOn(db, 's3');

      final left = await db.sessionEventsDao.getBySessionId('s3');
      expect(left.length, 3);
    });
  });

  group('对话历史不含失败卡', () {
    test('client_error 不会被当成 assistant 消息喂回模型', () {
      /* _buildMessages 的筛选条件就是"只要 user_message / agent_text" —
       * 这里锁住 client_error 不在其中, 防止有人后来把它改成 agent_text 复用
       * 桌面那套 ❌ 信封 (那样错误文案会污染下一轮上下文)。 */
      const historyKinds = {'user_message', 'agent_text'};
      expect(historyKinds.contains(kClientErrorKind), isFalse);
    });

    test('clampPhoneLocalHistory 对纯 user/assistant 序列仍然保序', () {
      final clamped = clampPhoneLocalHistory([
        (role: 'user', text: 'a'),
        (role: 'assistant', text: 'b'),
        (role: 'user', text: 'c'),
      ]);
      expect(clamped.map((m) => m['content']), ['a', 'b', 'c']);
    });
  });

  group('phone-local model id 归一 (2026-08-11 实测 P0 根因)', () {
    /* 用户在**电脑会话**里选模型 → 桌面 model.list 的 id 带命名空间
     * (`neox-cloud:deepseek-v4-flash`) → 写进全局默认 → 之后新建的**手机本地**
     * 会话拿它去问手机网关 → 网关不认前缀, 回「该模型已停用, 请选择其他模型」。
     * 实测同一个 deepseek-v4-flash 去掉前缀立刻就通。 */
    test('剥掉桌面命名空间前缀', () {
      expect(normalizePhoneLocalModelId('neox-cloud:deepseek-v4-flash'),
          'deepseek-v4-flash');
      expect(normalizePhoneLocalModelId('anthropic:claude-opus-5'),
          'claude-opus-5');
    });

    test('本来就干净的 id 原样不动', () {
      expect(normalizePhoneLocalModelId('deepseek-v4-flash'),
          'deepseek-v4-flash');
      expect(normalizePhoneLocalModelId('auto'), 'auto');
    });

    test('BYOK 的 byok/<provider>/<model> 是手机自己的格式, 不能动', () {
      expect(normalizePhoneLocalModelId('byok/my-openai/gpt-4o'),
          'byok/my-openai/gpt-4o');
    });

    test('畸形冒号不误伤', () {
      expect(normalizePhoneLocalModelId(':leading'), ':leading');
      expect(normalizePhoneLocalModelId('trailing:'), 'trailing:');
      expect(normalizePhoneLocalModelId(''), '');
    });
  });
}
