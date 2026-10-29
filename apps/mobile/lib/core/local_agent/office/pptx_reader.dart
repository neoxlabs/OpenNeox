/// pptx_reader.dart —— 把 PPT 读成「能画出来」的页面模型 (2026-10-12)。
///
/// 用户看了第一版预览 (每页一张卡, 只列字): 「这 ppt 和 pc 端的能力差太多了吧」, 还撑出了溢出条。
/// 这里按幻灯片里真实的形状读: 位置 / 大小 (EMU)、背景色、形状填充、文字 (字号 / 颜色 / 粗细 / 对齐 / 垂直锚点)、
/// 图片、表格; 占位符没写位置的去版式 / 母版里找同类型占位符的位置。画由 PptxSlideView (artifact_preview_page) 做。
///
/// 不追求像 PowerPoint 那样完全一致 (渐变、阴影、艺术字、组合形状的变换都不画), 目标是「一眼看得出这页长什么样」。
/// 用正则读 XML (跟 office_doc.dart 一样, 不引 xml 包)。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

class PptRun {
  const PptRun(this.text, {this.sizePt, this.color, this.bold = false});
  final String text;
  final double? sizePt;
  final int? color; // 0xRRGGBB
  final bool bold;
}

class PptPara {
  const PptPara(this.runs, {this.align = 'l', this.bullet = false, this.level = 0});
  final List<PptRun> runs;
  final String align; // l / ctr / r / just
  final bool bullet;
  final int level;
  String get text => runs.map((r) => r.text).join();
}

class PptShape {
  PptShape({
    required this.x,
    required this.y,
    required this.w,
    required this.h,
    this.fill,
    this.line,
    this.geom = 'rect',
    this.paras = const [],
    this.anchor = 't',
    this.image,
    this.table,
    this.defaultSizePt = 18,
    this.rowHeights = const [],
    this.colWidths = const [],
  });

  final double x, y, w, h; // EMU
  final int? fill;
  final int? line;
  final String geom;
  final List<PptPara> paras;
  final String anchor; // t / ctr / b
  final Uint8List? image;
  final List<List<({String text, int? fill, int? color, bool bold, double? sizePt})>>? table;

  /// 表格每行的高 (EMU) 和每列的宽 (EMU)
  final List<double> rowHeights;
  final List<double> colWidths;
  final double defaultSizePt;
}

/// 读出来的一页 (跟 pptx_builder 里「要生成的一页」PptSlide 不是一回事)
class PptPage {
  PptPage({required this.bg, required this.shapes});
  final int bg;
  final List<PptShape> shapes;
}

class PptDeck {
  PptDeck({required this.width, required this.height, required this.slides});
  final double width, height;
  final List<PptPage> slides;
}

class PptxReader {
  PptxReader(Uint8List bytes) : _zip = ZipDecoder().decodeBytes(bytes);

  final Archive _zip;
  late final Map<String, int> _scheme = _readScheme();

  String? _read(String path) {
    final f = _zip.findFile(path);
    return f == null ? null : utf8.decode(f.content, allowMalformed: true);
  }

  Uint8List? _bytes(String path) {
    final f = _zip.findFile(path);
    return f == null ? null : Uint8List.fromList(f.content as List<int>);
  }

  PptDeck read({int maxSlides = 80}) {
    final pres = _read('ppt/presentation.xml') ?? '';
    final sz = RegExp(r'<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"').firstMatch(pres);
    final w = double.tryParse(sz?[1] ?? '') ?? 12192000;
    final h = double.tryParse(sz?[2] ?? '') ?? 6858000;
    final rels = _rels('ppt/presentation.xml');
    final slides = <PptPage>[];
    for (final m in RegExp(r'<p:sldId\b[^>]*r:id="([^"]+)"').allMatches(pres)) {
      final target = rels[m[1]];
      if (target == null) continue;
      slides.add(_slide(_resolve('ppt/presentation.xml', target)));
      if (slides.length >= maxSlides) break;
    }
    return PptDeck(width: w, height: h, slides: slides);
  }

  // ───────────────────────── 页 ─────────────────────────

