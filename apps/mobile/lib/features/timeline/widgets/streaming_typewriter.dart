/// streaming_typewriter.dart — 流式正文的「打字机」呈现.
///
/// **为什么不是直接渲 MarkdownView(text)** (2026-09-18 用户: 「stream 打字机的
/// 优化 丝滑问题」)
///
/// 原来流式期间就是 `MarkdownView(整段文本)` + 下面单独一行闪烁光标。三个毛病:
///
///   1. **每次更新把整段 markdown 重新解析一遍**。文本越长越慢, 总代价 O(n²) ——
///      长回复的后半段必然开始顿 (合流到 50ms 一次只是把频率降了, 没消掉这件事)。
///   2. **光标独占一行**, 于是每次内容变长, 那个块就往下跳一次; 而且它跟文字不在
///      一行, 看起来不像"正在打字", 像下面挂了个方块。
///   3. **文字按网络块跳**。模型/中转常常攒一批一起给 (0 → 200 字), 屏幕上就是
///      一整段"啪"地出现, 不是打出来的。
///
/// 这里的做法:
///
///   · **头尾分离**: 最后一个空行之前的部分 (`head`) 是已经写完的段落, 用
///     MarkdownView 渲, 只在**又写完一段**时才重新解析; 最后那一段 (`tail`) 还在
///     变, 用纯 Text 渲, 每帧只重排这一小段, 光标就是它末尾的一个字符 (行内)。
///     markdown 语法基本以段落为单位闭合, 所以尾巴当纯文本渲的失真只在
///     "正在打的这一段"上, 一旦写完就立刻变成真正的 markdown。
///   · **匀速吐字**: 收到的文本进缓冲, 按帧往外放 (见 [revealTarget]), 把网络的
///     突发抹平成稳定的打字速度; 落后太多时加速追, 不会越积越多。
library;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../shared/theme/neox_tokens.dart' show NeoxMono;
import 'markdown_view.dart';

/// 落后超过这么多字符就开始加速追 —— 再往上堆就会"说完了还在打".
const int _kMaxBacklog = 220;

/// 每帧至少吐几个字 (60fps 下 ≈ 120 字/秒, 跟人读的速度差不多).
const int _kMinCharsPerFrame = 2;

/// 这一帧该显示到第几个字符.
///
/// 纯函数, 好测: 给定"已显示 [shown] / 总共 [total]", 返回新的已显示长度。
///   · 永不后退 (回退会让文字闪);
///   · 落后越多吐得越快 (backlog/12), 但不会一口气全吐完 —— 那就又变成"啪"一下;
///   · 落后超过 [_kMaxBacklog] 直接跳到只差一小截, 否则模型早说完了屏幕还在打。
int revealTarget(int shown, int total) {
  if (shown >= total) return total;
  final backlog = total - shown;
  if (backlog > _kMaxBacklog) {
    /* 追到只剩 _kMaxBacklog 的一半, 剩下的照常打 —— 直接跳到 total 会丢掉
     * "还在打字"这个信号, 而那是流式唯一的进度指示。 */
    return total - _kMaxBacklog ~/ 2;
  }
  final step = (backlog / 12).ceil();
  return (shown + (step < _kMinCharsPerFrame ? _kMinCharsPerFrame : step))
      .clamp(0, total);
}

/// 把 [text] 切成「已写完的段落」和「正在写的那一段」.
///
/// 以最后一个空行 (`\n\n`) 为界。没有空行时全都算尾巴 —— 第一段还没写完,
/// 那时候本来也没有"已完成"的部分。
({String head, String tail}) splitStreamingText(String text) {
  final i = text.lastIndexOf('\n\n');
  if (i < 0) return (head: '', tail: text);
  return (head: text.substring(0, i), tail: text.substring(i + 2));
}

/// 正在写的那一段的行内样式: 成对的 `**粗**` / `` `码` `` 直接画出来, 行首 `#` 标题、`- ` 列表换成样子,
/// 还没写完的半个 `**` / `` ` `` 先藏起来 —— 不再让人看到一串星号, 写完交给 MarkdownView 时也不跳。
/// (2026-10-14 实测: 流式中「Pick from the box labeled **mixed**」星号原样露出来)
List<InlineSpan> streamingTailSpans(String tail, TextStyle base, {required Color codeBg}) {
  final out = <InlineSpan>[];
  final lines = tail.split('\n');
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var style = base;
    final h = RegExp(r'^(#{1,6})\s+').firstMatch(line);
    if (h != null) {
      line = line.substring(h.end);
      style = base.copyWith(fontWeight: FontWeight.w700, fontSize: (base.fontSize ?? 16) * (h[1]!.length <= 2 ? 1.15 : 1.05));
    } else {
      final b = RegExp(r'^(\s*)[-*+]\s+').firstMatch(line);
      if (b != null) line = '${b[1]}•  ${line.substring(b.end)}';
    }
    /* 半个记号 (最后一个没配对的 ** 或 `) 先不画 */
    if ('**'.allMatches(line).length.isOdd) line = line.replaceFirst(RegExp(r'\*\*(?!.*\*\*)'), '');
    if ('`'.allMatches(line).length.isOdd) line = line.replaceFirst(RegExp(r'`(?!.*`)'), '');
    var at = 0;
    for (final m in RegExp(r'\*\*([^*]+)\*\*|`([^`]+)`').allMatches(line)) {
      if (m.start > at) out.add(TextSpan(text: line.substring(at, m.start), style: style));
      if (m[1] != null) {
        out.add(TextSpan(text: m[1], style: style.copyWith(fontWeight: FontWeight.w700)));
      } else {
        out.add(TextSpan(
          text: m[2],
          style: style.copyWith(
            fontFamily: NeoxMono.family,
            fontFamilyFallback: NeoxMono.fallback,
            fontSize: (style.fontSize ?? 16) * 0.9,
            backgroundColor: codeBg,
          ),
        ));
      }
      at = m.end;
    }
    if (at < line.length) out.add(TextSpan(text: line.substring(at), style: style));
    if (li < lines.length - 1) out.add(TextSpan(text: '\n', style: base));
  }
  return out;
}

