/// apk_updater.dart — 下载 APK 并拉起安装 (App 内更新的执行端).
///
/// 分工:
///   app_update.dart  查清单, 判断"有没有新版 / 要不要强更"
///   本文件           下载那个 APK, 交给系统安装器
///   ApkInstaller.kt  未知来源授权判定 + FileProvider 授 URI + 拉起安装器
///
/// 为什么下载放 Dart 侧: 进度、取消、断点重下这些都要接 UI, 在 Dart 里写比穿过
/// MethodChannel 往回喂进度简单得多; 而原生那边只留"必须原生做"的三件事。
///
/// 落盘位置 `getExternalFilesDir/updates/` ——
///   · 应用私有外部目录, **不需要任何存储权限**
///   · 卸载时随应用清掉, 不在用户手机里留 90MB 垃圾
///   · 跟 file_paths.xml 里 FileProvider 暴露的那一个子目录严格对应
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show debugPrint, kDebugMode, visibleForTesting;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

const MethodChannel _channel = MethodChannel('neox.update/apk');

/// 分段下载的门槛与并发度.
///
/// 4 条连接是移动网络上的经验值: 再多对单个 CDN 节点收益递减, 还容易被限速。
/// 8MB 以下不值得分段 (握手成本比省下的时间多)。
const int _kMaxConnections = 4;
const int _kMinSegmentBytes = 4 * 1024 * 1024;
const int _kMinSizeForRanges = 8 * 1024 * 1024;

enum ApkUpdatePhase { idle, downloading, readyToInstall, installing, failed }

class ApkUpdateState {
  const ApkUpdateState({
    this.phase = ApkUpdatePhase.idle,
    this.receivedBytes = 0,
    this.totalBytes = 0,
    this.error,
    this.filePath,
    this.bytesPerSecond = 0,
  });

  final ApkUpdatePhase phase;
  final int receivedBytes;
  final int totalBytes;
  final String? error;
  final String? filePath;

  /// 实测速度 (字节/秒) — 0 = 还没有样本.
  final int bytesPerSecond;

  /// 「3.2 MB/s」; 没有样本时空字符串.
  String get speedLabel {
    if (bytesPerSecond <= 0) return '';
    final mb = bytesPerSecond / 1048576;
    return mb >= 1
        ? '${mb.toStringAsFixed(1)} MB/s'
        : '${(bytesPerSecond / 1024).round()} KB/s';
  }

  /// 剩余时间 —— 有速度和总长才算得出.
  String get etaLabel {
    if (bytesPerSecond <= 0 || totalBytes <= 0) return '';
    final left = ((totalBytes - receivedBytes) / bytesPerSecond).round();
    if (left <= 0) return '';
    if (left < 60) return tr('约 $left 秒');
    return tr('约 ${(left / 60).ceil()} 分钟');
  }

  /// 0.0~1.0; 总长未知时返 null (UI 应显示不确定进度而不是假装 0%).
  double? get progress =>
      totalBytes > 0 ? (receivedBytes / totalBytes).clamp(0.0, 1.0) : null;

  bool get busy =>
      phase == ApkUpdatePhase.downloading || phase == ApkUpdatePhase.installing;

  String get progressLabel {
    if (totalBytes <= 0) return tr('下载中…');
    final mb = (receivedBytes / 1048576).toStringAsFixed(1);
    final total = (totalBytes / 1048576).toStringAsFixed(1);
    return '$mb / $total MB';
  }

  ApkUpdateState copyWith({
    ApkUpdatePhase? phase,
    int? receivedBytes,
    int? totalBytes,
    String? error,
    String? filePath,
    int? bytesPerSecond,
  }) => ApkUpdateState(
    phase: phase ?? this.phase,
    receivedBytes: receivedBytes ?? this.receivedBytes,
    totalBytes: totalBytes ?? this.totalBytes,
    error: error,
    filePath: filePath ?? this.filePath,
    bytesPerSecond: bytesPerSecond ?? this.bytesPerSecond,
  );
}

class ApkUpdater extends StateNotifier<ApkUpdateState> {
  ApkUpdater() : super(const ApkUpdateState());

  http.Client? _client;

