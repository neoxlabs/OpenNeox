/// web_search_shaping.dart — 搜索结果进模型上下文前的整形 (chat:C3-04 / C3-06 / C3-07).
///
/// 三件事, 全是纯函数, 便于单测:
///   · 域名去重 (C3-04): 8 条结果不该是同一家网站的 8 个页面 —— 同域最多留 [kPerDomainLimit] 条;
///   · 注入预算 (C3-07): 单次搜索注入 ≤ 1500 token, 超了按顺序截断并如实说「还有几条没显示」;
///   · 超时口径 (C3-06): [kChatSearchTimeout] 是工具层等上游的上限, 到点用已拿到的部分结果作答。
///
/// 预算按 **token 估算** 卡, 不按字符数: 中文一个字差不多就是一个 token, 英文 3.5 字符一个 ——
/// 用同一个字符上限卡, 纯中文会超一倍 (2550 字符的中文 ≈ 2073 token)。估算口径跟仓库既有的一致
/// (apps/mobile/test/chat_light_harness_test.dart 与 packages/kernel 的 promptSize probe 测试),
/// 且中文按 1 字 = 1 token 取值偏保守, 真实用量只会更少。
library;

import 'hosted_web_search.dart';

/// 一轮搜索最多等上游多久 (chat:C3-06)。到点就用手上已有的结果, 不让一家慢源把整轮卡住。
const Duration kChatSearchTimeout = Duration(seconds: 3);

/// 单次搜索注入的 token 预算 (chat:C3-07)。
const int kSearchInjectTokenBudget = 1500;

/// 同一预算的**粗略**字符换算 (1500 token × 1.7 字符/token)。
///
/// 只用于快速判断「这条结果是不是明显超了」, 真正卡预算的是 [estimateSearchTokens] ——
/// 纯中文按这个字符数换算会到 2000+ token, 不能拿它当闸。
const int kSearchInjectCharBudget = (kSearchInjectTokenBudget * 1.7) ~/ 1;

/// 同一个域名最多留几条 (chat:C3-04)。
const int kPerDomainLimit = 2;

/// 单条摘要 / 标题的硬上限 —— 一条超长摘要不能把整个预算吃掉。
const int _maxTitleChars = 120;
const int _maxSnippetChars = 240;

/// 结果的去重键: 主机名 (去掉 `www.` / `m.` 前缀)。拿不到主机名时退回完整 URL。
///
/// `news.163.com` 与 `163.com` 是**不同**的键 —— 子域往往承载不同内容 (新闻 / 体育),
/// 一律合并会把真正的多样性也砍掉。
String domainKeyOf(String url) {
  final trimmed = url.trim();
  if (trimmed.isEmpty) return '';
  Uri? uri;
  try {
    uri = Uri.parse(trimmed);
  } catch (_) {
    uri = null;
  }
  var host = uri?.host ?? '';
  if (host.isEmpty) return trimmed.toLowerCase();
  host = host.toLowerCase();
  if (host.startsWith('www.')) host = host.substring(4);
  if (host.startsWith('m.')) host = host.substring(2);
  return host;
}

/// 按域名去重, 同域最多 [perDomain] 条, 保持原来的相关性顺序 (chat:C3-04)。
///
/// 只**跳过**超出配额的那几条, 不重排 —— 搜索引擎给的相关性顺序是最有价值的信息。
List<WebSearchHit> diversifyByDomain(
  List<WebSearchHit> hits, {
  int perDomain = kPerDomainLimit,
}) {
  if (hits.isEmpty) return const [];
  final limit = perDomain < 1 ? 1 : perDomain;
  final seen = <String, int>{};
  final out = <WebSearchHit>[];
  for (final hit in hits) {
    final key = domainKeyOf(hit.url);
    final used = seen[key] ?? 0;
    if (used >= limit) continue;
    seen[key] = used + 1;
    out.add(hit);
  }
  return out;
}

