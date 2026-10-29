/// image_direct_service_test.dart — 出图计费与连续出图稳定性.
///
/// 覆盖两条方案条目:
///   · chat:C4-02 云端出图失败不再自动换路重扣 —— 一次 generate 最多一笔计费:
///     受理前拒掉的 4xx 里只有 429 限流值得原路重试一次 (再失败才退 BYOK),
///     402 / 403 / 400 这类确定性错误不重试、直接走下一步;
///     5xx / 超时 / 202 任务失败不重试、不换路。
///   · chat:C4-06 连续出图 10 次无失败 —— 用 mock 网关连画 10 次 (同一个 prompt),
///     每次都要出图、都要落盘、互不覆盖。可重复跑, 不花真钱。
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

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:neox_app/core/byok/byok_models.dart';
import 'package:neox_app/core/byok/byok_store.dart';
import 'package:neox_app/core/image/hosted_image_backend.dart';
import 'package:neox_app/core/image/image_charge_policy.dart';
import 'package:neox_app/core/image/image_direct_models.dart';
import 'package:neox_app/core/image/image_direct_service.dart';
import 'package:neox_app/core/llm/llm_http.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart';
import 'package:neox_app/core/local_agent/tools/image_tool.dart';
import 'package:neox_app/features/home/state/selected_model_provider.dart'
    show availableModelsProvider;
import 'package:neox_app/features/image/state/image_model_pref.dart'
    show imageModelPrefProvider;
import 'package:neox_app/shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

/// 1×1 透明 PNG — 网关回包里 `data[].b64_json` 就是这个形状.
const _pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

String _okBody({int n = 1}) => jsonEncode({
      'data': [
        for (var i = 0; i < n; i++) {'b64_json': _pngB64},
      ],
    });

String _errBody(String message) => jsonEncode({
      'error': {'message': message},
    });

/// 假网关 —— 每一次 [request] 就是一次**提交**, 也就是网关账上的一笔.
///
/// 真实网关是 202 + 后台任务: 提交即扣费, 之后失败也不退。
class _FakeHosted implements HostedImageBackend {
  _FakeHosted({
    this.failTimes = 0,
    this.timeoutTimes = 0,
    List<int>? statuses,
    this.jobId,
  }) : statuses = statuses == null ? null : [...statuses];

  /// 前 N 次回 500 (上游挂了).
  int failTimes;

  /// 前 N 次直接抛 TimeoutException (弱网 / 断流).
  int timeoutTimes;

  /// 依次回这些状态码 (优先于 [failTimes]); 用尽后回 200.
  final List<int>? statuses;

  /// 非 null 时模拟 202 后台任务: 先交任务号 (= 已受理), 再回 [statuses] 里的状态.
  final String? jobId;

  /// 提交次数.
  int requests = 0;

  /// 真正出图成功 (200 + 图) 的笔数 = 确定扣费的笔数.
  int charged = 0;

  final List<String> prompts = [];

  @override
  bool available = true;

  int? _nextStatus() {
    final q = statuses;
    if (q == null || q.isEmpty) return null;
    return q.removeAt(0);
  }

  @override
  Future<({int status, String body, String model})> request(
    ImageDirectRequest req,
  ) async {
    requests++;
    prompts.add(req.prompt);
    if (timeoutTimes > 0) {
      timeoutTimes--;
      throw TimeoutException('gateway timeout');
    }
    if (jobId != null) {
      /* 202 + 后台任务: 提交即受理 (可能扣费), 之后任务失败按上游状态码回 */
      req.onJobSubmitted?.call(jobId!);
      final st = _nextStatus() ?? 200;
      if (st == 200) charged++;
      return (
        status: st,
        body: st == 200 ? _okBody(n: req.n) : _errBody('job failed: $st'),
        model: 'gpt-image-2',
      );
    }
    int st;
    final queued = _nextStatus();
    if (queued != null) {
      st = queued;
    } else if (failTimes > 0) {
      failTimes--;
      st = 500;
    } else {
      st = 200;
    }
    if (st == 200) charged++;
    return (
      status: st,
      body: st == 200
          ? _okBody(n: req.n)
          : _errBody('upstream image provider error: $st'),
      model: 'gpt-image-2',
    );
  }

