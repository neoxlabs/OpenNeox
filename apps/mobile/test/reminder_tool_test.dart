/// reminder_tool_test.dart — 定时提醒的时间解析.
///
/// 为什么单独测这个: 模型给的时间字符串格式极不稳定 —— 同一个模型这轮给
/// "2026-08-15 09:00", 下轮给 "2026/8/15 9:00", 再下轮给中文 "2026年8月15日 9点"。
/// 解析失败的后果不是报错, 而是**用户以为提醒设上了, 到点没响** —— 跟这个功能
/// 修复之前的症状一模一样, 等于白做。
///
/// 另一半 (真的排进系统闹钟) 靠模拟器实测, 单测碰不到 flutter_local_notifications。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/tools/reminder_tool.dart';

void main() {
  group('模型给的各种时间格式都要认', () {
    test('标准 ISO / 连字符', () {
      expect(parseLocalDateTime('2026-08-15 09:00'),
          DateTime(2026, 8, 15, 9, 0));
      expect(parseLocalDateTime('2026-08-15T09:00:00'),
          DateTime(2026, 8, 15, 9, 0));
    });

    test('斜杠 + 单位数月日时', () {
      expect(parseLocalDateTime('2026/8/5 9:30'), DateTime(2026, 8, 5, 9, 30));
    });

    test('中文年月日 / 中文冒号', () {
      expect(parseLocalDateTime('2026年8月15日 9点00'),
          DateTime(2026, 8, 15, 9, 0));
      expect(parseLocalDateTime('2026-08-15 09：30'),
          DateTime(2026, 8, 15, 9, 30));
    });

    test('只给日期 → 默认当天 9 点 (生活提醒的合理默认)', () {
      expect(parseLocalDateTime('2026-08-15'), DateTime(2026, 8, 15, 9));
      expect(parseLocalDateTime('2026年8月15日'), DateTime(2026, 8, 15, 9));
    });

    test('带时区的 ISO 一律按本地时间理解', () {
      /* 用户说"8月15号早上9点"要的就是**当地的**早上 9 点。模型偶尔会自作主张
       * 加个 Z, 那时候按 UTC 转换会把提醒挪到半夜。 */
      expect(parseLocalDateTime('2026-08-15T09:00:00Z'),
          DateTime(2026, 8, 15, 9, 0));
      expect(parseLocalDateTime('2026-08-15T09:00:00+08:00'),
          DateTime(2026, 8, 15, 9, 0));
    });

    test('解析不了要返回 null, 不能瞎猜一个时间', () {
      /* 宁可告诉模型"格式不对, 重给一个", 也不能随手编一个时间点 —— 那会变成
       * 一条在错误时间响的提醒, 比不响更糟。 */
      expect(parseLocalDateTime(''), isNull);
      expect(parseLocalDateTime('明天早上'), isNull);
      expect(parseLocalDateTime('tomorrow 9am'), isNull);
      expect(parseLocalDateTime('下周三'), isNull);
    });
  });

  group('台账序列化', () {
    test('往返不丢字段', () {
      const r = ScheduledReminder(
        id: 42,
        title: '给妈妈买生日礼物',
        body: '提前 3 天',
        atMs: 1786500000000,
      );
      final back = ScheduledReminder.fromJson(r.toJson());
      expect(back, isNotNull);
      expect(back!.id, 42);
      expect(back.title, '给妈妈买生日礼物');
      expect(back.body, '提前 3 天');
      expect(back.atMs, 1786500000000);
    });

    test('坏数据不炸', () {
      expect(ScheduledReminder.fromJson(null), isNull);
      expect(ScheduledReminder.fromJson('nope'), isNull);
      expect(ScheduledReminder.fromJson({'id': 'x', 'at': 1}), isNull);
      expect(ScheduledReminder.fromJson({'id': 1}), isNull);
    });
  });
}
