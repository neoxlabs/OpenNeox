/// current_time_tag_test.dart — 精确当前时间走消息尾标签 (2026-10-18, C2-16).
///
/// 守四件事:
///   1. 每条用户消息挂的是**它自己落库那一刻**的 `<current-time>`, 不是"现在";
///   2. 两次请求重建同一段历史时, 前面每条消息逐字节相同 —— 前缀缓存才能接着命中;
///   3. system / 环境段同一天内逐字不变 (只有日期 + 星期, 没有分钟);
///   4. 界面显示和本地落库用的原文不含标签 —— 标签只作用在发给模型的那份副本上。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/chat_send_prep.dart';
import 'package:neox_app/core/local_agent/current_time_tag.dart';

void main() {
  group('消息尾 <current-time>', () {
    test('纯文本: 原文 + 空行 + 落库时刻', () {
      final text = userMessageWithTimeTag(
        '现在几点',
        DateTime(2026, 10, 18, 3, 25),
      );

      expect(text, startsWith('现在几点'));
      expect(text, contains('<current-time>2026-10-18 周日 03:25'));
      expect(text, endsWith('</current-time>'));
      /* 时区也写上: 环境段只剩日期, 时区由标签带 */
      expect(text, contains('UTC'));
      expect(text, matches(RegExp(r'UTC[+-]\d{2}:\d{2}\)</current-time>$')));
    });

    test('空文本 (只发图 / 只发文档): 只有标签, 不带多余空行', () {
      final text = userMessageWithTimeTag('', DateTime(2026, 10, 18, 3, 25));
      expect(text, startsWith('<current-time>'));
      expect(text, isNot(startsWith('\n')));
      expect(text, isNot(contains('\n\n')));
    });

    test('C2-16: 两次请求重建同一段历史 —— 旧消息逐字节不变', () {
      final aSent = DateTime(2026, 10, 18, 3, 25);
      final bSent = DateTime(2026, 10, 18, 3, 27);

      /* 第一次请求: 只有 A; 第二次请求 (两分钟后): 历史里 A 还是它自己那一刻 */
      final firstRequest = <String>[userMessageWithTimeTag('现在几点', aSent)];
      final secondRequest = <String>[
        userMessageWithTimeTag('现在几点', aSent),
        userMessageWithTimeTag('再问一句', bSent),
      ];

      expect(secondRequest.first, firstRequest.first,
          reason: '上一条消息的字节变了 = 前缀缓存从那里整段作废');
      expect(secondRequest.first, contains('03:25'));
      expect(secondRequest.last, contains('03:27'));
      expect(secondRequest.last, isNot(secondRequest.first));
    });
  });

  group('环境段日期行 — 同一天内逐字不变', () {
    test('同一天不同分钟完全一样, 且不含分钟', () {
      final a = formatEnvironmentDateLine(DateTime(2026, 10, 18, 3, 25));
      final b = formatEnvironmentDateLine(DateTime(2026, 10, 18, 3, 35));
      final c = formatEnvironmentDateLine(DateTime(2026, 10, 18, 23, 59));

      expect(a, b);
      expect(a, c);
      expect(a, '当前日期: 2026-10-18 周日');
      /* 分钟级时间一个字符都不能有 (有的话前缀缓存就打穿了) */
      expect(a, isNot(contains('03:25')));
      expect(a, isNot(matches(RegExp(r'\d{1,2}:\d{2}'))));
    });

    test('跨天就变 (模型仍知道今天几号)', () {
      final today = formatEnvironmentDateLine(DateTime(2026, 10, 18, 3, 25));
      final tomorrow = formatEnvironmentDateLine(DateTime(2026, 10, 19, 3, 25));
      expect(today, isNot(tomorrow));
      expect(tomorrow, contains('2026-10-19'));
    });

    test('星期写对 (周一 … 周日)', () {
      expect(formatEnvironmentDateLine(DateTime(2026, 10, 18)), contains('周日'));
      expect(formatEnvironmentDateLine(DateTime(2026, 10, 19)), contains('周一'));
    });
  });

  test('环境段缓存 10 分钟内不变, 但消息尾的时刻在走', () async {
    /* 跟 ChatEnvironmentCache 对齐: 同一 TTL 窗口内 system 段 (缓存那份) 逐字相同,
     * 时间只在消息尾标签里变 —— 这才是「问现在几点不会差 10 分钟」的完整链路。 */
    var now = DateTime(2026, 10, 18, 3, 25);
    final cache = ChatEnvironmentCache(ttl: const Duration(minutes: 10), now: () => now);
    Future<String> build() async {
      /* 环境段里只放天级日期行 (agent_environment.dart 就是这么拼的) */
      return '${formatEnvironmentDateLine(now)}\n当前模型: m1';
    }

    final systemA = await cache.acquire(key: 'm1|chat', build: build);
    final tagA = userMessageWithTimeTag('现在几点', now);

    /* 往 8 分钟之后走 —— 缓存窗口内 */
    now = now.add(const Duration(minutes: 8));
    final systemB = await cache.acquire(key: 'm1|chat', build: build);
    final tagB = userMessageWithTimeTag('现在几点', now);

    expect(systemB, systemA, reason: 'system 段必须逐字相同');
    expect(systemB, isNot(contains('03:25')));
    expect(tagA, contains('03:25'));
    expect(tagB, contains('03:33'));
    expect(tagA, isNot(tagB));
  });

  test('标签格式与桌面 <current-time> 同名, 带星期和时分', () {
    final tag = currentTimeTag(DateTime(2026, 10, 18, 3, 25));
    expect(tag, startsWith('<current-time>'));
    expect(tag, endsWith('</current-time>'));
    expect(tag, contains('2026-10-18 周日 03:25'));
  });
}
