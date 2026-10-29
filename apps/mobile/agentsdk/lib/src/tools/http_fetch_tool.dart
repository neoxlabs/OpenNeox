/// http_fetch_tool.dart — 联网取网页/API 的内置工具.
///
/// 安全边界:
///   - 只允许 http/https
///   - 拒绝内网/环回地址 (SSRF 防护 — 手机在家庭网内, 不能让模型探测路由器)
///   - 响应体截断 256KB; HTML 做粗提纯 (剥 script/style/tag) 省 token
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../types.dart';

class HttpFetchTool implements AgentTool {
  HttpFetchTool({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  static const int _maxBodyBytes = 256 * 1024;
  static const Duration _timeout = Duration(seconds: 20);
  static const int _maxRedirects = 5;

  @override
  ToolSpec get spec => const ToolSpec(
        name: 'http_fetch',
        description: '通过 HTTP(S) 获取网页或 API 数据。返回响应文本 (HTML 会提纯为可读文本)。'
            '适合: 查网页内容、调公开 API、下载文本数据。不能访问内网地址。',
        parameters: {
          'type': 'object',
          'properties': {
            'url': {
              'type': 'string',
              'description': '完整 URL (http:// 或 https://)',
            },
            'method': {
              'type': 'string',
              'enum': ['GET', 'POST'],
              'description': '默认 GET',
            },
            'body': {
              'type': 'string',
              'description': 'POST 请求体 (JSON 字符串等), 仅 method=POST 时有效',
            },
            'headers': {
              'type': 'object',
              'description': '额外请求头 (如 {"Accept":"application/json"})',
            },
          },
          'required': ['url'],
        },
      );

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    final rawUrl = (args['url'] as String?)?.trim() ?? '';
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || !(uri.isScheme('http') || uri.isScheme('https'))) {
      return const ToolResult.error('url 必须是 http:// 或 https:// 开头的完整地址');
    }
    if (await _isPrivateHost(uri.host)) {
      return const ToolResult.error('拒绝访问内网/环回地址');
    }

    final method = ((args['method'] as String?) ?? 'GET').toUpperCase();
    final headers = <String, String>{
      'User-Agent': 'NeoxAgent/1.0 (Android)',
    };
    final rawHeaders = args['headers'];
    if (rawHeaders is Map) {
      rawHeaders.forEach((k, v) {
        if (v is String) headers['$k'] = v;
      });
    }

    try {
      return await _sendWithGuardedRedirects(
        uri: uri,
        method: method,
        headers: headers,
        body: args['body'] as String?,
      ).timeout(_timeout);
    } on TimeoutException {
      return const ToolResult.error('请求超时 (20s)');
    } catch (e) {
      return ToolResult.error('请求失败: $e');
    }
  }

  /// 手工跟随重定向, **每一跳都重新做 SSRF 校验**.
  ///
  /// 为什么不能用 http.Client 自带的重定向:
  ///   Client 默认 followRedirects=true, 而 SSRF 检查只可能发生在第一个 URL 上。
  ///   攻击者 (或被提示词注入的模型) 只要给一个公网 URL, 让它 302 跳到
  ///   http://192.168.1.1/ 或 169.254.169.254, 整个防护就形同虚设 —— 这是 SSRF
  ///   最经典的绕过路径。所以这里关掉自动重定向, 自己一跳一跳地验。
  ///
  /// 同时把响应体改成**流式按字节封顶**: 原来走 resp.bodyBytes 是先把整个响应
  /// 完整读进内存再截断, 手机上遇到一个几百 MB 的 URL 直接 OOM。
  Future<ToolResult> _sendWithGuardedRedirects({
    required Uri uri,
    required String method,
    required Map<String, String> headers,
    String? body,
  }) async {
    var current = uri;
    var currentMethod = method;
    String? currentBody = body;

    for (var hop = 0; hop <= _maxRedirects; hop++) {
      final req = http.Request(currentMethod, current)
        ..followRedirects = false
        ..headers.addAll(headers);
      if (currentMethod == 'POST' && currentBody != null) {
        req.body = currentBody;
      }

      final streamed = await _client.send(req);
      final status = streamed.statusCode;

      /* 3xx + Location → 校验目标后再跳 */
      final location = streamed.headers['location'];
      if (status >= 300 && status < 400 && location != null) {
        /* 把这一跳的响应体丢掉, 不然 socket 不释放 */
        await streamed.stream.drain<void>();
        if (hop == _maxRedirects) {
          return const ToolResult.error('重定向次数过多');
        }
        final next = current.resolve(location);
        if (!(next.isScheme('http') || next.isScheme('https'))) {
          return const ToolResult.error('重定向目标协议不允许');
        }
        if (await _isPrivateHost(next.host)) {
          /* 明确说明是被重定向带进内网的, 便于排查 */
          return const ToolResult.error('拒绝访问内网/环回地址 (重定向目标)');
        }
        /* 303, 以及 301/302 对 POST 的惯例: 降级成 GET 且丢 body */
        if (status == 303 || (currentMethod == 'POST' && status != 307 && status != 308)) {
          currentMethod = 'GET';
          currentBody = null;
        }
        current = next;
        continue;
      }

      final contentType = streamed.headers['content-type'] ?? '';
      final bytes = await _readCapped(streamed.stream);
      var text = _decodeBody(bytes);
      if (contentType.contains('text/html')) {
        text = extractReadableText(text);
      }
      final out = 'HTTP $status ${contentType.split(';').first}\n\n$text';
      return status >= 400 ? ToolResult.error(out) : ToolResult.ok(out);
    }
    return const ToolResult.error('重定向次数过多');
  }

