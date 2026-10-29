/// image_direct_service.dart — 手机本机直连出图 (不依赖桌面).
///
/// 路径 (**一次请求最多扣一次钱** — chat:C4-02, 分级见 image_charge_policy.dart):
///   1. 托管出图可用 (商业版 = 已登录) → [HostedImageBackend] (NeoxCloud /n1/images/*):
///      · 网关受理前就拒掉的 4xx = 肯定没扣费: 429 限流原路重试一次, 仍失败才退到
///        用户自己的 Key 出图; 402/403/400 这类确定性错误不重试, 直接退 BYOK 或报错;
///      · 5xx / 超时 / 202 之后任务失败 → 可能已受理扣费, 不重试也不换路, 如实报错。
///   2. 没有托管出图 (未登录 / 开源版) → BYOK OpenAI 兼容厂商 POST $base/images/generations
///   Anthropic / Gemini 协议不支持本路径 — 诚实报错引导换 Key.
///
/// 产物落 App 文档目录 neox-artifacts/generated/YYYY-MM-DD/.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'package:http/http.dart' as http;

import '../byok/byok_models.dart';
import '../byok/byok_store.dart';
import '../errors/friendly_error.dart';
import '../llm/llm_http.dart';
import 'hosted_image_backend.dart';
import 'image_charge_policy.dart';
import 'image_direct_models.dart';
import 'image_request_control.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ImageDirectService {
  ImageDirectService(
    this._ref, {
    Future<Directory> Function()? artifactsDir,
    Duration retryDelay = imageRetryDelay,
  })  : _artifactsDirOverride = artifactsDir,
        _retryDelay = retryDelay;
  final Ref _ref;

  /// 落盘目录注入 (测试用) — 生产走 path_provider 的 App 文档目录.
  final Future<Directory> Function()? _artifactsDirOverride;

  /// 「明确没扣费」的失败在原路重试一次的间隔 (测试注入 0).
  final Duration _retryDelay;

  /// 出图入口 — **一次调用最多产生一笔计费** (chat:C4-02)。
  ///
  /// 只有「肯定没扣费」且值得重试的失败 (现在只有 429) 才原路重试一次;
  /// 没扣费的确定性 4xx 直接退到用户自己的 Key; 5xx / 超时 / 已提交任务的失败
  /// 一律如实报错, 不换路。
  Future<ImageDirectResult> generate(ImageDirectRequest req) async {
    final prompt = req.prompt.trim();
    if (prompt.isEmpty) {
      return ImageDirectResult.fail(tr('请先描述你想要的图片'));
    }
    if (req.control?.isCancelled ?? false) {
      return ImageDirectResult.fail(tr(imageCancelledMessage));
    }
    /* 整次出图的总上限 (chat:C4-05) —— 两条路同一个保险丝, 取消优先于超时。
     * 只包在最外层: 里面每一段 (提交 / 轮询 / 落盘) 还各管各的超时。 */
    try {
      return await guardImageRequest(
        _generate(req),
        control: req.control,
        deadline: imageRequestTimeout,
      );
    } on ImageRequestCancelled {
      return ImageDirectResult.fail(tr(imageCancelledMessage));
    } on ImageRequestTimedOut {
      return ImageDirectResult.fail(tr(imageTimeoutMessage));
    }
  }

  Future<ImageDirectResult> _generate(ImageDirectRequest req) async {
    final hosted = _ref.read(hostedImageBackendProvider);
    if (hosted != null && hosted.available) {
      final cloud = await _viaCloud(hosted, req);
      if (cloud.result.ok || !cloud.notCharged) {
        /* 成功, 或失败时可能已经扣过费 (5xx / 超时 / 任务失败) — 到此为止 */
        return cloud.result;
      }
      /* 网关受理前就拒了, 这一笔肯定没扣费 → 用户自己的 Key 顶上 */
      final byok = _pickByokImageProvider();
      if (byok == null) return cloud.result;
      debugPrint('[image-direct] cloud rejected before charging; fallback to byok');
      return _viaByok(byok, req);
    }

    final byok = _pickByokImageProvider();
    if (byok == null) {
      return ImageDirectResult.fail(
        hosted == null
            ? tr('请在「我的模型 → 云端 Key」接入 OpenAI / OpenRouter 等图像模型')
            : tr('请登录 Neox 使用托管生图, 或在「我的模型 → 云端 Key」接入 OpenAI / OpenRouter 等图像模型'),
      );
    }
    return _viaByok(byok, req);
  }

  /// 选一个能打 /images 的 BYOK: OpenAI 兼容协议 + 非空 key.
  ByokProviderConfig? _pickByokImageProvider() {
    final list = _ref.read(byokStoreProvider);
    for (final p in list) {
      if (!p.enabled) continue;
      if (p.apiKey.trim().isEmpty) continue;
      if (p.protocol != ByokProtocol.openaiCompat) continue;
      return p;
    }
    /* 用户只有 Anthropic/Gemini — 明确告诉不支持 */
    final any = list.where((p) => p.enabled && p.apiKey.trim().isNotEmpty);
    if (any.isNotEmpty) {
      return null; /* caller 用专用文案 */
    }
    return null;
  }

  /// 按任务号把一个已提交的托管出图取回来 (App 被杀 / 切后台后重开出图页时调)。
  Future<ImageDirectResult> resumeCloudJob(String jobId, {required String prompt, String? model}) async {
    final hosted = _ref.read(hostedImageBackendProvider);
    if (hosted == null || !hosted.available) {
      return ImageDirectResult.fail(tr('请登录 Neox 使用托管生图'));
    }
    final started = DateTime.now();
    final resp = await hosted.resumeJob(jobId);
    if (resp.status == 404) {
      return ImageDirectResult.fail(tr('这张图生成时 App 被关掉了太久, 结果已过期, 请重新生成'));
    }
    if (resp.status >= 400) {
      return ImageDirectResult.fail(_httpError(resp.status, resp.body));
    }
    final paths = await _persistFromResponse(resp.body, prompt);
    if (paths.isEmpty) {
      return ImageDirectResult.fail(tr('这次没拿到图片, 请换个描述或模型再试'));
    }
    return ImageDirectResult(
      ok: true,
      paths: paths,
      count: paths.length,
      mode: 'neoxcloud',
      model: model,
      latencyMs: DateTime.now().difference(started).inMilliseconds,
    );
  }

  /// 走云端出图。
  ///
  /// [notCharged] = 这次失败确定没扣费: 只有网关在受理前就拒掉 (4xx, 不含 408)
  /// 且没有提交过任务时才为 true —— 只有这种失败允许重试 / 换到用户自己的 Key。
  Future<({ImageDirectResult result, bool notCharged})> _viaCloud(
    HostedImageBackend hosted,
    ImageDirectRequest req,
  ) async {
    final started = DateTime.now();
    var submitted = false;
    /* 交出任务号即「已受理」。202 之后任务失败时, 网关会把上游的 4xx/5xx 原样回给
     * 我们, 但那一笔已经提交过, 不许再当「没扣费」去重试 / 换路。 */
    final guarded = ImageDirectRequest(
      prompt: req.prompt,
      model: req.model,
      n: req.n,
      size: req.size,
      quality: req.quality,
      referenceImages: req.referenceImages,
      control: req.control,
      onJobSubmitted: (id) {
        submitted = true;
        req.onJobSubmitted?.call(id);
      },
    );

    ({int status, String body, String model}) resp;
    try {
      resp = await _cloudCall(hosted, guarded);
      /* 限流且明确没扣费 → 同一路由隔 2 秒重试一次 (只这一次) */
      if (!submitted && isDefinitelyNotCharged(resp.status) && isWorthRetrying(resp.status)) {
        await Future<void>.delayed(_retryDelay);
        resp = await _cloudCall(hosted, guarded);
      }
    } on ImageRequestCancelled {
      /* 用户自己点的取消: 已经提交的那一笔在服务器上照跑, 钱不退, 照实说 */
      return (
        result: ImageDirectResult.fail(tr(imageCancelledMessage)),
        notCharged: false,
      );
    } catch (e) {
      /* 超时 / 断网 / 取 token 失败: 已经发出去的那一笔可能已受理, 不重试也不换路 */
      debugPrint('[image-direct] cloud request failed: $e');
      return (
        result: ImageDirectResult.fail(
          friendlyError(e, fallback: tr('生图失败, 请稍后重试或换一个图像模型')),
        ),
        notCharged: false,
      );
    }
    final model = resp.model;

    if (resp.status >= 400) {
      return (
        result: ImageDirectResult.fail(_httpError(resp.status, resp.body)),
        notCharged: !submitted && isDefinitelyNotCharged(resp.status),
      );
    }
    List<String> paths;
    try {
      paths = await _persistFromResponse(resp.body, req.prompt);
    } catch (e) {
      /* 回包解析 / 落盘出错: 网关那边已经出图, 当作已计费, 不重试 */
      debugPrint('[image-direct] persist failed: $e');
      return (
        result: ImageDirectResult.fail(tr('这次没拿到图片, 请换个描述或模型再试')),
        notCharged: false,
      );
    }
    if (paths.isEmpty) {
      return (
        result: ImageDirectResult.fail(tr('这次没拿到图片, 请换个描述或模型再试')),
        notCharged: false,
      );
    }
    return (
      result: ImageDirectResult(
        ok: true,
        paths: paths,
        count: paths.length,
        mode: 'neoxcloud',
        model: model,
        latencyMs: DateTime.now().difference(started).inMilliseconds,
      ),
      notCharged: false,
    );
  }

  /// 一次云端调用: 只加取消 + 总超时。
  ///
  /// 不能在这里套「提交超时」: `hosted.request` 内部是「POST + 轮询到终态」
  /// (202 后台任务, 最长 12 分钟), 外面再压一个 60 秒会把正在正常出图的请求
  /// 判成超时 —— 钱已扣、图还没回来。提交那一段的超时由后端自己管 (POST 60 秒)。
  /// 超时按「结果未知」向上抛: 调用方不会把它当成没扣费去重试 / 换路。
  Future<({int status, String body, String model})> _cloudCall(
    HostedImageBackend hosted,
    ImageDirectRequest req,
  ) async {
    try {
      return await guardImageRequest(
        hosted.request(req),
        control: req.control,
        deadline: imageRequestTimeout,
      );
    } on ImageRequestTimedOut {
      debugPrint('[image-direct] cloud submit timed out');
      rethrow;
    }
  }
  Future<ImageDirectResult> _viaByok(
    ByokProviderConfig provider,
    ImageDirectRequest req,
  ) async {
    if (provider.protocol != ByokProtocol.openaiCompat) {
      return ImageDirectResult.fail(
        tr('当前 Key (${provider.name}) 不支持直连生图, 请换 OpenAI / OpenRouter 等'),
      );
    }
    final started = DateTime.now();
    final model = _byokModelId(provider, req.model);
    final base = provider.baseUrl.replaceAll(RegExp(r'/$'), '');
    final isOpenRouter = base.contains('openrouter.ai');
    final subPath = isOpenRouter ? '/images' : '/images/generations';
    final url = '$base$subPath';

    final body = <String, Object?>{
      'model': model,
      'prompt': req.prompt,
      'n': req.n.clamp(1, 4),
      'size': req.size,
      'response_format': 'b64_json',
      if (req.isImg2Img) 'image': req.referenceImages.first,
    };

    final client = _ref.read(llmHttpClientProvider);

    http.Response resp;
    try {
      resp = await guardImageRequest(
        _postByok(client, url, provider, body),
        control: req.control,
        deadline: imageByokTimeout,
      );
      /* 厂商受理前就拒了 (参数 / 额度 / 频率), 肯定没扣费; 其中只有 429 限流值得同路重试一次 */
      if (isDefinitelyNotCharged(resp.statusCode) && isWorthRetrying(resp.statusCode)) {
        await Future<void>.delayed(_retryDelay);
        resp = await guardImageRequest(
          _postByok(client, url, provider, body),
          control: req.control,
          deadline: imageByokTimeout,
        );
      }
    } on ImageRequestCancelled {
      return ImageDirectResult.fail(tr(imageCancelledMessage));
    } catch (e) {
      /* 超时 / 断流: 厂商可能已经受理, 不重试 */
      debugPrint('[image-direct] byok request failed: $e');
      return ImageDirectResult.fail(
        friendlyError(e, fallback: tr('生图失败, 请稍后重试或换一个图像模型')),
      );
    }

    if (resp.statusCode >= 400) {
      return ImageDirectResult.fail(_httpError(resp.statusCode, resp.body));
    }
    final paths = await _persistFromResponse(resp.body, req.prompt);
    if (paths.isEmpty) {
      return ImageDirectResult.fail(tr('这次没拿到图片, 请换个描述或模型再试'));
    }
    return ImageDirectResult(
      ok: true,
      paths: paths,
      count: paths.length,
      mode: 'byok',
      model: model,
      latencyMs: DateTime.now().difference(started).inMilliseconds,
    );
  }

  Future<http.Response> _postByok(
    http.Client client,
    String url,
    ByokProviderConfig provider,
    Map<String, Object?> body,
  ) =>
      client
          .post(
            Uri.parse(url),
            headers: {
              'Authorization': 'Bearer ${provider.apiKey}',
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              ...provider.extraHeaders,
            },
            body: jsonEncode(body),
          )
          /* 硬上限统一在 image_request_control.dart (chat:C4-05), 这里不再各写一个数 */
          .timeout(imageByokTimeout);

  String _byokModelId(ByokProviderConfig provider, String? hint) {
    if (hint != null && hint.isNotEmpty) {
      /* byok/<providerId>/<model> → 裸 model */
      final ref = ByokModelRef.parse(hint);
      if (ref != null) return ref.modelId;
      if (hint.contains('/')) {
        final parts = hint.split('/');
        return parts.last;
      }
      return hint;
    }
    if (provider.models.isNotEmpty) return provider.models.first;
    if (provider.baseUrl.contains('openrouter')) {
      return 'openai/gpt-image-1';
    }
    return 'gpt-image-1';
  }

  Future<List<String>> _persistFromResponse(
    String body,
    String prompt,
  ) async {
    final parsed = jsonDecode(body);
    if (parsed is! Map) return const [];
    final data = parsed['data'];
    if (data is! List) return const [];

    final dir = await _artifactsDir();
    final slug = _slug(prompt);
    final out = <String>[];
    var i = 0;
    for (final item in data) {
      if (item is! Map) continue;
      final b64 = (item['b64_json'] as String?) ??
          (item['b64Json'] as String?) ??
          '';
      String? url = item['url'] as String?;
      Uint8List bytes;
      if (b64.isNotEmpty) {
        bytes = base64Decode(b64);
      } else if (url != null && url.isNotEmpty) {
        /* 2026-10-12 起网关会把上游的链接取回来转成 b64, 这里一般走不到; 走到了 (BYOK 直连) 给足时间、
         * 失败再试一次 —— 原来 60 秒一刀, 上游图床慢就报「连接异常」, 图其实已经出好了 */
        final client = _ref.read(llmHttpClientProvider);
        http.Response? r;
        for (var attempt = 0; attempt < 2 && r == null; attempt++) {
          try {
            r = await client.get(Uri.parse(url)).timeout(const Duration(seconds: 150));
          } catch (e) {
            if (attempt == 1) rethrow;
          }
        }
        if (r == null || r.statusCode >= 400) continue;
        bytes = r.bodyBytes;
      } else {
        continue;
      }
      /* 文件名带毫秒时间戳; 同一毫秒里连画两次 (同一个 prompt) 会撞名,
       * 后一张直接覆盖前一张 —— 用户以为少了一张图 (chat:C4-06 连测时踩到)。 */
      final base =
          '$slug-${DateTime.now().millisecondsSinceEpoch}${i == 0 ? '' : '-$i'}';
      var name = '$base.png';
      var dup = 1;
      while (await File(p.join(dir.path, name)).exists()) {
        name = '$base-${dup++}.png';
      }
      final file = File(p.join(dir.path, name));
      await file.writeAsBytes(bytes, flush: true);
      out.add(file.path);
      i++;
    }
    return out;
  }

  Future<Directory> _artifactsDir() async {
    final override = _artifactsDirOverride;
    if (override != null) return override();
    final root = await getApplicationDocumentsDirectory();
    final day = DateTime.now();
    final stamp =
        '${day.year.toString().padLeft(4, '0')}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';
    final dir = Directory(
      p.join(root.path, 'neox-artifacts', 'generated', stamp),
    );
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    return dir;
  }

  String _slug(String prompt) {
    final cleaned = prompt
        .replaceAll(RegExp(r'\s+'), '-')
        .replaceAll(RegExp(r'[^\w\u4e00-\u9fff-]+'), '')
        .toLowerCase();
    if (cleaned.isEmpty) return 'image';
    return cleaned.length > 36 ? cleaned.substring(0, 36) : cleaned;
  }

  String _httpError(int status, String body) {
    try {
      final parsed = jsonDecode(body);
      if (parsed is Map) {
        final err = parsed['error'];
        if (err is Map && err['message'] is String) {
          return err['message'] as String;
        }
        if (err is String) return err;
      }
    } catch (_) {}
    if (status == 401) return tr('登录已过期或 Key 无效');
    if (status == 402) return tr('额度或平台余额不足');
    if (status == 403) return tr('当前会员暂不能使用这个图像模型');
    if (status == 429) return tr('请求太频繁, 请稍后再试');
    if (status >= 500) return tr('图像服务暂不可用');
    return tr('生图失败 ($status)');
  }
}

final imageDirectServiceProvider = Provider<ImageDirectService>(
  (ref) => ImageDirectService(ref),
);