class StreamingTypewriter extends StatefulWidget {
  const StreamingTypewriter({super.key, required this.text, this.frozen = false});

  final String text;

  /// 用户已点停止 —— 立即停帧, 已经吐出来的字保持不动, 不再继续往外放
  /// (chat:C9-08 的第二层: 状态层丢了残留增量, 这一层把已缓冲的字也停住)。
  final bool frozen;

  @override
  State<StreamingTypewriter> createState() => _StreamingTypewriterState();
}

class _StreamingTypewriterState extends State<StreamingTypewriter>
    /* 两个 ticker (逐帧 _ticker + 光标 _blink), Single 版第二个就断言失败 → debug 包整条回复变红 */
    with TickerProviderStateMixin {
  late final Ticker _ticker;
  int _shown = 0;

  /// 光标闪烁跟吐字分开: 吐完了 (等模型) 也要继续闪, 否则看着像卡死.
  late final AnimationController _blink = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void initState() {
    super.initState();
    /* 已经冻结时直接全显示: 没有"打字"过程可言, 否则会停在一个随便哪里。 */
    _shown = widget.frozen ? widget.text.length : 0;
    /* Ticker 而不是 Timer: 跟帧对齐, 120Hz 屏上自动跟着走 —— 用 16ms 的 Timer
     * 在高刷屏上会跟帧错拍, 每隔几帧多吐一次, 反而看得出不匀。 */
    _ticker = createTicker(_onFrame);
    if (!widget.frozen) _ticker.start();
  }

  @override
  void didUpdateWidget(StreamingTypewriter old) {
    super.didUpdateWidget(old);
    /* 点停止: 立即停掉吐字 ticker —— 已缓冲的字不再往外放, 画面定格在
     * 用户按下停止的那一刻。(chat:C9-08) */
    if (widget.frozen && !old.frozen) {
      _ticker.stop();
    } else if (!widget.frozen && old.frozen) {
      _ticker.start();
    }
    /* 文本被换掉了 (换了一轮 / 重放历史) → 不做打字动画, 直接全显示。
     * 判据是"新文本不以已显示的部分开头" —— 那说明不是在原文上追加。
     * 冻结期间不跟随: 停住就是停住, 不许因为文本变化再长出来。 */
    if (!widget.frozen &&
        !widget.text.startsWith(old.text.substring(0, _shown.clamp(0, old.text.length)))) {
      _shown = widget.text.length;
    }
  }

  void _onFrame(Duration _) {
    if (widget.frozen) return;
    final next = revealTarget(_shown, widget.text.length);
    if (next != _shown) setState(() => _shown = next);
  }

  @override
  void dispose() {
    _ticker.dispose();
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final visible = widget.text.substring(0, _shown.clamp(0, widget.text.length));
    final parts = splitStreamingText(visible);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        /* 已写完的段落 —— key 用 head 本身: 内容没变时连 rebuild 都不会有,
         * 也就不会重新解析 markdown。 */
        if (parts.head.isNotEmpty)
          RepaintBoundary(
            child: MarkdownView(key: ValueKey(parts.head.length), data: parts.head, streaming: true),
          ),
        /* 正在写的那一段 + 行内光标。纯 Text, 每帧只重排这一小段。
         * 样式跟 markdown 正文对齐 (见 markdownBaseStyle), 一旦这段写完
         * 交给 MarkdownView 渲时不会"字跳一下"。 */
        RepaintBoundary(
          child: AnimatedBuilder(
            animation: _blink,
            builder: (context, _) => Text.rich(
              TextSpan(
                children: [
                  ...streamingTailSpans(parts.tail, markdownBaseStyle(theme), codeBg: theme.colorScheme.onSurface.withValues(alpha: 0.06)),
                  /* 停止后不再闪光标 —— 光标的意思是"还在写", 冻结时它不该还在跳。 */
                  if (!widget.frozen)
                    TextSpan(
                      text: '▍',
                      style: markdownBaseStyle(theme).copyWith(
                        color: theme.colorScheme.onSurface.withValues(
                          alpha: 0.25 + 0.75 * _blink.value,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