  PptPage _slide(String path) {
    final xml = _read(path) ?? '';
    final rels = _rels(path);
    final layoutPath = _relOfType(path, rels, 'slideLayout');
    final masterPath = layoutPath == null ? null : _relOfType(layoutPath, _rels(layoutPath), 'slideMaster');
    final layoutXml = layoutPath == null ? '' : (_read(layoutPath) ?? '');
    final masterXml = masterPath == null ? '' : (_read(masterPath) ?? '');
    final bg = _bg(xml) ?? _bg(layoutXml) ?? _bg(masterXml) ?? 0xFFFFFF;
    final phPos = <String, List<double>>{
      ..._placeholderBoxes(masterXml),
      ..._placeholderBoxes(layoutXml),
    };
    final shapes = <PptShape>[];
    /* 版式 / 母版上的非占位符形状 (装饰条、logo) 也画 —— 很多模板的配色全在母版上 */
    for (final (src, p) in [(masterXml, masterPath), (layoutXml, layoutPath)]) {
      if (p == null || src.isEmpty) continue;
      shapes.addAll(_shapes(src, p, const {}, includePlaceholders: false));
    }
    shapes.addAll(_shapes(xml, path, phPos, includePlaceholders: true));
    return PptPage(bg: bg, shapes: shapes);
  }

  int? _bg(String xml) {
    final bg = RegExp(r'<p:bg>([\s\S]*?)</p:bg>').firstMatch(xml)?[1];
    return bg == null ? null : _color(bg);
  }

  /// 占位符类型 → 位置 (版式 / 母版里定义的)
  Map<String, List<double>> _placeholderBoxes(String xml) {
    final out = <String, List<double>>{};
    for (final sp in RegExp(r'<p:sp>([\s\S]*?)</p:sp>').allMatches(xml)) {
      final body = sp[1]!;
      final ph = RegExp(r'<p:ph\b([^>]*)/?>').firstMatch(body);
      if (ph == null) continue;
      final box = _xfrm(body);
      if (box == null) continue;
      out[_phKey(ph[1]!)] = box;
    }
    return out;
  }

  String _phKey(String attrs) {
    final type = RegExp(r'\btype="(\w+)"').firstMatch(attrs)?[1] ?? 'body';
    return switch (type) { 'ctrTitle' || 'title' => 'title', 'subTitle' => 'body', _ => type };
  }

  List<double>? _xfrm(String body) {
    final m = RegExp(r'<a:off x="(-?\d+)" y="(-?\d+)"/>\s*<a:ext cx="(\d+)" cy="(\d+)"/>').firstMatch(body);
    if (m == null) return null;
    return [for (var i = 1; i <= 4; i++) double.parse(m[i]!)];
  }

