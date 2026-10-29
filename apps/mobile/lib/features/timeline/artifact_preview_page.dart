/// 对话里点文件卡 → 先看, 再决定分享 (2026-10-12)。
///
/// 用户: 「不支持展示, 点击后我们应该有渲染器预览」。原来点卡 = 直接弹系统分享面板,
/// 想看一眼 Agent 做的图 / 表 / PPT 得先存出去再用别的 App 打开。
///
/// 各格式怎么看:
///   图片        原图, 双指缩放
///   PDF         系统 PdfRenderer 一页页画出来 (安卓; iOS 退回分享)
///   PPT         每页一张 16:9 卡片: 第一段当标题, 其余是要点
///   Word        段落
///   Excel       每个工作表一张可横竖滚的表格
///   md          Markdown 排版
///   csv         表格
///   其他文本     等宽原文
///   音视频等     说明 + 用别的 App 打开
/// 右上角始终有分享。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/i18n/tr.dart';
import '../../core/local_agent/office/office_doc.dart';
import '../../core/local_agent/office/pptx_reader.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';

const _ch = MethodChannel('neox.phone/tools');

class ArtifactPreviewPage extends StatelessWidget {
  const ArtifactPreviewPage({super.key, required this.file, required this.name});

  final File file;
  final String name;

  String get _ext => name.contains('.') ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : '';

  static bool canPreview(String name) {
    final e = name.contains('.') ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return const {
      'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'pptx', 'docx', 'xlsx',
      'md', 'csv', 'txt', 'json', 'html', 'py', 'js', 'ts', 'log', 'xml', 'yaml', 'yml',
    }.contains(e) && !(e == 'pdf' && !Platform.isAndroid);
  }

  Future<void> _share(BuildContext context) async {
    final box = context.findRenderObject() as RenderBox?;
    await Share.shareXFiles([XFile(file.path, name: name)],
        sharePositionOrigin: box == null ? null : box.localToGlobal(Offset.zero) & box.size);
  }

  /// 陶土稿 v5: 暖纸页 + 顶栏 (返回 / 文件名 / 右上分享) + 内容 + 底部一颗「分享」。
  /// 「存到手机」「让它改」「长按一页」在稿上有, 这里还没有对应的功能, 先不画。
  @override
  Widget build(BuildContext context) {
    return ClayPage(
      title: name,
      actions: [
        Builder(
          builder: (b) => ClayRoundButton(
            flat: true,
            size: 44,
            icon: Icons.ios_share,
            tooltip: tr('分享'),
            onTap: () => _share(b),
          ),
        ),
      ],
      body: _body(context),
      bottom: Builder(
        builder: (b) => ClayButton(
          label: tr('分享'),
          icon: Icons.ios_share,
          size: ClayButtonSize.large,
          expand: true,
          onTap: () => _share(b),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    switch (_ext) {
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'webp':
      case 'gif':
        return InteractiveViewer(maxScale: 6, child: Center(child: Image.file(file)));
      case 'svg':
        return InteractiveViewer(maxScale: 6, child: Center(child: SvgPicture.file(file)));
      case 'pdf':
        return _PdfView(file: file);
      case 'pptx':
      case 'docx':
      case 'xlsx':
        return _OfficeView(file: file, name: name);
      case 'md':
        return _Text(file: file, builder: (s) => Markdown(data: s, selectable: true, padding: const EdgeInsets.all(NeoxSpace.lg)));
      case 'csv':
        return _Text(file: file, builder: (s) => _Grid(rows: _parseCsv(s)));
      default:
        return _Text(
          file: file,
          builder: (s) => SingleChildScrollView(
            padding: const EdgeInsets.all(NeoxSpace.lg),
            child: SelectableText(s, style: const TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, height: 1.45)),
          ),
        );
    }
  }
}

/// 读文本 (最多 1MB, 再大只看开头)
class _Text extends StatelessWidget {
  const _Text({required this.file, required this.builder});
  final File file;
  final Widget Function(String) builder;

  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
        future: () async {
          final bytes = await file.readAsBytes();
          final cut = bytes.length > 1 << 20;
          final s = utf8.decode(cut ? bytes.sublist(0, 1 << 20) : bytes, allowMalformed: true);
          return cut ? '$s\n…' : s;
        }(),
        builder: (c, snap) => snap.hasData
            ? builder(snap.data!)
            : snap.hasError
                ? _Fail(tr('读不出来'))
                : const Center(child: CircularProgressIndicator()),
      );
}

class _PdfView extends StatelessWidget {
  const _PdfView({required this.file});
  final File file;

