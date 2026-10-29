import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/execution/run_target.dart';
import 'package:neox_app/features/home/state/home_mode_provider.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:shared_preferences/shared_preferences.dart';

Future<HomeMode> _decoded(Map<String, Object> prefs) async {
  SharedPreferences.setMockInitialValues(prefs);
  final sp = await SharedPreferences.getInstance();
  final c = ProviderContainer(
    overrides: [sharedPreferencesProvider.overrideWithValue(sp)],
  );
  addTearDown(c.dispose);
  return c.read(homeModeProvider);
}

void main() {
  test('新装默认对话; 存过的沿用; 存量 life 归工作', () async {
    expect(await _decoded({}), HomeMode.chat);
    expect(await _decoded({'neox_home_mode': 'code'}), HomeMode.code);
    expect(await _decoded({'neox_home_mode': 'work'}), HomeMode.work);
    expect(await _decoded({'neox_home_mode': 'life'}), HomeMode.work);
  });

  test('只有对话不要电脑', () {
    expect(HomeMode.chat.needsDesktop, isFalse);
    expect(HomeMode.work.needsDesktop, isTrue);
    expect(HomeMode.code.needsDesktop, isTrue);
  });

  test('会话归属: 手机本地的工作归工作 (2026-10-11 工作能选本机), 其余手机本地算对话, 电脑 / 云端看 wire 值', () {
    expect(
      homeModeOfSession(agentMode: 'work', desktopDeviceId: kPhoneLocalDeviceId),
      HomeMode.work,
    );
    expect(
      homeModeOfSession(agentMode: null, desktopDeviceId: kPhoneLocalDeviceId),
      HomeMode.chat,
    );
    expect(
      homeModeOfSession(agentMode: 'chat', desktopDeviceId: kPhoneLocalDeviceId),
      HomeMode.chat,
    );
    expect(
      homeModeOfSession(agentMode: 'code', desktopDeviceId: 'mac-1'),
      HomeMode.code,
    );
    expect(
      homeModeOfSession(agentMode: 'assistant', desktopDeviceId: 'mac-1'),
      HomeMode.work,
    );
    expect(homeModeOfSession(agentMode: null, desktopDeviceId: 'mac-1'), isNull);
  });
}
