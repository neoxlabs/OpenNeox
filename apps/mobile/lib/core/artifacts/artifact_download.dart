/// artifact_download.dart — 把 agent 做出来的文件真正拿到手机上.
///
/// 起因是用户那句原话: "我让他做个 PPT, 做完了结果不能下载"。
/// 之前 timeline 里只有一行文件名文本, 手机端零出口 —— 附件是**单向**的
/// (手机能传上去, 桌面产出的拿不回来)。
///
/// 两条来源, 一个出口:
///   - 电脑会话 → JSON-RPC `file.fetch` 按 artifact_id 分块拉 (LAN 直连和云中继
///     两条 transport 共用同一个信封, 中继那条自带 E2E 加密);
///   - 手机本地会话 → 文件本来就在本机沙箱里 (agentsdk 的 WorkspaceFilesTool
///     写在 app_flutter/agent_workspace), 直接读, 不走网络。
///
/// 为什么不开 HTTP/FTP 端口: 桌面 wsServer 只在 LAN 上监听, 出差在外 (Mode B)
/// 就下不到了 —— 而"人在外面, 让电脑干完活把结果发我"恰恰是最需要这个功能的
/// 场景。走 RPC 信封两条路都通。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../network/relay_frame.dart' show chunkBytesOf;
import '../network/ws_client_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 单块原始字节数 — 跟桌面 `FILE_FETCH_CHUNK_BYTES` 对齐.
/// WS 单帧上限 2MB, base64 膨胀 4/3 后 512KB → ~683KB, 余量充足.
const int kArtifactChunkBytes = 512 * 1024;

/// 云中转已走 v2 (字节不进 base64、传输层分片): 一块 1MB, 电脑那头上限也是 1MB
const int kArtifactChunkBytesFrames = 1024 * 1024;

/// 下载进度 0.0~1.0; total 未知时 received 仍然有效.
class ArtifactProgress {
  const ArtifactProgress({required this.received, required this.total});
  final int received;
  final int total;
  double get fraction => total <= 0 ? 0 : (received / total).clamp(0.0, 1.0);
}

class ArtifactDownloadException implements Exception {
  ArtifactDownloadException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ArtifactDownloader {
  ArtifactDownloader(this._ref);
  final Ref _ref;

  /// 下载到 app 缓存目录, 返回本地文件. 已经下过就直接复用 (按 id+size 命名).
  ///
  /// [localPath] 非空 = 手机本地会话的产物, 直接拷贝, 不走网络.
  Future<File> download({
    required String artifactId,
    required String name,
    required int sizeBytes,
    String? localPath,
    void Function(ArtifactProgress)? onProgress,
  }) async {
    final target = await _targetFile(artifactId, name);
    /* 已完整下过 → 秒回。用户点两次分享不该重下一遍 */
    if (await target.exists() && await target.length() == sizeBytes && sizeBytes > 0) {
      onProgress?.call(ArtifactProgress(received: sizeBytes, total: sizeBytes));
      return target;
    }

    if (localPath != null && localPath.isNotEmpty) {
      final src = File(localPath);
      if (!await src.exists()) {
        throw ArtifactDownloadException(tr('文件已经不在了，可能被清理掉了'));
      }
      await src.copy(target.path);
      final len = await target.length();
      onProgress?.call(ArtifactProgress(received: len, total: len));
      return target;
    }

    return _fetchOverRpc(
      artifactId: artifactId,
      target: target,
      sizeBytes: sizeBytes,
      onProgress: onProgress,
    );
  }

  Future<File> _fetchOverRpc({
    required String artifactId,
    required File target,
    required int sizeBytes,
    void Function(ArtifactProgress)? onProgress,
  }) async {
    final ws = _ref.read(wsClientProvider.notifier);
    /* 边下边写, 不在内存里攒整个文件 —— 100MB 的产物攒内存会直接把 app 打死。
     * 断点续传: 上次断在半路留下的 .part 不删, 这次从它的长度接着拉 (文件名带 id + 大小, 同一份内容) */
    final tmp = File('${target.path}.part');
    var received = await tmp.exists() ? await tmp.length() : 0;
    if (received > sizeBytes) {
      await tmp.delete();
      received = 0;
    }
    final sink = tmp.openWrite(mode: FileMode.append);
    final chunkLen = ws.relayFramesActive ? kArtifactChunkBytesFrames : kArtifactChunkBytes;
    try {
      var eof = received > 0 && received == sizeBytes;
      while (!eof) {
        Map<String, dynamic>? chunk;
        /* 一块失败先重试两次 (网络抖一下不至于整个重来) */
        for (var attempt = 0; attempt < 3 && chunk == null; attempt++) {
          if (attempt > 0) await Future<void>.delayed(Duration(milliseconds: 500 * attempt));
          chunk = await ws.fetchArtifactChunk(artifactId: artifactId, offset: received, length: chunkLen);
        }
        if (chunk == null) {
          throw ArtifactDownloadException(tr('电脑没有响应，确认电脑端 Neox 还开着'));
        }
        final bytes = chunkBytesOf(chunk);
        if (bytes == null) {
          throw ArtifactDownloadException(tr('电脑返回的数据不完整'));
        }
        sink.add(bytes);
        received += bytes.length;
        onProgress?.call(
          ArtifactProgress(received: received, total: sizeBytes),
        );
        eof = chunk['eof'] == true;
        /* 防御: 服务端一直回 0 字节又不说 eof, 会转成死循环 */
        if (bytes.isEmpty && !eof) {
          throw ArtifactDownloadException(tr('传输中断，请重试'));
        }
      }
      await sink.close();
      if (await target.exists()) await target.delete();
      await tmp.rename(target.path);
      return target;
    } catch (_) {
      /* 已经拉到的留着, 下次点下载从断点接着拉 */
      await sink.close().catchError((_) {});
      rethrow;
    }
  }

  Future<File> _targetFile(String artifactId, String name) async {
    final dir = Directory(
      p.join((await getApplicationCacheDirectory()).path, 'artifacts'),
    );
    await dir.create(recursive: true);
    /* 用 artifactId 做子目录: 同名文件 (汇报.pptx 改了三版) 不会互相覆盖,
     * 而文件名保持原样 —— 分享出去的名字必须是用户认识的那个。 */
    final sub = Directory(p.join(dir.path, _safeSegment(artifactId)));
    await sub.create(recursive: true);
    return File(p.join(sub.path, _safeName(name)));
  }

  static String _safeSegment(String s) =>
      s.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');

  /// 文件名保留中文, 只挡路径分隔符和控制字符 —— 分享出去要让人认得出来.
  static String _safeName(String s) {
    final cleaned = s
        .replaceAll(RegExp(r'[/\\]'), '_')
        .replaceAll(RegExp(r'[\x00-\x1f]'), '')
        .trim();
    if (cleaned.isEmpty || cleaned == '.' || cleaned == '..') return 'file';
    return cleaned.length > 120 ? cleaned.substring(cleaned.length - 120) : cleaned;
  }
}

final artifactDownloaderProvider = Provider<ArtifactDownloader>(
  ArtifactDownloader.new,
);

/// 人话大小 — 卡片上显示.
String formatBytes(int bytes) {
  if (bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  var v = bytes.toDouble();
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i == 0 ? '$bytes B' : '${v.toStringAsFixed(v >= 10 ? 0 : 1)} ${units[i]}';
}
