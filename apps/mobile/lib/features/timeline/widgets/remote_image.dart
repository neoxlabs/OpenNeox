/// 电脑那边的图片按引用拉下来渲染 (2026-09-30: agent 截的图 / 生成的图 / 电脑上贴的图, 手机上全是「[图片]」)。
///
/// 桌面瘦身时把 base64 图片落盘成 `~/.neox/mobile-images/<sha256>.<ext>`, 消息里换成
/// `![](neox-image://<sha256>.<ext>)`。这里按名字走 file.fetch (id = `img-<name>`) 分块拉,
/// 存到手机缓存目录; 内容寻址, 同一张图只拉一次。
///
/// 分块取 150KB: 远程时走云中转, 单包上限 256KB, base64 膨胀 4/3 + 加密信封之后还要留余量。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/network/relay_frame.dart' show chunkBytesOf;
import '../../../core/network/ws_client_provider.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

const String kNeoxImageScheme = 'neox-image';
/// 分块取 96KB。远程时走云中转, 单包上限 250KB (cloudRelayClient RELAY_ENVELOPE_LIMIT_BYTES):
/// 原始字节 → base64 (×4/3) → AES-GCM 密文 → 信封再 base64 (×4/3), 一共约 ×16/9。
/// 150KB 时代算下来一块 ≈ 273KB, **每块都超线** —— 桌面自己判超限不发, 手机那头就是
/// 永远转圈/拉不到 (2026-10-18 真机: 「失败时的页面截图」下面的图一直是空的)。
/// 96KB → 约 175KB, 留 75KB 余量。LAN 直连上限 2MB, 用 150KB 少几次往返。
const int kImageChunkBytesCloud = 96 * 1024;
const int kImageChunkBytesLan = 150 * 1024;

/// 云中转走 v2 二进制帧时 (relay_frame.dart) 传输层自动分片、字节不进 base64, 一块要 512KB
/// (电脑上限 1MB 再收口); 再大的话 4 路并发在慢网上单块会超时
const int kChunkBytesFrames = 512 * 1024;

/// 云中转 (cloudRelay) / 云端 agent (cloudAgent) 都按 96KB; 只有 LAN 直连用 150KB.
int imageChunkBytesFor(WsTransport transport) =>
    transport == WsTransport.lan ? kImageChunkBytesLan : kImageChunkBytesCloud;
final RegExp _kNameRe = RegExp(r'^[a-f0-9]{64}\.(png|jpg|webp|gif|bmp|svg)$');
final RegExp kNeoxImageRefRe = RegExp(r'neox-image://([a-f0-9]{64}\.(?:png|jpg|webp|gif|bmp|svg))');

/// 文本里所有 neox-image 引用的名字 (去重保序) —— 工具输出不走 markdown, 从这里抽出来单独渲染
List<String> neoxImageNamesIn(String? text) {
  if (text == null || !text.contains('neox-image://')) return const [];
  final seen = <String>{};
  return [
    for (final m in kNeoxImageRefRe.allMatches(text))
      if (seen.add(m[1]!)) m[1]!,
  ];
}

class NeoxImageCache {
  NeoxImageCache._();
  static final NeoxImageCache instance = NeoxImageCache._();

  final Map<String, Future<File?>> _inflight = {};
  Directory? _dir;

  Future<Directory> _cacheDir() async {
    final d = _dir;
    if (d != null) return d;
    final base = await getApplicationCacheDirectory();
    final dir = Directory('${base.path}/neox-images');
    await dir.create(recursive: true);
    return _dir = dir;
  }

  /// 时间线用的缩略版: 电脑现压到长边 [kThumbEdge] 再传 (原图 Retina 截图动辄几 MB)。
  /// 老电脑不认 `@长边` 的 id, 拉不到就退回原图。
  Future<File?> getThumb(WsClientController ws, String name) async {
    if (!_kNameRe.hasMatch(name)) return null;
    final key = '$name@$kThumbEdge';
    final thumb = await _get(ws, key, 'img-$key');
    return thumb ?? await get(ws, name);
  }

  /// 原图 (点开全屏 / 保存分享)。本地有就直接给; 没有就从当前连着的电脑拉。
  /// 拉不到 (没连 / 电脑上没有) 返回 null, 不缓存失败。
  Future<File?> get(WsClientController ws, String name) {
    if (!_kNameRe.hasMatch(name)) return Future.value(null);
    return _get(ws, name, 'img-$name');
  }

