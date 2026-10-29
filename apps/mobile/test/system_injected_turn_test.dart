/// system_injected_turn_test.dart — 系统注入 turn 的识别与解析.
///
/// 真机 bug (2026-07-28): 手机把 `<agent-completion>` 整段当 user 气泡渲染, 露出
/// `</summary></agent-completion>` 内部标签, 还把子 agent 的完整报告灌进主 timeline;
/// 桌面同一会话没有这一段 (它有 aggregateTurnChanges + systemMessageParsers 两道过滤)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/models/system_injected_turn.dart';

void main() {
  group('识别', () {
    test('三类系统注入都认得', () {
      expect(isSystemInjectedTurn('<agent-completion><x/></agent-completion>'), isTrue);
      expect(isSystemInjectedTurn('<scheduled-wakeup></scheduled-wakeup>'), isTrue);
      expect(
        isSystemInjectedTurn('<background-task-notification></background-task-notification>'),
        isTrue,
      );
    });

    test('前导空白不影响判定', () {
      expect(isSystemInjectedTurn('\n  <agent-completion></agent-completion>'), isTrue);
    });

    test('用户真消息不误判', () {
      expect(isSystemInjectedTurn('帮我看看 <div> 这个标签'), isFalse);
      expect(isSystemInjectedTurn('普通问题'), isFalse);
      /* 只认行首, 不能因为正文里提到就吞掉用户的话 */
      expect(isSystemInjectedTurn('这段 <agent-completion> 是什么意思?'), isFalse);
    });
  });

  group('解析 agent-completion', () {
    const raw = '''
<agent-completion>
<agent-id>agent-3</agent-id>
<name>分析 scripts 结构</name>
<status>completed</status>
<elapsed-seconds>27</elapsed-seconds>
<tool-use-count>5</tool-use-count>
<summary># 报告

内容 &amp; 更多</summary>
</agent-completion>''';

    test('字段全解出来', () {
      final t = parseSystemInjectedTurn(raw)!;
      expect(t.kind, SystemTurnKind.agentCompletion);
      expect(t.agentId, 'agent-3');
      expect(t.name, '分析 scripts 结构');
      expect(t.status, 'completed');
      expect(t.elapsedSeconds, 27);
      expect(t.toolUseCount, 5);
      expect(t.summary, contains('# 报告'));
      expect(t.isFailed, isFalse);
    });

    test('XML 实体被还原', () {
      expect(parseSystemInjectedTurn(raw)!.summary, contains('内容 & 更多'));
    });

    test('残余正文为空 (整条就是 XML)', () {
      expect(parseSystemInjectedTurn(raw)!.residual, isEmpty);
    });

    test('failed 状态识别', () {
      final t = parseSystemInjectedTurn(
        '<agent-completion><status>failed</status></agent-completion>',
      )!;
      expect(t.isFailed, isTrue);
    });

    test('缺 status 按 completed', () {
      final t = parseSystemInjectedTurn(
        '<agent-completion><agent-id>a</agent-id></agent-completion>',
      )!;
      expect(t.isFailed, isFalse);
    });

    test('缺字段不抛', () {
      expect(
        () => parseSystemInjectedTurn('<agent-completion></agent-completion>'),
        returnsNormally,
      );
    });
  });

  group('其余两类', () {
    test('scheduled-wakeup', () {
      final t = parseSystemInjectedTurn(
        '<scheduled-wakeup><reason>检查 CI</reason><elapsed-seconds>600</elapsed-seconds></scheduled-wakeup>',
      )!;
      expect(t.kind, SystemTurnKind.scheduledWakeup);
      expect(t.name, '检查 CI');
      expect(t.elapsedSeconds, 600);
    });

    test('background-task-notification', () {
      final t = parseSystemInjectedTurn(
        '<background-task-notification><name>构建</name><summary>done</summary></background-task-notification>',
      )!;
      expect(t.kind, SystemTurnKind.backgroundTask);
      expect(t.name, '构建');
      expect(t.summary, 'done');
    });
  });

  group('边界', () {
    test('非系统消息返回 null', () {
      expect(parseSystemInjectedTurn('你好'), isNull);
    });

    test('XML 之外用户真写的内容不能吞', () {
      final t = parseSystemInjectedTurn(
        '<agent-completion><agent-id>a</agent-id></agent-completion>\n顺便帮我看下这个',
      )!;
      expect(t.residual, '顺便帮我看下这个');
    });
  });
}
