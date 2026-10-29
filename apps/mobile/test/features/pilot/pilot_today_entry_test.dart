/// pilot_today_entry_test.dart — 今天页入口 (pilot:U-04).
///
/// 验收: 通知与导航都能打开今天页。路由 /pilot/today 曾指回会话列表, 这里钉住。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/pilot/pilot_records.dart';
import 'package:neox_app/core/router.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_inbox_page.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/features/pilot/pilot_today_page.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

final _pilot = PilotContact.fromJson({'session_id': 's-pilot', 'name': '小航', 'avatar': 'cat'});

class _Records implements PilotRecordsApi {
  @override
  int get pendingCount => 0;
  @override
  Future<List<PilotSpecialist>> team() async => const [];
  @override
  Future<PilotToday> today() async => const PilotToday(overview: PilotOverview(insights: [], rooms: {}));
  @override
  Future<PilotOverview> overview() async => const PilotOverview(insights: [], rooms: {});
  @override
  Future<List<PilotInsight>> insights() async => const [];
  @override
  Future<List<PilotRecord>> day(DateTime day) async => const [];
  @override
  Future<void> log(List<Map<String, Object?>> records) async {}
  @override
  Future<void> delete(String id) async {}
  @override
  Future<List<PilotMetricPoint>> metric(String metric, {required DateTime from, required DateTime to}) async => const [];
  @override
  Future<String> profile() async => '';
  @override
  Future<List<PilotRecord>> query({List<String>? types, String? q, DateTime? from, DateTime? to, int limit = 20}) async => const [];
}

class _Cloud extends FakePilotCloud {
  @override
  PilotRecordsApi get records => _Records();
}

void main() {
  test('「今天」路由只能打开今天页', () {
    expect(buildPilotTodayRoute(), isA<PilotTodayPage>());
  });

  testWidgets('会话列表顶栏「今天」能打开今天页 (推送走的也是这一页)', (t) async {
    phoneViewport(t);
    final prefs = await testPrefs(aiConsentGiven);
    final db = newTestDb();
    addTearDown(db.close);
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          appDatabaseProvider.overrideWithValue(db),
          pilotCloudProvider.overrideWithValue(_Cloud()),
          pilotTeamProvider.overrideWith((ref) async => const <PilotSpecialist>[]),
          pilotPreviewProvider(_pilot.sessionId).overrideWith((ref) async => const PilotPreview()),
        ],
        child: MaterialApp(home: PilotInboxPage(pilots: [_pilot])),
      ),
    );
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    await t.tap(find.byTooltip(tr('今天')));
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));

    expect(find.byType(PilotTodayPage), findsOneWidget);
    expect(find.text(tr('它替你办完的')), findsOneWidget);
  });
}
