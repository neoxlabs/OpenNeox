/// hosted_web_search.dart — 托管联网搜索 (订阅网关 /n1/search) 的契约 + web_search 工具.
///
/// 手机 agent 以前只有 http_fetch: 模型想查「周边好玩的地方」只能自己拼知乎 / 携程的
/// 搜索页去抓, 撞上验证码就换下一家 (2026-10-05 用户实拍)。桌面一直有 web_search,
/// 登录了订阅就走网关的搜索聚合, 跟模型无关。这里把同一条路接到手机上。
///
/// 实现在发行版里 (商业版 = NeoxCloud 网关); 开源版没有托管搜索, 工具不出现。
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../edition/edition.dart';
import 'chat_budget.dart';
import 'web_search_shaping.dart';

class WebSearchHit {
  const WebSearchHit({
    required this.title,
    required this.url,
    required this.snippet,
    this.publishedAt,
  });
  final String title;
  final String url;
  final String snippet;
  final String? publishedAt;
}

abstract class HostedWebSearch {
  /// 现在能不能用 (通常 = 已登录)。
  bool get available;

  /// 失败抛异常, 文案直接给模型看。
  Future<List<WebSearchHit>> search(String query, {int count = 8});
}

final hostedWebSearchProvider = Provider<HostedWebSearch?>(
  (ref) => ref.watch(editionProvider).hostedWebSearch(ref),
);

class WebSearchTool implements sdk.AgentTool, sdk.ParallelSafeTool {
  WebSearchTool(this._backend);
  final HostedWebSearch _backend;

  /// 只读, 互不依赖 —— 一轮里多个搜索并发发出、同时跑 (总控裁决第六节)。
  @override
  bool get parallelSafe => true;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
    name: 'web_search',
    description:
        '联网搜索, 返回标题 / 链接 / 摘要。查实时信息、地点推荐、新闻、价格等先用它; '
        '需要某个结果的全文再用 http_fetch 打开那个链接。别自己拼网站的搜索页去抓。',
    parameters: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '搜索词'},
        'count': {'type': 'integer', 'description': '结果条数, 默认 8, 最多 20'},
      },
      'required': ['query'],
    },
  );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    final query = (args['query'] as String?)?.trim() ?? '';
    if (query.isEmpty) return const sdk.ToolResult.error('query 不能为空');
    if (!_backend.available) {
      return const sdk.ToolResult.error('联网搜索需要登录 Neox 账号');
    }
    final raw = args['count'];
    final count = (raw is num ? raw.toInt() : 8).clamp(1, 20);

    /* chat:C3-06 —— 3s 截止: 一家搜索源慢不再把整轮卡住。
     * 超时回的是 ok 而不是 error: 这是「这次没拿到」, 不是「工具坏了」,
     * 模型看到 error 会拿同样的词再搜一遍, 白等又白花钱。 */
    List<WebSearchHit> hits;
    try {
      hits = await _backend.search(query, count: count).timeout(kChatSearchTimeout);
    } on TimeoutException {
      return const sdk.ToolResult.ok(
        '搜索超时 (3 秒) —— 这次没拿到结果。不要用同样的词重试; '
        '要么换个更具体的搜索词, 要么直接用已有信息回答, 并跟用户说清哪部分没查到。',
      );
    }
    if (hits.isEmpty) return const sdk.ToolResult.ok('没有搜到结果, 换个搜索词再试');

    /* chat:C3-04 按域名去重 (同域最多 2 条) + chat:C3-07 注入 ≤1500 token。
     * 两步都在纯函数里 (web_search_shaping.dart), 单测直接测那一层。 */
    final shaped = shapeSearchResults(diversifyByDomain(hits));
    return sdk.ToolResult.ok(shaped.text);
  }
}

/// 轻聊天 (Chat 标签) 的搜索工具 —— 一轮回答最多 [maxCalls] 次, 到顶直接拒。
///
/// 10 次是防跑飞的保险丝, 不是「只准查一件事」: 模型可以在一轮里一次发出多个搜索,
/// 由 AgentRunner 并发跑 (见 WebSearchTool.parallelSafe)。提示词里也写了
/// 「要查多个方面就一次并发发出多个搜索」。
/// 计数按实例算, 每次发送新建一个。
class CappedWebSearchTool implements sdk.AgentTool, sdk.ParallelSafeTool {
  CappedWebSearchTool(this._inner, {this.maxCalls = kChatSearchLimit});

  final sdk.AgentTool _inner;
  final int maxCalls;

  int _used = 0;

  /// 这一轮已经搜了几次 (测试 / 日志用)
  int get used => _used;

  /// 包装层不能把并发能力吃掉: 多个搜索要同时跑, 不是排队。
  @override
  bool get parallelSafe =>
      _inner is sdk.ParallelSafeTool && (_inner as sdk.ParallelSafeTool).parallelSafe;

  @override
  sdk.ToolSpec get spec => _inner.spec;

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    if (_used >= maxCalls) {
      /* 回给模型的是「别再搜了」这句人话, 不是网关错误 —— 它得能直接改成作答 */
      return sdk.ToolResult.error(
        '这一轮已经搜了 $maxCalls 次, 到上限了。不要再搜, 用已经拿到的结果直接回答; '
        '还缺的信息就跟用户说清哪部分没查到。',
      );
    }
    _used++;
    return _inner.run(args, ctx);
  }
}