  List<PptShape> _shapes(String xml, String partPath, Map<String, List<double>> phPos, {required bool includePlaceholders}) {
    final spTree = RegExp(r'<p:spTree>([\s\S]*)</p:spTree>').firstMatch(xml)?[1] ?? '';
    final out = <PptShape>[];
    final rels = _rels(partPath);
    /* 按出现顺序 (= 叠放顺序) 认三种: 形状 / 图片 / 表格 */
    for (final m in RegExp(r'<p:sp>([\s\S]*?)</p:sp>|<p:pic>([\s\S]*?)</p:pic>|<p:graphicFrame>([\s\S]*?)</p:graphicFrame>').allMatches(spTree)) {
      if (m[1] != null) {
        final body = m[1]!;
        final ph = RegExp(r'<p:ph\b([^>]*)/?>').firstMatch(body);
        if (ph != null && !includePlaceholders) continue;
        final key = ph == null ? null : _phKey(ph[1]!);
        final box = _xfrm(body) ?? (key == null ? null : phPos[key]);
        if (box == null) continue;
        final spPr = RegExp(r'<p:spPr\b[^>]*>([\s\S]*?)</p:spPr>').firstMatch(body)?[1] ?? '';
        final noFill = RegExp(r'^\s*(<a:xfrm[\s\S]*?</a:xfrm>)?\s*(<a:prstGeom[\s\S]*?</a:prstGeom>|<a:prstGeom[^>]*/>)?\s*<a:noFill/>').hasMatch(spPr);
        final fill = noFill ? null : _color(spPr.replaceAll(RegExp(r'<a:ln\b[\s\S]*?</a:ln>'), ''));
        final ln = RegExp(r'<a:ln\b[^>]*>([\s\S]*?)</a:ln>').firstMatch(spPr)?[1];
        final txBody = RegExp(r'<p:txBody>([\s\S]*?)</p:txBody>').firstMatch(body)?[1] ?? '';
        final anchor = RegExp(r'<a:bodyPr\b[^>]*\banchor="(\w+)"').firstMatch(txBody)?[1] ?? (key == 'title' ? 'ctr' : 't');
        out.add(PptShape(
          x: box[0], y: box[1], w: box[2], h: box[3],
          fill: fill,
          line: ln == null || ln.contains('<a:noFill/>') ? null : _color(ln),
          geom: RegExp(r'<a:prstGeom prst="(\w+)"').firstMatch(spPr)?[1] ?? 'rect',
          paras: _paras(txBody, bulletDefault: key == 'body'),
          anchor: anchor,
          defaultSizePt: key == 'title' ? 36 : (key == null ? 18 : 22),
        ));
      } else if (m[2] != null) {
        final body = m[2]!;
        final box = _xfrm(body);
        final id = RegExp(r'r:embed="([^"]+)"').firstMatch(body)?[1];
        final target = id == null ? null : rels[id];
        if (box == null || target == null) continue;
        final img = _bytes(_resolve(partPath, target));
        if (img == null) continue;
        out.add(PptShape(x: box[0], y: box[1], w: box[2], h: box[3], image: img));
      } else {
        final body = m[3]!;
        final xf = RegExp(r'<p:xfrm>\s*<a:off x="(-?\d+)" y="(-?\d+)"/>\s*<a:ext cx="(\d+)" cy="(\d+)"/>').firstMatch(body);
        final tbl = RegExp(r'<a:tbl>([\s\S]*?)</a:tbl>').firstMatch(body)?[1];
        if (xf == null || tbl == null) continue;
        final rows = <List<({String text, int? fill, int? color, bool bold, double? sizePt})>>[];
        final heights = <double>[];
        final widths = [for (final g in RegExp(r'<a:gridCol w="(\d+)"').allMatches(tbl)) double.parse(g[1]!)];
        for (final tr in RegExp(r'<a:tr\b([^>]*)>([\s\S]*?)</a:tr>').allMatches(tbl)) {
          heights.add(double.tryParse(RegExp(r'\bh="(\d+)"').firstMatch(tr[1]!)?[1] ?? '') ?? 0);
          rows.add([
            for (final tc in RegExp(r'<a:tc\b[^>]*>([\s\S]*?)</a:tc>').allMatches(tr[2]!))
              () {
                final paras = _paras(tc[1]!);
                final firstRun = paras.expand((p) => p.runs).firstOrNull;
                final tcPr = RegExp(r'<a:tcPr\b[^>]*>([\s\S]*?)</a:tcPr>').firstMatch(tc[1]!)?[1] ?? '';
                return (
                  text: paras.map((p) => p.text).join('\n'),
                  fill: _color(tcPr.replaceAll(RegExp(r'<a:ln[LRTB]\b[\s\S]*?</a:ln[LRTB]>'), '')),
                  color: firstRun?.color,
                  bold: firstRun?.bold ?? false,
                  sizePt: firstRun?.sizePt,
                );
              }(),
          ]);
        }
        out.add(PptShape(
          x: double.parse(xf[1]!), y: double.parse(xf[2]!), w: double.parse(xf[3]!), h: double.parse(xf[4]!),
          table: rows,
          rowHeights: heights,
          colWidths: widths,
        ));
      }
    }
    return out;
  }

  List<PptPara> _paras(String txBody, {bool bulletDefault = false}) {
    final out = <PptPara>[];
    for (final p in RegExp(r'<a:p>([\s\S]*?)</a:p>|<a:p/>').allMatches(txBody)) {
      final body = p[1] ?? '';
      final pPr = RegExp(r'<a:pPr\b([^>]*)(?:/>|>([\s\S]*?)</a:pPr>)').firstMatch(body);
      final align = RegExp(r'\balgn="(\w+)"').firstMatch(pPr?[1] ?? '')?[1] ?? 'l';
      final level = int.tryParse(RegExp(r'\blvl="(\d)"').firstMatch(pPr?[1] ?? '')?[1] ?? '') ?? 0;
      final inner = pPr?[2] ?? '';
      final bullet = inner.contains('<a:buChar') || inner.contains('<a:buAutoNum') || (bulletDefault && !inner.contains('<a:buNone'));
      final runs = <PptRun>[];
      for (final r in RegExp(r'<a:r>([\s\S]*?)</a:r>|<a:fld\b[^>]*>([\s\S]*?)</a:fld>').allMatches(body)) {
        final rb = r[1] ?? r[2]!;
        final rPr = RegExp(r'<a:rPr\b([^>]*)(?:/>|>([\s\S]*?)</a:rPr>)').firstMatch(rb);
        final t = RegExp(r'<a:t>([\s\S]*?)</a:t>|<a:t/>').firstMatch(rb)?[1] ?? '';
        final sz = int.tryParse(RegExp(r'\bsz="(\d+)"').firstMatch(rPr?[1] ?? '')?[1] ?? '');
        runs.add(PptRun(
          _unescape(t),
          sizePt: sz == null ? null : sz / 100,
          color: _color(rPr?[2] ?? ''),
          bold: RegExp(r'\bb="1"').hasMatch(rPr?[1] ?? ''),
        ));
      }
      out.add(PptPara(runs, align: align, bullet: bullet && runs.any((r) => r.text.trim().isNotEmpty), level: level));
    }
    return out;
  }

