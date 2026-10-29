/// 手机上按需下载的模型 (2026-09-30: 本地语音 / 本地大模型都不进安装包, 用户自己点下载)。
///
/// 一个模型 = 一组文件 (语音: model.onnx + tokens.txt; 大模型: 一个 .gguf)。
/// 落到 `<appSupport>/models/<kind>/<id>/`, 全部下完并逐个校验过 sha256 (有的话) 之后写 `.installed`
/// —— 只有这个标记在才算装好, 下到一半被杀 / 校验失败都不会被当成可用。
///
/// 下载支持断点续传 (Range): 大模型动辄 1~3GB, 手机网络一抖从头来是不可接受的。
/// 同一时刻每个模型只有一个下载任务; 状态是全局的, 设置页和弹窗看到的是同一份进度。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import 'package:neox_app/core/i18n/tr.dart';

class ModelFile {
  const ModelFile({required this.name, required this.urls, required this.size, this.sha256});

  /// 落地文件名
  final String name;

  /// 候选下载地址, 按顺序试 (国内先 ModelScope / R2, 再 HuggingFace)
  final List<String> urls;
  final int size;
  final String? sha256;
}

/// 一个可下载的模型。[manifestUrl] 和 [files] 二选一: 我们自己托管在 R2 的走 manifest,
/// 第三方 (HF / ModelScope) 的在目录里直接写死文件列表。
class ModelPack {
  const ModelPack({
    required this.kind,
    required this.id,
    required this.title,
    this.subtitle = '',
    this.manifestUrl,
    this.files = const [],
    this.approxBytes = 0,
  });

  /// 'asr' | 'llm'
  final String kind;
  final String id;
  final String title;
  final String subtitle;
  final String? manifestUrl;
  final List<ModelFile> files;

  /// 展示用 (manifest 还没拉到时显示这个)
  final int approxBytes;

  String get key => '$kind/$id';

  /* provider family 按它做 key —— 同一个模型不同实例 (目录里新建的) 要算同一个 */
  @override
  bool operator ==(Object other) => other is ModelPack && other.key == key;
  @override
  int get hashCode => key.hashCode;
}

/// paused = 下了一部分、停着 (用户点了暂停, 或者上次下到一半 App 被关了) —— 继续会从断点接着下
enum ModelPhase { notInstalled, downloading, paused, installed, failed }

class ModelStatus {
  const ModelStatus(this.phase, {this.received = 0, this.total = 0, this.error});
  final ModelPhase phase;
  final int received;
  final int total;
  final String? error;

  double get progress => total <= 0 ? 0 : (received / total).clamp(0.0, 1.0);
  bool get installed => phase == ModelPhase.installed;
  bool get downloading => phase == ModelPhase.downloading;
}

class ModelStore extends StateNotifier<Map<String, ModelStatus>> {
  ModelStore() : super(const {});