  /// 下载并安装. [version] 只用于文件名, 方便排查"装的到底是哪个包".
  Future<void> downloadAndInstall({
    required String url,
    required String version,
  }) async {
    if (state.busy) return;
    state = const ApkUpdateState(phase: ApkUpdatePhase.downloading);
    _received = 0;
    _lastEmitBytes = 0;
    _lastEmitMs = 0;

    File? file;
    try {
      final dir = await _updatesDir();
      /* 同版本已经下过就不重下 —— 用户点了安装却因为没授权退回来时, 再点一次
       * 不该再花 90MB 流量。大小对得上才认, 半截文件一律重下。 */
      file = File('${dir.path}/neox-$version.apk');
      if (await file.exists()) {
        final len = await file.length();
        if (len > 0) {
          final remote = await _remoteLength(url);
          if (remote == null || remote == len) {
            state = state.copyWith(
              phase: ApkUpdatePhase.readyToInstall,
              receivedBytes: len,
              totalBytes: len,
              filePath: file.path,
            );
            await install();
            return;
          }
        }
        await file.delete();
      }

      await _cleanupOldApks(dir, keepName: 'neox-$version.apk');

      final probe = await _probe(url);
      final total = probe.length ?? 0;
      state = state.copyWith(totalBytes: total);

      /* 分段并发下载 (2026-09-17 用户: 「速度很慢, 同样的 R2 直接下载超快」)。
       *
       * 原来是一条 HTTP/1.1 连接顺着流写盘。浏览器下同一个链接快得多, 差别不在服务端:
       * Chrome 走 HTTP/3, 而 Dart 的 HttpClient 只有 HTTP/1.1 —— 单连接在丢包/高延迟
       * 的移动网络上吃不满带宽。补偿办法是开多条连接各拿一段 (R2 支持 Range),
       * 把单连接的拥塞窗口限制摊开。
       *
       * 只在**服务端明确支持 Range 且知道总长**时分段; 否则老老实实单流, 不赌。 */
      if (total > _kMinSizeForRanges && probe.acceptsRanges) {
        await _downloadRanged(url: url, file: file, total: total);
      } else {
        await _downloadSingle(url: url, file: file, total: total);
      }

      final written = await file.length();
      /* 断流会得到一个"成功"但缺字节的文件, 装上去是解析失败。总长已知就必须核对。 */
      if (total > 0 && written != total) {
        await file.delete();
        throw FileSystemException(tr('下载不完整，请重试'));
      }

      state = state.copyWith(
        phase: ApkUpdatePhase.readyToInstall,
        receivedBytes: written,
        totalBytes: written,
        filePath: file.path,
      );
      await install();
    } catch (e) {
      if (kDebugMode) debugPrint('[apk-updater] $e');
      try {
        if (file != null && await file.exists()) await file.delete();
      } catch (_) {}
      state = ApkUpdateState(phase: ApkUpdatePhase.failed, error: _friendly(e));
    } finally {
      _client?.close();
      _client = null;
    }
  }

  /// 拉起系统安装器. 未授权"安装未知应用"时先把用户送去授权页.
  Future<void> install() async {
    final path = state.filePath;
    if (path == null) return;
    try {
      final can = await _channel.invokeMethod<bool>('canInstall') ?? false;
      if (!can) {
        /* Android 8 起这是按应用授权的。不引导的话用户点了安装什么都不会发生 ——
         * 那种"点了没反应"是最难自查的一类问题。 */
        await _channel.invokeMethod<void>('openInstallPermissionSettings');
        state = state.copyWith(
          phase: ApkUpdatePhase.readyToInstall,
          error: tr('请在刚打开的页面允许 Neox 安装应用，然后回来再点一次安装'),
        );
        return;
      }
      state = state.copyWith(phase: ApkUpdatePhase.installing);
      final err = await _channel.invokeMethod<String?>('install', {
        'path': path,
      });
      if (err != null) {
        state = state.copyWith(phase: ApkUpdatePhase.failed, error: err);
        return;
      }
      /* 拉起后本进程即将被系统替换, 停在 installing 就好 —— 用户取消安装时
       * 回到 App 仍是这个状态, 再点一次即可。 */
    } on PlatformException catch (e) {
      state = state.copyWith(
        phase: ApkUpdatePhase.failed,
        error: e.message ?? tr('安装失败'),
      );
    }
  }

  void reset() => state = const ApkUpdateState();

  void cancel() {
    _client?.close();
    _client = null;
    state = const ApkUpdateState();
  }