  @override
  Widget build(BuildContext context) => FutureBuilder<Map>(
        future: _ch.invokeMethod<Map>('renderPdf', {'path': file.path, 'maxPages': 40, 'width': 1080}).then((m) => m ?? const {}),
        builder: (c, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final pages = [for (final p in (snap.data!['pages'] as List?) ?? const []) '$p'];
          if (pages.isEmpty) return _Fail('${snap.data!['error'] ?? tr('这个 PDF 打不开')}');
          final total = (snap.data!['total'] as num?)?.toInt() ?? pages.length;
          return InteractiveViewer(
            maxScale: 4,
            child: ListView(
              padding: const EdgeInsets.all(NeoxSpace.md),
              children: [
                for (final p in pages)
                  Padding(
                    padding: const EdgeInsets.only(bottom: NeoxSpace.md),
                    child: DecoratedBox(
                      decoration: BoxDecoration(boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 6)]),
                      child: Image.file(File(p)),
                    ),
                  ),
                if (total > pages.length)
                  Center(child: Text(tr('只预览了前 %s 页, 完整的请分享出去看').replaceFirst('%s', '${pages.length}'))),
              ],
            ),
          );
        },
      );
}

class _OfficeView extends StatelessWidget {
  const _OfficeView({required this.file, required this.name});
  final File file;
  final String name;

  @override
  Widget build(BuildContext context) => FutureBuilder<Object>(
        future: file.readAsBytes().then<Object>((b) => officeKindOf(name) == OfficeKind.pptx ? PptxReader(b).read() : OfficeDoc.open(name, b)),
        builder: (c, snap) {
          if (snap.hasError) return _Fail(tr('这个文件打不开'));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final d = snap.data!;
          if (d is PptDeck) return _Deck(deck: d);
          final doc = d as OfficeDoc;
          return doc.kind == OfficeKind.docx ? _Paragraphs(paras: doc.paragraphTexts()) : _Sheets(sheets: doc.sheetGrids());
        },
      );
}

/// PPT: 一页一屏, 左右滑翻页; 下面一排缩略图, 点哪张跳哪张。
/// 每页按真实版面画 (位置 / 颜色 / 字号 / 图片 / 表格), 双指可放大。
class _Deck extends StatefulWidget {
  const _Deck({required this.deck});
  final PptDeck deck;

  @override
  State<_Deck> createState() => _DeckState();
}

class _DeckState extends State<_Deck> {
  static const _thumbW = 62.0;
  static const _thumbGap = 10.0;

  final _pages = PageController();
  final _thumbs = ScrollController();
  int _cur = 0;

  @override
  void dispose() {
    _pages.dispose();
    _thumbs.dispose();
    super.dispose();
  }

  void _go(int i) => _pages.animateToPage(i, duration: const Duration(milliseconds: 260), curve: Curves.easeOutCubic);

  /// 翻到第 i 页时, 缩略图条跟着把它滚到中间
  void _onPage(int i) {
    setState(() => _cur = i);
    if (!_thumbs.hasClients) return;
    final target = i * (_thumbW + _thumbGap) - 120;
    _thumbs.animateTo(target.clamp(0.0, _thumbs.position.maxScrollExtent), duration: const Duration(milliseconds: 260), curve: Curves.easeOutCubic);
  }

  @override
  Widget build(BuildContext context) {
    final deck = widget.deck;
    if (deck.slides.isEmpty) return _Fail(tr('这个 PPT 没有页'));
    final c = ClayInk.of(context);
    final n = deck.slides.length;
    return Column(
      children: [
        const SizedBox(height: 6),
        Text('${_cur + 1} / $n', style: TextStyle(fontSize: 12.5, color: c.grey)),
        Expanded(
          child: PageView.builder(
            controller: _pages,
            itemCount: n,
            onPageChanged: _onPage,
            itemBuilder: (_, i) => Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              child: Center(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: InteractiveViewer(
                    maxScale: 4,
                    child: PptxSlideView(slide: deck.slides[i], width: deck.width, height: deck.height),
                  ),
                ),
              ),
            ),
          ),
        ),
        SizedBox(
          height: 80,
          child: ListView.separated(
            controller: _thumbs,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            itemCount: n,
            separatorBuilder: (_, __) => const SizedBox(width: _thumbGap),
            itemBuilder: (_, i) {
              final on = i == _cur;
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => _go(i),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: _thumbW,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(7),
                        border: Border.all(color: on ? c.ink : Colors.transparent, width: 1.5),
                      ),
                      padding: const EdgeInsets.all(1.5),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(5),
                        child: PptxSlideView(slide: deck.slides[i], width: deck.width, height: deck.height),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text('${i + 1}', style: TextStyle(fontSize: 11, fontWeight: on ? FontWeight.w700 : FontWeight.w400, color: on ? c.ink : c.grey)),
                  ],
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }
}

/// 画一页: 按宽度等比缩, EMU → 屏幕像素; 字号 pt → EMU (×12700) 再一起缩
class PptxSlideView extends StatelessWidget {
  const PptxSlideView({super.key, required this.slide, required this.width, required this.height});
  final PptPage slide;
  final double width, height;