  final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 20),
    receiveTimeout: const Duration(minutes: 5),
    followRedirects: true,
  ));
  final Map<String, CancelToken> _cancel = {};
  Directory? _root;

  Future<Directory> _rootDir() async {
    final r = _root;
    if (r != null) return r;
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/models');
    await d.create(recursive: true);
    return _root = d;
  }

  Future<Directory> dirOf(ModelPack p) async => Directory('${(await _rootDir()).path}/${p.kind}/${p.id}');

  /// 装好的模型里某个文件的绝对路径
  Future<String> pathOf(ModelPack p, String fileName) async => '${(await dirOf(p)).path}/$fileName';

  ModelStatus statusOf(ModelPack p) => state[p.key] ?? const ModelStatus(ModelPhase.notInstalled);

  /// 读磁盘刷新状态 (设置页 / 弹窗打开时调)
  Future<ModelStatus> refresh(ModelPack p) async {
    final cur = state[p.key];
    if (cur?.downloading == true) return cur!;
    /* 失败态保留着 (带原因), 别被磁盘扫描刷成"下了一半" */
    if (cur?.phase == ModelPhase.failed) return cur!;
    final marker = File('${(await dirOf(p)).path}/.installed');
    ModelStatus s;
    if (await marker.exists()) {
      s = const ModelStatus(ModelPhase.installed);
    } else {
      final got = await diskUsage(p);
      s = got > 0
          ? ModelStatus(ModelPhase.paused, received: got, total: p.approxBytes)
          : const ModelStatus(ModelPhase.notInstalled);
    }
    _set(p, s);
    return s;
  }

  /// 暂停: 停掉下载, 留着已下的部分
  final Set<String> _pausing = {};
  void pause(ModelPack p) {
    if (!_cancel.containsKey(p.key)) return;
    _pausing.add(p.key);
    _cancel[p.key]?.cancel();
  }

  Future<bool> isInstalled(ModelPack p) async => (await refresh(p)).installed;

  /// 已占用的磁盘 (含下到一半的)
  Future<int> diskUsage(ModelPack p) async {
    final d = await dirOf(p);
    if (!await d.exists()) return 0;
    var n = 0;
    await for (final f in d.list()) {
      if (f is File) n += await f.length();
    }
    return n;
  }

  void _set(ModelPack p, ModelStatus s) {
    state = {...state, p.key: s};
  }

  Future<List<ModelFile>> _resolveFiles(ModelPack p) async {
    if (p.files.isNotEmpty) return p.files;
    final url = p.manifestUrl;
    if (url == null) throw StateError(tr('模型没有下载地址'));
    final r = await _dio.get<String>(url, options: Options(responseType: ResponseType.plain));
    final j = jsonDecode(r.data ?? '');
    final files = (j is Map ? j['files'] : null) as List?;
    if (files == null || files.isEmpty) throw StateError(tr('模型清单是空的'));
    return [
      for (final f in files.whereType<Map>())
        ModelFile(
          name: f['name'] as String,
          urls: [f['url'] as String],
          size: (f['size'] as num?)?.toInt() ?? 0,
          sha256: f['sha256'] as String?,
        ),
    ];
  }

  /// 下载 (幂等: 已装好直接返回; 正在下就等同一个任务)
  Future<void> download(ModelPack p) async {
    /* 重试时清掉上次的失败态, 让 refresh 按磁盘重新判断 */
    if (state[p.key]?.phase == ModelPhase.failed) _set(p, const ModelStatus(ModelPhase.notInstalled));
    final before = await refresh(p);
    if (before.installed) return;
    if (_cancel.containsKey(p.key)) return;
    final token = CancelToken();
    _cancel[p.key] = token;
    try {
      _set(p, ModelStatus(ModelPhase.downloading, received: before.received, total: p.approxBytes));
      final files = await _resolveFiles(p);
      final total = files.fold<int>(0, (a, f) => a + f.size);
      final dir = await dirOf(p);
      await dir.create(recursive: true);
      var doneBytes = 0;
      for (final f in files) {
        final target = File('${dir.path}/${f.name}');
        if (await target.exists() && (f.size == 0 || await target.length() == f.size)) {
          doneBytes += await target.length();
          continue;
        }
        await _downloadOne(f, target, token, (got) {
          _set(p, ModelStatus(ModelPhase.downloading, received: doneBytes + got, total: total));
        });
        if (f.sha256 != null) {
          final digest = await sha256.bind(target.openRead()).first;
          if (digest.toString() != f.sha256) {
            await target.delete();
            throw StateError(tr('${f.name} 校验失败，请重新下载'));
          }
        }
        doneBytes += await target.length();
      }
      await File('${dir.path}/.installed').writeAsString(DateTime.now().toIso8601String());
      _set(p, const ModelStatus(ModelPhase.installed));
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) {
        /* 暂停 → 留着已下的; 取消 → 下面 cancel() 自己删 */
        final got = await diskUsage(p);
        _set(
          p,
          _pausing.contains(p.key) && got > 0
              ? ModelStatus(ModelPhase.paused, received: got, total: p.approxBytes)
              : const ModelStatus(ModelPhase.notInstalled),
        );
      } else {
        _set(p, ModelStatus(ModelPhase.failed, error: _dioText(e), received: await diskUsage(p), total: p.approxBytes));
      }
    } catch (e) {
      _set(p, ModelStatus(ModelPhase.failed, error: e.toString().replaceFirst('Bad state: ', '')));
    } finally {
      _cancel.remove(p.key);
      _pausing.remove(p.key);
    }
  }

  /// 一个文件: 先写 .part, 已有 .part 就从断点续; 地址按顺序试, 一个挂了换下一个
  Future<void> _downloadOne(ModelFile f, File target, CancelToken token, void Function(int) onBytes) async {
    final part = File('${target.path}.part');
    Object? lastErr;
    for (final url in f.urls) {
      try {
        var have = await part.exists() ? await part.length() : 0;
        if (f.size > 0 && have > f.size) {
          await part.delete();
          have = 0;
        }
        final resp = await _dio.get<ResponseBody>(
          url,
          cancelToken: token,
          options: Options(
            responseType: ResponseType.stream,
            headers: have > 0 ? {'Range': 'bytes=$have-'} : null,
            receiveTimeout: const Duration(minutes: 2),
          ),
        );
        /* 服务器不认 Range 给了 200 → 从头写 */
        final append = have > 0 && resp.statusCode == 206;
        if (!append) have = 0;
        final sink = part.openWrite(mode: append ? FileMode.append : FileMode.write);
        var got = have;
        try {
          await for (final chunk in resp.data!.stream) {
            sink.add(chunk);
            got += chunk.length;
            onBytes(got);
          }
        } finally {
          await sink.flush();
          await sink.close();
        }
        if (f.size > 0 && await part.length() != f.size) {
          throw StateError(tr('${f.name} 没下完整'));
        }
        await part.rename(target.path);
        return;
      } on DioException catch (e) {
        if (CancelToken.isCancel(e)) rethrow;
        lastErr = e;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? StateError(tr('下载失败'));
  }

  /// Dio 的原始报错是给开发者看的英文长句 ("Failed host lookup … cannot be solved by the library"),
  /// 界面上只说发生了什么、能怎么办
  static String _dioText(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
        return tr('连不上下载服务器，检查网络后重试');
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return tr('网络太慢，下载中断了，重试会接着下');
      case DioExceptionType.badResponse:
        return tr('下载服务器出错 (${e.response?.statusCode ?? '?'})，稍后重试');
      default:
        return tr('下载失败，重试会接着下');
    }
  }

  /// 取消 = 停下并丢掉已下的部分 (要留着用 [pause])
  void cancel(ModelPack p) {
    _cancel[p.key]?.cancel();
    unawaited(delete(p));
  }

  Future<void> delete(ModelPack p) async {
    _cancel[p.key]?.cancel();
    final d = await dirOf(p);
    if (await d.exists()) await d.delete(recursive: true);
    _set(p, const ModelStatus(ModelPhase.notInstalled));
  }
}

final modelStoreProvider = StateNotifierProvider<ModelStore, Map<String, ModelStatus>>((ref) => ModelStore());

/// 某个模型的实时状态 (设置页 / 弹窗 watch 这个)
final modelStatusProvider = Provider.family<ModelStatus, ModelPack>((ref, p) {
  final m = ref.watch(modelStoreProvider);
  return m[p.key] ?? const ModelStatus(ModelPhase.notInstalled);
});

String formatBytes(int b) {
  if (b >= 1 << 30) return '${(b / (1 << 30)).toStringAsFixed(1)} GB';
  if (b >= 1 << 20) return '${(b / (1 << 20)).toStringAsFixed(0)} MB';
  if (b >= 1 << 10) return '${(b / (1 << 10)).toStringAsFixed(0)} KB';
  return '$b B';
}
