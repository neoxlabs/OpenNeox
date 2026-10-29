/// markdown_view.dart — 统一 markdown 渲染器.
///
/// 字号 13.5 + line-height 1.55 — 移动端高密度优先, 一屏多放信息.
/// muted=true 用于 thinking / 元信息, 灰色.
/// code block: 浅 fill + 细描边 + monospace 12px, **横向可滚** (防长行挤压换行).
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'remote_image.dart';
import 'rich_cards.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 正文链接点击 —— 只放行 http(s) / mailto; 打不开就给一句提示, 不静默吞掉。
Future<void> _openLink(BuildContext context, String? href) async {
  final uri = href == null ? null : Uri.tryParse(href.trim());
  const allowed = {'http', 'https', 'mailto'};
  if (uri == null || !allowed.contains(uri.scheme.toLowerCase())) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!ok) messenger?.showSnackBar(SnackBar(content: Text(tr('无法打开链接: $href'))));
}

/// markdown 正文的基准样式 —— **流式打字机的尾巴也用它**.
///
/// 抽出来是为了让"正在打的那一段"(纯 Text 渲) 跟"已经写完的段落"(MarkdownView 渲)
/// 字号行高完全一致: 不一致的话, 每写完一段, 那段字会当场跳一下
/// (见 streaming_typewriter.dart)。
/* 2026-09-24 换成跟桌面同一套圆体后按桌面的节奏收: 桌面正文 13px / 行高 1.75 /
 * 字距 +0.01em / 段距 0.85em。手机字号大, 行高不照搬 1.75 (09-18 用户嫌过 1.6 太松),
 * 取 1.62; 字距同桌面 +0.01em; 段距见 blockSpacing。
 * leadingDistribution.even: 圆体的 ascent 偏高 (1.16em), 按默认比例分配行距时字会
 * 贴着行顶, 一段话看着上紧下松。均分后字形在行里居中。 */
TextStyle markdownBaseStyle(ThemeData theme, {bool muted = false}) => TextStyle(
  fontSize: 15.5,
  height: 1.62,
  letterSpacing: 0.15,
  leadingDistribution: TextLeadingDistribution.even,
  color: muted
      ? theme.colorScheme.onSurfaceVariant
      : theme.colorScheme.onSurface,
);

/// 把 LLM 常见的"不严谨 markdown"补成 CommonMark 合法形式.
///
/// ## 为什么需要 (2026-07-28 真机对比桌面)
///
/// 模型经常写 `##2. design/foo.md (192行)` —— `#` 后面**没有空格**。
/// CommonMark 规定 ATX 标题的 `#` 之后必须跟空格, 所以严格解析器 (手机用的
/// flutter_markdown_plus) 判定它不是标题, 原样渲染成字面量 `##2. …`;
/// 而桌面那套渲染器更宽松, 照样当标题渲染。同一段内容两端长得不一样, 手机看着像坏了。
///
/// 这里在渲染前做一次最小修补: 行首 1~6 个 `#` 紧跟非空格内容时, 补一个空格。
/// 只动行首、只认 1~6 个 `#`, 不碰正文里的 `#话题` 之类写法。
///
/// 顺带修另一个高频写法: 有序列表 `1.foo` (点后无空格) 同样不被识别为列表。
String normalizeLlmMarkdown(String src) {
  if (!src.contains('#') && !src.contains('.')) return src;
  final lines = src.split('\n');
  var changed = false;
  var inFence = false;
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    /* 代码块内的内容一个字都不能动 */
    final trimmed = line.trimLeft();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    final heading = _kAtxNoSpace.firstMatch(line);
    if (heading != null) {
      lines[i] = '${heading.group(1)} ${heading.group(2)}';
      changed = true;
      continue;
    }
    final ordered = _kOrderedNoSpace.firstMatch(line);
    if (ordered != null) {
      lines[i] = '${ordered.group(1)}${ordered.group(2)} ${ordered.group(3)}';
      changed = true;
    }
  }
  return changed ? lines.join('\n') : src;
}

/// 行首 1~6 个 `#` + 紧跟的非空格非 `#` 内容 (即缺空格的 ATX 标题).
final RegExp _kAtxNoSpace = RegExp(r'^(#{1,6})([^#\s].*)$');

/// 行首序号 + `.` + 紧跟非空格内容 (即缺空格的有序列表), 保留原缩进.
///
/// `(?!\d)` 是 2026-09-18 补的: 原来它把**版本号和小数**也当成列表补空格 ——
/// 更新日志第一行 `3.3.9 → 3.4.0。` 被改成 `3. 3.9 → 3.4.0。`, 渲出来是一个
/// 序号为 3 的列表项, 版本号当场断成两截 (渲染台截图抓到的)。
/// 同理 `1.5 倍速`、`2.0 版本` 这类 agent 输出里很常见。
/// 点后面是数字的一律不动: 真正的有序列表不会写成 `1.2 内容`。
final RegExp _kOrderedNoSpace = RegExp(r'^(\s*)(\d{1,9}\.)(?!\d)([^\s].*)$');

