/// image_tool_reference_test.dart — chat:C4-09 图生图：用户发的图直接当参考.
///
/// 要修的病: 用户发一张图说「改成水彩」, 模型得先问「图片路径是多少」。
/// 现在这一轮的图已经在工作区 uploads/ 下, 工具自己认出来当参考 —— 模型只说改法。
///
/// 覆盖:
///   · 这一轮发了图 → generate_image 不填 reference 也走 img2img (请求里带 image);
///   · 上一轮发的图 → 不拿来当参考 (不偷偷改旧照片);
///   · 模型显式填了 reference → 以模型的为准;
///   · 用户选了尺寸 (chat:C4-07) → 覆盖模型填的 size。
library;

import 'dart:convert';
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:neox_app/core/image/hosted_image_backend.dart';
import 'package:neox_app/core/image/image_direct_models.dart';
import 'package:neox_app/core/image/image_direct_service.dart';
import 'package:neox_app/core/image/image_size_pref.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart';
import 'package:neox_app/core/local_agent/tools/image_tool.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/features/home/state/selected_model_provider.dart'
    show availableModelsProvider;
import 'package:neox_app/shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

const _pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

String _okBody() => jsonEncode({
  'data': [
    {'b64_json': _pngB64},
  ],
});

/// 记住**每一次请求的 body**, 用来断言 size / image 有没有带上。
class _RecordingHosted implements HostedImageBackend {
  final List<Map<String, dynamic>> bodies = [];

  @override
  bool available = true;

  @override
  Future<({int status, String body, String model})> request(
    ImageDirectRequest req,
  ) async {
    bodies.add({
      'prompt': req.prompt,
      'size': req.size,
      'n': req.n,
      'images': req.referenceImages,
    });
    return (status: 200, body: _okBody(), model: 'gpt-image-2');
  }

  @override
  Future<({int status, String body})> resumeJob(String jobId) async =>
      (status: 404, body: '{}');
}

final _refProvider = Provider<Ref>((ref) => ref);

Future<({ProviderContainer c, AppDatabase db, Directory ws})> _setup({
  ImageSize? size,
}) async {
  final tmp = await Directory.systemTemp.createTemp('neox-img-ref');
  addTearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });
  final ws = await Directory('${tmp.path}/ws').create(recursive: true);
  final db = AppDatabase.forTesting(NativeDatabase.memory());
  addTearDown(db.close);

  SharedPreferences.setMockInitialValues(<String, Object>{});
  final prefs = await SharedPreferences.getInstance();
  if (size != null) prefs.setString('neox_image_size', size.wire);

  final hosted = _RecordingHosted();
  final c = ProviderContainer(
    overrides: [
      appDatabaseProvider.overrideWithValue(db),
      hostedImageBackendProvider.overrideWithValue(hosted),
      sharedPreferencesProvider.overrideWithValue(prefs),
      availableModelsProvider.overrideWith(
        (ref) async => const [GatewayModel(id: 'gpt-image-2', name: 'gpt-image-2')],
      ),
      imageDirectServiceProvider.overrideWith(
        (ref) => ImageDirectService(ref, artifactsDir: () async => tmp),
      ),
    ],
  );
  addTearDown(c.dispose);
  /* 让 hosted 从这个容器里拿不到 (provider 已覆盖) */
  _lastHosted = hosted;
  return (c: c, db: db, ws: ws);
}

_RecordingHosted? _lastHosted;

Future<void> _insertUpload({
  required AppDatabase db,
  required String sessionId,
  required String relPath,
  required int seq,
}) => db.sessionEventsDao.insertEvent(
  SessionEventsCompanion.insert(
    sessionId: sessionId,
    seq: seq,
    ts: 1000 + seq,
    kind: 'user_message',
    payload: jsonEncode({
      'text': '改成水彩',
      'saved_images': [
        {'name': relPath.split('/').last, 'path': relPath},
      ],
    }),
  ),
);