  /// 边收边数, 到上限就断流 —— 不把整个响应读进内存.
  Future<List<int>> _readCapped(Stream<List<int>> stream) async {
    final buf = <int>[];
    await for (final chunk in stream) {
      final room = _maxBodyBytes - buf.length;
      if (room <= 0) break;
      buf.addAll(chunk.length > room ? chunk.sublist(0, room) : chunk);
      if (buf.length >= _maxBodyBytes) break;
    }
    return buf;
  }

  String _decodeBody(List<int> bytes) {
    final limited =
        bytes.length > _maxBodyBytes ? bytes.sublist(0, _maxBodyBytes) : bytes;
    try {
      return utf8.decode(limited, allowMalformed: true);
    } catch (_) {
      return String.fromCharCodes(limited);
    }
  }

  /// SSRF 防护 — 解析后任一地址是环回/私网/链路本地都拒.
  Future<bool> _isPrivateHost(String host) async {
    final literal = InternetAddress.tryParse(host);
    if (literal != null) return _isPrivateAddr(literal);
    try {
      final resolved = await InternetAddress.lookup(host)
          .timeout(const Duration(seconds: 5));
      return resolved.any(_isPrivateAddr);
    } catch (_) {
      /* 解析失败让请求自己去失败, 报网络错误更直观 */
      return false;
    }
  }

  bool _isPrivateAddr(InternetAddress a) {
    if (a.isLoopback || a.isLinkLocal) return true;
    var raw = a.rawAddress;

    /* IPv4-mapped IPv6 (::ffff:10.0.0.1) 的 type 是 IPv6, 走不到下面的 IPv4 分支,
     * 而上面只挡了 ULA —— 于是 ::ffff:10.0.0.1 / ::ffff:127.0.0.1 能直接绕过整个
     * 私网判定。这里先把后 4 字节还原成 IPv4 再统一判。
     * 同理 IPv4-compatible (::a.b.c.d, 已废弃但仍可解析)。*/
    if (a.type == InternetAddressType.IPv6 && raw.length == 16) {
      final isMapped = raw.take(10).every((b) => b == 0) &&
          raw[10] == 0xff &&
          raw[11] == 0xff;
      final isCompat =
          raw.take(12).every((b) => b == 0) && !(raw[12] == 0 && raw[13] == 0);
      if (isMapped || isCompat) {
        raw = raw.sublist(12);
      } else {
        if ((raw[0] & 0xfe) == 0xfc) return true; // fc00::/7 ULA
        return false;
      }
    }

    if (raw.length == 4) {
      if (raw[0] == 0) return true; // 0.0.0.0/8 — 多数栈上等价 localhost
      if (raw[0] == 10) return true;
      if (raw[0] == 127) return true; // 兜底: 非 InternetAddress 判定路径
      if (raw[0] == 172 && raw[1] >= 16 && raw[1] <= 31) return true;
      if (raw[0] == 192 && raw[1] == 168) return true;
      if (raw[0] == 192 && raw[1] == 0 && raw[2] == 0) return true; // IETF 保留
      if (raw[0] == 169 && raw[1] == 254) return true; // 链路本地 + 云元数据
      if (raw[0] == 100 && raw[1] >= 64 && raw[1] <= 127) return true; // CGNAT
      if (raw[0] == 198 && (raw[1] == 18 || raw[1] == 19)) return true; // benchmark
    }
    return false;
  }
}

/// HTML → 可读文本 (粗提纯): 剥 script/style/noscript/注释, 标签换空白, 实体解码.
/// 不追求完美 — 目标是给 LLM 一份省 token 的正文.
String extractReadableText(String html) {
  var s = html
      .replaceAll(
        RegExp(
          r'<(script|style|noscript|svg|head)[^>]*>[\s\S]*?</\1>',
          caseSensitive: false,
        ),
        ' ',
      )
      .replaceAll(RegExp(r'<!--[\s\S]*?-->'), ' ');
  /* 块级标签换行, 其余换空格 */
  s = s.replaceAll(
    RegExp(r'</?(p|div|br|li|tr|h[1-6]|section|article)[^>]*>',
        caseSensitive: false),
    '\n',
  );
  s = s.replaceAll(RegExp(r'<[^>]+>'), ' ');
  s = s
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");
  /* 压空白 */
  s = s.replaceAll(RegExp(r'[ \t]+'), ' ');
  s = s.replaceAll(RegExp(r'\n\s*\n+'), '\n\n');
  return s.trim();
}
