/// 用户发出去的附件在手机上的留底 (2026-09-30 用户: 「发送图片能看到图片了, 但图片没有在
/// timeline 的消息上渲染」)。
///
/// 为什么要单独留底而不是塞进事件表:
///   · 电脑会话的 user_message 是电脑**回显**回来的, 里面没有图 (图在中转 256KB 上限那头被瘦成
///     `[图片]`), 手机这边能拿到原图的只有发送那一刻。
///   · 手机本地会话的图片一直没落库 (payload 只记 `has_attachments: true`), 切回会话就没了。
///   · 事件表按 (session, seq) 入库, 回显那条的 seq 发送时还不知道 —— 没法在发送时写对行。
///
/// 所以: 发送时把字节写到 `<docs>/attachments/<sessionId>/<sha256>.<ext>`, 同目录 index.json
/// 记一条 {ts, text, items}; 时间线渲染 user_message 时按 (同文本, 时间窗 ±2 分钟) 找回来。
/// 索引按会话整个读进内存 (一个会话几十条量级), 匹配是同步的, 不卡渲染。
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

import '../storage/app_paths.dart';

class LocalAttachmentRef {
  const LocalAttachmentRef({
    required this.kind,
    required this.name,
    required this.mime,
    required this.path,
    required this.size,
  });

  /// 'image' | 'file'
  final String kind;
  final String name;
  final String mime;
  /// 绝对路径
  final String path;
  final int size;

  bool get isImage => kind == 'image';

  Map<String, Object?> toJson() => {
        'kind': kind,
        'name': name,
        'mime': mime,
        'path': path,
        'size': size,
      };

  static LocalAttachmentRef? fromJson(Object? j) {
    if (j is! Map) return null;
    final kind = j['kind'];
    final path = j['path'];
    if (kind is! String || path is! String || path.isEmpty) return null;
    return LocalAttachmentRef(
      kind: kind,
      name: (j['name'] as String?) ?? '',
      mime: (j['mime'] as String?) ?? 'application/octet-stream',
      /* iOS 升级后容器换了 UUID, 存的旧绝对路径要换到当前容器 */
      path: AppPaths.rebase(path),
      size: (j['size'] is int) ? j['size'] as int : 0,
    );
  }
}

class _Record {
  _Record({required this.ts, required this.text, required this.items});
  final int ts;
  final String text;
  final List<LocalAttachmentRef> items;

  Map<String, Object?> toJson() => {
        'ts': ts,
        'text': text,
        'items': [for (final i in items) i.toJson()],
      };
}

/// 待写入的一项 —— composer 里的 _AttachmentItem 转过来
typedef PendingAttachment = ({String kind, String name, String mime, Uint8List bytes});

/// 回显跟发送之间允许的时间差。桌面回显一般在 1s 内, 但远程弱网 + 重连补发可能拖到几十秒。
const int kAttachmentMatchWindowMs = 2 * 60 * 1000;

class LocalAttachmentStore {
  LocalAttachmentStore._();
  static final LocalAttachmentStore instance = LocalAttachmentStore._();

  final Map<String, List<_Record>> _bySession = {};
  final Map<String, Future<void>> _loading = {};
  Directory? _root;

