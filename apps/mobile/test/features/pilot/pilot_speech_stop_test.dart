/// pilot_speech_stop_test.dart — 点停立刻静音 (pilot:U-20).
///
/// 验收: 点停后 200ms 内静音。真正的静音靠原生 stop; 这里盯的是「停了之后又被念回来」:
///   合成中点的停   → 合成回来不再 play
///   排队下一句     → 停后不再出声
///   新一轮         → 照常出声, 停不能把后面的会话一起哑掉
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_cloud.dart';
import 'package:neox_app/core/voice/pilot_voice.dart';
import 'package:neox_app/features/pilot/pilot_chat_view.dart';
import 'package:neox_app/features/pilot/pilot_im.dart';
import 'package:neox_app/features/pilot/pilot_link.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

import '../../support/fake_pilot_cloud.dart';
import '../../support/mobile_test_support.dart';

const _channel = MethodChannel('neox.pilot/voice');

/// 假的合成: 立即返回, 或者卡在 [hold] 上让你有机会点停 (合成本身不走测试)
class _FakeVoice extends PilotVoice {
  _FakeVoice(super.ref);

  final List<String> texts = [];
  Completer<void>? hold;

  @override
  Future<({Uint8List audio, String format})> synth(String text) async {
    texts.add(text);
    final h = hold;
    if (h != null) await h.future;
    return (audio: Uint8List.fromList(const [1, 2, 3]), format: 'mp3');
  }
}

late ProviderContainer _container;
late _FakeVoice _voice;
late PilotLink _link;
late List<String> _calls;
Completer<bool>? _playGate;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    _calls = [];
    _playGate = null;
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(_channel, (call) async {
      _calls.add(call.method);
      if (call.method == 'play') {
        final gate = _playGate;
        if (gate != null) return gate.future;
        return true;
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(_channel, null));

    _container = ProviderContainer(overrides: [
      pilotVoiceProvider.overrideWith((ref) => _voice = _FakeVoice(ref)),
    ]);
    addTearDown(_container.dispose);
    _container.read(pilotVoiceProvider); /* 建出假合成器 (override 回调里赋值) */
    _link = _container.read(pilotLinkProvider);
  });

  test('合成期间点停: 合成回来也不出声', () async {
    _voice.hold = Completer<void>();
    final speaking = _link.speak('第一句。');

    await pumpEventQueue();
    expect(_voice.texts, ['第一句。'], reason: '先开始合成, 还没到播放');

    await _link.stopSpeaking();
    expect(_calls, contains('stop'), reason: '点停要当场停原生播放器');

    _voice.hold!.complete();
    expect(await speaking, isNull);
    expect(_calls, isNot(contains('play')), reason: '合成回来时已经停过了, 不能再开口');
  });

  test('点停后排着的下一句不再出声', () async {
    final say = _link.narration();
    await _link.stopSpeaking();

    expect(say.stopped, isTrue);
    expect(await say.say('第二句。'), isNull);
    expect(_voice.texts, isEmpty, reason: '作废的一轮连合成都不要做');
    expect(_calls, isNot(contains('play')));
  });

  test('停完开新一轮照常出声 (停不能把后面的会话一起哑掉)', () async {
    await _link.stopSpeaking();
    final again = _link.narration();

    expect(again.stopped, isFalse);
    expect(await again.say('新的一句。'), isNull);
    expect(_voice.texts, ['新的一句。']);
    expect(_calls.where((m) => m == 'play'), hasLength(1));
  });

  test('播到一半点停: 原生收到 stop, 也不当成「声音坏了」', () async {
    _playGate = Completer<bool>();
    final say = _link.narration();
    final speaking = say.say('一句长话。');

    await pumpEventQueue();
    expect(_calls, contains('play'));

    /* 点停 → 原生播放器被停, play 那个调用以 false 回来 (这是「被打断」, 不是故障) */
    await _link.stopSpeaking();
    expect(_calls, contains('stop'));
    _playGate!.complete(false);

    expect(await speaking, isNull);
    expect(say.stopped, isTrue);
  });

  testWidgets('聊天页点停: 原生通道当场收到 stop (声音和画面一起停)', (t) async {
    final live = StreamController<PilotLive>();
    addTearDown(live.close);
    final cloud = FakePilotCloud(liveController: live, handleInterrupt: true);
    final prefs = await testPrefs(aiConsentGiven);
    phoneViewport(t);
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          pilotCloudProvider.overrideWithValue(cloud),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SafeArea(
              child: PilotChatView(thread: PilotThread.direct(PilotContact.fromJson(const {
                'session_id': 's-pilot',
                'name': '小航',
                'avatar': 'cat',
                'persona': '你的生活助理',
              }))),
            ),
          ),
        ),
      ),
    );
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
    await t.pump(const Duration(milliseconds: 50));

    /* 它正在说: 停止键才出现 */
    cloud.emit('delta', text: '我正在念这一段');
    await t.pump();
    await t.pump();

    await t.tap(find.byTooltip(tr('让它停下')));
    await t.pump();

    expect(_calls, contains('stop'), reason: '点停要立刻让原生播放器静音');
  });

  test('点停当场作废这一轮并发出 stop, 不等合成 (200ms 预算)', () async {
    _voice.hold = Completer<void>();
    final say = _link.narration();
    unawaited(say.say('还在合成的一句。'));
    await pumpEventQueue();

    final sw = Stopwatch()..start();
    final stopping = _link.stopSpeaking();
    /* 关键: 不等任何网络 / 合成, 这一轮当场作废 */
    expect(say.stopped, isTrue);
    await stopping;
    sw.stop();

    expect(_calls, contains('stop'));
    expect(sw.elapsedMilliseconds, lessThan(200), reason: '停原生播放器只走一次平台通道');
    _voice.hold!.complete();
  });
}