  static Color _c(int rgb) => Color(0xFF000000 | rgb);

  @override
  Widget build(BuildContext context) => AspectRatio(
        aspectRatio: width / height,
        child: LayoutBuilder(builder: (c, box) {
          final k = box.maxWidth / width;
          return ClipRect(
            child: Container(
              color: _c(slide.bg),
              child: Stack(children: [
                for (final s in slide.shapes)
                  Positioned(
                    left: s.x * k,
                    top: s.y * k,
                    width: (s.w * k).clamp(0.5, double.infinity),
                    height: (s.h * k).clamp(0.5, double.infinity),
                    child: _shape(s, k),
                  ),
              ]),
            ),
          );
        }),
      );

  Widget _shape(PptShape s, double k) {
    if (s.image != null) return Image.memory(s.image!, fit: BoxFit.fill, gaplessPlayback: true);
    if (s.table != null) return _table(s, k);
    final radius = switch (s.geom) {
      'roundRect' => BorderRadius.circular(s.h * k * 0.16),
      _ => null,
    };
    return Container(
      decoration: BoxDecoration(
        color: s.fill == null ? null : _c(s.fill!),
        borderRadius: radius,
        shape: s.geom == 'ellipse' ? BoxShape.circle : BoxShape.rectangle,
        border: s.line == null ? null : Border.all(color: _c(s.line!), width: (9525 * k).clamp(0.5, 3)),
      ),
      child: s.paras.isEmpty ? null : _text(s, k),
    );
  }

  Widget _text(PptShape s, double k) {
    /* 文字超出框就裁掉 (不报溢出); 不能滚 —— 这只是一张图 */
    return ClipRect(
      child: Align(
        alignment: switch (s.anchor) { 'ctr' => Alignment.centerLeft, 'b' => Alignment.bottomLeft, _ => Alignment.topLeft },
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 91440 * k * 0.6, vertical: 45720 * k * 0.6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final p in s.paras)
                  Padding(
                    padding: EdgeInsets.only(left: p.level * 457200 * k * 0.5, top: p.bullet ? 4 * 12700 * k : 0),
                    child: Text.rich(
                      TextSpan(children: [
                        if (p.bullet) TextSpan(text: '•  ', style: _style(p.runs.isEmpty ? null : p.runs.first, s, k)),
                        for (final r in p.runs) TextSpan(text: r.text, style: _style(r, s, k)),
                        if (p.runs.isEmpty) TextSpan(text: ' ', style: TextStyle(fontSize: s.defaultSizePt * 12700 * k)),
                      ]),
                      textAlign: switch (p.align) { 'ctr' => TextAlign.center, 'r' => TextAlign.right, 'just' => TextAlign.justify, _ => TextAlign.left },
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  TextStyle _style(PptRun? r, PptShape s, double k) => TextStyle(
        fontSize: ((r?.sizePt ?? s.defaultSizePt) * 12700 * k).clamp(2, 200),
        height: 1.2,
        color: r?.color == null ? (_dark(slide.bg) && s.fill == null ? Colors.white : const Color(0xFF1F2937)) : _c(r!.color!),
        fontWeight: (r?.bold ?? false) ? FontWeight.w700 : FontWeight.w400,
      );

  static bool _dark(int rgb) => ((rgb >> 16 & 0xFF) * 0.299 + (rgb >> 8 & 0xFF) * 0.587 + (rgb & 0xFF) * 0.114) < 128;

  Widget _table(PptShape s, double k) {
    final rows = s.table!;
    if (rows.isEmpty) return const SizedBox.shrink();
    final cols = rows.map((r) => r.length).fold<int>(0, (a, b) => a > b ? a : b);
    return ClipRect(
      child: Table(
        border: const TableBorder(horizontalInside: BorderSide(color: Color(0xFFE5E7EB), width: 0.5)),
        /* 列宽按原文件的 gridCol 比例 */
        columnWidths: {
          for (var i = 0; i < cols; i++)
            i: FlexColumnWidth(i < s.colWidths.length && s.colWidths[i] > 0 ? s.colWidths[i] : 1),
        },
        children: [
          for (var ri = 0; ri < rows.length; ri++)
            TableRow(children: [
              for (var ci = 0; ci < cols; ci++)
                () {
                  final c = ci < rows[ri].length ? rows[ri][ci] : (text: '', fill: null, color: null, bold: false, sizePt: null);
                  final h = ri < s.rowHeights.length ? s.rowHeights[ri] * k : null;
                  return Container(
                    height: h != null && h > 0 ? h : null,
                    color: c.fill == null ? null : _c(c.fill!),
                    alignment: Alignment.centerLeft,
                    padding: EdgeInsets.symmetric(horizontal: 91440 * k),
                    child: Text(c.text, maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: ((c.sizePt ?? 14) * 12700 * k).clamp(2.0, 60.0),
                          color: c.color == null ? const Color(0xFF1F2937) : _c(c.color!),
                          fontWeight: c.bold ? FontWeight.w700 : FontWeight.w400,
                        )),
                  );
                }(),
            ]),
        ],
      ),
    );
  }
}

class _Paragraphs extends StatelessWidget {
  const _Paragraphs({required this.paras});
  final List<String> paras;

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.lg, NeoxSpace.xl, 40),
        children: [
          for (final p in paras)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SelectableText(p, style: const TextStyle(fontSize: 15, height: 1.6)),
            ),
        ],
      );
}

class _Sheets extends StatelessWidget {
  const _Sheets({required this.sheets});
  final List<({String name, List<List<String>> rows})> sheets;

