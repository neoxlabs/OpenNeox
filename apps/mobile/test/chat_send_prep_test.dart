/// chat_send_prep_test.dart — 发送前准备 (C8-03 / C8-04) 的回归用例.
///
/// 守四件事:
///   1. 环境采集很慢时, 首轮最多等 300ms, 不挡发送;
///   2. 后台采好的那份下一轮直接用 (不再等);
///   3. TTL 窗口内两轮拿到的是同一份 (system 前缀逐字节不变), 到期才换;
///   4. 前置步骤并行后, 结果跟串行一样, 总耗时≈最慢的一项.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/chat_send_prep.dart';
import 'package:neox_app/core/telemetry/chat_metric.dart';

Future<T> _delayed<T>(int ms, T value) =>
    Future<T>.delayed(Duration(milliseconds: ms), () => value);

void main() {
  group('ChatEnvironmentCache', () {
    test('首轮环境采集很慢: 最多等 300ms, 先不带环境发', () async {
      final cache = ChatEnvironmentCache();
      final sw = Stopwatch()..start();
      final env = await cache.acquire(
        key: 'm1|chat',
        build: () => _delayed(1500, '慢环境'),
      );
      sw.stop();
      expect(env, '', reason: '超时就不带环境, 不能把发送卡住');
      expect(sw.elapsedMilliseconds, lessThan(900),
          reason: '实际等了 ${sw.elapsedMilliseconds}ms, 应该只等 300ms 左右');
    });

    test('首轮超时后, 后台采好的那份下一轮直接用 (不再等)', () async {
      final cache = ChatEnvironmentCache();
      var calls = 0;
      Future<String> build() async {
        calls++;
        if (calls == 1) return _delayed(600, '慢环境');
        return '快环境';
      }

      expect(await cache.acquire(key: 'm1|chat', build: build), '');
      /* 等后台那次 (600ms) 采完 */
      await _delayed(700, null);

      final sw = Stopwatch()..start();
      final second = await cache.acquire(key: 'm1|chat', build: build);
      sw.stop();
      expect(second, '慢环境', reason: '后台采好的环境下一轮要带上');
      expect(sw.elapsedMilliseconds, lessThan(100), reason: '命中缓存不能有等待');
    });

    test('TTL 窗口内两轮是同一份; 到期换上后台备好的那份, 不等慢采集', () async {
      var now = DateTime(2026, 10, 18, 10, 0);
      final cache = ChatEnvironmentCache(
        ttl: const Duration(minutes: 10),
        now: () => now,
      );
      var calls = 0;
      var slow = false;
      Future<String> build() async {
        calls++;
        if (slow) return _delayed(1500, 'E$calls');
        return 'E$calls';
      }

      expect(await cache.acquire(key: 'm1|chat', build: build), 'E1');
      /* 第二轮: 命中上一轮那份 (逐字节相同), 同时后台去采 E2 */
      now = now.add(const Duration(minutes: 1));
      expect(await cache.acquire(key: 'm1|chat', build: build), 'E1');
      await _delayed(20, null);

      slow = true;
      /* 再隔 9.5 分钟: 正在用的那份过期了, 后台备好的 E2 还没过期 → 直接换上 */
      now = now.add(const Duration(minutes: 9, seconds: 30));
      final sw = Stopwatch()..start();
      final third = await cache.acquire(key: 'm1|chat', build: build);
      sw.stop();
      expect(third, 'E2', reason: 'TTL 到期换上后台已经采好的那份');
      expect(sw.elapsedMilliseconds, lessThan(200),
          reason: '有备好的就不该再等慢采集');
    });

    test('换了模型 / 轻聊天档: 不复用上一份', () async {
      final cache = ChatEnvironmentCache();
      expect(await cache.acquire(key: 'm1|chat', build: () async => 'A'), 'A');
      expect(await cache.acquire(key: 'm2|work', build: () async => 'B'), 'B');
    });

    test('采集抛错: 不挡发送, 下一轮还能重新采', () async {
      final cache = ChatEnvironmentCache();
      var fail = true;
      Future<String> build() async {
        if (fail) throw StateError('设备信息拿不到');
        return 'E';
      }

      expect(await cache.acquire(key: 'm1|chat', build: build), '');
      fail = false;
      expect(await cache.acquire(key: 'm1|chat', build: build), 'E');
    });
  });

  group('prepareChatSend', () {
    test('并行: 结果跟串行一致, 总耗时≈最慢的一项', () async {
      final sw = Stopwatch()..start();
      final prep = await prepareChatSend(
        byokReady: _delayed(150, null),
        modelId: _delayed(150, 'm1'),
        agentMode: _delayed(150, 'chat'),
        messages: _delayed(150, <Map<String, Object?>>[
          {'role': 'system', 'content': 'p'},
          {'role': 'user', 'content': '你好'},
        ]),
        persona: _delayed(150, '身份'),
      );
      sw.stop();

      expect(prep.modelId, 'm1');
      expect(prep.agentMode, 'chat');
      expect(prep.persona, '身份');
      expect(prep.messages.last['content'], '你好');
      expect(sw.elapsedMilliseconds, lessThan(450),
          reason: '5 项各 150ms, 串行约 750ms; 实际 ${sw.elapsedMilliseconds}ms');
    });

    test('谁先出错先抛谁 (跟串行时一样)', () async {
      await expectLater(
        prepareChatSend(
          byokReady: _delayed(150, null),
          modelId: Future<String>.error(StateError('模型读不到')),
          agentMode: _delayed(150, null),
          messages: _delayed(150, const <Map<String, Object?>>[]),
          persona: _delayed(150, ''),
        ),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('ChatTurnTiming', () {
    test('两段耗时都记上, 每轮只打一条', () {
      final lines = <String>[];
      var now = DateTime(2026, 10, 18, 10, 0, 0);
      final timing = ChatTurnTiming(
        sessionId: 's1',
        sendAt: now,
        now: () => now,
        writeLog: lines.add,
      )
        ..modelId = 'deepseek-v4.1-flash'
        ..lightChat = true;

      now = now.add(const Duration(milliseconds: 120));
      timing.markRequestSent();
      now = now.add(const Duration(milliseconds: 800));
      timing.markFirstToken();
      /* 一轮收尾时又会被调一次 —— 不能重复打 */
      timing.logIfUnfinished();

      expect(lines, hasLength(1));
      final line = lines.single;
      expect(line, startsWith('[chat-ttft]'));
      expect(line, contains('send_to_request=120ms'));
      expect(line, contains('request_to_first=800ms'));
      expect(line, contains('total=920ms'));
      expect(line, contains('model=deepseek-v4.1-flash'));
      expect(line, contains('light=1'));
    });

    test('没出字的一轮也记一条, 两段用 -1', () {
      final lines = <String>[];
      final now = DateTime(2026, 10, 18, 10, 0, 0);
      final timing = ChatTurnTiming(
        sessionId: 's2',
        sendAt: now,
        now: () => now,
        writeLog: lines.add,
      );

      timing.markRequestSent();
      timing.logIfUnfinished();

      expect(lines, hasLength(1));
      expect(lines.single, contains('send_to_request=0ms'));
      expect(lines.single, contains('request_to_first=-1ms'));
      expect(lines.single, contains('total=-1ms'));
    });

    test('重试再发一次请求时只认第一次', () {
      final lines = <String>[];
      var now = DateTime(2026, 10, 18, 10, 0, 0);
      final timing = ChatTurnTiming(
        sessionId: 's3',
        sendAt: now,
        now: () => now,
        writeLog: lines.add,
      );

      now = now.add(const Duration(milliseconds: 50));
      timing.markRequestSent();
      now = now.add(const Duration(seconds: 3)); /* 断网退避后重试 */
      timing.markRequestSent();
      now = now.add(const Duration(milliseconds: 400));
      timing.markFirstToken();

      /* 只认第一次请求; 退避那 3 秒也是用户真实等的时间, 算在第二段里 */
      expect(lines.single, contains('send_to_request=50ms'));
      expect(lines.single, contains('request_to_first=3400ms'));
    });

    test('算完交给 onMetric 一份, 供入库 (chat:C8-11)', () {
      final metrics = <ChatTurnMetric>[];
      var now = DateTime(2026, 10, 18, 10, 0, 0);
      final timing = ChatTurnTiming(
        sessionId: 's4',
        sendAt: now,
        now: () => now,
        writeLog: (_) {},
        onMetric: metrics.add,
      )
        ..modelId = 'deepseek-v4.1-flash'
        ..lightChat = true;

      now = now.add(const Duration(milliseconds: 90));
      timing.markRequestSent();
      now = now.add(const Duration(milliseconds: 710));
      timing.markFirstToken();
      timing.logIfUnfinished(); /* 收尾再调一次不应重复上报 */

      expect(metrics, hasLength(1));
      final m = metrics.single;
      expect(m.sessionId, 's4');
      expect(m.modelId, 'deepseek-v4.1-flash');
      expect(m.lightChat, isTrue);
      expect(m.sendToRequestMs, 90);
      expect(m.requestToFirstMs, 710);
      expect(m.firstTokenMs, 800);
      expect(m.gotFirstToken, isTrue);
    });

    test('没出字的一轮也上报, firstTokenMs=-1', () {
      final metrics = <ChatTurnMetric>[];
      final now = DateTime(2026, 10, 18, 10, 0, 0);
      final timing = ChatTurnTiming(
        sessionId: 's5',
        sendAt: now,
        now: () => now,
        writeLog: (_) {},
        onMetric: metrics.add,
      );

      timing.markRequestSent();
      timing.logIfUnfinished();

      expect(metrics, hasLength(1));
      expect(metrics.single.gotFirstToken, isFalse);
      expect(metrics.single.firstTokenMs, -1);
    });
  });
}
