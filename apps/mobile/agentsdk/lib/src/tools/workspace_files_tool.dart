/// workspace_files_tool.dart — 手机端"工作区"文件读写.
///
/// 沙箱: 所有路径都锁死在宿主给的 rootDir 下 (app documents/agent_workspace).
/// 越界路径 (.. / 绝对路径逃逸) 一律拒绝. 单文件上限 2MB, 工作区总限额 50MB —
/// 超限时 write 拒绝并引导 agent 用 stats+delete 清理 (手机存储寸土寸金).
library;

import 'dart:io';

import '../types.dart';

class WorkspaceFilesTool implements AgentTool {
  WorkspaceFilesTool({required this.rootDir, this.quotaBytes = 50 * 1024 * 1024});

  /// 沙箱根目录 (宿主创建好后传入).
  final Directory rootDir;

  /// 工作区总限额 — 超过后 write/append 拒绝, 强制先清理.
  final int quotaBytes;

  static const int _maxFileBytes = 2 * 1024 * 1024;

  @override
  ToolSpec get spec => const ToolSpec(
        name: 'workspace_files',
        description: '在手机上的 Agent 工作区读写文件 (沙箱目录, 会话间保留, 总限额 50MB)。'
            'op=list 列目录; op=read 读文件; op=write 写文件 (覆盖); op=append 追加; '
            'op=delete 删除文件或目录; op=mkdir 建目录; op=stats 查看空间占用 '
            '(接近限额时先用 stats 找大文件再 delete 清理)。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {
              'type': 'string',
              'enum': ['list', 'read', 'write', 'append', 'delete', 'mkdir', 'stats'],
            },
            'path': {
              'type': 'string',
              'description': '相对工作区根的路径, 如 "notes/todo.md"。op=list/stats 时可为空 (根目录)',
            },
            'content': {
              'type': 'string',
              'description': 'op=write/append 时要写入的内容',
            },
          },
          'required': ['op'],
        },
      );

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    final op = (args['op'] as String?) ?? '';
    final rel = ((args['path'] as String?) ?? '').trim();

    switch (op) {
      case 'list':
        return _list(rel);
      case 'read':
        return _read(rel);
      case 'write':
        return _write(rel, (args['content'] as String?) ?? '', append: false);
      case 'append':
        return _write(rel, (args['content'] as String?) ?? '', append: true);
      case 'delete':
        return _delete(rel);
      case 'mkdir':
        return _mkdir(rel);
      case 'stats':
        return _stats();
      default:
        return ToolResult.error(
            '未知 op "$op" (支持 list/read/write/append/delete/mkdir/stats)');
    }
  }

  /// 递归统计工作区用量. 返回 (总字节, 文件数, 最大的 5 个文件).
  Future<({int bytes, int files, List<(String, int)> top})> usage() async {
    var bytes = 0;
    var files = 0;
    final sizes = <(String, int)>[];
    if (await rootDir.exists()) {
      await for (final e in rootDir.list(recursive: true)) {
        if (e is File) {
          final s = await e.length();
          bytes += s;
          files++;
          sizes.add((e.path.substring(rootDir.absolute.path.length + 1), s));
        }
      }
    }
    sizes.sort((a, b) => b.$2.compareTo(a.$2));
    return (bytes: bytes, files: files, top: sizes.take(5).toList());
  }

  static String _fmtBytes(int b) {
    if (b >= 1024 * 1024) return '${(b / 1024 / 1024).toStringAsFixed(1)}MB';
    if (b >= 1024) return '${(b / 1024).toStringAsFixed(1)}KB';
    return '${b}B';
  }

  Future<ToolResult> _stats() async {
    final u = await usage();
    final out = StringBuffer()
      ..writeln('工作区用量: ${_fmtBytes(u.bytes)} / ${_fmtBytes(quotaBytes)} '
          '(${u.files} 个文件)');
    if (u.top.isNotEmpty) {
      out.writeln('最大文件:');
      for (final (p, s) in u.top) {
        out.writeln('  $p (${_fmtBytes(s)})');
      }
    }
    return ToolResult.ok(out.toString().trimRight());
  }

  Future<ToolResult> _mkdir(String rel) async {
    final p = _resolvePath(rel);
    if (p == null) return const ToolResult.error('路径无效或越界');
    await Directory(p).create(recursive: true);
    return ToolResult.ok('已创建目录 $rel');
  }

  /// 解析并校验相对路径 — 越界返回 null.
  File? _resolveFile(String rel) {
    final p = _resolvePath(rel);
    return p == null ? null : File(p);
  }

  String? _resolvePath(String rel) {
    if (rel.isEmpty) return null;
    if (rel.startsWith('/') || rel.contains('..')) return null;
    final root = rootDir.absolute.path;
    final full = '$root/$rel';
    /* 归一化后仍须在 root 下 */
    final normalized = Uri.file(full).normalizePath().toFilePath();
    if (!normalized.startsWith(root)) return null;
    return normalized;
  }

  Future<ToolResult> _list(String rel) async {
    final dirPath = rel.isEmpty ? rootDir.absolute.path : _resolvePath(rel);
    if (dirPath == null) return const ToolResult.error('路径越界');
    final dir = Directory(dirPath);
    if (!await dir.exists()) return const ToolResult.ok('(目录为空/不存在)');
    final out = StringBuffer();
    await for (final e in dir.list(recursive: false)) {
      final name = e.path.substring(rootDir.absolute.path.length + 1);
      if (e is Directory) {
        out.writeln('$name/');
      } else if (e is File) {
        final size = await e.length();
        out.writeln('$name ($size B)');
      }
    }
    final s = out.toString();
    return ToolResult.ok(s.isEmpty ? '(目录为空)' : s);
  }

  Future<ToolResult> _read(String rel) async {
    final f = _resolveFile(rel);
    if (f == null) return const ToolResult.error('路径无效或越界');
    if (!await f.exists()) return ToolResult.error('文件不存在: $rel');
    if (await f.length() > _maxFileBytes) {
      return const ToolResult.error('文件超过 2MB, 拒绝读取');
    }
    return ToolResult.ok(await f.readAsString());
  }

  Future<ToolResult> _write(String rel, String content,
      {required bool append}) async {
    final f = _resolveFile(rel);
    if (f == null) return const ToolResult.error('路径无效或越界');
    if (content.length > _maxFileBytes) {
      return const ToolResult.error('内容超过 2MB, 拒绝写入');
    }
    /* 总限额检查 — 超限时拒绝并引导清理, 防手机存储被沙箱吃满 */
    final u = await usage();
    if (u.bytes + content.length > quotaBytes) {
      return ToolResult.error(
        '工作区已满 (${_fmtBytes(u.bytes)}/${_fmtBytes(quotaBytes)})。'
        '先用 op=stats 查看大文件, 再用 op=delete 清理不需要的内容。',
      );
    }
    await f.parent.create(recursive: true);
    await f.writeAsString(content,
        mode: append ? FileMode.append : FileMode.write);
    return ToolResult.ok('已${append ? '追加' : '写入'} $rel (${content.length} 字符)');
  }

  Future<ToolResult> _delete(String rel) async {
    final p = _resolvePath(rel);
    if (p == null) return const ToolResult.error('路径无效或越界');
    final f = File(p);
    if (await f.exists()) {
      await f.delete();
      return ToolResult.ok('已删除 $rel');
    }
    /* 目录删除 — 清理场景常见 (整个过期目录一把删) */
    final d = Directory(p);
    if (await d.exists()) {
      await d.delete(recursive: true);
      return ToolResult.ok('已删除目录 $rel');
    }
    return ToolResult.error('文件不存在: $rel');
  }
}
