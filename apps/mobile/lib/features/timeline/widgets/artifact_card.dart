/// artifact_card.dart — timeline 里的「agent 做出来的文件」卡片.
///
/// 用户原话: "我让他做个 PPT, 做完了结果不能下载"。这张卡是那个出口。
///
/// 交互刻意做成一步: 点卡片 = 下载 + 弹系统分享面板。分享面板本身就同时提供
/// 「存储到文件」「用 WPS 打开」「发给微信好友」「AirDrop」—— 自己再做一个
/// 下载目录 + 文件管理器只会更绕, 而且用户拿到文件之后想干什么本来就不该我们猜。
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/artifacts/artifact_download.dart';
import '../../../core/errors/friendly_error.dart';
import '../../../shared/clay/clay.dart';
import '../../../core/network/ws_client_provider.dart';
import '../artifact_preview_page.dart';
import '../remote_media_page.dart';
import 'remote_image.dart' show NeoxImageCache;
import '../state/timeline_state.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ArtifactCard extends ConsumerStatefulWidget {
  const ArtifactCard({super.key, required this.entry});

  final TimelineEntry entry;

  @override
  ConsumerState<ArtifactCard> createState() => _ArtifactCardState();
}

class _ArtifactCardState extends ConsumerState<ArtifactCard> {
  double? _progress;
  bool _busy = false;

  Map<String, dynamic> get _args => widget.entry.args ?? const {};
  String get _name => (_args['name'] as String?) ?? tr('文件');
  int get _size => (_args['size_bytes'] as num?)?.toInt() ?? 0;
  String? get _artifactId => _args['artifact_id'] as String?;
  String? get _localPath => _args['local_path'] as String?;

  /// 电脑上的产物 (不是手机本机做的)
  bool get _remote => (_artifactId ?? '').isNotEmpty && (_localPath ?? '').isEmpty;
  bool get _isHtml => _name.toLowerCase().endsWith('.html') || _name.toLowerCase().endsWith('.htm');

  /// 卡片上的预览图: 电脑出 (Office / PDF 首页、视频封面、网页首屏…), 只拉一张小图
  late final Future<File?>? _preview = _remote
      ? NeoxImageCache.instance.getArtifactPreview(ref.read(wsClientProvider.notifier), _artifactId!)
      : null;

