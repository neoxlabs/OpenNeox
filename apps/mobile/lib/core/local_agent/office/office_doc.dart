/// office_doc.dart — 在手机上直接改 PPT / Word / Excel (2026-10-11)。
///
/// 用户: 「工作就是本机, 给它一个工作区域, 它能跟 PC 一样干活 …… 比如用户传给他一个 PPT, 让他改一改」。
/// 手机上没有 python-pptx / LibreOffice, 但 Office 三件套本来就是 zip 里的 XML ——
/// 解包、按结构改 XML、再打包, 纯 Dart 就能做, 不用连电脑也不用云端。
///
/// 能做的 (覆盖「改一改」的大头, 不碰版式和图片):
///   通用   outline 看结构 (第几页 / 第几段 / 哪个格子) · replace 查找替换 · set_text 整段改写
///   PPT    删页 · 复制页 · 挪页
///   Excel  改格子 (数字 / 文字, 公式格改成值; 打开时让 Excel 重算)
///   新建   Word (标题 + 段落) / Excel (一张表)
///
/// 取舍跟 attachment_text.dart 一样: 正则走结构, 不引 DOM 解析器。改字只动 `<a:t>` / `<w:t>` / `<t>`
/// 的文字内容, 格式 (字体、颜色、版式) 跟着原来的第一个 run 走 —— 跨 run 的整段替换会并进第一个 run,
/// 这是「改一改」可以接受的代价, 比改坏文件好。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

import 'docx_builder.dart';
import 'xlsx_builder.dart';

class OfficeEditError implements Exception {
  OfficeEditError(this.message);
  final String message;
  @override
  String toString() => message;
}

enum OfficeKind { pptx, docx, xlsx }

OfficeKind? officeKindOf(String name) {
  final i = name.lastIndexOf('.');
  final ext = i < 0 ? '' : name.substring(i + 1).toLowerCase();
  return switch (ext) {
    'pptx' => OfficeKind.pptx,
    'docx' => OfficeKind.docx,
    'xlsx' || 'xlsm' => OfficeKind.xlsx,
    _ => null,
  };
}

class OfficeDoc {
  OfficeDoc._(this.kind, this._zip);

  factory OfficeDoc.open(String name, Uint8List bytes) {
    final kind = officeKindOf(name);
    if (kind == null) throw OfficeEditError('只能改 .pptx / .docx / .xlsx (老格式 .ppt/.doc/.xls 先另存为新格式)');
    final Archive zip;
    try {
      zip = ZipDecoder().decodeBytes(bytes);
    } catch (_) {
      throw OfficeEditError('$name 打不开，文件可能损坏');
    }
    final doc = OfficeDoc._(kind, zip);
    final probe = switch (kind) {
      OfficeKind.pptx => 'ppt/presentation.xml',
      OfficeKind.docx => 'word/document.xml',
      OfficeKind.xlsx => 'xl/workbook.xml',
    };
    if (doc._read(probe) == null) throw OfficeEditError('$name 不是有效的 ${kind.name.toUpperCase()} 文件');
    return doc;
  }

  final OfficeKind kind;
  final Archive _zip;
  /* 改过的部件先放这, 存的时候一次写回 —— 同一部件改多次不用反复解压 */
  final Map<String, String> _dirty = {};

  String? _read(String path) {
    final d = _dirty[path];
    if (d != null) return d;
    final f = _zip.findFile(path);
    if (f == null) return null;
    return utf8.decode(f.content, allowMalformed: true);
  }

  void _write(String path, String xml) => _dirty[path] = xml;

  Uint8List save() {
    for (final e in _dirty.entries) {
      _zip.add(ArchiveFile.string(e.key, e.value));
    }
    _dirty.clear();
    return ZipEncoder().encodeBytes(_zip);
  }

  // ═══════════════════════ 结构 ═══════════════════════

  /// 给模型看的结构: 每一项带 id, 后面 set_text / set_cell 用它指。
  String outline({int cap = 40000}) {
    final out = StringBuffer();
    switch (kind) {
      case OfficeKind.pptx:
        final slides = _slidePaths();
        out.writeln('PPT 共 ${slides.length} 页。id 形如 s<页>.p<段>。');
        for (var i = 0; i < slides.length; i++) {
          out.writeln('\n## 第 ${i + 1} 页');
          final paras = _paragraphs(_read(slides[i]) ?? '', 'a:p', 'a:t');
          if (paras.isEmpty) out.writeln('(这页没有文字)');
          for (var j = 0; j < paras.length; j++) {
            if (paras[j].text.trim().isEmpty) continue;
            out.writeln('[s${i + 1}.p${j + 1}] ${paras[j].text}');
          }
          if (out.length > cap) break;
        }
      case OfficeKind.docx:
        final paras = _paragraphs(_read('word/document.xml') ?? '', 'w:p', 'w:t');
        out.writeln('Word 共 ${paras.length} 段。id 形如 p<段>。');
        for (var j = 0; j < paras.length; j++) {
          if (paras[j].text.trim().isEmpty) continue;
          out.writeln('[p${j + 1}] ${paras[j].text}');
          if (out.length > cap) break;
        }
      case OfficeKind.xlsx:
        final shared = _sharedStrings();
        for (final sh in _sheets()) {
          out.writeln('\n## 工作表 ${sh.name} (格子 id 形如 ${sh.name}!A1)');
          final xml = _read(sh.path) ?? '';
          var n = 0;
          for (final c in RegExp(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)').allMatches(xml)) {
            final ref = RegExp(r'\br="([A-Z]+\d+)"').firstMatch(c[1]!)?[1];
            if (ref == null) continue;
            final v = _cellValue(c[1]!, c[2] ?? '', shared);
            if (v.isEmpty) continue;
            out.writeln('${sh.name}!$ref = $v');
            if (++n >= 800 || out.length > cap) break;
          }
          if (n == 0) out.writeln('(空表)');
        }
    }
    return out.toString().trim();
  }

