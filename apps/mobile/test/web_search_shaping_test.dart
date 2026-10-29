// chat:C3-04 / C3-06 / C3-07 —— 手机 Chat 搜索的三条口径。
//
// 1. 域名去重: 8 条结果不再是同一家网站的 8 个页面 (同域最多 2 条);
// 2. 3s 超时: 一家搜索源慢不再把整轮卡住, 超时给模型一句「换个词 / 用已有信息答」;
// 3. 注入预算: 单次搜索结果 ≤1500 token (中文按 1 字 1 token 保守估算)。
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:neox_app/core/local_agent/hosted_web_search.dart';
import 'package:neox_app/core/local_agent/web_search_shaping.dart';

WebSearchHit _hit(String url, {String title = 't', String snippet = 's'}) =>
    WebSearchHit(title: title, url: url, snippet: snippet);

/// 仓库既有换算口径 (packages/kernel 的 promptSize probe 测试 / chat_light_harness_test):
/// 中文 1 字 ≈ 1 token, 其余 3.5 字符 ≈ 1 token。这里独立算一遍, 不复用被测函数。
int _estimateTokens(String s) {
  var cjk = 0;
  var other = 0;
  for (final rune in s.runes) {
    final isCjk = (rune >= 0x2E80 && rune <= 0x9FFF) ||
        (rune >= 0xF900 && rune <= 0xFAFF) ||
        (rune >= 0xFF00 && rune <= 0xFFEF) ||
        (rune >= 0x3000 && rune <= 0x303F);
    if (isCjk) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + (other / 3.5).ceil();
}

class _ScriptedSearch implements HostedWebSearch {
  _ScriptedSearch(this._fn);
  final Future<List<WebSearchHit>> Function(String query) _fn;

  @override
  bool get available => true;

  @override
  Future<List<WebSearchHit>> search(String query, {int count = 8}) => _fn(query);
}

void main() {
  group('chat:C3-04 按域名去重', () {
    test('同一家网站的 8 个页面只留 2 条, 其余让给别的站点', () {
      final hits = [
        for (var i = 0; i < 8; i++) _hit('https://example.com/a$i'),
      ];
      final out = diversifyByDomain(hits);
      expect(out.length, 2);
      expect(out.every((h) => domainKeyOf(h.url) == 'example.com'), isTrue);
    });

    test('相关性顺序不变: 只跳过超配额的那几条, 不重排', () {
      final hits = [
        _hit('https://a.com/1'),
        _hit('https://a.com/2'),
        _hit('https://a.com/3'),
        _hit('https://b.com/1'),
        _hit('https://a.com/4'),
        _hit('https://c.com/1'),
      ];
      final out = diversifyByDomain(hits);
      expect(out.map((h) => h.url), [
        'https://a.com/1',
        'https://a.com/2',
        'https://b.com/1',
        'https://c.com/1',
      ]);
    });

    test('www. / m. 前缀算同一家; 不同子域算不同来源', () {
      final hits = [
        _hit('https://www.zhihu.com/q/1'),
        _hit('https://zhihu.com/q/2'),
        _hit('https://m.zhihu.com/q/3'),
        _hit('https://news.163.com/1'),
        _hit('https://sports.163.com/1'),
      ];
      final out = diversifyByDomain(hits);
      /* zhihu 三种写法归一 → 最多 2 条; 163 的两个子域各自算一家 → 都留 */
      expect(out.length, 4);
      expect(out.map((h) => h.url), [
        'https://www.zhihu.com/q/1',
        'https://zhihu.com/q/2',
        'https://news.163.com/1',
        'https://sports.163.com/1',
      ]);
    });

    test('8 条各来自不同站点时一条都不砍 (不为了多样性丢结果)', () {
      final hits = [for (var i = 0; i < 8; i++) _hit('https://site$i.com/x')];
      expect(diversifyByDomain(hits).length, 8);
    });

    test('空 URL / 非法 URL 不炸, 也不会把正常结果顶掉', () {
      final hits = [_hit(''), _hit('not a url'), _hit('https://a.com/1')];
      expect(() => diversifyByDomain(hits), returnsNormally);
      expect(diversifyByDomain(hits).length, 3);
    });
  });

  group('chat:C3-07 注入预算 ≤1500 token', () {
    test('20 条长结果被截到预算内, 并如实说还有几条没显示', () {
      final hits = [
        for (var i = 0; i < 20; i++)
          _hit(
            'https://site$i.com/a',
            title: '标题 $i ${'很长的标题' * 5}',
            snippet: '摘要 $i ${'这是一段很长的摘要内容' * 8}',
          ),
      ];
      final shaped = shapeSearchResults(hits);
      expect(shaped.text.length, lessThanOrEqualTo(kSearchInjectCharBudget));
      expect(_estimateTokens(shaped.text), lessThanOrEqualTo(kSearchInjectTokenBudget));
      expect(shaped.tokens, lessThanOrEqualTo(kSearchInjectTokenBudget));
      expect(shaped.shown, lessThan(hits.length));
      expect(shaped.truncated, isTrue);
      expect(shaped.text, contains('还有 ${hits.length - shaped.shown} 条结果未显示'));
    });

    test('纯英文长结果同样卡在预算内 (不是只对中文生效)', () {
      final hits = [
        for (var i = 0; i < 20; i++)
          _hit(
            'https://site$i.com/a',
            title: 'title $i ${'very long english title ' * 4}',
            snippet: 'snippet $i ${'a fairly long english snippet body ' * 10}',
          ),
      ];
      final shaped = shapeSearchResults(hits);
      expect(_estimateTokens(shaped.text), lessThanOrEqualTo(kSearchInjectTokenBudget));
      expect(shaped.shown, lessThan(hits.length));
    });

    test('预算口径: 1500 token, 字符上限是同一件事的粗略换算式', () {
      expect(kSearchInjectTokenBudget, 1500);
      expect(kSearchInjectCharBudget, 2550);
    });

    test('结果少的时候一条不砍, 也不加省略提示', () {
      final hits = [_hit('https://a.com/1', title: '短标题', snippet: '短摘要')];
      final shaped = shapeSearchResults(hits);
      expect(shaped.shown, 1);
      expect(shaped.truncated, isFalse);
      expect(shaped.text, isNot(contains('未显示')));
      expect(shaped.text, contains('短标题'));
      expect(shaped.text, contains('https://a.com/1'));
    });

    test('单条超长摘要也能放进预算 (截断, 不是整条丢掉)', () {
      final shaped = shapeSearchResults([
        _hit('https://a.com/1', title: '标题', snippet: '超长' * 3000),
      ]);
      expect(shaped.shown, 1);
      expect(_estimateTokens(shaped.text), lessThanOrEqualTo(kSearchInjectTokenBudget));
      expect(shaped.text, contains('https://a.com/1'));
    });

    test('空结果返回空文本 (工具层自己决定怎么说)', () {
      expect(shapeSearchResults(const []).text, isEmpty);
    });
  });

  group('chat:C3-06 3s 超时', () {
    test('上游卡住时 3s 内返回, 是 ok 不是 error (不诱导模型原样重试)', () async {
      final tool = WebSearchTool(
        _ScriptedSearch((q) => Completer<List<WebSearchHit>>().future),
      );
      final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());
      final started = DateTime.now();
      final r = await tool.run({'query': '今天金价'}, ctx);
      final elapsed = DateTime.now().difference(started);

      expect(kChatSearchTimeout, const Duration(seconds: 3));
      expect(elapsed.inMilliseconds, lessThan(5000));
      expect(r.isError, isFalse);
      expect(r.output, contains('超时'));
      expect(r.output, contains('不要用同样的词重试'));
    });

    test('3s 内返回的结果照常整形 (去重 + 预算)', () async {
      final tool = WebSearchTool(
        _ScriptedSearch((q) async => [
              for (var i = 0; i < 6; i++) _hit('https://same.com/$i'),
              _hit('https://other.com/1'),
            ]),
      );
      final r = await tool.run(
        {'query': 'q'},
        sdk.ToolContext(cancel: sdk.AgentCancelToken()),
      );
      expect(r.isError, isFalse);
      expect('same.com'.allMatches(r.output).length, 2);
      expect(r.output, contains('other.com'));
      expect(r.output, isNot(contains('same.com/2')));
    });

    test('上游抛别的异常时照常往上抛 (超时口径不掩盖真故障)', () async {
      final tool = WebSearchTool(
        _ScriptedSearch((q) async => throw StateError('HTTP 500')),
      );
      expect(
        () => tool.run({'query': 'q'}, sdk.ToolContext(cancel: sdk.AgentCancelToken())),
        throwsA(isA<StateError>()),
      );
    });
  });
}