/// [normalizeLlmMarkdown] 的按内容缓存 —— 2026-09-22.
///
/// 它在 [MarkdownView.build] 里被调用, 而 timeline 在 streaming 期间**每 32ms
/// 重建一次列表**: 屏上每一段正文都会跟着被反复归一化 —— 同一段文本被
/// split('\n') + 逐行正则扫几十遍。文本没变就没有理由重算。
///
/// 键用**内容本身**而不是 hashCode: 碰撞会让两段不同的正文互相顶掉, 那是渲染错
/// 内容, 不是性能问题。上限 64 条 —— 屏上可见的段落数远小于它, 按下一段正文
/// (通常几百字节) 算也就几十 KB。
final _kNormalizeCache = <String, String>{};
const int _kNormalizeCacheMax = 64;

String _normalizeCached(String src) {
  final hit = _kNormalizeCache[src];
  if (hit != null) return hit;
  final out = normalizeLlmMarkdown(src);
  if (_kNormalizeCache.length >= _kNormalizeCacheMax) {
    /* 简单 FIFO 淘汰. 这里不值得上 LRU: 命中率取决于屏上那几段, 先进先出已经够用,
     * 而每命中一次省下的是一次完整的逐行扫描 —— 比维护访问顺序贵得多。 */
    _kNormalizeCache.remove(_kNormalizeCache.keys.first);
  }
  _kNormalizeCache[src] = out;
  return out;
}

class MarkdownView extends StatelessWidget {
  const MarkdownView({super.key, required this.data, this.muted = false, this.streaming = false});
  final String data;
  final bool muted;