  // ═══════════════════════ 预览 (给人看, 2026-10-12) ═══════════════════════
  // 对话里点文件卡 → 预览页 (artifact_preview_page.dart)。只取字和表格, 不排版。

  /// PPT: 每页的段落 (空段去掉), 按放映顺序
  List<List<String>> slideTexts() => [
        for (final p in _slidePaths())
          [for (final x in _paragraphs(_read(p) ?? '', 'a:p', 'a:t')) if (x.text.trim().isNotEmpty) x.text.trim()],
      ];

  /// Word: 段落 (空段保留成空串, 预览里当段间距)
  List<String> paragraphTexts() => [for (final x in _paragraphs(_read('word/document.xml') ?? '', 'w:p', 'w:t')) x.text];

  /// Excel: 每个工作表的格子网格 (最多 maxRows 行 × maxCols 列)
  List<({String name, List<List<String>> rows})> sheetGrids({int maxRows = 300, int maxCols = 26}) {
    final shared = _sharedStrings();
    final out = <({String name, List<List<String>> rows})>[];
    for (final sh in _sheets()) {
      final xml = _read(sh.path) ?? '';
      final cells = <int, Map<int, String>>{};
      var maxC = 0;
      for (final c in RegExp(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)').allMatches(xml)) {
        final m = RegExp(r'\br="([A-Z]+)(\d+)"').firstMatch(c[1]!);
        if (m == null) continue;
        final col = _colIndex(m[1]!) - 1;
        final row = int.parse(m[2]!) - 1;
        if (row >= maxRows || col >= maxCols) continue;
        final v = _cellValue(c[1]!, c[2] ?? '', shared);
        if (v.isEmpty) continue;
        (cells[row] ??= {})[col] = v;
        if (col + 1 > maxC) maxC = col + 1;
      }
      final lastRow = cells.keys.isEmpty ? -1 : cells.keys.reduce((a, b) => a > b ? a : b);
      out.add((
        name: sh.name,
        rows: [for (var r = 0; r <= lastRow; r++) [for (var c = 0; c < maxC; c++) cells[r]?[c] ?? '']],
      ));
    }
    return out;
  }

  // ═══════════════════════ 改字 ═══════════════════════

  /// 全文查找替换, 返回替换了几处。
  int replace(String find, String replacement) {
    if (find.isEmpty) throw OfficeEditError('find 不能为空');
    var count = 0;
    switch (kind) {
      case OfficeKind.pptx:
        for (final p in _slidePaths()) {
          count += _replaceInPart(p, 'a:p', 'a:t', find, replacement);
        }
      case OfficeKind.docx:
        for (final p in _zip.files.map((f) => f.name).where(_isWordTextPart)) {
          count += _replaceInPart(p, 'w:p', 'w:t', find, replacement);
        }
      case OfficeKind.xlsx:
        /* 共享字符串 + 各表里的行内字符串 */
        for (final p in ['xl/sharedStrings.xml', for (final s in _sheets()) s.path]) {
          final xml = _read(p);
          if (xml == null) continue;
          var n = 0;
          final next = xml.replaceAllMapped(RegExp(r'(<t\b[^>]*>)([^<]*)(</t>)'), (m) {
            final t = _unescape(m[2]!);
            if (!t.contains(find)) return m[0]!;
            n += find.allMatches(t).length;
            return '${_preserve(m[1]!)}${_escape(t.replaceAll(find, replacement))}${m[3]}';
          });
          if (n > 0) _write(p, next);
          count += n;
        }
    }
    return count;
  }

  /// 按 outline 里的 id 整段改写 (PPT: s3.p2 / Word: p12)。
  void setText(String id, String text) {
    final m = RegExp(r'^(?:s(\d+)\.)?p(\d+)$').firstMatch(id.trim());
    if (m == null) throw OfficeEditError('id 写错了: $id (PPT 用 s<页>.p<段>, Word 用 p<段>)');
    final paraIndex = int.parse(m[2]!) - 1;
    final String part;
    final String pTag;
    final String tTag;
    if (kind == OfficeKind.pptx) {
      if (m[1] == null) throw OfficeEditError('PPT 的 id 要带页: s<页>.p<段>');
      final slides = _slidePaths();
      final s = int.parse(m[1]!) - 1;
      if (s < 0 || s >= slides.length) throw OfficeEditError('没有第 ${s + 1} 页 (共 ${slides.length} 页)');
      part = slides[s];
      pTag = 'a:p';
      tTag = 'a:t';
    } else if (kind == OfficeKind.docx) {
      part = 'word/document.xml';
      pTag = 'w:p';
      tTag = 'w:t';
    } else {
      throw OfficeEditError('Excel 用 set_cell 改格子');
    }
    final xml = _read(part) ?? '';
    final paras = _paragraphs(xml, pTag, tTag);
    if (paraIndex < 0 || paraIndex >= paras.length) throw OfficeEditError('没有段落 $id');
    final p = paras[paraIndex];
    if (p.runs.isEmpty) throw OfficeEditError('段落 $id 里没有文字可改 (可能是图片或空占位)');
    _write(part, xml.replaceRange(p.start, p.end, _rewriteParagraph(p, text, tTag)));
  }

