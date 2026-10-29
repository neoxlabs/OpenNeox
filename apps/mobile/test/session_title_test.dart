/// session_title_test.dart — 本机会话首次发送后的自动标题 (chat:C1-04).
///
/// 约束: 首条消息压成 3~12 字摘要; 用户已经起过名的不覆盖。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/session_title.dart';

void main() {
  group('sessionTitleFromFirstMessage', () {
    test('长中文压到 12 字以内, 截断带省略号', () {
      final title = sessionTitleFromFirstMessage('帮我写一个 Python 冒泡排序算法并解释每一步');
      expect(title.runes.length, lessThanOrEqualTo(kSessionTitleMaxChars));
      expect(title.endsWith('…'), isTrue);
      expect(title, isNot(contains('帮我')), reason: '开头客套词不该占标题');
    });

    test('短消息原样保留 (不编造, 不补字)', () {
      expect(sessionTitleFromFirstMessage('你好'), '你好');
      expect(sessionTitleFromFirstMessage('  看下这个 bug  '), '看下这个 bug');
    });

    test('换行 / 连续空白折叠成一行', () {
      expect(
        sessionTitleFromFirstMessage('  明天\n\n  几点的会?  '),
        '明天 几点的会?',
      );
    });

    test('链接只留链接文字, 裸 URL 去掉', () {
      expect(
        sessionTitleFromFirstMessage('看看 [这个方案](https://example.com/a)'),
        '看看 这个方案',
      );
      expect(
        sessionTitleFromFirstMessage('https://example.com/very/long/path 总结一下'),
        '总结一下',
      );
    });

    test('隐藏注入标签不进标题', () {
      expect(
        sessionTitleFromFirstMessage('写个周报<reply-language>中文</reply-language>'),
        '写个周报',
      );
    });

    test('空消息 / 纯空白返回空串', () {
      expect(sessionTitleFromFirstMessage(''), '');
      expect(sessionTitleFromFirstMessage('   \n  '), '');
      expect(sessionTitleFromFirstMessage('***'), '***');
    });
  });

  group('improvedSessionTitle', () {
    test('默认标题可以被首条消息替换', () {
      expect(improvedSessionTitle('新会话', '做一份季度复盘 PPT'), '做一份季度复盘 PPT');
      expect(improvedSessionTitle('', '查一下明天的天气'), '查一下明天的天气');
      expect(improvedSessionTitle('新任务', '修一下登录问题'), '修一下登录问题');
    });

    test('用户/桌面起过的名字不覆盖', () {
      expect(improvedSessionTitle('我的重要会话', '随便说点'), isNull);
    });

    test('首条消息没内容时不动标题', () {
      expect(improvedSessionTitle('新会话', '   '), isNull);
    });

    test('标题长度上限对默认标题同样生效', () {
      final title = improvedSessionTitle('新会话', '请帮我把这段很长的需求整理成一份可以执行的清单');
      expect(title, isNotNull);
      expect(title!.runes.length, lessThanOrEqualTo(kSessionTitleMaxChars));
    });
  });
}
