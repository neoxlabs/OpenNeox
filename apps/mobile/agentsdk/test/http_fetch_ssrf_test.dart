/// http_fetch_ssrf_test.dart — SSRF 防护回归.
///
/// 背景: README 一直宣称 http_fetch "拒内网/环回/CGNAT", 但此前**一条测试都没有**,
/// 实测存在两个可直接打穿的绕过 (重定向跟随 / IPv4-mapped IPv6)。这个文件把这些
/// 路径全部钉死, 避免以后重构时静默回归。
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:neox_agent_sdk/neox_agent_sdk.dart';
import 'package:test/test.dart';

/// 可编程假 Client: 按 URL 决定返回重定向还是正文, 并记录所有实际发出的请求.
class _FakeClient extends http.BaseClient {
  _FakeClient(this.handler);

  final http.StreamedResponse Function(http.BaseRequest req) handler;
  final List<Uri> sent = [];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    sent.add(request.url);
    return handler(request);
  }
}

http.StreamedResponse _resp(
  int status, {
  String body = '',
  Map<String, String> headers = const {},
}) =>
    http.StreamedResponse(
      Stream.value(utf8.encode(body)),
      status,
      headers: headers,
    );

ToolContext get _ctx => ToolContext(cancel: AgentCancelToken(), sessionId: 't');

void main() {
  group('http_fetch SSRF — 直连内网', () {
    for (final host in <String>[
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254', // 云元数据服务
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '[::1]',
      '[::ffff:192.168.1.1]', // IPv4-mapped IPv6 — 曾经能绕过
      '[::ffff:127.0.0.1]',
      '[fc00::1]', // ULA
    ]) {
      test('拒绝 $host', () async {
        final client = _FakeClient((_) => _resp(200, body: 'SHOULD NOT REACH'));
        final tool = HttpFetchTool(client: client);
        final r = await tool.run({'url': 'http://$host/admin'}, _ctx);

        expect(r.isError, isTrue, reason: '$host 必须被拒');
        expect(r.output, contains('内网'));
        expect(client.sent, isEmpty, reason: '$host 不该真的发出请求');
      });
    }
  });

  group('http_fetch SSRF — 重定向绕过', () {
    test('302 跳内网被拦下 (核心回归)', () async {
      /* 攻击形态: 模型拿到一个看起来正常的公网 URL, 服务端 302 到路由器后台。
       * 修复前 http.Client 自动跟随, 检查只发生在第一跳 → 完全绕过。*/
      final client = _FakeClient((req) {
        if (req.url.host == 'evil.example.com') {
          return _resp(302, headers: {'location': 'http://192.168.1.1/admin'});
        }
        return _resp(200, body: 'ROUTER ADMIN PAGE');
      });
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://evil.example.com/x'}, _ctx);

      expect(r.isError, isTrue);
      expect(r.output, contains('重定向目标'));
      expect(
        client.sent.map((u) => u.host),
        equals(['evil.example.com']),
        reason: '内网那一跳绝不能真的发出去',
      );
    });

    test('多级重定向: 公网→公网→内网 同样拦下', () async {
      final client = _FakeClient((req) {
        switch (req.url.host) {
          case 'a.example.com':
            return _resp(302, headers: {'location': 'http://b.example.com/'});
          case 'b.example.com':
            return _resp(302, headers: {'location': 'http://10.1.2.3/'});
          default:
            return _resp(200, body: 'INTERNAL');
        }
      });
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://a.example.com/'}, _ctx);

      expect(r.isError, isTrue);
      expect(r.output, contains('内网'));
      expect(client.sent.any((u) => u.host == '10.1.2.3'), isFalse);
    });

    test('正常公网重定向仍然跟随', () async {
      final client = _FakeClient((req) {
        if (req.url.host == 'old.example.com') {
          return _resp(301, headers: {'location': 'http://new.example.com/ok'});
        }
        return _resp(200, body: 'FINAL', headers: {'content-type': 'text/plain'});
      });
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://old.example.com/'}, _ctx);

      expect(r.isError, isFalse);
      expect(r.output, contains('FINAL'));
      expect(client.sent.length, 2);
    });

    test('重定向链过长 → 报错而不是无限跟随', () async {
      var n = 0;
      final client = _FakeClient((_) {
        n++;
        return _resp(302, headers: {'location': 'http://h$n.example.com/'});
      });
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://h0.example.com/'}, _ctx);

      expect(r.isError, isTrue);
      expect(r.output, contains('重定向次数过多'));
      expect(client.sent.length, lessThanOrEqualTo(6));
    });

    test('重定向到非 http(s) 协议被拒', () async {
      final client = _FakeClient(
        (_) => _resp(302, headers: {'location': 'file:///etc/passwd'}),
      );
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://pub.example.com/'}, _ctx);

      expect(r.isError, isTrue);
      expect(r.output, contains('协议'));
    });
  });

  group('http_fetch 响应体封顶', () {
    test('超大响应按 256KB 截断且不 OOM', () async {
      /* 修复前走 resp.bodyBytes: 先整体读进内存再截, 手机上是真会 OOM 的。*/
      final chunk = List<int>.filled(64 * 1024, 0x41); // 'A'
      final client = _FakeClient(
        (_) => http.StreamedResponse(
          Stream.fromIterable(List.generate(200, (_) => chunk)), // 12.8MB
          200,
          headers: const {'content-type': 'text/plain'},
        ),
      );
      final tool = HttpFetchTool(client: client);
      final r = await tool.run({'url': 'http://big.example.com/'}, _ctx);

      expect(r.isError, isFalse);
      /* 头部那行 "HTTP 200 text/plain\n\n" 之外, 正文不超过上限 */
      expect(r.output.length, lessThan(256 * 1024 + 128));
    });
  });

  group('http_fetch 协议白名单', () {
    for (final url in ['file:///etc/passwd', 'ftp://x.com/', 'gopher://x/']) {
      test('拒绝 $url', () async {
        final client = _FakeClient((_) => _resp(200));
        final tool = HttpFetchTool(client: client);
        final r = await tool.run({'url': url}, _ctx);
        expect(r.isError, isTrue);
        expect(client.sent, isEmpty);
      });
    }
  });
}