  // ═══════════════════════ PPT 页 ═══════════════════════

  void deleteSlide(int n) {
    final pres = _read('ppt/presentation.xml')!;
    final ids = _sldIds(pres);
    if (ids.length <= 1) throw OfficeEditError('只剩一页了, 不能再删');
    if (n < 1 || n > ids.length) throw OfficeEditError('没有第 $n 页 (共 ${ids.length} 页)');
    final m = ids[n - 1];
    _write('ppt/presentation.xml', pres.replaceRange(m.start, m.end, ''));
    /* 页文件留在包里不引用 —— 删文件还要连带清备注页的反向引用, 改坏的风险比几十 KB 体积大 */
  }

  void duplicateSlide(int n) {
    final pres = _read('ppt/presentation.xml')!;
    final ids = _sldIds(pres);
    if (n < 1 || n > ids.length) throw OfficeEditError('没有第 $n 页 (共 ${ids.length} 页)');
    final src = _slidePaths()[n - 1];
    final srcName = src.split('/').last;
    final nums = _zip.files
        .map((f) => RegExp(r'^ppt/slides/slide(\d+)\.xml$').firstMatch(f.name)?[1])
        .whereType<String>()
        .map(int.parse)
        .followedBy(_dirty.keys.map((k) => RegExp(r'^ppt/slides/slide(\d+)\.xml$').firstMatch(k)?[1]).whereType<String>().map(int.parse));
    final newNum = nums.fold<int>(0, (a, b) => a > b ? a : b) + 1;
    final newName = 'slide$newNum.xml';
    _write('ppt/slides/$newName', _read(src)!);
    final rels = _read('ppt/slides/_rels/$srcName.rels');
    if (rels != null) {
      /* 备注页是一页一份的, 两页共用一份打开会报修复 —— 复制出来的页不带备注 */
      _write('ppt/slides/_rels/$newName.rels',
          rels.replaceAll(RegExp(r'<Relationship\b[^>]*Type="[^"]*/notesSlide"[^>]*/>'), ''));
    }
    final ct = _read('[Content_Types].xml')!;
    _write('[Content_Types].xml', ct.replaceFirst('</Types>',
        '<Override PartName="/ppt/slides/$newName" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'));
    final presRels = _read('ppt/_rels/presentation.xml.rels')!;
    final rid = _nextRid(presRels);
    _write('ppt/_rels/presentation.xml.rels', presRels.replaceFirst('</Relationships>',
        '<Relationship Id="$rid" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/$newName"/></Relationships>'));
    final maxId = ids.map((m) => int.parse(RegExp(r'\bid="(\d+)"').firstMatch(m[0]!)![1]!)).fold<int>(255, (a, b) => a > b ? a : b);
    final at = ids[n - 1];
    _write('ppt/presentation.xml', pres.replaceRange(at.end, at.end, '<p:sldId id="${maxId + 1}" r:id="$rid"/>'));
  }

  void moveSlide(int from, int to) {
    final pres = _read('ppt/presentation.xml')!;
    final ids = _sldIds(pres);
    if (from < 1 || from > ids.length || to < 1 || to > ids.length) {
      throw OfficeEditError('页码超出范围 (共 ${ids.length} 页)');
    }
    final items = ids.map((m) => m[0]!).toList();
    final moved = items.removeAt(from - 1);
    items.insert(to - 1, moved);
    _write('ppt/presentation.xml', pres.replaceRange(ids.first.start, ids.last.end, items.join()));
  }

  // ═══════════════════════ Excel 格子 ═══════════════════════

  /// "Sheet1!A1:C3" / "A1:C3" → (表, 区域)
  ({String name, String path}) _sheetOf(String? name) {
    final sheets = _sheets();
    if (name == null || name.isEmpty) return sheets.first;
    return sheets.firstWhere((s) => s.name == name.replaceAll("'", ''),
        orElse: () => throw OfficeEditError('没有工作表 $name (有: ${sheets.map((s) => s.name).join('、')})'));
  }

