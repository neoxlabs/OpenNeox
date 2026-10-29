/// history_load_test.dart — 「历史会话加载」那一类 bug 的闸.
///
/// 2026-09-18 用户: 「历史会话 无法传输加载 目前要支持的 这个不简单 要高性能」。
///
/// 四条真因, 每条一道闸:
///   1. 失败和"空"是同一个值 0 → 一次超时被读成"没更多了", 界面写「还没有消息」;
///   2. `fetchSessionHistory` 里一道读出来没用过的 paired 守卫, 会静默杀掉每一页;
///   3. `loadOlderHistory` 判 `localMin <= 1`, 而 seq 从 0 起算 → 第一条消息永远翻不出来;
///   4. 翻页拿到 0 就 `_noMoreOlder = true` 永久关掉, 失败也算。
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/history_load_status.dart';
import 'package:neox_app/core/network/ws_client_provider.dart';

/// 读源码, **剥掉注释**再比.
///
/// 不剥的话这道闸会被自己打中: 修这几处时我把旧写法原样抄进注释里解释"为什么
/// 不能这么写", 于是闸在注释里搜到了那段话就报红 (同一个坑记在
/// memory「闸必须排掉自己的源码」)。
String _read(String p) {
  final out = <String>[];
  var inBlock = false;
  for (final line in File(p).readAsLinesSync()) {
    final t = line.trimLeft();
    if (inBlock) {
      if (t.contains('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!line.contains('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.add(line);
  }
  return out.join('\n');
}

void main() {
  group('HistoryPage: 失败 ≠ 空', () {
    test('失败的一页不是"到头了"', () {
      const p = HistoryPage.failed();
      expect(p.failed, isTrue);
      expect(p.written, 0);
      /* 这一条就是整类 bug 的核心: 失败绝不能被读成"没有更早的了" */
      expect(p.reachedEnd, isFalse);
    });

    test('拿到了但是空的 = 真的到头了', () {
      const p = HistoryPage(written: 0, minSeqSeen: 0);
      expect(p.failed, isFalse);
      expect(p.reachedEnd, isTrue);
    });

    test('拿到内容 = 还能继续往回翻', () {
      const p = HistoryPage(written: 42, minSeqSeen: 7);
      expect(p.failed, isFalse);
      expect(p.reachedEnd, isFalse);
    });
  });

  group('HistoryLoadStatus', () {
    test('idle/ok 不是失败, failed/otherDesktop 是', () {
      expect(HistoryLoadStatus.idle.isFailure, isFalse);
      expect(
        const HistoryLoadStatus(phase: HistoryLoadPhase.ok).isFailure,
        isFalse,
      );
      expect(
        const HistoryLoadStatus(phase: HistoryLoadPhase.failed).isFailure,
        isTrue,
      );
      expect(
        const HistoryLoadStatus(
          phase: HistoryLoadPhase.otherDesktop,
        ).isFailure,
        isTrue,
      );
    });
  });

  group('不许长回来的三处写法', () {
    test('fetchSessionHistory 里不许再有 paired 前置守卫', () {
      final src = _read('lib/core/network/ws_client_provider.dart');
      /* 只看 fetchSessionHistory 这一段 —— 别处的 paired 判空是正当的
       * (发消息、配对握手都真的要那行数据)。整文件搜等于误报。 */
      final from = src.indexOf('Future<HistoryPage> fetchSessionHistory');
      expect(from, greaterThan(0), reason: '函数改名了? 闸要跟着改');
      final to = src.indexOf('fetchSubagentHistory', from);
      final body = src.substring(from, to > from ? to : src.length);

      expect(
        body.contains('pairedDesktopsDao'),
        isFalse,
        reason: '拉历史能不能成由连接决定, 不由本地那张配对表决定',
      );
    });

    test('loadOlderHistory 判 seq 0, 不判 1', () {
      final src = _read('lib/core/network/ws_client_provider.dart');
      expect(
        src.contains('localMin <= 1'),
        isFalse,
        reason: 'seq 从 0 起算; 判 <= 1 会让会话第一条消息永远翻不出来',
      );
      expect(src.contains('localMin <= 0'), isTrue);
    });

    test('翻页只在真到头时关掉, 不看 written == 0', () {
      final src = _read(
        'lib/features/timeline/widgets/timeline_message_list.dart',
      );
      expect(
        src.contains('if (page.reachedEnd) _noMoreOlder = true'),
        isTrue,
        reason: '失败也返回 0 条; 按条数关翻页 = 一次超时就永久不再请求',
      );
      expect(src.contains('fetched == 0'), isFalse);
    });

    test('空态会区分"没拉到"和"没有"', () {
      final src = _read(
        'lib/features/timeline/widgets/timeline_message_list.dart',
      );
      expect(src.contains('HistoryLoadPhase.failed'), isTrue);
      expect(src.contains('HistoryLoadPhase.otherDesktop'), isTrue);
    });
  });
}