  // ───────────────────────── 颜色 ─────────────────────────

  /// 第一处 solidFill 的颜色 (srgbClr 或 schemeClr), 没有 → null
  int? _color(String xml) {
    final m = RegExp(r'<a:solidFill>\s*<a:(srgbClr|schemeClr|sysClr)\b([^>]*)').firstMatch(xml);
    if (m == null) return null;
    final attrs = m[2]!;
    if (m[1] == 'srgbClr') return int.tryParse(RegExp(r'val="([0-9A-Fa-f]{6})"').firstMatch(attrs)?[1] ?? '', radix: 16);
    if (m[1] == 'sysClr') return int.tryParse(RegExp(r'lastClr="([0-9A-Fa-f]{6})"').firstMatch(attrs)?[1] ?? '', radix: 16);
    final v = RegExp(r'val="(\w+)"').firstMatch(attrs)?[1] ?? '';
    final key = switch (v) { 'tx1' => 'dk1', 'bg1' => 'lt1', 'tx2' => 'dk2', 'bg2' => 'lt2', _ => v };
    return _scheme[key];
  }

  Map<String, int> _readScheme() {
    final out = <String, int>{};
    final theme = _zip.files.where((f) => f.name.startsWith('ppt/theme/') && f.name.endsWith('.xml')).firstOrNull;
    if (theme == null) return out;
    final xml = utf8.decode(theme.content, allowMalformed: true);
    final scheme = RegExp(r'<a:clrScheme\b[^>]*>([\s\S]*?)</a:clrScheme>').firstMatch(xml)?[1] ?? '';
    for (final m in RegExp(r'<a:(\w+)>\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr[^>]*lastClr="([0-9A-Fa-f]{6})")').allMatches(scheme)) {
      final hex = m[2] ?? m[3];
      if (hex != null) out[m[1]!] = int.parse(hex, radix: 16);
    }
    return out;
  }

  // ───────────────────────── 关系 ─────────────────────────

  Map<String, String> _rels(String partPath) {
    final dir = partPath.substring(0, partPath.lastIndexOf('/'));
    final name = partPath.substring(partPath.lastIndexOf('/') + 1);
    final xml = _read('$dir/_rels/$name.rels') ?? '';
    return {
      for (final m in RegExp(r'<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"').allMatches(xml)) m[1]!: m[2]!,
      for (final m in RegExp(r'<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"').allMatches(xml)) m[2]!: m[1]!,
    };
  }

  String? _relOfType(String partPath, Map<String, String> rels, String type) {
    final dir = partPath.substring(0, partPath.lastIndexOf('/'));
    final name = partPath.substring(partPath.lastIndexOf('/') + 1);
    final xml = _read('$dir/_rels/$name.rels') ?? '';
    final m = RegExp('<Relationship\\b[^>]*Type="[^"]*/$type"[^>]*Target="([^"]+)"|<Relationship\\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*/$type"').firstMatch(xml);
    final t = m?[1] ?? m?[2];
    return t == null ? null : _resolve(partPath, t);
  }

  /// 相对 partPath 所在目录解析 Target (../slideLayouts/x.xml 这种)
  String _resolve(String partPath, String target) {
    if (target.startsWith('/')) return target.substring(1);
    final parts = partPath.split('/')..removeLast();
    for (final seg in target.split('/')) {
      if (seg == '..') {
        if (parts.isNotEmpty) parts.removeLast();
      } else if (seg != '.') {
        parts.add(seg);
      }
    }
    return parts.join('/');
  }

  static String _unescape(String s) => s
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
}