  /// 区域设数字格式 (百分比 / 金额 / 千分位 ...)。在原格子的样式上只换数字格式 —— 字体、底色、边框都留着。
  /// 返回改了几格 (空格子不算)。
  int setFormat(String range, String format) {
    if (kind != OfficeKind.xlsx) throw OfficeEditError('只有 Excel 能 set_format');
    final key = XlsxBuilder.normalizeFormat(format);
    if (key == 'general' && !RegExp(r'^(general|常规)$', caseSensitive: false).hasMatch(format.trim())) {
      throw OfficeEditError('不认识的格式 $format (percent / money / thousands / decimal / int / date)');
    }
    final m = RegExp(r'^(?:(.+)!)?([$A-Za-z0-9]+(?::[$A-Za-z0-9]+)?)$').firstMatch(range.trim());
    if (m == null) throw OfficeEditError('区域写错了: $range (例: Sheet1!C2:C9)');
    final sheet = _sheetOf(m[1]);
    final refs = XlsxBuilder.refsOf(m[2]!).toSet();
    if (refs.isEmpty) throw OfficeEditError('区域写错了: $range');

    var styles = _read('xl/styles.xml');
    if (styles == null) throw OfficeEditError('这个 Excel 没有样式表, 改不了格式');
    final fmt = XlsxBuilder.numFmtOf(key);
    var fmtId = fmt.id;
    if (fmt.code != null) {
      /* 自定义格式: 已有同样的格式码就复用它的 id, 没有就新分一个 (>=164, 不撞原文件的) */
      final code = _escape(fmt.code!);
      final existing = RegExp('<numFmt\\b[^>]*numFmtId="(\\d+)"[^>]*formatCode="${RegExp.escape(code)}"').firstMatch(styles);
      if (existing != null) {
        fmtId = int.parse(existing[1]!);
      } else {
        final used = RegExp(r'<numFmt\b[^>]*numFmtId="(\d+)"').allMatches(styles).map((x) => int.parse(x[1]!));
        fmtId = used.fold<int>(163, (a, b) => a > b ? a : b) + 1;
        final nf = '<numFmt numFmtId="$fmtId" formatCode="$code"/>';
        /* openpyxl 存的是空的 <numFmts count="0"/>, 先当没有处理 */
        styles = styles.replaceFirst(RegExp(r'<numFmts\b[^>]*/>'), '');
        final open = RegExp(r'<numFmts\b[^>]*>').firstMatch(styles);
        styles = open != null
            ? styles.replaceRange(open.start, open.end,
                '<numFmts count="${RegExp(r'<numFmt\b').allMatches(styles).length + 1}">$nf')
            : styles.replaceFirstMapped(RegExp(r'(<styleSheet\b[^>]*>)'), (x) => '${x[1]}<numFmts count="1">$nf</numFmts>');
      }
    }
    final xfsM = RegExp(r'<cellXfs\b[^>]*>([\s\S]*?)</cellXfs>').firstMatch(styles);
    if (xfsM == null) throw OfficeEditError('样式表里没有 cellXfs, 改不了格式');
    final xfs = RegExp(r'<xf\b[^>]*?(?:/>|>[\s\S]*?</xf>)').allMatches(xfsM[1]!).map((x) => x[0]!).toList();
    final added = <String>[];
    final remap = <int, int>{};
    int styleFor(int old) => remap.putIfAbsent(old, () {
          final base = old < xfs.length ? xfs[old] : '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
          var next = base.replaceFirst(RegExp(r'\bnumFmtId="\d+"'), 'numFmtId="$fmtId"');
          if (!next.contains('applyNumberFormat')) next = next.replaceFirst('<xf ', '<xf applyNumberFormat="1" ');
          added.add(next);
          return xfs.length + added.length - 1;
        });

    var xml = _read(sheet.path)!;
    var changed = 0;
    xml = xml.replaceAllMapped(RegExp(r'<c\b([^>]*?)(/?)>'), (c) {
      final ref = RegExp(r'\br="([A-Z]+\d+)"').firstMatch(c[1]!)?[1];
      if (ref == null || !refs.contains(ref)) return c[0]!;
      changed++;
      final old = int.tryParse(RegExp(r'\bs="(\d+)"').firstMatch(c[1]!)?[1] ?? '0') ?? 0;
      final s = styleFor(old);
      final attrs = c[1]!.contains(RegExp(r'\bs="')) ? c[1]!.replaceFirst(RegExp(r'\bs="\d+"'), 's="$s"') : '${c[1]} s="$s"';
      return '<c$attrs${c[2]}>';
    });
    if (changed == 0) return 0;
    styles = styles.replaceFirstMapped(RegExp(r'<cellXfs\b([^>]*)>([\s\S]*?)</cellXfs>'), (x) {
      final attrs = x[1]!.replaceFirst(RegExp(r'\bcount="\d+"'), 'count="${xfs.length + added.length}"');
      return '<cellXfs$attrs>${x[2]}${added.join()}</cellXfs>';
    });
    _write('xl/styles.xml', styles);
    _write(sheet.path, xml);
    return changed;
  }

