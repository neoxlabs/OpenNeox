import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/notifications/notify_prefs.dart';
import 'package:neox_app/features/settings/notify_settings_page.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> attach(Map<String, Object> values) async {
    SharedPreferences.setMockInitialValues(values);
    NotifyPrefs.attach(await SharedPreferences.getInstance());
  }

  test('安静时段统一 22:30–07:30, 默认开 (pilot:P-03)', () async {
    await attach({});
    expect(NotifyPrefs.quietStart, '22:30');
    expect(NotifyPrefs.quietEnd, '07:30');
    expect(NotifyPrefs.quiet, isTrue);
  });

  test('边界: 22:29 弹, 22:30 起不弹, 07:29 仍静音, 07:30 恢复', () async {
    await attach({});
    bool quietAt(int h, int m) => NotifyPrefs.inQuietHoursAt(DateTime(2026, 10, 18, h, m));
    expect(quietAt(22, 29), isFalse);
    expect(quietAt(22, 30), isTrue);
    expect(quietAt(0, 0), isTrue);
    expect(quietAt(7, 29), isTrue);
    expect(quietAt(7, 30), isFalse);
    expect(quietAt(12, 0), isFalse);
  });

  test('连续 7 天逐分钟: 22:30–07:30 之外才放行', () async {
    await attach({});
    var nightMinutes = 0;
    var allowedAtNight = 0;
    for (var d = 0; d < 7; d++) {
      for (var m = 0; m < 1440; m++) {
        final t = DateTime(2026, 10, 18 + d, m ~/ 60, m % 60);
        final quiet = NotifyPrefs.inQuietHoursAt(t);
        final minutes = t.hour * 60 + t.minute;
        final inWindow = minutes >= 22 * 60 + 30 || minutes < 7 * 60 + 30;
        if (inWindow) {
          nightMinutes++;
          if (!quiet) allowedAtNight++;
        } else {
          expect(quiet, isFalse);
        }
      }
    }
    expect(nightMinutes, 7 * (90 + 450));
    expect(allowedAtNight, 0);
  });

  testWidgets('设置页显示统一时段, 开关默认开', (t) async {
    await attach({});
    await t.pumpWidget(const ProviderScope(child: MaterialApp(home: NotifySettingsPage())));
    expect(find.text('22:30 – 07:30'), findsOneWidget);
    expect(find.text('23:00 – 08:00'), findsNothing);
  });

  test('用户主动关掉安静时段后按他的来', () async {
    await attach({'notify_quiet': false});
    expect(NotifyPrefs.quiet, isFalse);
    await NotifyPrefs.setQuiet(true);
    expect(NotifyPrefs.quiet, isTrue);
  });
}