  /// 电脑出的产物预览图 (`thumb-<产物 id>@<长边>`, 见电脑端 mobileArtifactPreview.ts)。
  /// 出不了 (老电脑 / 系统不支持这种文件) 返回 null, 卡片退回图标。
  Future<File?> getArtifactPreview(WsClientController ws, String artifactId, {int edge = 640}) {
    if (!RegExp(r'^art-[0-9a-f-]{36}$').hasMatch(artifactId)) return Future.value(null);
    final id = 'thumb-$artifactId@$edge';
    return _get(ws, id, id);
  }

  /// 本地已经有原图就不用再拉缩略图
  Future<File?> cachedOriginal(String name) async {
    final f = File('${(await _cacheDir()).path}/$name');
    return await f.exists() && await f.length() > 0 ? f : null;
  }

  Future<File?> _get(WsClientController ws, String key, String artifactId) {
    /* 整体兜底: 里面每一步都有时限, 但路径目录 / 写盘卡住时 UI 会永远停在转圈。
     * 超时就当拉不到, 用户看到重试按钮而不是一个永远转的圈。 */
    return _inflight[key] ??= _fetch(ws, key, artifactId)
        .timeout(const Duration(seconds: 60), onTimeout: () => null)
        /* 块体 {}: `=> _inflight.remove(key)` 会返回这个 future 自己, whenComplete 等自己 = 永远转圈
         * (图其实已经落盘, 退出重进才出来) */
        .whenComplete(() {
          _inflight.remove(key);
        });
  }

  Future<Map<String, dynamic>?> _chunk(WsClientController ws, String id, int offset, int length) =>
      /* 每块 20 秒拉不到就算失败 —— 原来没有时限, 电脑那头不回就一直转圈 (2026-10-11 真机) */
      ws
          .fetchArtifactChunk(artifactId: id, offset: offset, length: length)
          .timeout(const Duration(seconds: 30), onTimeout: () => null);

  /// 一块失败先重试几次; 还是不行, 已经拉到的块留在 [_resume], 下次 (点重试 / 重新进页面) 只补缺的。
  /// 图是内容寻址的, 同一个名字字节永远一样, 拼起来不会错位。
  Future<List<int>?> _chunkRetry(WsClientController ws, String id, int offset, int length) async {
    for (var attempt = 0; attempt < kChunkAttempts; attempt++) {
      if (attempt > 0) await Future<void>.delayed(Duration(milliseconds: 400 * attempt));
      final b = chunkBytesOf(await _chunk(ws, id, offset, length));
      if (b != null) return b;
    }
    return null;
  }

  /// 拉了一半的图: 总长 / 块长 / 已到的块
  final Map<String, ({int total, int stride, Map<int, List<int>> parts})> _resume = {};

  /// 先拉第一块拿到总大小和电脑实际给的块长, 剩下的块 [kParallelChunks] 路并发拉 ——
  /// 以前一块一块串着等, 云中转每块一个来回, 2MB 图要 20 多个来回。
  Future<File?> _fetch(WsClientController ws, String key, String artifactId) async {
    final dir = await _cacheDir();
    final file = File('${dir.path}/$key');
    if (await file.exists() && await file.length() > 0) return file;
    var state = _resume[key];
    if (state == null) {
      final want = ws.relayFramesActive ? kChunkBytesFrames : imageChunkBytesFor(ws.transport);
      final first = await _chunk(ws, artifactId, 0, want);
      final firstBytes = chunkBytesOf(first);
      if (first == null || firstBytes == null || firstBytes.isEmpty) return null;
      final total = (first['size_bytes'] as num?)?.toInt() ?? firstBytes.length;
      /* 电脑按 transport 收口块长, 以它实际给的为准 */
      state = (total: total, stride: firstBytes.length, parts: <int, List<int>>{0: firstBytes});
    }
    final total = state.total, stride = state.stride, parts = state.parts;
    final offsets = [for (var o = 0; o < total; o += stride) if (!parts.containsKey(o)) o];
    var next = 0;
    var failed = false;
    Future<void> worker() async {
      while (!failed && next < offsets.length) {
        final o = offsets[next++];
        final b = await _chunkRetry(ws, artifactId, o, stride);
        if (b == null || b.length != (total - o < stride ? total - o : stride)) {
          failed = true;
          return;
        }
        parts[o] = b;
      }
    }
    await Future.wait([for (var i = 0; i < kParallelChunks; i++) worker()]);
    if (failed) {
      _resume[key] = state;
      return null;
    }
    _resume.remove(key);
    final tmp = File('${file.path}.part');
    final sink = tmp.openWrite();
    try {
      for (final o in parts.keys.toList()..sort()) {
        sink.add(parts[o]!);
      }
    } finally {
      await sink.close();
    }
    if (await tmp.length() != total) {
      await tmp.delete();
      return null;
    }
    await tmp.rename(file.path);
    return file;
  }
}

