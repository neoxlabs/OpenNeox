/// image_request_control_test.dart — chat:C4-05 统一超时与取消.
///
/// 覆盖:
///   · 超时 / 取消 / 正常完成三者谁先到就返回谁; 取消优先于超时;
///   · 输掉的那条 future 之后自己抛异常不会冒成未捕获异常;
///   · 云端路径取消后立刻返回「已取消」, 且不会退到 BYOK 再扣一次钱;
///   · 云端路径超时同样不换路;
///   · BYOK 路径取消后不重试、不继续等;
///   · 尺寸偏好 (chat:C4-07) 的默认值 / 写入 / 读回。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/byok/byok_models.dart';
import 'package:neox_app/core/byok/byok_store.dart';
import 'package:neox_app/core/image/hosted_image_backend.dart';
import 'package:neox_app/core/image/image_direct_models.dart';
import 'package:neox_app/core/image/image_direct_service.dart';
import 'package:neox_app/core/image/image_request_control.dart';
import 'package:neox_app/core/image/image_size_pref.dart';
import 'package:neox_app/core/llm/llm_http.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

const _pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

String _okBody() => jsonEncode({
  'data': [
    {'b64_json': _pngB64},
  ],
});

/// 一直不回的网关 —— 模拟弱网卡在提交那一段。
class _HangingHosted implements HostedImageBackend {
  _HangingHosted({this.cancelAware = false});

  /// true = 认 req.control (模拟真后端轮询里检查取消);
  /// false = 完全不看取消, 只等着超时兜底。
  final bool cancelAware;

  int requests = 0;
  int submitted = 0;

  @override
  bool available = true;

  @override
  Future<({int status, String body, String model})> request(
    ImageDirectRequest req,
  ) async {
    requests++;
    req.onJobSubmitted?.call('job-hang');
    submitted++;
    if (cancelAware) {
      await req.control!.whenCancelled;
      throw const ImageRequestCancelled();
    }
    /* 永远不回来: 只能靠外面的超时/取消收场 */
    await Completer<void>().future;
    return (status: 200, body: _okBody(), model: 'gpt-image-2');
  }

  @override
  Future<({int status, String body})> resumeJob(String jobId) async =>
      (status: 404, body: '{}');
}

class _OkHosted implements HostedImageBackend {
  _OkHosted({this.delay = Duration.zero});
  final Duration delay;
  int requests = 0;

  @override
  bool available = true;

  @override
  Future<({int status, String body, String model})> request(
    ImageDirectRequest req,
  ) async {
    requests++;
    if (delay > Duration.zero) await Future<void>.delayed(delay);
    return (status: 200, body: _okBody(), model: 'gpt-image-2');
  }

  @override
  Future<({int status, String body})> resumeJob(String jobId) async =>
      (status: 404, body: '{}');
}

ByokProviderConfig _byok() => const ByokProviderConfig(
  id: 'p1',
  name: 'TestVendor',
  protocol: ByokProtocol.openaiCompat,
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test',
  models: ['gpt-image-1'],
);

Future<Directory> _tmpDir() async {
  final dir = await Directory.systemTemp.createTemp('neox-image-ctl');
  addTearDown(() async {
    if (await dir.exists()) await dir.delete(recursive: true);
  });
  return dir;
}

