/// generate_image —— 对话里直接画图 / 改图 (2026-10-12)。
///
/// 用户: 「聊天的时候, 他能不能直接调用图片、生成图片, 这个体验很重要, 要支持」。
/// 原来要画图得离开对话去「图片」页。现在对话 / 工作模式的 Agent 都能直接调:
/// 跟图片页走同一条路 (托管出图优先, 没登录退 BYOK; 模型从网关真实列表挑, 用户在图片页选过就用他的)。
/// 出来的图存进 Agent 工作区, 对话里直接显示缩略图 (phone_local_agent._localArtifactsOf 认回执), 点开大图。
///
/// 两处来自 chat 方案:
///   · chat:C4-07 尺寸 —— 用户在输入框 [+] 里选了方 / 横 / 竖就以他为准, 没选才听模型的;
///   · chat:C4-09 图生图 —— 用户这一轮刚发的图**自动**当参考, 不用模型再问路径。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../../../features/home/state/selected_model_provider.dart' show availableModelsProvider;
import '../../../features/image/state/image_model_pref.dart' show imageModelPrefProvider;
import '../../storage/database.dart' show appDatabaseProvider;
import '../../image/image_direct_models.dart';
import '../../image/image_direct_service.dart';
import '../../image/image_model_pick.dart';
import '../../image/image_request_control.dart';
import '../../image/image_size_pref.dart';

class GenerateImageTool implements sdk.AgentTool, sdk.ParallelSafeTool {
  GenerateImageTool(this._ref, {required this.rootDir});

  final Ref _ref;
  final Directory rootDir;

  /// 回执里每张图一行「图片: <工作区相对路径>」
  static const linePrefix = '图片: ';

  /// 用户发来的附件落在这里 (跟 phone_local_agent._saveUpload 同一个目录)。
  static const uploadsDir = 'uploads';

  /// 一张图一次请求, 各写各的文件 (文件名由出图服务给, 复制进 images/) ——
  /// 同一轮里多张不同的图可以并发画 (总控裁决第六节: 画图不限张数, 靠并发提速)。
  @override
  bool get parallelSafe => true;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'generate_image',
        description: '画图 / 改图。用户要图 (头像、海报、插画、配图、表情包、Logo、照片风格的场景…) 就直接调, 不用先问。'
            'prompt 用一段具体的描述: 主体、风格、构图、颜色、光线, 中英文都行; 图里要出现的文字用引号写明。'
            '改图 / 以图生图: 用户这一轮刚发的图会自动当参考, 你直接写怎么改就行, 不用问路径;'
            ' 要改的是更早的图时, reference 填工作区里的图片路径。'
            '画好的图会直接显示在对话里, 你只需一两句说明画了什么, 别描述得太长, 也别贴路径。',
        parameters: {
          'type': 'object',
          'properties': {
            'prompt': {'type': 'string'},
            'size': {
              'type': 'string',
              'enum': ['1024x1024', '1536x1024', '1024x1536'],
              'description': '方图 / 横图 / 竖图, 默认方图; 海报、手机壁纸用竖图',
            },
            'n': {'type': 'integer', 'description': '几张, 1~4, 默认 1'},
            'reference': {
              'type': 'string',
              'description': '要改的那张图的工作区路径; 用户这一轮刚发的图不用填 (自动当参考)',
            },
          },
          'required': ['prompt'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final prompt = '${args['prompt'] ?? ''}'.trim();
    if (prompt.isEmpty) return const sdk.ToolResult.error('prompt 是空的');
    final refs = <String>[];
    final explicit = '${args['reference'] ?? ''}'.trim();
    if (explicit.isNotEmpty) {
      refs.add(await _dataUrl(explicit));
    } else {
      /* chat:C4-09: 用户这一轮刚发的图直接当参考, 不用模型报路径。
       * 只取**这一轮**的 (ctx.sessionId 的最新一条 user_message), 上上轮的照片不拿来改。 */
      final rel = await thisUploadedImage(ctx.sessionId);
      if (rel != null) refs.add(await _dataUrl(rel));
    }
    var ids = const <String>[];
    try {
      ids = [for (final m in await _ref.read(availableModelsProvider.future)) m.id];
    } catch (_) {/* 拿不到列表就交给出图服务自己挑 */}
    final model = pickImageModel(ids, preferred: _ref.read(imageModelPrefProvider));
    /* chat:C4-07 尺寸: 用户在 [+] 里选过就以他为准 (强约束, 模型填的也不听);
     * 没选过 (自动) 仍然听模型的判断, 默认方图。 */
    final chosenSize = _ref.read(imageSizePrefProvider);
    final size = chosenSize?.wire ?? '${args['size'] ?? '1024x1024'}';
    final r = await _ref.read(imageDirectServiceProvider).generate(ImageDirectRequest(
          prompt: prompt,
          model: model,
          n: ((args['n'] as num?)?.toInt() ?? 1).clamp(1, 4),
          size: size,
          referenceImages: refs,
          control: ImageRequestControl(),
        ));
    if (!r.ok) return sdk.ToolResult.error(r.error ?? '没画出来');
    /* 复制进工作区: 对话里的图卡 / 预览 / 分享都认工作区里的文件 */
    final dir = Directory('${rootDir.absolute.path}/images')..createSync(recursive: true);
    final out = <String>[];
    for (final p in r.paths) {
      final name = p.split('/').last;
      await File(p).copy('${dir.path}/$name');
      out.add('images/$name');
    }
    return sdk.ToolResult.ok([
      '画好了 ${out.length} 张${r.model != null ? ' (${r.model})' : ''}, 已显示在对话里:',
      for (final o in out) '$linePrefix$o',
    ].join('\n'));
  }

  /// 工作区相对路径 → data URL (给 /images/edits 用)。
  Future<String> _dataUrl(String rel) async {
    final f = File('${rootDir.absolute.path}/$rel');
    if (!f.existsSync()) throw StateError('工作区里没有 $rel');
    final lower = rel.toLowerCase();
    final ext = lower.endsWith('.png')
        ? 'png'
        : lower.endsWith('.webp')
            ? 'webp'
            : 'jpeg';
    return 'data:image/$ext;base64,${base64Encode(await f.readAsBytes())}';
  }

  /// **这一轮**用户发来的图 (工作区相对路径, 最新一张), 没有返回 null。
  ///
  /// 只认最近一条 user_message 的 payload —— 那里 `saved_images` 记着这张图在工作区
  /// 的路径 (phone_local_agent._saveUpload 落的 uploads/)。不用「uploads/ 里最新的文件」:
  /// 那会把上一轮、上上轮的照片也拿来改。逐条按消息顺序找最后一条用户消息;
  /// 它没带图就说明这一轮不是在改图。
  Future<String?> thisUploadedImage(String? sessionId) async {
    if (sessionId == null || sessionId.isEmpty) return null;
    try {
      final db = _ref.read(appDatabaseProvider);
      final events = await db.sessionEventsDao.getBySessionId(sessionId);
      for (final ev in events.reversed) {
        if (ev.kind != 'user_message') continue;
        final parsed = jsonDecode(ev.payload);
        final imgs = parsed is Map ? parsed['saved_images'] : null;
        if (imgs is! List || imgs.isEmpty) return null;
        for (final m in imgs.reversed.whereType<Map>()) {
          final path = m['path'];
          if (path is String && path.isNotEmpty) {
            final f = File('${rootDir.absolute.path}/$path');
            if (f.existsSync()) return path;
          }
        }
        return null;
      }
    } catch (_) {/* 读不到就当这一轮没发图 —— 不能因此把画图整条卡住 */}
    return null;
  }
}