  Future<Directory> _rootDir() async {
    final r = _root;
    if (r != null) return r;
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}/attachments');
    await dir.create(recursive: true);
    return _root = dir;
  }

  Future<Directory> _sessionDir(String sessionId) async {
    final safe = sessionId.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    final d = Directory('${(await _rootDir()).path}/$safe');
    await d.create(recursive: true);
    return d;
  }

  /// 把这一次发送的附件落盘并登记。返回可直接挂到 pending 气泡上的引用。
  Future<List<LocalAttachmentRef>> save(
    String sessionId,
    String text,
    List<PendingAttachment> items, {
    int? ts,
  }) async {
    if (items.isEmpty) return const [];
    await load(sessionId);
    final dir = await _sessionDir(sessionId);
    final refs = <LocalAttachmentRef>[];
    for (final it in items) {
      final digest = sha256.convert(it.bytes).toString();
      final ext = _extOf(it.name, it.mime);
      final file = File('${dir.path}/$digest$ext');
      if (!await file.exists()) await file.writeAsBytes(it.bytes, flush: true);
      refs.add(LocalAttachmentRef(
        kind: it.kind,
        name: it.name,
        mime: it.mime,
        path: file.path,
        size: it.bytes.length,
      ));
    }
    final rec = _Record(
      ts: ts ?? DateTime.now().millisecondsSinceEpoch,
      text: _norm(text),
      items: refs,
    );
    (_bySession[sessionId] ??= []).add(rec);
    await _writeIndex(sessionId);
    return refs;
  }

  /// 还没有会话 id 时 (按下发送 → 连电脑 / 建会话那几秒) 先把附件落到临时目录, 给占位气泡画缩略图用。
  /// 不登记索引; 会话建好后照常 [save]。
  Future<List<LocalAttachmentRef>> preview(List<PendingAttachment> items) async {
    if (items.isEmpty) return const [];
    final dir = Directory('${(await _rootDir()).path}/_sending');
    await dir.create(recursive: true);
    return [
      for (final it in items)
        await () async {
          final file = File('${dir.path}/${sha256.convert(it.bytes)}${_extOf(it.name, it.mime)}');
          if (!await file.exists()) await file.writeAsBytes(it.bytes, flush: true);
          return LocalAttachmentRef(kind: it.kind, name: it.name, mime: it.mime, path: file.path, size: it.bytes.length);
        }(),
    ];
  }

  /// 把某会话的索引读进内存 (幂等, 并发只读一次)。时间线 hydrate 前调。
  Future<void> load(String sessionId) {
    if (_bySession.containsKey(sessionId)) return Future.value();
    return _loading[sessionId] ??= _loadInner(sessionId).whenComplete(() {
      _loading.remove(sessionId);
    });
  }

  Future<void> _loadInner(String sessionId) async {
    final list = <_Record>[];
    try {
      final f = File('${(await _sessionDir(sessionId)).path}/index.json');
      if (await f.exists()) {
        final raw = jsonDecode(await f.readAsString());
        if (raw is List) {
          for (final r in raw.whereType<Map>()) {
            final items = (r['items'] is List)
                ? (r['items'] as List).map(LocalAttachmentRef.fromJson).whereType<LocalAttachmentRef>().toList()
                : <LocalAttachmentRef>[];
            if (items.isEmpty) continue;
            list.add(_Record(
              ts: (r['ts'] is int) ? r['ts'] as int : 0,
              text: (r['text'] as String?) ?? '',
              items: items,
            ));
          }
        }
      }
    } catch (_) {
      /* 索引坏了就当没有 —— 图还在盘上, 但对不上号; 不能因此让整个会话渲染不出来 */
    }
    _bySession[sessionId] = list;
  }

  /// 同步匹配: 已加载的会话里, 同文本且时间最近 (±2 分钟) 的那条。没加载过 / 没有 → null。
  List<LocalAttachmentRef>? match(String sessionId, String text, int ts) {
    final list = _bySession[sessionId];
    if (list == null || list.isEmpty) return null;
    final key = _norm(text);
    /* 只发附件没打字: 留底记的是空串, 而时间线上这条写的是占位 (手机本地「📎 文件名」/「图片」,
     * 电脑回显「看一下这些附件」)。这种只按时间窗配, 否则附件永远挂不上去。 */
    final placeholder = _isPlaceholder(key);
    _Record? best;
    for (final r in list) {
      if (r.text != key && !(r.text.isEmpty && placeholder)) continue;
      final d = (r.ts - ts).abs();
      if (d > kAttachmentMatchWindowMs) continue;
      if (best == null || d < (best.ts - ts).abs()) best = r;
    }
    return best?.items;
  }

  /// 会话删掉时把留底一起删 (删除必须连存档一起删)。
  Future<void> deleteSession(String sessionId) async {
    _bySession.remove(sessionId);
    try {
      final d = await _sessionDir(sessionId);
      if (await d.exists()) await d.delete(recursive: true);
    } catch (_) {}
  }

  Future<void> _writeIndex(String sessionId) async {
    final list = _bySession[sessionId] ?? const <_Record>[];
    final f = File('${(await _sessionDir(sessionId)).path}/index.json');
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode([for (final r in list) r.toJson()]), flush: true);
    await tmp.rename(f.path);
  }

  /// 匹配用的文本口径: 去首尾空白、压缩连续空白。桌面回显会剥 `<current-time>` 之类的标签
  /// (timeline_state._stripHiddenContextTags), 调用方传进来的是剥过的。
  static String _norm(String s) => s.trim().replaceAll(RegExp(r'\s+'), ' ');

  static bool _isPlaceholder(String t) =>
      t.isEmpty ||
      t == '图片' ||
      t == '（附件）' ||
      t == '看一下这些附件' ||
      t.startsWith('📎');

  static String _extOf(String name, String mime) {
    final i = name.lastIndexOf('.');
    if (i >= 0 && name.length - i <= 6) return name.substring(i).toLowerCase();
    switch (mime) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/webp':
        return '.webp';
      case 'image/gif':
        return '.gif';
      default:
        return '';
    }
  }
}