/// 估算一段文本的 token 数: 中文 (CJK / 全角) 1 字 ≈ 1 token, 其余 3.5 字符 ≈ 1 token。
///
/// 跟仓库既有换算同一口径; 中文取 1 字 1 token 是**保守**的一侧 (DeepSeek 分词器里
/// 常见词会合表, 实际更低), 所以「估算 ≤ 预算」能保证「真实 ≤ 预算」。
int estimateSearchTokens(String text) {
  var cjk = 0;
  var other = 0;
  for (final rune in text.runes) {
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

/// 把结果渲染成给模型读的纯文本, 并在 [tokenBudget] 内截断 (chat:C3-07)。
///
/// [ShapedSearchResults.tokens] 不超过 [tokenBudget] —— 含末尾那句
/// 「还有 N 条没显示」的提示本身 (提示也占预算, 否则模型会以为这就是全部)。
ShapedSearchResults shapeSearchResults(
  List<WebSearchHit> hits, {
  int tokenBudget = kSearchInjectTokenBudget,
}) {
  if (hits.isEmpty) {
    return const ShapedSearchResults(text: '', shown: 0, total: 0, tokens: 0);
  }
  final b = StringBuffer();
  var used = 0;
  var shown = 0;
  for (var i = 0; i < hits.length; i++) {
    final block = _renderHit(i + 1, hits[i]);
    final blockTokens = estimateSearchTokens(block);
    final remaining = hits.length - (i + 1);
    // 预算要留给末尾的省略提示 —— 先按「这一条之后还剩几条」把提示的份额扣出来。
    final reserve = remaining > 0 ? estimateSearchTokens(_omittedHint(remaining)) : 0;
    if (used + blockTokens + reserve > tokenBudget) break;
    b.write(block);
    used += blockTokens;
    shown++;
  }
  if (shown == 0) {
    // 第一条就超预算 (超长摘要): 截断到能放下, 不让一次搜索返回空文本。
    final hintReserve = hits.length > 1 ? estimateSearchTokens(_omittedHint(hits.length - 1)) : 0;
    final first = _renderHit(1, hits.first, tokenBudget: tokenBudget - hintReserve);
    b.write(first);
    used = estimateSearchTokens(first);
    shown = 1;
  }
  final omitted = hits.length - shown;
  if (omitted > 0) {
    final hint = _omittedHint(omitted);
    b.write(hint);
    used += estimateSearchTokens(hint);
  }
  return ShapedSearchResults(
    text: b.toString().trimRight(),
    shown: shown,
    total: hits.length,
    tokens: used,
  );
}

class ShapedSearchResults {
  const ShapedSearchResults({
    required this.text,
    required this.shown,
    required this.total,
    required this.tokens,
  });

  /// 给模型读的文本 (已去重 / 已按预算截断)。
  final String text;

  /// 实际写进去的条数。
  final int shown;

  /// 去重后、截断前的条数。
  final int total;

  /// 估算的 token 数 (≤ 预算)。
  final int tokens;

  bool get truncated => shown < total;
}

String _renderHit(int index, WebSearchHit h, {int? tokenBudget}) {
  final b = StringBuffer();
  b.writeln('$index. ${_clip(h.title, _maxTitleChars)}');
  if (h.url.isNotEmpty) b.writeln('   ${h.url}');
  if (h.publishedAt != null && h.publishedAt!.trim().isNotEmpty) {
    b.writeln('   ${h.publishedAt!.trim()}');
  }
  if (h.snippet.isNotEmpty) {
    b.writeln('   ${_clip(h.snippet, _maxSnippetChars)}');
  }
  var text = b.toString();
  if (tokenBudget != null && estimateSearchTokens(text) > tokenBudget) {
    text = _clipToTokens(text, tokenBudget);
  }
  return text;
}

/// 按估算口径把一段文本削到 [tokenBudget] 以内 (保留头部, 末尾加省略号)。
String _clipToTokens(String text, int tokenBudget) {
  if (tokenBudget <= 0) return '';
  var used = 0.0;
  final out = StringBuffer();
  for (final rune in text.runes) {
    final ch = String.fromCharCode(rune);
    final isCjk = (rune >= 0x2E80 && rune <= 0x9FFF) ||
        (rune >= 0xF900 && rune <= 0xFAFF) ||
        (rune >= 0xFF00 && rune <= 0xFFEF) ||
        (rune >= 0x3000 && rune <= 0x303F);
    final cost = isCjk ? 1.0 : 1 / 3.5;
    if (used + cost > tokenBudget - 1) break; // 留 1 token 给省略号
    used += cost;
    out.write(ch);
  }
  return '${out.toString().trimRight()}…';
}

String _omittedHint(int count) => '（还有 $count 条结果未显示, 需要更多就换更具体的搜索词）\n';

String _clip(String s, int max) {
  if (s.length <= max) return s;
  return '${s.substring(0, max)}…';
}