  /// 点卡片: 能预览的先打开预览 (2026-10-12 用户: 「不支持展示, 点击后应该有渲染器预览」); 预览页右上角再分享。
  /// 电脑上的视频 / 音频边下边播, 网页看电脑出的整页截图 —— 都不用先把整个文件拉下来。
  Future<void> _open() {
    if (_remote && isMediaArtifact(_name)) {
      return Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => RemoteMediaPage(
          artifactId: _artifactId!,
          name: _name,
          sizeBytes: _size,
          mime: (_args['mime'] as String?) ?? 'application/octet-stream',
          onShare: _openShare,
        ),
      ));
    }
    if (_remote && _isHtml) {
      return Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => RemoteSnapshotPage(artifactId: _artifactId!, name: _name, onShare: _openShare),
      ));
    }
    return _openFile();
  }

  Future<void> _openFile() => _fetchThen((file) async {
    if (!ArtifactPreviewPage.canPreview(_name)) return _shareFile(file);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ArtifactPreviewPage(file: file, name: _name),
      ),
    );
  });

  Future<void> _openShare() => _fetchThen(_shareFile);

  Future<void> _shareFile(File file) async {
    /* sharePositionOrigin: iPad 上不给锚点会直接抛 —— 用卡片自己的位置 */
    final box = context.findRenderObject() as RenderBox?;
    await Share.shareXFiles(
      [XFile(file.path, name: _name)],
      sharePositionOrigin: box == null
          ? null
          : box.localToGlobal(Offset.zero) & box.size,
    );
  }

  Future<void> _fetchThen(Future<void> Function(File) then) async {
    final id = _artifactId;
    if (id == null || id.isEmpty) return;
    if (_busy) return;
    setState(() {
      _busy = true;
      _progress = 0;
    });
    try {
      final file = await ref
          .read(artifactDownloaderProvider)
          .download(
            artifactId: id,
            name: _name,
            sizeBytes: _size,
            localPath: _localPath,
            onProgress: (p) {
              if (mounted) setState(() => _progress = p.fraction);
            },
          );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _progress = null;
      });
      await then(file);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(friendlyError(e, fallback: tr('拿文件失败，请重试')))),
        );
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _progress = null;
        });
      }
    }
  }

  IconData get _icon {
    final n = _name.toLowerCase();
    if (n.endsWith('.pptx') || n.endsWith('.ppt'))
      return Icons.slideshow_outlined;
    if (n.endsWith('.docx') || n.endsWith('.doc'))
      return Icons.description_outlined;
    if (n.endsWith('.xlsx') || n.endsWith('.csv'))
      return Icons.table_chart_outlined;
    if (n.endsWith('.pdf')) return Icons.picture_as_pdf_outlined;
    if (n.endsWith('.zip')) return Icons.folder_zip_outlined;
    if (n.endsWith('.mp4') || n.endsWith('.mp3') || n.endsWith('.wav')) {
      return Icons.play_circle_outline;
    }
    if (n.endsWith('.png') ||
        n.endsWith('.jpg') ||
        n.endsWith('.jpeg') ||
        n.endsWith('.webp') ||
        n.endsWith('.gif') ||
        n.endsWith('.svg')) {
      return Icons.image_outlined;
    }
    return Icons.insert_drive_file_outlined;
  }

  /// 文件类型的一句话 (「演示文稿」「表格」…), 跟大小拼在名字下面
  String get _kindLabel {
    final n = _name.toLowerCase();
    if (n.endsWith('.pptx') || n.endsWith('.ppt')) return tr('演示文稿');
    if (n.endsWith('.docx') || n.endsWith('.doc')) return tr('文档');
    if (n.endsWith('.xlsx') || n.endsWith('.csv')) return tr('表格');
    if (n.endsWith('.pdf')) return 'PDF';
    if (n.endsWith('.md') || n.endsWith('.txt')) return tr('文本');
    if (n.endsWith('.html')) return tr('网页');
    if (_isImage) return tr('图片');
    final dot = n.lastIndexOf('.');
    return dot >= 0 ? n.substring(dot + 1).toUpperCase() : tr('文件');
  }

  bool get _isImage {
    final n = _name.toLowerCase();
    return n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.webp') || n.endsWith('.gif');
  }

  /// 图存进相册; 其它文件交给系统分享面板 (里面有「保存到文件」)
  Future<void> _saveToPhone() => _fetchThen((file) async {
    if (!_isImage) return _shareFile(file);
    try {
      await Gal.putImage(file.path, album: 'Neox');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('已存到相册'))));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendlyError(e, fallback: tr('没存成，去设置里给相册权限')))));
      }
    }
  });

  /// 陶土稿 v5「成品卡」: 大块泥板, 左边陶土方块图标, 名字 + 类型 · 大小, 底下 预览 / 分享 / 存到手机.
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final sizeText = formatBytes(_size);
    final playable = _remote && isMediaArtifact(_name);
    final canPreview = ArtifactPreviewPage.canPreview(_name) || playable;
    final sub = _busy
        ? (_progress == null || _progress == 0 ? tr('正在取…') : tr('正在取 ${((_progress ?? 0) * 100).toStringAsFixed(0)}%'))
        : [_kindLabel, if (sizeText.isNotEmpty) sizeText].join(' · ');

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: ClaySlab(
        radius: 18,
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
        onTap: _busy ? null : _open,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            /* 本机做出来的图直接在对话里露出来, 不用点开才知道画了什么 */
            if (_localImage != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 260),
                    child: Image.file(
                      _localImage!,
                      fit: BoxFit.contain,
                      cacheWidth: 900,
                      errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                    ),
                  ),
                ),
              ),
            if (_preview != null)
              FutureBuilder<File?>(
                future: _preview,
                builder: (context, snap) {
                  final f = snap.data;
                  if (f == null) return const SizedBox.shrink();
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxHeight: 220),
                            child: Image.file(
                              f,
                              width: double.infinity,
                              /* 网页是整页长图, 卡片上只露首屏 */
                              fit: _isHtml ? BoxFit.cover : BoxFit.contain,
                              alignment: Alignment.topCenter,
                              cacheWidth: 900,
                              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                            ),
                          ),
                          if (playable)
                            const DecoratedBox(
                              decoration: BoxDecoration(color: Color(0x66000000), shape: BoxShape.circle),
                              child: Padding(
                                padding: EdgeInsets.all(10),
                                child: Icon(Icons.play_arrow, color: Colors.white, size: 32),
                              ),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            Row(
              children: [
                _busy
                    ? SizedBox(
                        width: 44,
                        height: 44,
                        child: const Center(child: ClaySpinner(size: 20)),
                      )
                    : ClayTile(icon: _icon, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _name,
                        /* 图已经露在上面了, 名字一行就够 (生图的文件名很长) */
                        maxLines: _localImage != null ? 1 : 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink, height: 1.3),
                      ),
                      const SizedBox(height: 2),
                      Text(sub, style: TextStyle(fontSize: 12.5, color: c.grey)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                if (canPreview) ...[
                  Expanded(child: ClayButton.ink(label: playable ? tr('播放') : tr('预览'), size: ClayButtonSize.small, expand: true, onTap: _busy ? null : _open)),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: ClayButton(label: tr('分享'), kind: ClayButtonKind.clay, size: ClayButtonSize.small, expand: true, onTap: _busy ? null : _openShare),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ClayButton(label: tr('存到手机'), kind: ClayButtonKind.clay, size: ClayButtonSize.small, expand: true, onTap: _busy ? null : _saveToPhone),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// 本机已有的图片产物 (手机 Agent 做的) —— 远端产物要下载, 不在列表里预取
  File? get _localImage {
    final p = _localPath;
    if (p == null) return null;
    final n = _name.toLowerCase();
    if (!(n.endsWith('.png') ||
        n.endsWith('.jpg') ||
        n.endsWith('.jpeg') ||
        n.endsWith('.webp') ||
        n.endsWith('.gif')))
      return null;
    final f = File(p);
    return f.existsSync() ? f : null;
  }
}

bool isImageArtifact(Map<String, dynamic> a) {
  final n = '${a['name'] ?? ''}'.toLowerCase();
  return n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.webp') || n.endsWith('.gif');
}

/// 一轮里的配图 / 素材: 一排 64 的小方缩略图 +「素材 · N 张」, 点一张看大图。
/// 2026-10-14 实测: 做 PPT 时两张配图各占一整屏大卡, 真正的成品 PPT 被挤到最底下。
class ArtifactThumbRow extends StatelessWidget {
  const ArtifactThumbRow({super.key, required this.artifacts});
  final List<Map<String, dynamic>> artifacts;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(tr('素材 · ${artifacts.length} 张'), style: TextStyle(fontSize: 12.5, color: c.grey)),
          const SizedBox(height: 6),
          SizedBox(
            height: 64,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: artifacts.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final a = artifacts[i];
                final p = a['local_path'] as String?;
                final f = p == null ? null : File(p);
                final ok = f != null && f.existsSync();
                return GestureDetector(
                  onTap: ok
                      ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ArtifactPreviewPage(file: f, name: '${a['name']}')))
                      : null,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      width: 64,
                      height: 64,
                      color: c.fill,
                      child: ok
                          ? Image.file(f, fit: BoxFit.cover, cacheWidth: 200, errorBuilder: (_, __, ___) => Icon(Icons.image_outlined, color: c.grey))
                          : Icon(Icons.image_outlined, color: c.grey),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// 一条 tool entry 上挂的所有产物 —— 摊成一列卡片, 没有就零占位.
class ArtifactStrip extends StatelessWidget {
  const ArtifactStrip({super.key, required this.entry, this.skipImages = false});

  final TimelineEntry entry;

  /// 图片另外收成一排小缩略图 ([ArtifactThumbRow]) —— 这一轮有文档成品时, 配图只是素材
  final bool skipImages;

  @override
  Widget build(BuildContext context) {
    final arts = entry.artifacts?.where((a) => !skipImages || !isImageArtifact(a)).toList();
    if (arts == null || arts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final a in arts)
          ArtifactCard(
            key: ValueKey('art-${a['id'] ?? a['name']}'),
            entry: TimelineEntry(
              id: 'artifact-${a['id'] ?? a['name']}',
              kind: 'artifact',
              sequence: entry.sequence,
              timestamp: entry.timestamp,
              args: {
                'artifact_id': a['id'],
                'name': a['name'],
                'size_bytes': a['size_bytes'],
                'mime': a['mime'],
                if (a['local_path'] != null) 'local_path': a['local_path'],
              },
            ),
          ),
      ],
    );
  }
}