  /// 在已有的表上加原生图表, 原表一格不动。sheet 不给就是第一张表。
  void addChart(XlsxChartSpec spec, {String? sheet}) {
    if (kind != OfficeKind.xlsx) throw OfficeEditError('只有 Excel 能 add_chart');
    final sh = _sheetOf(sheet);
    if (XlsxBuilder.refsOf(spec.categories).isEmpty || spec.series.isEmpty) {
      throw OfficeEditError('图表要 categories (如 "A2:A5") 和 series [{name, values: "B2:B5"}]');
    }
    final grid = sheetGrids(maxRows: 2000, maxCols: 60).firstWhere((g) => g.name == sh.name).rows;
    String text(String ref) {
      final p = RegExp(r'^\$?([A-Za-z]+)\$?(\d+)$').firstMatch(ref.trim());
      if (p == null) return '';
      final r = int.parse(p[2]!) - 1, c = _colIndex(p[1]!.toUpperCase()) - 1;
      final v = r < grid.length && c < grid[r].length ? grid[r][c] : '';
      final i = v.indexOf('  (公式 =');
      return i < 0 ? v : v.substring(0, i);
    }

    /* 部件编号: 全包里找没用过的 */
    int nextNo(String prefix) {
      var n = 1;
      while (_read('$prefix$n.xml') != null) {
        n++;
      }
      return n;
    }

    const ns = 'http://schemas.openxmlformats.org';
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var ct = _read('[Content_Types].xml')!;
    final chartNo = nextNo('xl/charts/chart');
    _write('xl/charts/chart$chartNo.xml',
        XlsxBuilder.chartXml(spec, sh.name, text: text, number: (ref) => double.tryParse(text(ref).replaceAll(',', ''))));
    ct = ct.replaceFirst('</Types>',
        '<Override PartName="/xl/charts/chart$chartNo.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>');

    final sheetFile = sh.path.split('/').last;
    final sheetRelsPath = '${sh.path.substring(0, sh.path.lastIndexOf('/'))}/_rels/$sheetFile.rels';
    var sheetRels = _read(sheetRelsPath) ?? '$head<Relationships xmlns="$ns/package/2006/relationships"></Relationships>';
    var xml = _read(sh.path)!;
    final maxCol = grid.fold<int>(0, (a, r) => r.length > a ? r.length : a);

    final drawingRid = RegExp(r'<drawing\b[^>]*\br:id="([^"]+)"').firstMatch(xml)?[1];
    String drawingPath;
    var existingCharts = 0;
    if (drawingRid != null) {
      /* 表上已经有图 (图片 / 别的图表): 往同一个 drawing 里加 */
      final rel = RegExp('<Relationship\\b[^>]*\\bId="$drawingRid"[^>]*>').firstMatch(sheetRels)?[0] ?? '';
      final target = RegExp(r'\bTarget="([^"]+)"').firstMatch(rel)?[1] ?? '';
      drawingPath = target.startsWith('/') ? target.substring(1) : Uri.parse(sh.path).resolve(target).path;
      existingCharts = RegExp(r'<xdr:graphicFrame\b|<xdr:pic\b').allMatches(_read(drawingPath) ?? '').length;
    } else {
      final dn = nextNo('xl/drawings/drawing');
      drawingPath = 'xl/drawings/drawing$dn.xml';
      _write(drawingPath, XlsxBuilder.drawingXml(''));
      ct = ct.replaceFirst('</Types>',
          '<Override PartName="/$drawingPath" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
      final rid = _nextRid(sheetRels);
      sheetRels = sheetRels.replaceFirst('</Relationships>',
          '<Relationship Id="$rid" Type="$ns/officeDocument/2006/relationships/drawing" Target="../drawings/drawing$dn.xml"/></Relationships>');
      /* <drawing> 在 schema 里的位置: pageMargins / pageSetup / headerFooter ... 之后, legacyDrawing / tableParts / extLst 之前 */
      final before = RegExp(r'<(legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b').firstMatch(xml);
      final tag = '<drawing r:id="$rid"/>';
      xml = before != null ? xml.replaceRange(before.start, before.start, tag) : xml.replaceFirst('</worksheet>', '$tag</worksheet>');
      if (!xml.contains('xmlns:r=')) {
        xml = xml.replaceFirst(RegExp(r'<worksheet\b'), '<worksheet xmlns:r="$ns/officeDocument/2006/relationships"');
      }
      _write(sh.path, xml);
      _write(sheetRelsPath, sheetRels);
    }

    final drawingDir = drawingPath.substring(0, drawingPath.lastIndexOf('/'));
    final drawingRelsPath = '$drawingDir/_rels/${drawingPath.split('/').last}.rels';
    var drawingRels = _read(drawingRelsPath) ?? '$head<Relationships xmlns="$ns/package/2006/relationships"></Relationships>';
    final chartRid = _nextRid(drawingRels);
    drawingRels = drawingRels.replaceFirst('</Relationships>',
        '<Relationship Id="$chartRid" Type="$ns/officeDocument/2006/relationships/chart" Target="../charts/chart$chartNo.xml"/></Relationships>');
    _write(drawingRelsPath, drawingRels);
    final drawing = _read(drawingPath)!;
    final ids = RegExp(r'<xdr:cNvPr\b[^>]*\bid="(\d+)"').allMatches(drawing).map((x) => int.parse(x[1]!));
    final from = XlsxBuilder.anchorCell(spec.anchor, maxCol, existingCharts);
    _write(drawingPath, drawing.replaceFirst('</xdr:wsDr>',
        '${XlsxBuilder.anchorXml(from.$1, from.$2, ids.fold<int>(1, (a, b) => a > b ? a : b) + 1, chartRid)}</xdr:wsDr>'));
    _write('[Content_Types].xml', ct);
  }

  /// 给公式求值用的格子网格: 有缓存值的用值, 只有公式没值的 (刚 set_cell 写进去的) 写成 "=..." 让求值器接着算
  List<List<String>> _formulaGrid(String sheetPath) {
    final shared = _sharedStrings();
    final xml = _read(sheetPath) ?? '';
    final rows = <List<String>>[];
    for (final c in RegExp(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)').allMatches(xml)) {
      final m = RegExp(r'\br="([A-Z]+)(\d+)"').firstMatch(c[1]!);
      if (m == null) continue;
      final col = _colIndex(m[1]!) - 1;
      final row = int.parse(m[2]!) - 1;
      if (row > 5000 || col > 200) continue;
      final inner = c[2] ?? '';
      final f = RegExp(r'<f\b[^>]*>([^<]*)</f>').firstMatch(inner)?[1];
      final hasV = inner.contains('<v>');
      String v;
      if (f != null && !hasV) {
        v = '=${_unescape(f)}';
      } else {
        v = _cellValue(c[1]!, inner, shared);
        final i = v.indexOf('  (公式 =');
        if (i >= 0) v = v.substring(0, i);
      }
      while (rows.length <= row) {
        rows.add(<String>[]);
      }
      final r = rows[row];
      while (r.length <= col) {
        r.add('');
      }
      r[col] = v;
    }
    return rows;
  }

  /// cell 形如 "Sheet1!B3" 或 "B3" (第一张表)。value 像数字就存数字, 否则存文字。
  /// 写的是公式时返回算出来的值 (double / String; 算不了是 null), 回执里给模型看真数, 别让它自己心算
  Object? setCell(String cell, String value) {
    if (kind != OfficeKind.xlsx) throw OfficeEditError('只有 Excel 能 set_cell');
    final m = RegExp(r'^(?:(.+)!)?\$?([A-Za-z]+)\$?(\d+)$').firstMatch(cell.trim());
    if (m == null) throw OfficeEditError('格子写错了: $cell (例: Sheet1!B3)');
    final sheets = _sheets();
    final sheet = m[1] == null
        ? sheets.first
        : sheets.firstWhere((s) => s.name == m[1]!.replaceAll("'", ''),
            orElse: () => throw OfficeEditError('没有工作表 ${m[1]} (有: ${sheets.map((s) => s.name).join('、')})'));
    final col = m[2]!.toUpperCase();
    final row = int.parse(m[3]!);
    final ref = '$col$row';
    final numeric = RegExp(r'^-?\d+(\.\d+)?([eE][-+]?\d+)?$').hasMatch(value.trim());
    final formula = value.trim().startsWith('=') && value.trim().length > 1;
    /* 文字走共享字符串表 (t="s"), 不用 inlineStr —— WPS 手机版 / 微信预览把 inlineStr 格当空 (2026-10-12 实拍)。
     * `=` 开头写真公式 (2026-10-16 之前当文字存, 用户打开是一串「=SUM(...)」); 打开时由 _forceRecalc 让表格软件重算 */
    /* 公式顺手算好写进 <v>: WPS 手机版 / 微信预览不重算, 没缓存值就是空格子 */
    final cached = formula ? XlsxBuilder.evaluate(_formulaGrid(sheet.path), value) : null;
    final f = formula ? '<f>${_escape(value.trim().substring(1))}</f>' : '';
    final cellXml = formula
        ? cached is double
            ? '<c r="$ref"STYLE>$f<v>${XlsxBuilder.numText(cached)}</v></c>'
            : cached is String
                ? '<c r="$ref"STYLE t="str">$f<v>${_escape(cached)}</v></c>'
                : '<c r="$ref"STYLE>$f</c>'
        : numeric
            ? '<c r="$ref"STYLE><v>${value.trim()}</v></c>'
            : '<c r="$ref"STYLE t="s"><v>${_sharedStringIndex(value)}</v></c>';

    var xml = _read(sheet.path)!;
    final existing = RegExp('<c\\b[^>]*\\br="$ref"[^>]*?(?:/>|>[\\s\\S]*?</c>)').firstMatch(xml);
    if (existing != null) {
      /* 留住原格子的样式 (s=), 公式 / 旧类型一并丢掉 —— 改成值 */
      final style = RegExp(r'\bs="\d+"').firstMatch(existing[0]!)?[0];
      xml = xml.replaceRange(existing.start, existing.end, cellXml.replaceFirst('STYLE', style == null ? '' : ' $style'));
    } else {
      final c = cellXml.replaceFirst('STYLE', '');
      final rowM = RegExp('<row\\b[^>]*\\br="$row"[^>]*?(?:/>|>([\\s\\S]*?)</row>)').firstMatch(xml);
      if (rowM != null) {
        final rowXml = rowM[0]!;
        String nextRow;
        if (rowXml.endsWith('/>')) {
          nextRow = '${rowXml.substring(0, rowXml.length - 2)}>$c</row>';
        } else {
          /* 插到列序对的位置 */
          final cells = RegExp(r'<c\b[^>]*\br="([A-Z]+)\d+"').allMatches(rowXml).toList();
          final after = cells.where((x) => _colIndex(x[1]!) > _colIndex(col)).toList();
          nextRow = after.isEmpty
              ? rowXml.replaceFirst(RegExp(r'</row>$'), '$c</row>')
              : rowXml.replaceRange(after.first.start, after.first.start, c);
        }
        xml = xml.replaceRange(rowM.start, rowM.end, nextRow);
      } else {
        final newRow = '<row r="$row">$c</row>';
        final rows = RegExp(r'<row\b[^>]*\br="(\d+)"').allMatches(xml).toList();
        final after = rows.where((x) => int.parse(x[1]!) > row).toList();
        if (after.isNotEmpty) {
          xml = xml.replaceRange(after.first.start, after.first.start, newRow);
        } else if (xml.contains('<sheetData/>')) {
          xml = xml.replaceFirst('<sheetData/>', '<sheetData>$newRow</sheetData>');
        } else {
          xml = xml.replaceFirst('</sheetData>', '$newRow</sheetData>');
        }
      }
    }
    _write(sheet.path, xml);
    _forceRecalc();
    return cached;
  }

  // ═══════════════════════ 新建 ═══════════════════════

  /// 新建 Word: Markdown 常用写法 (标题 / 列表 / 表格 / 加粗 / 引用 / 分页), 见 [DocxBuilder]。
  static Uint8List createDocx(String body) => DocxBuilder(body).build();

  /// 新建 Excel: 一张表, rows 是行 (每行若干格)。公式 / 格式 / 多表 / 图表见 [XlsxBuilder]。
  ///
  /// 按 Excel 自己存盘的样子写全: 共享字符串表 + 样式表 + docProps + 列宽。
  /// 第一版图省事用 inlineStr、没有 styles.xml —— Excel / LibreOffice 读得出, 但 WPS 手机版和
  /// 微信里的预览把文字格全当空, 用户拿到一张空表 (2026-10-12 实拍「学生座位表」)。
  static Uint8List createXlsx(List<List<String>> rows, {String sheetName = 'Sheet1'}) =>
      XlsxBuilder([XlsxSheetSpec(name: sheetName, rows: rows)]).build();

  // ═══════════════════════ 内部 ═══════════════════════

  /// PPT 页按放映顺序 (presentation.xml 的 sldIdLst, 不是文件名的数字)。
  List<String> _slidePaths() {
    final pres = _read('ppt/presentation.xml') ?? '';
    final rels = _read('ppt/_rels/presentation.xml.rels') ?? '';
    final targets = <String, String>{
      for (final r in RegExp(r'<Relationship\b[^>]*>').allMatches(rels))
        if (RegExp(r'\bId="([^"]+)"').firstMatch(r[0]!) case final id?)
          id[1]!: RegExp(r'\bTarget="([^"]+)"').firstMatch(r[0]!)?[1] ?? '',
    };
    return [
      for (final m in _sldIds(pres))
        if (RegExp(r'\br:id="([^"]+)"').firstMatch(m[0]!) case final rid?)
          if (targets[rid[1]!] case final t? when t.isNotEmpty) 'ppt/${t.replaceFirst(RegExp(r'^/?ppt/'), '')}',
    ];
  }

  List<RegExpMatch> _sldIds(String pres) =>
      RegExp(r'<p:sldId\b[^>]*/>').allMatches(pres).toList();

  String _nextRid(String rels) {
    final used = RegExp(r'\bId="rId(\d+)"').allMatches(rels).map((m) => int.parse(m[1]!));
    return 'rId${used.fold<int>(0, (a, b) => a > b ? a : b) + 1}';
  }

  bool _isWordTextPart(String name) =>
      name == 'word/document.xml' || RegExp(r'^word/(header|footer)\d*\.xml$').hasMatch(name);

  int _replaceInPart(String part, String pTag, String tTag, String find, String replacement) {
    final xml = _read(part);
    if (xml == null) return 0;
    var count = 0;
    final buf = StringBuffer();
    var cursor = 0;
    for (final p in _paragraphs(xml, pTag, tTag)) {
      if (!p.text.contains(find)) continue;
      count += find.allMatches(p.text).length;
      /* 落在一个 run 里: 只改那个 run, 格式原样 */
      final single = p.runs.where((r) => r.text.contains(find)).toList();
      final String next;
      if (single.isNotEmpty && single.fold<int>(0, (a, r) => a + find.allMatches(r.text).length) == find.allMatches(p.text).length) {
        var para = xml.substring(p.start, p.end);
        for (final r in single.reversed) {
          final rs = r.start - p.start;
          final re = r.end - p.start;
          para = para.replaceRange(rs, re, _escape(r.text.replaceAll(find, replacement)));
        }
        next = para;
      } else {
        next = _rewriteParagraph(p, p.text.replaceAll(find, replacement), tTag);
      }
      buf
        ..write(xml.substring(cursor, p.start))
        ..write(next);
      cursor = p.end;
    }
    if (count == 0) return 0;
    buf.write(xml.substring(cursor));
    _write(part, buf.toString());
    return count;
  }

  /// 整段文字放进第一个文字 run, 其余 run 清空 —— 格式跟第一个 run。
  String _rewriteParagraph(_Para p, String text, String tTag) {
    final xml = p.xml;
    final out = StringBuffer();
    var cursor = 0;
    for (var i = 0; i < p.runs.length; i++) {
      final r = p.runs[i];
      final rs = r.start - p.start;
      final re = r.end - p.start;
      out.write(xml.substring(cursor, rs));
      out.write(i == 0 ? _escape(text) : '');
      cursor = re;
    }
    out.write(xml.substring(cursor));
    /* Word 的 w:t 首尾空格要 preserve, 否则会被吃掉; PPT 的 a:t 不收属性, 不加 */
    if (tTag != 'w:t') return out.toString();
    return out.toString().replaceFirst(RegExp('<w:t(?=[ >])(?![^>]*xml:space)'), '<w:t xml:space="preserve"');
  }

  List<_Para> _paragraphs(String xml, String pTag, String tTag) {
    final out = <_Para>[];
    for (final m in RegExp('<$pTag\\b(?:[^>]*/>|[^>]*>[\\s\\S]*?</$pTag>)').allMatches(xml)) {
      final pxml = m[0]!;
      if (pxml.endsWith('/>') && !pxml.contains('</')) {
        out.add(_Para(m.start, m.end, pxml, const []));
        continue;
      }
      final runs = <_Run>[];
      for (final t in RegExp('<$tTag\\b[^>]*>([^<]*)</$tTag>').allMatches(pxml)) {
        final open = t[0]!.indexOf('>') + 1;
        final s = m.start + t.start + open;
        runs.add(_Run(s, s + t[1]!.length, _unescape(t[1]!)));
      }
      out.add(_Para(m.start, m.end, pxml, runs));
    }
    return out;
  }

  List<({String name, String path})> _sheets() {
    final wb = _read('xl/workbook.xml') ?? '';
    final rels = _read('xl/_rels/workbook.xml.rels') ?? '';
    final out = <({String name, String path})>[];
    for (final s in RegExp(r'<sheet\b[^>]*/>').allMatches(wb)) {
      final name = _unescape(RegExp(r'\bname="([^"]*)"').firstMatch(s[0]!)?[1] ?? '');
      final rid = RegExp(r'\br:id="([^"]+)"').firstMatch(s[0]!)?[1];
      if (rid == null) continue;
      final rel = RegExp('<Relationship\\b[^>]*\\bId="$rid"[^>]*>').firstMatch(rels)?[0];
      final target = rel == null ? null : RegExp(r'\bTarget="([^"]+)"').firstMatch(rel)?[1];
      if (target == null) continue;
      out.add((name: name, path: target.startsWith('/') ? target.substring(1) : 'xl/$target'));
    }
    if (out.isEmpty) throw OfficeEditError('这个 Excel 里没找到工作表');
    return out;
  }

  List<String> _sharedStrings() {
    final xml = _read('xl/sharedStrings.xml');
    if (xml == null) return const [];
    return [
      for (final si in RegExp(r'<si\b[^>]*>([\s\S]*?)</si>').allMatches(xml))
        RegExp(r'<t\b[^>]*>([^<]*)</t>').allMatches(si[1]!).map((t) => _unescape(t[1]!)).join(),
    ];
  }

  /// 文字在共享字符串表里的序号 —— 有就复用, 没有就追加 (表本身不存在时建出来并登记关系 / 类型)。
  int _sharedStringIndex(String text) {
    const path = 'xl/sharedStrings.xml';
    var xml = _read(path);
    if (xml == null) {
      xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
          '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>';
      final rels = _read('xl/_rels/workbook.xml.rels') ?? '';
      _write('xl/_rels/workbook.xml.rels', rels.replaceFirst('</Relationships>',
          '<Relationship Id="${_nextRid(rels)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
      final ct = _read('[Content_Types].xml') ?? '';
      if (!ct.contains('/xl/sharedStrings.xml')) {
        _write('[Content_Types].xml', ct.replaceFirst('</Types>',
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
      }
    }
    final existing = _sharedStrings();
    final hit = existing.indexOf(text);
    if (hit >= 0) return hit;
    final si = '<si><t xml:space="preserve">${_escape(text)}</t></si>';
    xml = xml.contains('</sst>') ? xml.replaceFirst('</sst>', '$si</sst>') : xml.replaceFirst(RegExp(r'/>\s*$'), '>$si</sst>');
    final n = existing.length + 1;
    xml = xml
        .replaceFirst(RegExp(r'\buniqueCount="\d+"'), 'uniqueCount="$n"')
        .replaceFirstMapped(RegExp(r'\bcount="(\d+)"'), (m) => 'count="${int.parse(m[1]!) + 1}"');
    _write(path, xml);
    return existing.length;
  }

  String _cellValue(String attrs, String inner, List<String> shared) {
    final t = RegExp(r'\bt="([^"]+)"').firstMatch(attrs)?[1];
    final v = RegExp(r'<v>([^<]*)</v>').firstMatch(inner)?[1];
    final f = RegExp(r'<f\b[^>]*>([^<]*)</f>').firstMatch(inner)?[1];
    String out;
    if (t == 's' && v != null) {
      final i = int.tryParse(v);
      out = i != null && i < shared.length ? shared[i] : '';
    } else if (t == 'inlineStr') {
      out = RegExp(r'<t\b[^>]*>([^<]*)</t>').allMatches(inner).map((x) => _unescape(x[1]!)).join();
    } else {
      out = _unescape(v ?? '');
    }
    return f == null ? out : '$out  (公式 =${_unescape(f)})';
  }

  void _forceRecalc() {
    final wb = _read('xl/workbook.xml');
    if (wb == null || wb.contains('fullCalcOnLoad')) return;
    final next = wb.contains('<calcPr')
        ? wb.replaceFirst('<calcPr', '<calcPr fullCalcOnLoad="1"')
        : wb.replaceFirst('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
    _write('xl/workbook.xml', next);
    /* calcChain 记着旧公式链, 改了格子以后它可能对不上 —— 删掉让 Excel 重建 */
    final chain = _zip.findFile('xl/calcChain.xml');
    if (chain != null) _zip.removeFile(chain);
  }

  static int _colIndex(String col) => col.codeUnits.fold(0, (a, c) => a * 26 + (c - 64));


  static String _preserve(String openTag) =>
      openTag.contains('xml:space') ? openTag : openTag.replaceFirst(RegExp(r'^<t\b'), '<t xml:space="preserve"');

  static String _escape(String s) =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  static String _unescape(String s) => s
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAllMapped(RegExp(r'&#(x?)([0-9a-fA-F]+);'),
          (m) => String.fromCharCode(int.parse(m[2]!, radix: m[1]!.isEmpty ? 10 : 16)))
      .replaceAll('&amp;', '&');
}

class _Para {
  const _Para(this.start, this.end, this.xml, this.runs);
  final int start;
  final int end;
  final String xml;
  final List<_Run> runs;
  String get text => runs.map((r) => r.text).join();
}

/// 一个文字 run 的**文字内容**在整份 XML 里的位置 (不含标签)。
class _Run {
  const _Run(this.start, this.end, this.text);
  final int start;
  final int end;
  final String text;
}