/// 工作区里放一张真图, 返回相对路径。
Future<String> _writeUpload(Directory ws, String name) async {
  final dir = Directory('${ws.path}/${GenerateImageTool.uploadsDir}')
    ..createSync(recursive: true);
  final f = File('${dir.path}/$name');
  await f.writeAsBytes(base64Decode(_pngB64));
  return '${GenerateImageTool.uploadsDir}/$name';
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

  group('C4-09 用户发的图直接当参考', () {
    test('这一轮发了图: 不填 reference 也走 img2img', () async {
      final s = await _setup();
      final rel = await _writeUpload(s.ws, 'cat.png');
      await _insertUpload(db: s.db, sessionId: 's1', relPath: rel, seq: 1);

      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      final res = await tool.run(
        const {'prompt': '改成水彩风格'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken(), sessionId: 's1'),
      );

      expect(res.isError, isFalse, reason: res.output);
      final body = _lastHosted!.bodies.single;
      expect(body['images'], hasLength(1), reason: '用户这张图应该带上');
      expect(body['images'].single, startsWith('data:image/png;base64,'));
      expect(body['prompt'], '改成水彩风格');
    });

    test('上一轮发的图: 这一轮纯画新图, 不偷偷拿旧照片改', () async {
      final s = await _setup();
      final rel = await _writeUpload(s.ws, 'old.png');
      await _insertUpload(db: s.db, sessionId: 's1', relPath: rel, seq: 1);
      /* 这一轮没发图 */
      await s.db.sessionEventsDao.insertEvent(
        SessionEventsCompanion.insert(
          sessionId: 's1',
          seq: 2,
          ts: 2000,
          kind: 'user_message',
          payload: jsonEncode({'text': '画一只橘猫'}),
        ),
      );

      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      final res = await tool.run(
        const {'prompt': '画一只橘猫'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken(), sessionId: 's1'),
      );

      expect(res.isError, isFalse, reason: res.output);
      expect(_lastHosted!.bodies.single['images'], isEmpty);
    });

    test('模型显式填了 reference: 以模型的为准', () async {
      final s = await _setup();
      final latest = await _writeUpload(s.ws, 'latest.png');
      final older = await _writeUpload(s.ws, 'older.png');
      await _insertUpload(db: s.db, sessionId: 's1', relPath: latest, seq: 1);

      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      final res = await tool.run(
        {'prompt': '换成黑白', 'reference': older},
        sdk.ToolContext(cancel: sdk.AgentCancelToken(), sessionId: 's1'),
      );

      expect(res.isError, isFalse, reason: res.output);
      expect(_lastHosted!.bodies.single['images'], hasLength(1));
    });

    test('没有会话 / 没发过图: 就是普通出图, 不带参考', () async {
      final s = await _setup();
      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      final res = await tool.run(
        const {'prompt': '画一只橘猫'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken()),
      );
      expect(res.isError, isFalse, reason: res.output);
      expect(_lastHosted!.bodies.single['images'], isEmpty);
    });
  });

  group('C4-07 用户选的尺寸覆盖模型填的', () {
    test('选了竖图: 就算模型填了方图也按竖图发', () async {
      final s = await _setup(size: ImageSize.portrait);
      expect(s.c.read(imageSizePrefProvider), ImageSize.portrait);

      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      final res = await tool.run(
        const {'prompt': '画一张手机壁纸', 'size': '1024x1024'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken()),
      );

      expect(res.isError, isFalse, reason: res.output);
      expect(_lastHosted!.bodies.single['size'], '1024x1536');
    });

    test('没选过 (自动): 听模型的 size', () async {
      final s = await _setup();
      expect(s.c.read(imageSizePrefProvider), isNull);

      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      await tool.run(
        const {'prompt': '画一张横版海报', 'size': '1536x1024'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken()),
      );

      expect(_lastHosted!.bodies.single['size'], '1536x1024');
    });

    test('没选过也没填: 默认方图', () async {
      final s = await _setup();
      final tool = GenerateImageTool(s.c.read(_refProvider), rootDir: s.ws);
      await tool.run(
        const {'prompt': '画一只橘猫'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken()),
      );
      expect(_lastHosted!.bodies.single['size'], '1024x1024');
    });
  });
}
