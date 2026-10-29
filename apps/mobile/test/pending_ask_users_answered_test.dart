// 电脑终端里先答了 ask_user: 手机上那张卡要翻成「已答」并带上答案 (2026-10-18)。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/stream_buffer_provider.dart';
import 'package:neox_app/features/timeline/widgets/ask_user_card.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

PendingAskUser _ask(String requestId, String question) => PendingAskUser(
  requestId: requestId,
  questions: [
    PendingAskUserQuestion(
      question: question,
      options: const [PendingAskUserOption(label: '保留')],
      multiSelect: false,
    ),
  ],
);

void main() {
  test('终端先答: 卡片翻成已答, 答案和问题都留着', () {
    final ctrl = PendingAskUsersController();
    ctrl.add('s1', _ask('r1', '要不要保留兼容'));

    ctrl.answered('s1', 'r1', {'要不要保留兼容': '保留'});

    final item = ctrl.state['s1']!.single;
    expect(item.answered, isTrue);
    expect(item.answers, {'要不要保留兼容': '保留'});
    // 卡片不是撤掉: 问题文本还在, UI 才显示得出「已在电脑上回答」
    expect(item.questions.single.question, '要不要保留兼容');
  });

  test('只翻对应的那一条; 不存在的 requestId 无操作', () {
    final ctrl = PendingAskUsersController();
    ctrl.add('s1', _ask('r1', 'q1'));
    ctrl.add('s1', _ask('r2', 'q2'));

    ctrl.answered('s1', 'r2', {'q2': '保留'});
    expect(ctrl.state['s1']![0].answered, isFalse);
    expect(ctrl.state['s1']![1].answered, isTrue);

    ctrl.answered('s1', 'nope', {'q': 'x'});
    expect(ctrl.state['s1']!.length, 2);
    expect(ctrl.state['s1']![0].answers, isNull);
  });

  test('已经答过的不被覆盖; tool_done 收尾后整条 session 清空', () {
    final ctrl = PendingAskUsersController();
    ctrl.add('s1', _ask('r1', 'q1'));
    ctrl.answered('s1', 'r1', {'q1': '保留'});
    ctrl.answered('s1', 'r1', {'q1': '不保留'});
    expect(ctrl.state['s1']!.single.answers, {'q1': '保留'});

    ctrl.clearSession('s1');
    expect(ctrl.state.containsKey('s1'), isFalse);
  });

  testWidgets('已答的卡片渲染成「已在电脑上回答」且显示答案, 不能再点', (t) async {
    final answered = PendingAskUser(
      requestId: 'r1',
      questions: _ask('r1', '要不要保留兼容').questions,
      answers: const {'要不要保留兼容': '保留'},
    );

    await t.pumpWidget(
      ProviderScope(
        overrides: [
          sessionPendingAskUsersProvider('s1').overrideWithValue([answered]),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: const Scaffold(body: AskUserStack(sessionId: 's1')),
        ),
      ),
    );

    expect(find.textContaining('已在电脑上回答'), findsOneWidget);
    expect(find.textContaining('保留'), findsOneWidget);
    // 已答状态不该再露「在等你回答」, 也没有可点的追问入口
    expect(find.textContaining('在等你回答'), findsNothing);
    expect(find.byIcon(Icons.chevron_right_rounded), findsNothing);
  });
}
