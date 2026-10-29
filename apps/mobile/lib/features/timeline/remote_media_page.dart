/// 电脑上做出来的视频 / 音频: 手机里边下边播 (remote_media_server.dart), 不用先下完。
/// 加载时先摆电脑出的封面图; 底部「分享」才去拉整个文件。
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:video_player/video_player.dart';

import '../../core/artifacts/remote_media_server.dart';
import '../../core/i18n/tr.dart';
import '../../core/network/relay_frame.dart' show chunkBytesOf;
import '../../core/network/ws_client_provider.dart';
import '../../shared/clay/clay.dart';
import 'widgets/remote_image.dart';

bool isMediaArtifact(String name) {
  final n = name.toLowerCase();
  return const ['.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.aac'].any(n.endsWith);
}

bool _isAudio(String name) {
  final n = name.toLowerCase();
  return const ['.mp3', '.wav', '.m4a', '.aac'].any(n.endsWith);
}

class RemoteMediaPage extends ConsumerStatefulWidget {
  const RemoteMediaPage({
    super.key,
    required this.artifactId,
    required this.name,
    required this.sizeBytes,
    required this.mime,
    required this.onShare,
  });

  final String artifactId;
  final String name;
  final int sizeBytes;
  final String mime;
  final VoidCallback onShare;

  @override
  ConsumerState<RemoteMediaPage> createState() => _RemoteMediaPageState();
}

class _RemoteMediaPageState extends ConsumerState<RemoteMediaPage> {
  VideoPlayerController? _ctl;
  Uri? _uri;
  File? _poster;
  String? _error;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final ws = ref.read(wsClientProvider.notifier);
    NeoxImageCache.instance.getArtifactPreview(ws, widget.artifactId).then((f) {
      if (mounted && f != null) setState(() => _poster = f);
    });
    Future<Uint8List?> fetch(int off, int len) async {
      for (var attempt = 0; attempt < 3; attempt++) {
        final b = chunkBytesOf(await ws.fetchArtifactChunk(artifactId: widget.artifactId, offset: off, length: len));
        if (b != null) return b;
      }
      return null;
    }

    try {
      final uri = await RemoteMediaServer.instance.register(fetch: fetch, size: widget.sizeBytes, mime: widget.mime);
      _uri = uri;
      final ctl = VideoPlayerController.networkUrl(uri);
      _ctl = ctl;
      await ctl.initialize();
      ctl.addListener(_tick);
      await ctl.play();
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _error = tr('播放不了，可以分享出去用别的 App 打开'));
    }
  }

  void _tick() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _ctl?.removeListener(_tick);
    _ctl?.dispose();
    final u = _uri;
    if (u != null) RemoteMediaServer.instance.unregister(u);
    super.dispose();
  }

  String _fmt(Duration d) {
    final m = d.inMinutes, s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final ctl = _ctl;
    final ready = ctl != null && ctl.value.isInitialized;
    Widget stage;
    if (ready && !_isAudio(widget.name)) {
      stage = AspectRatio(aspectRatio: ctl.value.aspectRatio, child: VideoPlayer(ctl));
    } else if (_poster != null) {
      stage = Image.file(_poster!, fit: BoxFit.contain);
    } else {
      stage = Icon(_isAudio(widget.name) ? Icons.graphic_eq : Icons.movie_outlined, size: 72, color: c.grey);
    }
    return ClayPage(
      title: widget.name,
      body: Column(
        children: [
          Expanded(
            child: Center(
              child: Stack(
                alignment: Alignment.center,
                children: [
                  stage,
                  if (!ready && _error == null) const ClaySpinner(size: 28),
                ],
              ),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: TextStyle(color: c.grey)),
            ),
          if (ready)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 16, 16),
              child: Row(
                children: [
                  IconButton(
                    icon: Icon(ctl.value.isPlaying ? Icons.pause : Icons.play_arrow, color: c.ink),
                    onPressed: () => ctl.value.isPlaying ? ctl.pause() : ctl.play(),
                  ),
                  Expanded(
                    child: VideoProgressIndicator(ctl, allowScrubbing: true, padding: const EdgeInsets.symmetric(vertical: 12)),
                  ),
                  const SizedBox(width: 8),
                  Text('${_fmt(ctl.value.position)} / ${_fmt(ctl.value.duration)}',
                      style: TextStyle(fontSize: 12, color: c.grey)),
                ],
              ),
            ),
        ],
      ),
      bottom: ClayButton(
        label: tr('分享'),
        icon: Icons.ios_share,
        size: ClayButtonSize.large,
        expand: true,
        onTap: widget.onShare,
      ),
    );
  }
}

/// 网页产物: 电脑后台打开整页截图 (1280 宽), 手机上整页往下滑着看; 分享才拉 .html 原文件
class RemoteSnapshotPage extends ConsumerWidget {
  const RemoteSnapshotPage({super.key, required this.artifactId, required this.name, required this.onShare});

  final String artifactId;
  final String name;
  final VoidCallback onShare;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final ws = ref.read(wsClientProvider.notifier);
    return ClayPage(
      title: name,
      body: FutureBuilder<File?>(
        future: NeoxImageCache.instance.getArtifactPreview(ws, artifactId, edge: 1280),
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: ClaySpinner(size: 28));
          final f = snap.data;
          if (f == null) {
            return Center(child: Text(tr('电脑没出得了这页的截图，可以分享出去用浏览器打开'), style: TextStyle(color: c.grey)));
          }
          return InteractiveViewer(
            maxScale: 4,
            child: SingleChildScrollView(child: Image.file(f, width: double.infinity, fit: BoxFit.fitWidth)),
          );
        },
      ),
      bottom: ClayButton(
        label: tr('分享'),
        icon: Icons.ios_share,
        size: ClayButtonSize.large,
        expand: true,
        onTap: onShare,
      ),
    );
  }
}