  @override
  Future<({int status, String body})> resumeJob(String jobId) async =>
      (status: 404, body: '{}');
}

ByokProviderConfig _byokConfig() => const ByokProviderConfig(
      id: 'p1',
      name: 'TestVendor',
      protocol: ByokProtocol.openaiCompat,
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk-test',
      models: ['gpt-image-1'],
    );

/// Ref 供被测工具构造用 (GenerateImageTool 只 read, 不写).
final _refProvider = Provider<Ref>((ref) => ref);

Future<Directory> _tmpDir() async {
  final dir = await Directory.systemTemp.createTemp('neox-image-test');
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
  Duration retryDelay = Duration.zero,
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
        (ref) => ImageDirectService(
          ref,
          artifactsDir: () async => artifactsDir,
          retryDelay: retryDelay,
        ),
      ),
    ],
  );
  addTearDown(c.dispose);
  return c;
}

/// 桩掉 flutter_secure_storage 的平台通道, 回一个空库.
///
/// 测试进程里没有真插件, `ByokStore` 构造时会异步读安全存储 → 每次跑都往 stderr 打
/// 一行 `MissingPluginException`. 异常被 ByokStore._load 自己吞掉 (`read` 返回 null
/// 时也不改 state), 断言不受影响, 但日志会盖住真正的失败。
void _stubSecureStorage() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (call) async => call.method == 'readAll' ? <String, String>{} : null,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  _stubSecureStorage();

  group('C4-02 云端失败不换路重扣', () {
    test('云端 500: 只提交一次, 不再打 BYOK, 不出图也不落盘', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(failTimes: 1);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, isNotEmpty);
      expect(hosted.requests, 1,
          reason: '一次 generate 只允许提交一次 —— 网关账上最多一笔');
      expect(byokHits, 0, reason: '云端失败不许自动换 BYOK 再扣一次钱');
      expect(tmp.listSync(), isEmpty, reason: '失败不该落盘');
    });

    test('云端抛异常 (超时/断流): 同样只提交一次, 不换路', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(timeoutTimes: 1);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, isNotEmpty);
      expect(hosted.requests, 1);
      expect(byokHits, 0, reason: '异常也不许换路由');
    });

    test('云端成功: 一笔计费, 图落盘, 完全不碰 BYOK', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted();
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue);
      expect(r.mode, 'neoxcloud');
      expect(hosted.requests, 1);
      expect(byokHits, 0);
      expect(r.paths, hasLength(1));
      expect(File(r.paths.first).existsSync(), isTrue);
    });

    test('回归: 没有托管出图时 BYOK 仍然可用 (未登录 / 开源版)', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue);
      expect(r.mode, 'byok');
      expect(byokHits, 1);
    });

    test('回归: 没有托管出图也没有 Key → 明确提示, 不发任何请求', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final c = _container(
        artifactsDir: tmp,
        byokHttp: MockClient((req) async {
          byokHits++;
          return http.Response(_okBody(), 200);
        }),
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, isNotEmpty);
      expect(byokHits, 0);
    });
  });

  group('C4-06 连续出图 10 次无失败', () {
    test('服务层: mock 网关连画 10 次 (同一个 prompt), 10 张都在', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted();
      final c = _container(artifactsDir: tmp, hosted: hosted);

      final paths = <String>[];
      for (var i = 0; i < 10; i++) {
        final r = await c
            .read(imageDirectServiceProvider)
            .generate(const ImageDirectRequest(prompt: '画一只橘猫'));
        expect(r.ok, isTrue, reason: '第 ${i + 1} 次出图失败了: ${r.error}');
        paths.addAll(r.paths);
      }

      expect(hosted.requests, 10, reason: '10 次出图 = 10 笔, 一次不多');
      expect(paths, hasLength(10));
      expect(paths.toSet(), hasLength(10), reason: '同一毫秒的连画不许互相覆盖');
      for (final p in paths) {
        expect(File(p).existsSync(), isTrue);
        expect(File(p).lengthSync(), greaterThan(0));
      }
      expect(
        tmp.listSync().whereType<File>().length,
        10,
        reason: '落盘目录里就该有 10 个文件',
      );
    });

    test('工具层: 对话里连画 10 次, 每次都回执带图片行且图进工作区', () async {
      final tmp = await _tmpDir();
      final workspace = await Directory('${tmp.path}/ws').create(recursive: true);
      final hosted = _FakeHosted();

      SharedPreferences.setMockInitialValues(<String, Object>{});
      final prefs = await SharedPreferences.getInstance();

      final c = ProviderContainer(
        overrides: [
          hostedImageBackendProvider.overrideWithValue(hosted),
          sharedPreferencesProvider.overrideWithValue(prefs),
          availableModelsProvider.overrideWith(
            (ref) async => const [
              GatewayModel(id: 'gpt-image-2', name: 'gpt-image-2'),
            ],
          ),
          imageDirectServiceProvider.overrideWith(
            (ref) => ImageDirectService(ref, artifactsDir: () async => tmp),
          ),
        ],
      );
      addTearDown(c.dispose);
      expect(c.read(imageModelPrefProvider), isNull);

      final tool = GenerateImageTool(c.read(_refProvider), rootDir: workspace);
      for (var i = 0; i < 10; i++) {
        final res = await tool.run(
          const {'prompt': '画一只橘猫'},
          sdk.ToolContext(cancel: sdk.AgentCancelToken()),
        );
        expect(res.isError, isFalse, reason: '第 ${i + 1} 次画图失败: ${res.output}');
        final imageLines = res.output
            .split('\n')
            .where((l) => l.startsWith(GenerateImageTool.linePrefix))
            .toList();
        expect(imageLines, hasLength(1), reason: '回执里要有 1 行「图片: 」');
        final rel = imageLines.single
            .substring(GenerateImageTool.linePrefix.length)
            .trim();
        expect(File('${workspace.path}/$rel').existsSync(), isTrue);
      }

      expect(hosted.requests, 10);
      final images = Directory('${workspace.path}/images').listSync();
      expect(images, hasLength(10), reason: '工作区里应有 10 张图, 一张不少');
    });
  });

  group('C4-02 计费分级规则', () {
    test('4xx = 网关受理前拒掉, 肯定没扣费', () {
      for (final st in [400, 401, 402, 403, 404, 413, 415, 422, 429]) {
        expect(isDefinitelyNotCharged(st), isTrue, reason: '$st 应该算肯定没扣费');
      }
    });

    test('408 / 5xx / 2xx 结果未知, 不算肯定没扣费', () {
      for (final st in [408, 500, 502, 503, 504, 200, 202]) {
        expect(isDefinitelyNotCharged(st), isFalse,
            reason: '$st 可能已经受理扣费, 不许重试 / 换路');
      }
    });

    test('明确没扣费的重试间隔是 2 秒', () {
      expect(imageRetryDelay, const Duration(seconds: 2));
    });

    test('没扣费里只有 429 值得原路重试', () {
      expect(isWorthRetrying(429), isTrue,
          reason: '限流是临时性的, 隔 2 秒再试可能就过了');
    });

    test('确定性 4xx / 5xx / 408 都不值得重试', () {
      for (final st in [
        400, 401, 402, 403, 404, 408, 413, 415, 422, 500, 502, 503, 504,
      ]) {
        expect(isWorthRetrying(st), isFalse,
            reason: '$st 再试一次结果一样 (或可能已扣费), 不许重试');
      }
    });

    test('值得重试的状态码一定属于「肯定没扣费」', () {
      /* 两条规则叠加才有计费安全: 重试的前提是上一笔没扣钱 */
      for (final st in [
        400, 401, 402, 403, 404, 408, 413, 415, 422, 429, 500, 502, 503, 504,
      ]) {
        if (isWorthRetrying(st)) {
          expect(isDefinitelyNotCharged(st), isTrue,
              reason: '$st 能重试, 就必须先确定没扣费');
        }
      }
    });
  });

  group('C4-02 云端按状态码分级', () {
    /* 确定性 4xx: 再试一次结果一样 → 不重试, 直接退 BYOK (不白等 2 秒) */
    for (final st in [400, 401, 402, 403, 404, 413, 422]) {
      test('云端 $st (确定性): 不重试, 直接退 BYOK', () async {
        final tmp = await _tmpDir();
        var byokHits = 0;
        final byokHttp = MockClient((req) async {
          byokHits++;
          return http.Response(_okBody(), 200);
        });
        final hosted = _FakeHosted(statuses: [st, st]);
        final c = _container(
          artifactsDir: tmp,
          hosted: hosted,
          byok: [_byokConfig()],
          byokHttp: byokHttp,
        );

        final r = await c
            .read(imageDirectServiceProvider)
            .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

        expect(r.ok, isTrue, reason: 'BYOK 出图成了就是成');
        expect(r.mode, 'byok');
        expect(hosted.requests, 1, reason: '$st 是确定性错误, 再试一次结果一样');
        expect(hosted.charged, 0, reason: '云端这一笔是 4xx, 一分没扣');
        expect(byokHits, 1, reason: '换路出一张 = 总共只扣一笔');
        expect(File(r.paths.first).existsSync(), isTrue);
      });
    }

    test('云端 429 后重试成功: 只走云端, 不碰 BYOK', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(statuses: [429, 200]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue);
      expect(r.mode, 'neoxcloud');
      expect(hosted.requests, 2, reason: '429 是临时性限流, 值得原路再试一次');
      expect(hosted.charged, 1, reason: '成功的只有第二笔');
      expect(byokHits, 0, reason: '云端成了就不用换路');
    });

    test('云端 429 两次: 重试一次仍失败 → 退 BYOK (云端两笔都没扣费)', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(statuses: [429, 429]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue, reason: 'BYOK 出图成了就是成');
      expect(r.mode, 'byok');
      expect(hosted.requests, 2, reason: '限流只重试一次');
      expect(hosted.charged, 0, reason: '两次都是 429, 一分没扣');
      expect(byokHits, 1, reason: '换路出一张 = 总共只扣一笔');
      expect(File(r.paths.first).existsSync(), isTrue);
    });

    test('只重试一次: 两次 429 之后不再发第三次', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(statuses: [429, 429, 200]);
      final c = _container(artifactsDir: tmp, hosted: hosted);

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, isNotEmpty);
      expect(hosted.requests, 2, reason: '一次 generate 最多提交两次 (首发 + 一次重试)');
    });

    test('云端 403 且没有 BYOK: 如实报错, 不落盘', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(statuses: [403, 403]);
      final c = _container(artifactsDir: tmp, hosted: hosted);

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, contains('403'));
      expect(hosted.requests, 1, reason: '403 是确定性错误, 不重试');
      expect(tmp.listSync(), isEmpty);
    });

    test('云端 5xx: 不重试, 不换路 (可能已扣费)', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(statuses: [502, 200]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(hosted.requests, 1, reason: '5xx 不重试');
      expect(byokHits, 0, reason: '5xx 不换路');
    });

    test('云端 408 (请求超时): 结果未知, 不重试不换路', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(statuses: [408, 200]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(hosted.requests, 1);
      expect(byokHits, 0);
    });

    test('202 任务失败 (上游 402): 已受理, 不重试不换路', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(jobId: 'job-402', statuses: [402]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(hosted.requests, 1, reason: '任务已提交 (可能已扣费), 不许重试');
      expect(byokHits, 0, reason: '任务已提交就不许换路再扣一次');
    });

    test('202 任务失败 (上游 500) 且任务号照常交给调用方', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(jobId: 'job-500', statuses: [500]);
      final c = _container(artifactsDir: tmp, hosted: hosted);
      String? seen;

      final r = await c.read(imageDirectServiceProvider).generate(
            ImageDirectRequest(
              prompt: '画一只橘猫',
              onJobSubmitted: (id) => seen = id,
            ),
          );

      expect(r.ok, isFalse);
      expect(hosted.requests, 1);
      expect(seen, 'job-500', reason: '包一层重试钩子不能把任务号吞掉');
    });

    test('202 任务成功: 一笔计费, 图落盘', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(jobId: 'job-ok');
      final c = _container(artifactsDir: tmp, hosted: hosted);

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue);
      expect(hosted.requests, 1);
      expect(hosted.charged, 1);
      expect(r.paths, hasLength(1));
    });

    test('一次请求最多扣一次: 402 不重试, 退 BYOK 成功 = 1 笔', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_okBody(), 200);
      });
      final hosted = _FakeHosted(statuses: [402, 402]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(hosted.requests, 1, reason: '402 是确定性错误, 不重试');
      expect(hosted.charged + byokHits, 1);
    });

    test('429 重试之间确实留了间隔 (注入 60ms)', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(statuses: [429, 200]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        retryDelay: const Duration(milliseconds: 60),
      );

      final sw = Stopwatch()..start();
      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));
      sw.stop();

      expect(r.ok, isTrue);
      expect(hosted.requests, 2);
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(50));
    });

    test('确定性 4xx 不白等: 402 不消耗重试间隔', () async {
      final tmp = await _tmpDir();
      final hosted = _FakeHosted(statuses: [402, 402]);
      final c = _container(
        artifactsDir: tmp,
        hosted: hosted,
        retryDelay: const Duration(milliseconds: 400),
      );

      final sw = Stopwatch()..start();
      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));
      sw.stop();

      expect(r.ok, isFalse);
      expect(hosted.requests, 1);
      expect(sw.elapsedMilliseconds, lessThan(300),
          reason: '402 直接走下一步, 不该等重试间隔');
    });
  });

  group('C4-02 BYOK 路由的重试分级', () {
    test('BYOK 429 后重试成功: 两次请求, 一张图', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        if (byokHits == 1) return http.Response(_errBody('rate limited'), 429);
        return http.Response(_okBody(), 200);
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isTrue);
      expect(r.mode, 'byok');
      expect(byokHits, 2);
      expect(r.paths, hasLength(1));
    });

    test('BYOK 429 两次: 只重试一次, 不再发第三次', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_errBody('rate limited'), 429);
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(byokHits, 2, reason: '首发 + 一次重试, 不许发第三次');
    });

    test('BYOK 400 / 402 / 403 (确定性): 不重试, 直接如实报错', () async {
      for (final st in [400, 402, 403]) {
        final tmp = await _tmpDir();
        var byokHits = 0;
        final byokHttp = MockClient((req) async {
          byokHits++;
          return http.Response(_errBody('rejected: $st'), st);
        });
        final c = _container(
          artifactsDir: tmp,
          byok: [_byokConfig()],
          byokHttp: byokHttp,
        );

        final r = await c
            .read(imageDirectServiceProvider)
            .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

        expect(r.ok, isFalse);
        expect(r.error, isNotEmpty);
        expect(byokHits, 1, reason: '$st 是确定性错误, 再试一次也一样');
      }
    });

    test('BYOK 5xx: 不重试 (可能已扣费)', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        return http.Response(_errBody('provider down'), 500);
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(byokHits, 1);
    });

    test('BYOK 超时: 不重试, 如实报错而不是抛给界面', () async {
      final tmp = await _tmpDir();
      var byokHits = 0;
      final byokHttp = MockClient((req) async {
        byokHits++;
        throw TimeoutException('slow provider');
      });
      final c = _container(
        artifactsDir: tmp,
        byok: [_byokConfig()],
        byokHttp: byokHttp,
      );

      final r = await c
          .read(imageDirectServiceProvider)
          .generate(const ImageDirectRequest(prompt: '画一只橘猫'));

      expect(r.ok, isFalse);
      expect(r.error, isNotEmpty);
      expect(byokHits, 1);
    });
  });
}
