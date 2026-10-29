/// pilot_specialist_starter_test.dart — 专员会话零消息时的开场 (2026-10-18).
///
/// 用户点进「财务管家」「家务管家」这类专员的窗口, 原来一句话没有就是一片白:
/// 不知道它是谁、能问它什么。现在给它一句自我介绍 + 三条它管得着的示例。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/features/pilot/pilot_chat_page.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/features/pilot/pilot_specialist_starter.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat'});

PilotSpecialist _spec({
  String id = 'finance',
  String name = '财务管家',
  String duty = '花销、收入、资产、订阅，每月出月报',
}) =>
    PilotSpecialist.fromJson({'id': id, 'name': name, 'duty': duty, 'clay': 'i-coins'});

Future<void> _pump(WidgetTester t, PilotThread thread, {FakePilotCloud? cloud}) async {
  phoneViewport(t);
  final prefs = await testPrefs(aiConsentGiven);
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        pilotCloudProvider.overrideWithValue(cloud ?? FakePilotCloud()),
        pilotTeamProvider.overrideWith((ref) async => const <PilotSpecialist>[]),
      ],
      child: MaterialApp(home: PilotChatPage(thread: thread)),
    ),
  );
  await t.pump();
  await t.pump(const Duration(milliseconds: 50));
  await t.pump(const Duration(milliseconds: 50));
}

void main() {
  test('每个专员都有 3 条示例, 认不出的专员也给 3 条', () {
    for (final id in ['health', 'finance', 'home', 'social', 'work', 'travel', 'brand-new-one']) {
      final ex = specialistStarterExamples(_spec(id: id));
      expect(ex.length, 3, reason: id);
      expect(ex.toSet().length, 3, reason: '$id 的三条不能重复');
      for (final e in ex) {
        expect(e.trim(), isNotEmpty, reason: id);
      }
    }
  });

  test('自我介绍用专员已有的描述 (duty); 没写就只报名字', () {
    expect(specialistIntro(_spec()), '我是财务管家，管花销、收入、资产、订阅，每月出月报。');
    expect(specialistIntro(_spec(name: '出行向导', duty: '')), '我是出行向导。');
  });

  testWidgets('专员零消息: 有开场 (自我介绍 + 3 条示例), 不再是一片空白', (t) async {
    final spec = _spec();
    await _pump(t, PilotThread.specialist(_pilot, spec));

    expect(find.text(specialistIntro(spec)), findsOneWidget);
    for (final e in specialistStarterExamples(spec)) {
      expect(find.text(e), findsOneWidget, reason: e);
    }

    /* 专员窗口不摆通用能力 + 拍小票: 那是主管的事 */
    expect(find.text('拍张小票，帮我记一笔'), findsNothing);
    expect(find.text('看全部能力 ›'), findsNothing);
  });

  testWidgets('点一条示例: 只填进输入框, 不直接发', (t) async {
    final spec = _spec();
    final cloud = FakePilotCloud();
    await _pump(t, PilotThread.specialist(_pilot, spec), cloud: cloud);

    final first = specialistStarterExamples(spec).first;
    await t.tap(find.text(first));
    await t.pump();

    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, first);
    expect(cloud.sent, isEmpty, reason: '点了只是预填, 不自动发出去');
  });
}