/// 一块最多试几次 (含第一次)
const int kChunkAttempts = 3;

/// 时间线缩略图长边 (电脑现压)。时间线图最多 260dp 宽, 3x 屏 ~800px, 1280 够清楚
const int kThumbEdge = 1280;

/// 同一张图同时在路上的块数。电脑那头单连接发送队列 64 格, 4 路留足余量
const int kParallelChunks = 4;

/// 一张按引用的图: 加载中是灰底占位, 拉不到给一句话 + 点一下重试, 拉到了点开全屏。
class NeoxRemoteImage extends ConsumerStatefulWidget {
  const NeoxRemoteImage({super.key, required this.name, this.maxWidth = 260, this.maxHeight = 320});
  final String name;
  final double maxWidth;
  final double maxHeight;

  @override
  ConsumerState<NeoxRemoteImage> createState() => _NeoxRemoteImageState();
}

class _NeoxRemoteImageState extends ConsumerState<NeoxRemoteImage> {
  late Future<File?> _future;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() {
    final cache = NeoxImageCache.instance;
    final ws = ref.read(wsClientProvider.notifier);
    _future = cache
        .cachedOriginal(widget.name)
        .then((f) => f ?? cache.getThumb(ws, widget.name));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final radius = BorderRadius.circular(NeoxRadius.card);
    return FutureBuilder<File?>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return _box(scheme, radius, const SizedBox(
            width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)));
        }
        final file = snap.data;
        if (file == null) {
          return GestureDetector(
            onTap: () => setState(_load),
            child: _box(
              scheme,
              radius,
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.image_outlined, color: scheme.onSurfaceVariant),
                  const SizedBox(height: 4),
                  Text(
                    tr('图片没拉下来，点一下重试'),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          );
        }
        return GestureDetector(
          onTap: () => _openPreview(context, file),
          child: ClipRRect(
            borderRadius: radius,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: widget.maxWidth, maxHeight: widget.maxHeight),
              child: Image.file(
                file,
                fit: BoxFit.contain,
                cacheWidth: (widget.maxWidth * MediaQuery.of(context).devicePixelRatio).round(),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _box(ColorScheme scheme, BorderRadius radius, Widget child) => Container(
        width: widget.maxWidth * 0.75,
        height: 120,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(NeoxSpace.sm),
        decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: radius),
        child: child,
      );

  /// 全屏先摆缩略图, 原图拉到了再换上 (保存/分享也用原图)
  void _openPreview(BuildContext context, File thumb) {
    HapticFeedback.selectionClick();
    final original = NeoxImageCache.instance.get(ref.read(wsClientProvider.notifier), widget.name);
    showDialog<void>(
      context: context,
      builder: (ctx) => FutureBuilder<File?>(
        future: original,
        builder: (ctx, snap) => _preview(ctx, snap.data ?? thumb, loading: snap.connectionState != ConnectionState.done),
      ),
    );
  }

  Widget _preview(BuildContext ctx, File file, {required bool loading}) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(child: Center(child: Image.file(file, gaplessPlayback: true))),
            if (loading)
              const Positioned(
                top: 18,
                left: 18,
                child: SizedBox(
                    width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70)),
              ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.pop(ctx),
              ),
            ),
            Positioned(
              bottom: 16,
              left: 0,
              right: 0,
              child: Center(
                child: FilledButton.tonalIcon(
                  onPressed: () => Share.shareXFiles([XFile(file.path)]),
                  icon: const Icon(Icons.ios_share, size: 18),
                  label: Text(tr('保存或分享')),
                ),
              ),
            ),
          ],
        ),
      );
}

/// 工具行下方的图片条 —— 工具输出默认折叠, 但截图 / 生成的图是用户要看的结果, 不该藏在折叠里
class NeoxImageStrip extends StatelessWidget {
  const NeoxImageStrip({super.key, required this.names});
  final List<String> names;

  @override
  Widget build(BuildContext context) {
    if (names.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, NeoxSpace.xs, NeoxSpace.lg, NeoxSpace.xs),
      child: Wrap(
        spacing: NeoxSpace.xs,
        runSpacing: NeoxSpace.xs,
        children: [
          for (final n in names)
            NeoxRemoteImage(name: n, maxWidth: names.length == 1 ? 260 : 150, maxHeight: names.length == 1 ? 320 : 150),
        ],
      ),
    );
  }
}