  @override
  void dispose() {
    _client?.close();
    super.dispose();
  }

  /* ── 下载 ───────────────────────────────────────────────────── */

  /// 单流下载 — 服务端不支持 Range 或总长未知时的老路.
  Future<void> _downloadSingle({
    required String url,
    required File file,
    required int total,
  }) async {
    final client = http.Client();
    _client = client;
    final resp = await client
        .send(http.Request('GET', Uri.parse(url)))
        .timeout(const Duration(seconds: 30));
    if (resp.statusCode != 200) {
      throw HttpException(tr('下载失败 (${resp.statusCode})'));
    }
    final sink = file.openWrite();
    try {
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        _onBytes(chunk.length, total);
      }
      await sink.flush();
    } finally {
      await sink.close();
    }
  }

  /// 分段并发下载 — N 条连接各取一段, 写进同一个文件的对应偏移.
  ///
  /// 用 RandomAccessFile 直接按偏移写, 不在内存里拼 90MB。
  /// 任何一段失败整体抛错 (上层会删掉半截文件并提示重试) —— 不做"部分成功"的假象。
  ///
  /// ⚠️ 每段**各开一个文件句柄**, 不许共用 (2026-09-18 真机实录):
  /// 共用一个 RandomAccessFile 时下载会报 `An async operation is currently pending`
  /// —— 一个句柄只有一个游标, 也只允许一个在途异步操作, 四段一交错就撞上。
  /// 各开一个句柄各有各的游标, 顺带还省掉了每个 chunk 一次 setPosition。
  Future<void> _downloadRanged({
    required String url,
    required File file,
    required int total,
  }) async {
    final segments = _planSegments(total);
    /* 先把文件撑到总长再关掉 —— 各段随后按自己的偏移写 */
    final sizer = await file.open(mode: FileMode.write);
    try {
      await sizer.truncate(total);
    } finally {
      await sizer.close();
    }
    final client = http.Client();
    _client = client;
    await Future.wait([
      for (final seg in segments)
        _fetchSegment(
          client: client,
          url: url,
          file: file,
          start: seg.$1,
          end: seg.$2,
          total: total,
        ),
    ]);
  }

  /// 给测试用 —— 区间算错的后果 (APK 装不上) 只有装的时候才暴露, 必须可测.
  @visibleForTesting
  List<(int, int)> debugPlanSegments(int total) => _planSegments(total);

  /// 给测试用 —— 分段下载必须**真跑一遍**才测得到.
  ///
  /// 2026-09-18 那个 `An async operation is currently pending` (四段共用一个文件句柄)
  /// 就是纯算区间的测试拦不住的: 区间全对, 一落地就炸。所以留这个缝, 让测试拿真的
  /// HTTP server 跑一遍并逐字节比对。
  @visibleForTesting
  Future<void> debugDownloadRanged({
    required String url,
    required File file,
    required int total,
  }) => _downloadRanged(url: url, file: file, total: total);

  /// 按段数切区间 —— 每段至少 [_kMinSegmentBytes], 最多 [_kMaxConnections] 段.
  List<(int, int)> _planSegments(int total) {
    var count = (total / _kMinSegmentBytes).floor();
    if (count > _kMaxConnections) count = _kMaxConnections;
    if (count < 1) count = 1;
    final size = (total / count).ceil();
    return [
      for (var i = 0; i < count; i++)
        (i * size, (i == count - 1) ? total - 1 : ((i + 1) * size - 1)),
    ];
  }

  Future<void> _fetchSegment({
    required http.Client client,
    required String url,
    required File file,
    required int start,
    required int end,
    required int total,
  }) async {
    final req = http.Request('GET', Uri.parse(url))
      ..headers['range'] = 'bytes=$start-$end';
    final resp = await client.send(req).timeout(const Duration(seconds: 30));
    /* 206 才是"给了这一段"; 200 意味着服务端无视了 Range, 整包又来一遍 —— 拒绝, 别写花文件 */
    if (resp.statusCode != 206) {
      throw HttpException(tr('下载失败 (分段 ${resp.statusCode})'));
    }
    /* 本段自己的句柄: append = 可读写且**不截断** (write 会把前面段写好的内容清掉).
     * 定位一次就够, 之后游标随写入自己前进 —— 这个游标不跟别的段共享。 */
    final raf = await file.open(mode: FileMode.append);
    var offset = start;
    try {
      await raf.setPosition(start);
      await for (final chunk in resp.stream) {
        await raf.writeFrom(chunk);
        offset += chunk.length;
        _onBytes(chunk.length, total);
      }
      await raf.flush();
    } finally {
      await raf.close();
    }
    if (offset != end + 1) {
      throw FileSystemException(tr('下载不完整，请重试'));
    }
  }

  /* 进度/测速: 每 512KB 才推一次状态 —— 逐 chunk setState 会把 UI 线程刷爆,
   * 下载 90MB 期间界面反而卡住。速度用"上次推送到现在"的均值, 够稳也够准。 */
  int _received = 0;
  int _lastEmitBytes = 0;
  int _lastEmitMs = 0;

  void _onBytes(int n, int total) {
    _received += n;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_lastEmitMs == 0) _lastEmitMs = now;
    final enough = _received - _lastEmitBytes >= 512 * 1024;
    if (!enough && !(total > 0 && _received >= total)) return;
    final dtMs = now - _lastEmitMs;
    final speed = dtMs > 0
        ? ((_received - _lastEmitBytes) * 1000 / dtMs).round()
        : state.bytesPerSecond;
    _lastEmitBytes = _received;
    _lastEmitMs = now;
    state = state.copyWith(receivedBytes: _received, bytesPerSecond: speed);
  }

  /* ── helpers ────────────────────────────────────────────────── */

  Future<Directory> _updatesDir() async {
    /* 必须是 external-files-dir: file_paths.xml 里 FileProvider 只暴露了它下面的
     * updates/。换成 getApplicationDocumentsDirectory 的话 URI 授不出去。 */
    final base =
        await getExternalStorageDirectory() ??
        await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/updates');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// 旧版本的包留着纯占地方 (一个就 90MB), 下新的之前清掉.
  Future<void> _cleanupOldApks(
    Directory dir, {
    required String keepName,
  }) async {
    try {
      await for (final e in dir.list()) {
        if (e is File &&
            e.path.endsWith('.apk') &&
            !e.path.endsWith(keepName)) {
          await e.delete();
        }
      }
    } catch (_) {
      /* 清理失败不影响下载 */
    }
  }

  Future<int?> _remoteLength(String url) async => (await _probe(url)).length;

  /// HEAD 一次拿总长 + 是否支持 Range (分段下载的前提).
  Future<({int? length, bool acceptsRanges})> _probe(String url) async {
    try {
      final r = await http
          .head(Uri.parse(url))
          .timeout(const Duration(seconds: 8));
      final len = int.tryParse(r.headers['content-length'] ?? '');
      final ranges = (r.headers['accept-ranges'] ?? '').toLowerCase();
      return (length: len, acceptsRanges: ranges.contains('bytes'));
    } catch (_) {
      return (length: null, acceptsRanges: false);
    }
  }

  String _friendly(Object e) {
    if (e is TimeoutException) return tr('下载超时，请检查网络后重试');
    if (e is SocketException) return tr('网络连接中断，请重试');
    if (e is FileSystemException) return _ownMessageOr(e.message, tr('写入文件失败，请检查存储空间后重试'));
    if (e is HttpException) return _ownMessageOr(e.message, tr('下载失败，请稍后重试'));
    return tr('更新失败，请稍后重试');
  }

  /// 只透传**我们自己写的**那些提示, 运行时的原文一律换成人话.
  ///
  /// 2026-09-18 真机截图: 更新页上一行红字 `An async operation is currently pending`
  /// —— 那是 Dart 运行时的 FileSystemException.message, 被原样透传上来的。
  /// 用户既看不懂也没法处置; 而我们自己抛的都是中文 ('下载不完整，请重试' 之类),
  /// 所以判据就是"有没有中日韩字符": 有就是我们写的, 没有就是运行时原文。
  String _ownMessageOr(String? raw, String fallback) {
    final s = raw?.trim() ?? '';
    if (s.isEmpty) return fallback;
    final ours = RegExp(r'[一-鿿]').hasMatch(s);
    return ours ? s : fallback;
  }
}

final apkUpdaterProvider = StateNotifierProvider<ApkUpdater, ApkUpdateState>(
  (ref) => ApkUpdater(),
);
