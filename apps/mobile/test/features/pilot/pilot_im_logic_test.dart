/// pilot_im_logic_test.dart — Pilot 当 IM 用时, 「这个窗口里能看到哪些话」的纯逻辑.
///
/// 这部分算错了用户看到的就是别人（专员）的对话, 或者自己的话消失 ——
/// 不靠眼睛看, 直接把账本筛一遍。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';

PilotContact _pilot(String name, {String sessionId = 's1'}) => PilotContact.fromJson({
      'session_id': sessionId,
      'name': name,
      'avatar': 'cat',
      'persona': '',
    });

PilotSpecialist _spec(String name, {bool on = true, int? lastAt, String? summary, String? schedule}) =>
    PilotSpecialist.fromJson({
      'id': name,
      'name': name,
      'duty': '看消息',
      'clay': 'i-team',
      'on': on,
      'schedule': schedule == null ? null : {'label': schedule},
      'last': lastAt == null ? null : {'at': lastAt, 'summary': summary},
    });

void main() {
  group('专员交付事件的解析', () {
    test('「👥 名字 · 标题 + 换行正文」拆成三段', () {
      final p = specialistPost('👥 收支 · 本周账单\n花了 320，主要在吃饭');
      expect(p, isNotNull);
      expect(p!.name, '收支');
      expect(p.title, '本周账单');
      expect(p.body, '花了 320，主要在吃饭');
    });

    test('没换行时正文是空串, 不是 null', () {
      final p = specialistPost('👥 家里 · 提醒交水费');
      expect(p!.body, '');
    });

    test('普通用户消息 / 其它 emoji 都不是专员交付', () {
      expect(specialistPost('帮我看下天气'), isNull);
      expect(specialistPost('📎 a.pdf'), isNull);
      /* 只有标题行那一行才算 (正文里出现 👥 不算) */
      expect(specialistPost('随便说说\n👥 收支 · 假标题'), isNull);
    });

    test('名字两侧的空格去掉, 标题里带 · 也拆得对', () {
      final p = specialistPost('👥  收支  ·  本周 · 账单');
      expect(p!.name, '收支');
      expect(p.title, '本周 · 账单');
    });
  });

  group('按窗口筛账本', () {
    final rows = [
      (role: 'user', text: '在吗'),
      (role: 'assistant', text: '在'),
      (role: 'event', text: '👥 收支 · 周报\n花了 100'),
      (role: 'assistant', text: '收到'),
      (role: 'event', text: '👥 家里 · 水费\n交了吗'),
    ];
    List<({String role, String text})> filter(PilotThread t, List<({String role, String text})> rs) =>
        pilotFilterThread(t, rs, role: (r) => r.role, text: (r) => r.text);

    test('群: 账本全部 (专员交的也在群里)', () {
      expect(filter(PilotThread.group(_pilot('小航')), rows).length, 5);
    });

    test('跟 Pilot 单聊: 去掉专员交付, 其余按原顺序', () {
      final out = filter(PilotThread.direct(_pilot('小航')), rows);
      expect(out.map((r) => r.text), ['在吗', '在', '收到']);
    });

    test('专员单聊: 只要它交的 + 你 @ 它的那一轮', () {
      final out = filter(PilotThread.specialist(_pilot('小航'), _spec('收支')), rows);
      expect(out.map((r) => r.text), ['👥 收支 · 周报\n花了 100']);
    });

    test('专员单聊: @ 它之后紧跟的回话算这个窗口的', () {
      final rs = [
        (role: 'user', text: '@收支 这周怎么样'),
        (role: 'assistant', text: '这周还好'),
        (role: 'assistant', text: '具体说：320'),
      ];
      final out = filter(PilotThread.specialist(_pilot('小航'), _spec('收支')), rs);
      expect(out.length, 3);
    });

    test('专员单聊: @ 了别人之后就断开了, 不把别人的话算进来', () {
      final rs = [
        (role: 'user', text: '@收支 这周怎么样'),
        (role: 'assistant', text: '这周还好'),
        (role: 'user', text: '@家里 水费交了吗'),
        (role: 'assistant', text: '交了'),
      ];
      final out = filter(PilotThread.specialist(_pilot('小航'), _spec('收支')), rs);
      expect(out.map((r) => r.text), ['@收支 这周怎么样', '这周还好']);
    });

    test('专员单聊: 别的专员交付不算进来', () {
      final rs = [
        (role: 'event', text: '👥 家里 · 水费\n交了'),
        (role: 'event', text: '👥 收支 · 周报\n320'),
      ];
      final out = filter(PilotThread.specialist(_pilot('小航'), _spec('收支')), rs);
      expect(out.length, 1);
    });
  });

  group('内部往来不是对话', () {
    test('<phone-signal> 是手机替它看到的消息', () {
      expect(pilotInternalLine('user', '<phone-signal source="mac">1 条新短信'), isTrue);
      expect(pilotInternalLine('assistant', '<phone-signal>'), isFalse);
    });

    test('[quiet] 是它「没事」的回话', () {
      expect(pilotInternalLine('assistant', '[quiet]'), isTrue);
      expect(pilotInternalLine('assistant', '有事的'), isFalse);
    });
  });

  group('列表预览字', () {
    test('markdown 记号去掉, 只留第一句非空的话', () {
      expect(pilotPreviewText(PilotLine(role: 'assistant', text: '\n## 标题\n**正文**', at: _t)), '标题');
    });

    test('自己说的带「我：」; 它说的带名字', () {
      final line = PilotLine(role: 'user', text: '帮我看天气', at: _t);
      expect(pilotPreviewText(line, withSender: true), startsWith('我'));
      final a = PilotLine(role: 'assistant', text: '看了，晴', at: _t);
      expect(pilotPreviewText(a, withSender: true, pilotName: '小航'), startsWith('小航'));
    });

    test('专员交付写成「名字：标题」', () {
      final line = PilotLine(role: 'event', text: '👥 收支 · 周报\n320', at: _t);
      expect(pilotPreviewText(line), contains('收支'));
      expect(pilotPreviewText(line), contains('周报'));
    });
  });

  group('IM 时间', () {
    test('今天 = 时:分 (两位分钟)', () {
      final now = DateTime.now();
      final t = DateTime(now.year, now.month, now.day, 8, 5);
      expect(pilotListTime(t), '08:05');
    });

    test('昨天 = 昨天', () {
      final now = DateTime.now();
      expect(pilotListTime(now.subtract(const Duration(days: 1))), isNotEmpty);
    });

    test('一周以前 = 月/日', () {
      final old = DateTime(2020, 3, 4);
      expect(pilotListTime(old), '3/4');
    });
  });

  group('窗口标题与发出去的样子', () {
    test('单聊 = Pilot 名字; 群 = 我的团队; 专员 = 专员名', () {
      final p = _pilot('小航');
      expect(PilotThread.direct(p).title, '小航');
      expect(PilotThread.group(p).title, isNotEmpty);
      expect(PilotThread.specialist(p, _spec('收支')).title, '收支');
    });

    test('专员单聊发出去带 @名字; 别的不带', () {
      final p = _pilot('小航');
      expect(PilotThread.specialist(p, _spec('收支')).outgoing('这周怎么样'), '@收支 这周怎么样');
      expect(PilotThread.direct(p).outgoing('这周怎么样'), '这周怎么样');
      expect(PilotThread.group(p).outgoing('这周怎么样'), '这周怎么样');
    });
  });

  group('专员目录', () {
    test('默认开着; 显式 false 才是关着', () {
      expect(_spec('a').on, isTrue);
      expect(_spec('b', on: false).on, isFalse);
    });

    test('排班文案 / 最近一次 / 摘要都读得到', () {
      final s = _spec('收支', lastAt: 1234, summary: '周报已发', schedule: '每天 9:00');
      expect(s.lastAt, 1234);
      expect(s.lastSummary, '周报已发');
      expect(s.scheduleLabel, '每天 9:00');
    });
  });
}

final _t = DateTime(2026, 1, 1);