  /// 这段正文还在流式写 —— 只有这时 `neox-card` 的半截 JSON 才显示「卡片生成中」;
  /// 写完了还解析不出来就退回原文代码块, 不能永远转圈。
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    /* 正文 16.5 (原 15) + 行高 1.6 (原 1.55) —— 2026-09-18 用户拿同类产品对比:
     * "文字的 timeline 你看看 字体 大小 对比 等 很清晰啊 我们的差远了"。
     *
     * 对比图里的正文明显更大、跟旁边那些元信息行 (Edited 1 files… / Ran 2 commands)
     * 拉开得也更狠。我们原来正文 15 / 元信息 13, 只差 2 号 —— 层级几乎不存在, 满屏
     * 一样重, 于是"哪句是答案、哪行是过程"要靠读才分得出。
     *
     * 正文是这个界面唯一要被逐字读的东西, 它该是最大的那一档。 */
    /* 2026-09-18 再调一档: 16.5/1.6 在真机截图上一屏只放得下三段, 用户判词
     * 「timeline 里面的间距 … 间距过大」。上一轮为了"清晰"把正文抬到 16.5,
     * 抬过头了 —— 桌面端同一段内容的正文是 13.5~14。
     * 15.5/1.5: 比元信息 (14) 仍高一档半, 层级还在, 一屏内容多出约三分之一。 */
    final base = markdownBaseStyle(theme, muted: muted);
    final codeBg = theme.colorScheme.surfaceContainerLowest;
    final codeblockDecoration = BoxDecoration(
      color: codeBg,
      border: Border.all(
        color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
      ),
      borderRadius: NeoxRadius.smallR,
    );
    final codeStyle = TextStyle(
      fontFamily: NeoxMono.family,
      fontFamilyFallback: NeoxMono.fallback,
      fontSize: 13,
      height: 1.45,
      color: theme.colorScheme.onSurface,
    );
    return MarkdownBody(
      data: _normalizeCached(data),
      selectable: true,
      softLineBreak: true,
      fitContent: true,
      shrinkWrap: true,
      /* 原来是空函数 —— 链接画成了链接, 点下去什么都不发生。
       * 只放行 http(s) / mailto, 交给系统浏览器 / 邮件 app; 其它 scheme (file:, javascript:)
       * 来自模型输出, 不该被一次点击触发。 */
      onTapLink: (_, href, __) => _openLink(context, href),
      /* 图片: 电脑那边的图按引用 (neox-image://) 拉; 网络图直接显示; 其它 scheme 不渲染 */
      imageBuilder: (uri, _, alt) {
        if (uri.scheme == kNeoxImageScheme) return NeoxRemoteImage(name: uri.host);
        if (uri.scheme == 'http' || uri.scheme == 'https') {
          return Image.network(
            uri.toString(),
            errorBuilder: (_, __, ___) => Text(alt ?? uri.toString()),
          );
        }
        return Text(alt ?? '');
      },
      /* 无序列表的点自己画 (见 listBullet 处的说明) */
      bulletBuilder: (params) {
        if (params.style == BulletStyle.orderedList) {
          return Text(
            '${params.index + 1}.',
            style: base.copyWith(color: theme.colorScheme.onSurfaceVariant),
          );
        }
        return Padding(
          /* 点垂直居中在首行: (行高 - 点径) / 2 = (15.5*1.62 - 5) / 2 ≈ 10 */
          padding: const EdgeInsets.only(top: 10),
          child: Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(
              color: theme.colorScheme.onSurfaceVariant,
              shape: BoxShape.circle,
            ),
          ),
        );
      },
      builders: {
        'pre': _ScrollablePreBuilder(
          decoration: codeblockDecoration,
          style: codeStyle,
          streaming: streaming,
        ),
      },
      styleSheet: MarkdownStyleSheet(
        p: base,
        a: base.copyWith(
          color: theme.colorScheme.linkInk,
          decoration: TextDecoration.underline,
          decorationColor: theme.colorScheme.linkInk.withValues(alpha: 0.35),
        ),
        h1: theme.textTheme.titleLarge?.copyWith(
          fontWeight: FontWeight.w700,
          height: 1.3,
        ),
        h2: theme.textTheme.titleMedium?.copyWith(
          fontWeight: FontWeight.w700,
          height: 1.3,
        ),
        h3: theme.textTheme.titleSmall?.copyWith(
          fontWeight: FontWeight.w600,
          height: 1.3,
        ),
        h4: base.copyWith(fontWeight: FontWeight.w600),
        h5: base.copyWith(fontWeight: FontWeight.w600),
        h6: base.copyWith(fontWeight: FontWeight.w600),
        strong: base.copyWith(fontWeight: FontWeight.w700),
        em: base.copyWith(fontStyle: FontStyle.italic),
        /* 【无序列表得有点】(2026-09-18 渲染台实拍)
         *
         * 原来只设了 listBullet 的**文字样式**, 没给 bulletBuilder —— 渲出来的三条并列项
         * 前面什么都没有, 读起来像三个独立段落, 完全看不出"这是一个列表"。
         * 用户拿同类产品对比时说的"很清晰 / 我们差远了", 这是其中一条: 结构不可见。
         *
         * 自己画点而不是用默认的 "•": 默认那个字符的大小和基线跟着正文字号走, 16.5 的
         * 正文配出来的点又大又靠上; 一个 5px 的圆、垂直居中在首行, 才是"标记"而不是"字"。
         * 有序列表交回默认 (数字本来就对)。 */
        listBullet: base,
        listBulletPadding: const EdgeInsets.only(right: 6),
        blockquote: base.copyWith(color: theme.colorScheme.onSurfaceVariant),
        blockquoteDecoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerLow,
          border: Border(
            left: BorderSide(color: theme.colorScheme.outlineVariant, width: 3),
          ),
        ),
        blockquotePadding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
        /* 行内代码: 蓝灰墨 + 浅灰底 (对标 Claude)。原来跟正文同色、底是 surfaceContainerLowest ——
         * 在页面底上几乎看不见, 一段话里的 `opts` `sessionId` 只能靠字体认。
         * 字号比正文小 2 号: 等宽字在同字号下视觉更大。 */
        /* 13.5 (跟着正文从 16.5 回到 15.5 一起收一档): 等宽字形本来就比同号
         * 比例字显大, 14.5 配 15.5 正文时那些灰块比句子还重, 把行距顶开。
         *
         * 原注释 (仍然成立的那半): 正文抬高之后等宽字会在句子里塌一档 ——
         * 而 `opts` / `sessionId` 这种恰恰是句子里最该被认出来的部分。
         *
         * 还差一层: 真正的胶囊要有左右内边距 + 圆角, 而 TextStyle.backgroundColor 画的是
         * 紧贴字形的矩形。Flutter 里只能用 WidgetSpan 才有内边距, 但本视图是
         * selectable: true —— WidgetSpan 会破坏文本选择 (复制代码是常用操作),
         * 这笔账不划算。等换掉 markdown 渲染器或验证过选择行为再补。 */
        code: TextStyle(
          fontFamily: NeoxMono.family,
          fontFamilyFallback: NeoxMono.fallback,
          fontSize: 13.5,
          color: theme.colorScheme.codeInk,
          backgroundColor: theme.colorScheme.chipFill,
        ),
        codeblockPadding: const EdgeInsets.all(10),
        codeblockDecoration: codeblockDecoration,
        /* 表格必须横向可滚 —— 跟 code block 同一个道理, 但之前漏了.
         *
         * 真机实锤 (2026-07-28, agent 返回一张 4 列目录统计表): 手机宽度放不下,
         * 表格又不滚, 于是最后一列被逐字符硬折成
         *   "mo / norep / o, Vu / e3+Vit / e+pnp / m+Tur / borep / o"
         * 连路径 `frontend/` 都被拆成 `fronte` + `nd/`, 完全没法读。
         *
         * flutter_markdown_plus 其实内置了横滚 (builder.dart 的 tag=='table' 分支),
         * 但**只在 tableColumnWidth 是 Fixed/Intrinsic 时才启用**; 默认的
         * FlexColumnWidth 恰好落进不滚的那条 else, 列宽被压到容器内 → 逐字折行。
         * 换成 IntrinsicColumnWidth: 列按内容取宽, 超出部分横向滚动。 */
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableScrollbarThumbVisibility: true,
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 10,
          vertical: 6,
        ),
        tableHead: base.copyWith(fontWeight: FontWeight.w700),
        tableBody: base,
        tableBorder: TableBorder.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6),
          width: 0.5,
        ),
        h1Padding: const EdgeInsets.only(top: 12, bottom: 4),
        h2Padding: const EdgeInsets.only(top: 10, bottom: 4),
        h3Padding: const EdgeInsets.only(top: 8, bottom: 4),
        /* 段间距 9 (≈0.6em; 原 6): 6 在截图上段与段、列表项之间几乎分不开, 一整块字。
         * 桌面是 0.85em —— 手机行高已经比原来松一点, 段距不用追满。
         * 列表缩进 16 (原 18) —— bullet 到文字的距离由 listBulletPadding 管。 */
        blockSpacing: 9,
        listIndent: 16,
        horizontalRuleDecoration: BoxDecoration(
          border: Border(
            top: BorderSide(
              color: theme.colorScheme.outlineVariant,
              width: 0.5,
            ),
          ),
        ),
      ),
    );
  }
}