  @override
  Widget build(BuildContext context) {
    if (sheets.isEmpty) return _Fail(tr('空表'));
    if (sheets.length == 1) return _Grid(rows: sheets.first.rows);
    return DefaultTabController(
      length: sheets.length,
      child: Column(children: [
        TabBar(isScrollable: true, tabs: [for (final s in sheets) Tab(text: s.name)]),
        Expanded(child: TabBarView(children: [for (final s in sheets) _Grid(rows: s.rows)])),
      ]),
    );
  }
}

/// 表格: 第一行当表头加粗, 横竖都能滚
class _Grid extends StatelessWidget {
  const _Grid({required this.rows});
  final List<List<String>> rows;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return _Fail(tr('空表'));
    final scheme = Theme.of(context).colorScheme;
    final cols = rows.map((r) => r.length).fold<int>(0, (a, b) => a > b ? a : b);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(NeoxSpace.md),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          border: TableBorder.all(color: scheme.outlineVariant, width: 0.6),
          children: [
            for (var r = 0; r < rows.length && r < 1000; r++)
              TableRow(
                decoration: BoxDecoration(color: r == 0 ? scheme.surfaceContainerHighest : null),
                children: [
                  for (var c = 0; c < cols; c++)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 260),
                        child: Text(c < rows[r].length ? rows[r][c] : '',
                            style: TextStyle(fontSize: 13, fontWeight: r == 0 ? FontWeight.w600 : FontWeight.w400)),
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _Fail extends StatelessWidget {
  const _Fail(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(NeoxSpace.xl),
          child: Text('$text\n${tr('可以点右上角分享到别的 App 打开')}', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ),
      );
}

/// 简单 CSV: 支持引号包起来的格子 (里面可以有逗号 / 换行 / "")
List<List<String>> _parseCsv(String s) {
  final rows = <List<String>>[];
  var row = <String>[];
  final cell = StringBuffer();
  var q = false;
  for (var i = 0; i < s.length; i++) {
    final ch = s[i];
    if (q) {
      if (ch == '"') {
        if (i + 1 < s.length && s[i + 1] == '"') {
          cell.write('"');
          i++;
        } else {
          q = false;
        }
      } else {
        cell.write(ch);
      }
    } else if (ch == '"') {
      q = true;
    } else if (ch == ',') {
      row.add(cell.toString());
      cell.clear();
    } else if (ch == '\n') {
      row.add(cell.toString().replaceAll('\r', ''));
      cell.clear();
      rows.add(row);
      row = <String>[];
    } else {
      cell.write(ch);
    }
  }
  if (cell.isNotEmpty || row.isNotEmpty) {
    row.add(cell.toString());
    rows.add(row);
  }
  return rows;
}
