/// pilot_receipt_test.dart — 回执卡三要素 (pilot:U-05).
///
/// 验收: 10 条回执抽检, 每条都含「一句话 + 数字 + 下一步」。
/// 数字从原句里取 (时刻 / 金额 / 次数…), 取不到就用发生时间; 下一步按事情类型给。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/pilot/pilot_receipt.dart';

const _samples = [
  '✅ 设好了 8:30 的提醒，到点叫你起床',
  '✅ 把「下午 3 点开会」加进日历了',
  '✅ 给妈妈发了一条短信，已发送',
  '✅ 记下了这周的第 3 次跑步',
  '✅ 周会 PPT 做好了，一共 12 页',
  '✅ 这个月花销整理好了：¥7,538',
  '⚠️ 给王总发消息没办成，他没回话',
  '✅ 打给外卖小哥了，通话 2 分钟',
  '✅ 打卡「早睡」，连续 5 天',
  '✅ 帮你查了 3 个航班',
];

void main() {
  test('10 条回执都拆得出三要素', () {
    final at = DateTime(2026, 10, 18, 9, 5);
    for (final s in _samples) {
      final r = PilotReceipt.fromEvent(s, at: at);
      expect(r.summary.trim(), isNotEmpty, reason: '$s → 一句话');
      expect(r.fact.trim(), isNotEmpty, reason: '$s → 数字');
      expect(r.next.trim(), isNotEmpty, reason: '$s → 下一步');
      expect(r.summary.contains('✅'), isFalse, reason: '小勾不该留在正文里');
    }
  });

  test('数字优先取时刻 / 金额, 不看错位置', () {
    expect(PilotReceipt.fromEvent(_samples[0]).fact, '8:30');
    expect(PilotReceipt.fromEvent('把「下午 3 点开会」加进日历了，明天 9:00 提醒你').fact, '9:00');
    expect(PilotReceipt.fromEvent(_samples[5]).fact, '¥7,538');
  });

  test('下一步按事情类型给', () {
    expect(PilotReceipt.fromEvent(_samples[0]).next, '到点我会提醒你');
    expect(PilotReceipt.fromEvent(_samples[2]).next, '对方回了我告诉你');
    expect(PilotReceipt.fromEvent(_samples[4]).next, '点开就能用');
    expect(PilotReceipt.fromEvent(_samples[6]).next, '我晚点再试一次');
  });

  test('下一步按关键词推导: 每一类事都有对应的一句', () {
    const cases = {
      '✅ 设好了闹钟': '到点我会提醒你',
      '✅ 加进日历了': '到点我会提醒你',
      '✅ 用 iMessage 发给王总了': '对方回了我告诉你',
      '✅ 报告生成好了': '点开就能用',
      '✅ 记好了这周的账': '要改直接跟我说',
      '✅ 存好了': '要改直接跟我说',
      '✅ 打卡「早睡」': '要改直接跟我说',
      '⚠️ 失败了': '我晚点再试一次',
    };
    cases.forEach((text, next) {
      expect(PilotReceipt.fromEvent(text).next, next, reason: text);
    });
  });

  test('下一步看事情本身, 不被别的关键词带跑: 没办成优先', () {
    expect(PilotReceipt.fromEvent('⚠️ 给妈妈发短信没办成').next, '我晚点再试一次');
    expect(PilotReceipt.fromEvent('✅ 提醒设好了，短信也发了').next, '到点我会提醒你');
  });

  test('没命中关键词: 回到最保守的一句', () {
    expect(PilotReceipt.fromEvent('✅ 帮你把快递取回来了').next, '有变化我再说');
  });

  test('句子里一个数都没有: 用发生时间当那个数字', () {
    final r = PilotReceipt.fromEvent('✅ 帮你把快递取回来了', at: DateTime(2026, 10, 18, 9, 5));
    expect(r.fact, '09:05');
  });

  testWidgets('回执卡把三要素都画出来 (平: 一行字 + 一行灰字)', (t) async {
    const r = PilotReceipt(summary: '设好了提醒', fact: '8:30', next: '到点我会提醒你');
    await t.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: PilotReceiptCard(receipt: r)))));

    expect(find.text('设好了提醒'), findsOneWidget);
    expect(find.text('8:30 · 到点我会提醒你'), findsOneWidget);
  });
}