/// `<pre>` 代码块 — 横向滚动, 不强制折行挤压.
class _ScrollablePreBuilder extends MarkdownElementBuilder {
  _ScrollablePreBuilder({required this.decoration, required this.style, this.streaming = false});
  final BoxDecoration decoration;
  final TextStyle style;
  final bool streaming;

  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    var text = element.textContent;
    if (text.endsWith('\n')) text = text.substring(0, text.length - 1);
    /* ```neox-card:<kind> → 富卡片 (rich_cards.dart)。认不出 / JSON 坏的交回下面的普通代码块 */
    final code = element.children?.whereType<md.Element>().where((e) => e.tag == 'code').firstOrNull;
    final lang = (code?.attributes['class'] ?? '').replaceFirst('language-', '');
    if (lang.startsWith(kNeoxCardLangPrefix)) {
      final card = buildNeoxCard(lang.substring(kNeoxCardLangPrefix.length), text, streaming: streaming);
      if (card != null) return card;
    }
    return Container(
      width: double.infinity,
      decoration: decoration,
      padding: const EdgeInsets.fromLTRB(10, 10, 4, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Text(
                text,
                style: preferredStyle ?? style,
                softWrap: false,
              ),
            ),
          ),
          /* 代码块右上角复制 —— 手机上横向滚动着拖选一段代码基本不可能 */
          _CodeCopyButton(text: text),
        ],
      ),
    );
  }
}

/// 代码块角上的复制键. 点完就地变勾 2 秒, 不弹 SnackBar 盖正文.
class _CodeCopyButton extends StatefulWidget {
  const _CodeCopyButton({required this.text});
  final String text;

  @override
  State<_CodeCopyButton> createState() => _CodeCopyButtonState();
}

class _CodeCopyButtonState extends State<_CodeCopyButton> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    final mute = Theme.of(context).colorScheme.onSurfaceVariant;
    return Tooltip(
      message: _copied ? tr('已复制') : tr('复制代码'),
      child: InkResponse(
        radius: 16,
        onTap: () async {
          await Clipboard.setData(ClipboardData(text: widget.text));
          if (!mounted) return;
          setState(() => _copied = true);
          await Future<void>.delayed(const Duration(seconds: 2));
          if (mounted) setState(() => _copied = false);
        },
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(
            _copied ? Icons.check_rounded : Icons.copy_rounded,
            size: 14,
            color: mute.withValues(alpha: 0.6),
          ),
        ),
      ),
    );
  }
}