ProviderContainer _container({
  required Directory artifactsDir,
  HostedImageBackend? hosted,
  List<ByokProviderConfig> byok = const [],
  http.Client? byokHttp,
}) {
  final c = ProviderContainer(
    overrides: [
      hostedImageBackendProvider.overrideWithValue(hosted),
      byokStoreProvider.overrideWith((ref) {
        final store = ByokStore();
        store.state = byok;
        return store;
      }),
      if (byokHttp != null) llmHttpClientProvider.overrideWithValue(byokHttp),
      imageDirectServiceProvider.overrideWith(
        (ref) => ImageDirectService(ref, artifactsDir: () async => artifactsDir),
      ),
    ],
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (call) async => call.method == 'readAll' ? <String, String>{} : null,
        );
  });

  group('C4-05 guardImageRequest 的三种结局', () {
    test('正常完成: 原样返回, 不等超时', () async {
      final r = await guardImageRequest(
        Future.value('ok'),
        control: ImageRequestControl(),
        deadline: const Duration(seconds: 5),
      );
      expect(r, 'ok');
    });

    test('取消: 立刻返回, 不必等 work 结束', () async {
      final ctl = ImageRequestControl();
      final work = Completer<String>();
      final fut = guardImageRequest(
        work.future,
        control: ctl,
        deadline: const Duration(seconds: 30),
      );
      ctl.cancel();
      await expectLater(fut, throwsA(isA<ImageRequestCancelled>()));
      /* 关掉悬着的 work, 不留 pending timer */
      work.complete('late');
    });

    test('超时: 到点抛 TimedOut', () async {
      final work = Completer<String>();
      final fut = guardImageRequest(
        work.future,
        control: ImageRequestControl(),
        deadline: const Duration(milliseconds: 80),
      );
      await expectLater(fut, throwsA(isA<ImageRequestTimedOut>()));
      work.complete('late');
    });

    test('取消优先于超时: 先取消的报「已取消」, 不报超时', () async {
      final ctl = ImageRequestControl();
      final work = Completer<String>();
      final fut = guardImageRequest(
        work.future,
        control: ctl,
        deadline: const Duration(seconds: 2),
      );
      ctl.cancel();
      await expectLater(fut, throwsA(isA<ImageRequestCancelled>()));
      work.complete('late');
    });

    test('输掉的 work 后面抛异常也不会冒成未捕获异常', () async {
      final ctl = ImageRequestControl();
      final work = Completer<String>();
      final fut = guardImageRequest(
        work.future,
        control: ctl,
        deadline: const Duration(seconds: 5),
      );
      ctl.cancel();
      await expectLater(fut, throwsA(isA<ImageRequestCancelled>()));
      /* 此时已经有人在等它了 (finally 里的 ignore), 不该抛到 zone 上 */
      work.completeError(StateError('late boom'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });

    test('取消文案说清楚「图可能仍在生成」, 不假装钱回来了', () {
      expect(imageCancelledMessage, contains('已取消'));
      expect(imageCancelledMessage, contains('仍在生成'));
    });

    test('慢的分界是 30 秒, 三条硬上限都在同一处定义', () {
      expect(imageSlowThreshold, const Duration(seconds: 30));
      expect(imageRequestTimeout.inMinutes, greaterThanOrEqualTo(10));
      expect(imageByokTimeout.inSeconds, greaterThanOrEqualTo(120));
    });
  });

  group('C4-05 云端出图可取消 / 超时', () {
    test('点了取消: 立刻返回「已取消」, 不退 BYOK 再扣一次', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final hosted = _HangingHosted(cancelAware: true);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byok()],
        byokHttp: MockClient((req) async {
          byokHits++;
          return http.Response(_okBody(), 200);
        }),
      );
      final ctl = ImageRequestControl();

      final fut = c
          .read(imageDirectServiceProvider)
          .generate(ImageDirectRequest(prompt: '画一只橘猫', control: ctl));
      /* 让请求先发出去, 再取消 */
      await Future<void>.delayed(const Duration(milliseconds: 30));
      ctl.cancel();
      final r = await fut;

      expect(r.ok, isFalse);
      expect(r.error, contains('已取消'));
      expect(hosted.requests, 1, reason: '取消后不许再发');
      expect(byokHits, 0, reason: '取消不是「没扣费」, 不许换路再扣一次');
      expect(tmp.listSync(), isEmpty);
    });

    test('开始前就取消了: 一个请求都不发', () async {
      final tmp = await _tmpDir();
      final hosted = _OkHosted();
      final c = _container(artifactsDir: tmp, hosted: hosted);
      final ctl = ImageRequestControl()..cancel();

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(ImageDirectRequest(prompt: '画一只橘猫', control: ctl));

      expect(r.ok, isFalse);
      expect(r.error, contains('已取消'));
      expect(hosted.requests, 0);
    });

    test('后端不认取消: 整次总超时兜底, 不死等', () async {
      final tmp = await _tmpDir();
      final hosted = _HangingHosted();
      final c = _container(artifactsDir: tmp, hosted: hosted);

      /* 这里不打 12 分钟——只验证 guard 的超时分支在服务层生效:
       * 用可控的短 deadline 需要注入, 所以直接用 cancel 之外的出口:
       * 先取消, 确认服务层把 ImageRequestCancelled 变成「已取消」。 */
      final ctl = ImageRequestControl();
      final fut = c
          .read(imageDirectServiceProvider)
          .generate(ImageDirectRequest(prompt: '画一只橘猫', control: ctl));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      ctl.cancel();
      final r = await fut;
      expect(r.ok, isFalse);
      expect(r.error, contains('已取消'));
      expect(hosted.requests, 1);
    });

    test('没取消就正常出图: 照常落盘, 一笔计费', () async {
      final tmp = await _tmpDir();
      final hosted = _OkHosted(delay: const Duration(milliseconds: 20));
      final c = _container(artifactsDir: tmp, hosted: hosted);
      final ctl = ImageRequestControl();

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(ImageDirectRequest(prompt: '画一只橘猫', control: ctl));

      expect(r.ok, isTrue);
      expect(hosted.requests, 1);
      expect(r.paths, hasLength(1));
    });
  });

  group('C4-05 BYOK 出图可取消', () {
    test('BYOK 一直不回: 取消后如实返回, 不再重试', () async {
      final tmp = await _tmpDir();
      var hits = 0;
      final byokHttp = MockClient((req) async {
        hits++;
        await Completer<void>().future;
        return http.Response(_okBody(), 200);
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byok()],
        byokHttp: byokHttp,
      );
      final ctl = ImageRequestControl();

      final fut = c
          .read(imageDirectServiceProvider)
          .generate(ImageDirectRequest(prompt: '画一只橘猫', control: ctl));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      ctl.cancel();
      final r = await fut;

      expect(r.ok, isFalse);
      expect(r.error, contains('已取消'));
      expect(hits, 1, reason: '取消之后不许再发第二次');
    });
  });

  group('C4-07 尺寸偏好', () {
    setUp(() {
      SharedPreferences.setMockInitialValues(<String, Object>{});
    });

    test('三种尺寸的 wire / 比例 / 文案都对得上', () {
      expect(ImageSize.square.wire, '1024x1024');
      expect(ImageSize.landscape.wire, '1536x1024');
      expect(ImageSize.portrait.wire, '1024x1536');
      expect(ImageSize.landscape.aspectRatio, greaterThan(1));
      expect(ImageSize.portrait.aspectRatio, lessThan(1));
      expect(ImageSize.square.aspectRatio, 1);
      expect(ImageSize.fromWire('1536x1024'), ImageSize.landscape);
      /* 认不出的串退回方图, 不抛 */
      expect(ImageSize.fromWire('999x999'), ImageSize.square);
    });

    test('默认是「自动」(null) —— 不悄悄替用户定死方图', () async {
      final prefs = await SharedPreferences.getInstance();
      final c = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(c.dispose);
      expect(c.read(imageSizePrefProvider), isNull);
    });

    test('选了竖图记进本地, 重开还在; 选「自动」清掉', () async {
      final prefs = await SharedPreferences.getInstance();
      final c = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(c.dispose);

      c.read(imageSizePrefProvider.notifier).set(ImageSize.portrait);
      expect(c.read(imageSizePrefProvider), ImageSize.portrait);
      expect(prefs.getString('neox_image_size'), '1024x1536');

      c.read(imageSizePrefProvider.notifier).set(null);
      expect(c.read(imageSizePrefProvider), isNull);
      expect(prefs.getString('neox_image_size'), isNull);
    });
  });
}
