/// phone_local_history_test.dart — 手机本地会话送给模型的历史窗口.
///
/// 为什么要锁 (2026-08-08):
///   这段之前**完全没有上限**: session 的全部事件依次拼进 messages, 没条数限制、
///   没 token 预算、没压缩。聊到几十轮后每次发送都在重传整段历史 —— 越来越慢、
///   越来越贵, 最后撞上模型上下文上限直接报错, 而且从此这个会话每一次发送都会
///   再撞一次, 被永久聊废。
///
///   窗口逻辑判错的两个方向:
///     · 窗口太松 → 回到原来的问题, 只是晚一点发生
///     · 窗口切坏 (丢了当前这轮 / 首条是没有来由的 assistant 回答) → 模型答非
///       所问, 而这种坏比"太慢"更难被发现
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/phone_local_agent.dart';

/// 造一段 [turns] 轮完整问答 (user/assistant 交替), 内容带序号便于断言.
List<({String role, String text})> conversation(int turns) => [
      for (var i = 0; i < turns; i++) ...[
        (role: 'user', text: 'q$i'),
        (role: 'assistant', text: 'a$i'),
      ],
    ];

void main() {
  group('窗口 — 只保留最近的', () {
    test('短会话原样带过去, 一条不丢', () {
      final out = clampPhoneLocalHistory(conversation(3));
      expect(out.length, 6);
      expect(out.first['content'], 'q0');
      expect(out.last['content'], 'a2');
    });

    test('超长会话截到上限以内', () {
      final out = clampPhoneLocalHistory(conversation(100)); // 200 条
      expect(out.length, lessThanOrEqualTo(kPhoneLocalMaxHistoryMessages));
    });

    test('保留的是**最近**的而不是最早的', () {
      final out = clampPhoneLocalHistory(conversation(100));
      // 最后一轮必须在
      expect(out.last['content'], 'a99');
      // 开头那些必须已经不在
      expect(out.any((m) => m['content'] == 'q0'), isFalse);
    });

    test('当前这一轮的提问永远在窗口里 — 否则模型答的是上一个问题', () {
      // 真实调用时当前 user_message 已经落库, 是 history 的最后一条
      final history = [...conversation(100), (role: 'user', text: '当前提问')];
      final out = clampPhoneLocalHistory(history);
      expect(out.last['content'], '当前提问');
      expect(out.last['role'], 'user');
    });
  });

  group('窗口边界对齐 — 不能以无来由的回答开头', () {
    test('切口落在 assistant 上时把它丢掉', () {
      // 41 条: user,assistant,... 取最后 40 条会以 assistant 开头
      final history = [
        ...conversation(20), // 40 条, 末尾是 a19
        (role: 'user', text: '最后一问'),
      ];
      expect(history.length, 41);
      final out = clampPhoneLocalHistory(history, maxMessages: 40);
      expect(out.first['role'], 'user',
          reason: '首条是 assistant 的话, 模型会看到一句没有来由的回答');
      expect(out.length, 39, reason: '丢掉那条孤儿 assistant 后应少一条');
    });

    test('切口正好落在 user 上时一条不丢', () {
      final out = clampPhoneLocalHistory(conversation(30), maxMessages: 40);
      expect(out.length, 40);
      expect(out.first['role'], 'user');
    });

    test('空历史不炸', () {
      expect(clampPhoneLocalHistory(const []), isEmpty);
    });

    test('只有一条 assistant (异常数据) 也不炸', () {
      final out = clampPhoneLocalHistory([(role: 'assistant', text: 'a')]);
      expect(out, isEmpty);
    });
  });

  group('单条截断 — 一条超长粘贴不能顶掉全部预算', () {
    test('没超上限的原样返回', () {
      expect(clampHistoryText('短文本'), '短文本');
    });

    test('超长时头尾都留住, 中间挖空', () {
      final long = '${'H' * 3000}MIDDLE${'T' * 3000}';
      final out = clampHistoryText(long, maxChars: 1000);

      expect(out.startsWith('H' * 500), isTrue, reason: '头部要留住');
      expect(out.endsWith('T' * 500), isTrue, reason: '尾部要留住');
      expect(out.contains('省略'), isTrue, reason: '要明示这是节选');
      // 只截一头的话, 粘贴日志再问"最后报的什么错"就必然答不上来
      expect(out.contains('MIDDLE'), isFalse);
    });

    test('截断结果远小于原文 (预算真的省下来了)', () {
      final long = 'X' * 100000;
      final out = clampHistoryText(long, maxChars: 4000);
      expect(out.length, lessThan(4200)); // 4000 + 那句省略提示
    });

    test('窗口内的每一条都会被截断, 不只是最后一条', () {
      final history = [
        (role: 'user', text: 'A' * 9000),
        (role: 'assistant', text: 'B' * 9000),
      ];
      final out = clampPhoneLocalHistory(history, maxCharsPerMessage: 1000);
      for (final m in out) {
        expect((m['content'] as String).length, lessThan(1200));
      }
    });
  });
}
