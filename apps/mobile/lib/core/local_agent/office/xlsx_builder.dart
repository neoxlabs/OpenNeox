/// xlsx_builder.dart — 手机本机新建 Excel (纯 Dart OOXML)。
///
/// 2026-10-16 实测「做一张带公式和柱状图的销售表」: 旧 createXlsx 把 `=SUM(B2:G2)` 当文字存进共享字符串,
/// 打开就是一串字, 模型还回复「公式已生效」。这一版:
///   · `=` 开头 → 真公式 `<f>`, 并且自己把值算好写进 `<v>` (WPS 手机版 / 微信预览不重算, 没缓存值就是空格子)
///   · 数字格式: 百分比 / 金额 / 千分位 / 小数 / 日期; "12%" "1,200" "¥3,000" 这类文字直接认成数字 + 对应格式
///   · 多张工作表、表头加粗底色、合计行加粗、冻结首行、合并单元格、列宽
///   · 原生图表 (柱 / 横条 / 折线 / 饼), 在 Excel / WPS 里可以继续编辑
/// 部件写全 (共享字符串 + 样式表 + docProps + drawing/chart 关系) —— 少一个 WPS 就可能打不开。
library;

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:archive/archive.dart';

class XlsxChartSpec {
  XlsxChartSpec({
    required this.type,
    required this.categories,
    required this.series,
    this.title = '',
    this.anchor,
  });

  /// bar (竖柱) / barh (横条) / line / pie
  final String type;
  final String title;

  /// 类别 (横轴标签) 区域, 如 "A2:A7"
  final String categories;

  /// 每条数据系列: {name: "销售额" 或 "B1" (表头格), values: "B2:B7"}
  final List<({String name, String values})> series;

  /// 图放在哪个格子开始 (如 "H2"); 不给就放在数据右边
  final String? anchor;
}

class XlsxSheetSpec {
  XlsxSheetSpec({
    required this.name,
    required this.rows,
    this.header = true,
    this.freezeHeader = true,
    this.formats = const {},
    this.merges = const [],
    this.charts = const [],
    this.widths = const {},
  });

  final String name;
  final List<List<String>> rows;
  final bool header;
  final bool freezeHeader;

  /// 区域 → 格式, 如 {"C2:C9": "percent", "B2:G4": "money"}。格式: percent / percent1 / money / thousands / decimal / int / date
  final Map<String, String> formats;
  final List<String> merges;
  final List<XlsxChartSpec> charts;

  /// 列宽覆盖, 如 {"A": 18}
  final Map<String, double> widths;
}

/// 建完的统计 —— 工具回执照实告诉模型写进了什么, 别再让它凭空说「公式已生效」。
class XlsxBuildReport {
  int sheets = 0;
  int formulas = 0;
  int formulasComputed = 0;
  final List<String> formulaErrors = [];

  /// 公式算出来的值 (「H5=1760」), 回执里给模型看 —— 回复里的合计数要用这个, 别自己心算 (实测心算错过)
  final List<String> computed = [];
  int charts = 0;
  final List<String> chartKinds = [];
  final Set<String> formats = {};
  int merges = 0;

  String describe() {
    final parts = <String>['工作表 $sheets 张'];
    if (formulas > 0) {
      parts.add('公式 $formulas 个 (真公式, Excel / WPS 改数会自动重算; 已预先算好显示值 $formulasComputed 个)');
    } else {
      parts.add('没有公式 (所有格子都是固定值)');
    }
    if (computed.isNotEmpty) {
      /* 合计行 / 列在最后, 留尾巴 */
      final shown = computed.length > 24 ? computed.sublist(computed.length - 24) : computed;
      parts.add('公式算出的值 (回复里的数字以这个为准): ${shown.join(', ')}');
    }
    if (formulaErrors.isNotEmpty) {
      parts.add('⚠️ 这些公式没法预先算值, 打开后由 Excel 自己算: ${formulaErrors.take(5).join('、')}');
    }
    parts.add(charts > 0 ? '图表 $charts 张 (${chartKinds.join('、')}, 原生图表可编辑)' : '没有图表');
    if (formats.isNotEmpty) parts.add('数字格式: ${formats.join('、')}');
    if (merges > 0) parts.add('合并单元格 $merges 处');
    return parts.join(' · ');
  }
}

class XlsxBuilder {
  XlsxBuilder(this.sheets);

  final List<XlsxSheetSpec> sheets;
  final report = XlsxBuildReport();

  static const _ns = 'http://schemas.openxmlformats.org';
  static const _head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  /* ── 样式: (粗体, 表头底色, 数字格式) → cellXfs 序号 ── */
  final _xfKeys = <String, int>{};
  final _xfXml = <String>[];
  static const _fmtIds = {
    'general': 0,
    'int': 1,
    'decimal': 4, // #,##0.00
    'thousands': 3, // #,##0
    'percent': 10, // 0.00%
    'percent0': 9, // 0%
    'percent1': 165, // 0.0%
    'money': 164, // ¥#,##0.00
    'date': 14,
  };
  static const _fmtNames = {
    'int': '整数', 'decimal': '两位小数', 'thousands': '千分位', 'percent': '百分比',
    'percent0': '百分比', 'percent1': '百分比', 'money': '金额 ¥', 'date': '日期',
  };

  int _xf({bool bold = false, bool headerFill = false, String fmt = 'general', bool border = true}) {
    final key = '$bold|$headerFill|$fmt|$border';
    return _xfKeys.putIfAbsent(key, () {
      final numFmt = _fmtIds[fmt] ?? 0;
      final align = fmt == 'general' ? 'center' : 'right';
      _xfXml.add('<xf numFmtId="$numFmt" fontId="${bold ? 1 : 0}" fillId="${headerFill ? 2 : 0}" borderId="${border ? 1 : 0}" xfId="0"'
          '${numFmt != 0 ? ' applyNumberFormat="1"' : ''} applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
          '<alignment horizontal="${headerFill ? 'center' : align}" vertical="center" wrapText="1"/></xf>');
      return _xfXml.length; // 序号 0 是默认样式, 自定义的从 1 开始
    });
  }

  /* ── 共享字符串 ── */
  final _shared = <String>[];
  final _sharedIdx = <String, int>{};
  var _sharedRefs = 0;
  int _ss(String s) {
    _sharedRefs++;
    return _sharedIdx.putIfAbsent(s, () {
      _shared.add(s);
      return _shared.length - 1;
    });
  }

  Uint8List build() {
    if (sheets.isEmpty) throw ArgumentError('至少要一张工作表');
    report.sheets = sheets.length;
    final zip = Archive();
    final names = <String>[];
    final sheetXml = <String>[];
    final sheetRels = <int, String>{};
    var chartNo = 0;
    final contentOverrides = StringBuffer();

    for (var si = 0; si < sheets.length; si++) {
      final sheet = sheets[si];
      var name = _sheetTitle(sheet.name.isEmpty ? 'Sheet${si + 1}' : sheet.name);
      while (names.contains(name)) {
        name = _sheetTitle('$name${si + 1}');
      }
      names.add(name);

      final grid = _Grid(sheet.rows);
      final fmtMap = _expandFormats(sheet.formats, grid);
      final values = grid.evaluate(report);

      final data = StringBuffer();
      final widths = <int, double>{};
      for (var r = 0; r < grid.rows.length; r++) {
        final row = grid.rows[r];
        final isHeader = sheet.header && r == 0;
        final isTotal = !isHeader && row.isNotEmpty && RegExp(r'^\s*(合计|总计|小计|总和|total\b|sum\b)', caseSensitive: false).hasMatch(row.first);
        data.write('<row r="${r + 1}"${isHeader ? ' ht="24" customHeight="1"' : ''}>');
        for (var c = 0; c < row.length; c++) {
          final raw = row[c];
          if (raw.isEmpty) continue;
          final ref = '${_colName(c)}${r + 1}';
          final cell = _parseCell(raw);
          var fmt = fmtMap[ref] ?? cell.fmt ?? 'general';
          if (cell.isFormula && fmt == 'general' && values[ref] is double) fmt = _guessFormulaFormat(cell.text, fmtMap, grid);
          if (fmt != 'general') {
            report.formats.add(_fmtNames[fmt] ?? fmt);
            fmtMap[ref] = fmt; // 后面的公式引用它时跟着用 (合计行 =SUM(I2:I4) 跟占比列一样是百分比)
          }
          final s = _xf(bold: isHeader || isTotal, headerFill: isHeader, fmt: fmt);
          final shown = cell.isFormula ? _shownWidth(values[ref], fmt) : raw;
          /* 带格式的数字 (加粗合计 / 百分比 / ¥) 实际比估的宽, 多留 2 格, 不然 100.00% 被裁 */
          final w = shown.runes.fold<double>(0, (a, ch) => a + (ch > 0x2E80 ? 2 : 1.1)) + (fmt == 'general' ? 0 : 2);
          if (w > (widths[c] ?? 0)) widths[c] = w;
          if (cell.isFormula) {
            final v = values[ref];
            final f = _escape(cell.text.substring(1));
            if (v is double) {
              data.write('<c r="$ref" s="$s"><f>$f</f><v>${_num(v)}</v></c>');
            } else if (v is String) {
              data.write('<c r="$ref" s="$s" t="str"><f>$f</f><v>${_escape(v)}</v></c>');
            } else {
              data.write('<c r="$ref" s="$s"><f>$f</f></c>');
            }
          } else if (cell.number != null) {
            data.write('<c r="$ref" s="$s"><v>${_num(cell.number!)}</v></c>');
          } else {
            data.write('<c r="$ref" s="$s" t="s"><v>${_ss(cell.text)}</v></c>');
          }
        }
        data.write('</row>');
      }

      for (final e in sheet.widths.entries) {
        widths[_colIndex(e.key.toUpperCase()) - 1] = e.value - 2;
      }
      final cols = widths.isEmpty
          ? ''
          : '<cols>${[
              for (final e in (widths.entries.toList()..sort((a, b) => a.key - b.key)))
                '<col min="${e.key + 1}" max="${e.key + 1}" width="${(e.value + 2).clamp(8, 60).toStringAsFixed(1)}" customWidth="1"/>',
            ].join()}</cols>';
      final maxCol = grid.rows.fold<int>(0, (m, r) => math.max(m, r.length));
      final dim = maxCol == 0 ? 'A1' : 'A1:${_colName(maxCol - 1)}${grid.rows.length}';
      final freeze = sheet.header && sheet.freezeHeader && grid.rows.length > 1
          ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
          : '';
      final merges = sheet.merges.where((m) => RegExp(r'^[A-Za-z]+\d+:[A-Za-z]+\d+$').hasMatch(m.trim())).toList();
      report.merges += merges.length;
      final mergeXml = merges.isEmpty ? '' : '<mergeCells count="${merges.length}">${merges.map((m) => '<mergeCell ref="${m.trim().toUpperCase()}"/>').join()}</mergeCells>';

      var drawing = '';
      if (sheet.charts.isNotEmpty) {
        final drawingNo = si + 1;
        final anchors = StringBuffer();
        final drawingRels = StringBuffer();
        for (var k = 0; k < sheet.charts.length; k++) {
          chartNo++;
          final spec = sheet.charts[k];
          String shown(String ref) {
            final v = values[ref];
            if (v is double) return _num(v);
            if (v is String) return v;
            return grid.raw(ref);
          }

          final chart = chartXml(spec, name,
              text: shown,
              number: (ref) => values[ref] is double ? values[ref] as double : double.tryParse(grid.raw(ref).replaceAll(',', '')));
          zip.add(ArchiveFile.string('xl/charts/chart$chartNo.xml', chart));
          contentOverrides.write('<Override PartName="/xl/charts/chart$chartNo.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>');
          drawingRels.write('<Relationship Id="rId${k + 1}" Type="$_ns/officeDocument/2006/relationships/chart" Target="../charts/chart$chartNo.xml"/>');
          final from = anchorCell(spec.anchor, maxCol, k);
          anchors.write(anchorXml(from.$1, from.$2, k + 2, 'rId${k + 1}'));
          report.charts++;
          report.chartKinds.add(chartNames[spec.type] ?? '柱状图');
        }
        zip.add(ArchiveFile.string('xl/drawings/drawing$drawingNo.xml', drawingXml('$anchors')));
        zip.add(ArchiveFile.string('xl/drawings/_rels/drawing$drawingNo.xml.rels',
            '$_head<Relationships xmlns="$_ns/package/2006/relationships">$drawingRels</Relationships>'));
        contentOverrides.write('<Override PartName="/xl/drawings/drawing$drawingNo.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
        sheetRels[si] = '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/drawing" Target="../drawings/drawing$drawingNo.xml"/>';
        drawing = '<drawing r:id="rId1"/>';
      }

      sheetXml.add('$_head<worksheet xmlns="$_ns/spreadsheetml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships"><dimension ref="$dim"/>'
          '<sheetViews><sheetView${si == 0 ? ' tabSelected="1"' : ''} workbookViewId="0">$freeze</sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/>$cols'
          '<sheetData>$data</sheetData>$mergeXml<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>$drawing</worksheet>');
    }

    final sst = StringBuffer('$_head<sst xmlns="$_ns/spreadsheetml/2006/main" count="$_sharedRefs" uniqueCount="${_shared.length}">');
    for (final s in _shared) {
      sst.write('<si><t xml:space="preserve">${_escape(s)}</t></si>');
    }
    sst.write('</sst>');

    final sheetOverrides = [
      for (var i = 0; i < sheetXml.length; i++)
        '<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    ].join();
    zip
      ..add(ArchiveFile.string('[Content_Types].xml',
          '$_head<Types xmlns="$_ns/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>$sheetOverrides'
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>$contentOverrides'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'))
      ..add(ArchiveFile.string('_rels/.rels',
          '$_head<Relationships xmlns="$_ns/package/2006/relationships"><Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          '<Relationship Id="rId2" Type="$_ns/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
          '<Relationship Id="rId3" Type="$_ns/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'))
      ..add(ArchiveFile.string('docProps/core.xml', _coreProps()))
      ..add(ArchiveFile.string('docProps/app.xml',
          '$_head<Properties xmlns="$_ns/officeDocument/2006/extended-properties"><Application>Neox</Application></Properties>'))
      ..add(ArchiveFile.string('xl/workbook.xml',
          '$_head<workbook xmlns="$_ns/spreadsheetml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
          '${[for (var i = 0; i < names.length; i++) '<sheet name="${_escape(names[i])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>'].join()}'
          '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'))
      ..add(ArchiveFile.string('xl/_rels/workbook.xml.rels',
          '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
          '${[for (var i = 0; i < names.length; i++) '<Relationship Id="rId${i + 1}" Type="$_ns/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>'].join()}'
          '<Relationship Id="rId${names.length + 1}" Type="$_ns/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
          '<Relationship Id="rId${names.length + 2}" Type="$_ns/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'))
      ..add(ArchiveFile.string('xl/sharedStrings.xml', sst.toString()))
      ..add(ArchiveFile.string('xl/styles.xml', _stylesXml()));
    for (var i = 0; i < sheetXml.length; i++) {
      zip.add(ArchiveFile.string('xl/worksheets/sheet${i + 1}.xml', sheetXml[i]));
      if (sheetRels[i] != null) {
        zip.add(ArchiveFile.string('xl/worksheets/_rels/sheet${i + 1}.xml.rels',
            '$_head<Relationships xmlns="$_ns/package/2006/relationships">${sheetRels[i]}</Relationships>'));
      }
    }
    return Uint8List.fromList(ZipEncoder().encode(zip));
  }

  String _stylesXml() {
    return '$_head<styleSheet xmlns="$_ns/spreadsheetml/2006/main">'
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font><font><b/><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F7"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left style="thin"><color rgb="FFC8CDD5"/></left><right style="thin"><color rgb="FFC8CDD5"/></right><top style="thin"><color rgb="FFC8CDD5"/></top><bottom style="thin"><color rgb="FFC8CDD5"/></bottom><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="${_xfXml.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${_xfXml.join()}</cellXfs>'
        '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  /* ── 图表 (改已有表的 add_chart 也用这两个) ── */

  static const chartNames = {'bar': '柱状图', 'barh': '横条图', 'line': '折线图', 'pie': '饼图'};

  /// 一个图在 drawing 里的锚点: 从 (col, row) 起占 8 列 16 行
  static String anchorXml(int col, int row, int id, String rid) =>
      '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>$col</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>$row</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
      '<xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="$id" name="图表 ${id - 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="$_ns/drawingml/2006/chart">'
      '<c:chart xmlns:c="$_ns/drawingml/2006/chart" xmlns:r="$_ns/officeDocument/2006/relationships" r:id="$rid"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';

  static String drawingXml(String anchors) =>
      '$_head<xdr:wsDr xmlns:xdr="$_ns/drawingml/2006/spreadsheetDrawing" xmlns:a="$_ns/drawingml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships">$anchors</xdr:wsDr>';

  /// 图表部件。text / number 给格子的显示文字和数值 (写进缓存, 不重算的预览也能画出来)
  static String chartXml(XlsxChartSpec spec, String sheetName,
      {required String Function(String ref) text, required double? Function(String ref) number}) {
    final q = "'${sheetName.replaceAll("'", "''")}'";
    String abs(String range) => range.split(':').map((p) {
          final m = RegExp(r'^\$?([A-Za-z]+)\$?(\d+)$').firstMatch(p.trim());
          return m == null ? p : '\$${m[1]!.toUpperCase()}\$${m[2]}';
        }).join(':');
    List<String> cells(String range) => _Grid.rangeRefs(range);
    String shown(String ref) => text(ref);

    final cats = cells(spec.categories);
    final catCache = '<c:strCache><c:ptCount val="${cats.length}"/>'
        '${[for (var i = 0; i < cats.length; i++) '<c:pt idx="$i"><c:v>${_escape(shown(cats[i]))}</c:v></c:pt>'].join()}</c:strCache>';
    final type = spec.type;
    final isPie = type == 'pie';
    final colors = ['2F6BFF', 'F5A623', '34C38F', 'E8505B', '8B5CF6', '00B8D9'];
    final ser = StringBuffer();
    for (var i = 0; i < spec.series.length; i++) {
      final s = spec.series[i];
      final vals = cells(s.values);
      final nameIsRef = RegExp(r'^\$?[A-Za-z]+\$?\d+$').hasMatch(s.name.trim());
      final tx = nameIsRef
          ? '<c:tx><c:strRef><c:f>$q!${abs(s.name)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${_escape(shown(s.name.trim().toUpperCase().replaceAll('\$', '')))}</c:v></c:pt></c:strCache></c:strRef></c:tx>'
          : '<c:tx><c:v>${_escape(s.name)}</c:v></c:tx>';
      final numCache = '<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>'
          '${[for (var j = 0; j < vals.length; j++) if (number(vals[j]) case final v?) '<c:pt idx="$j"><c:v>${_num(v)}</c:v></c:pt>'].join()}</c:numCache>';
      final color = colors[i % colors.length];
      final fill = isPie
          ? ''
          : type == 'line'
              ? '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="$color"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>'
              : '<c:spPr><a:solidFill><a:srgbClr val="$color"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>';
      final dPts = isPie
          ? [for (var j = 0; j < vals.length; j++) '<c:dPt><c:idx val="$j"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${colors[j % colors.length]}"/></a:solidFill></c:spPr></c:dPt>'].join()
          : '';
      ser.write('<c:ser><c:idx val="$i"/><c:order val="$i"/>$tx$fill$dPts'
          '${isPie ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>' : ''}'
          '<c:cat><c:strRef><c:f>$q!${abs(spec.categories)}</c:f>$catCache</c:strRef></c:cat>'
          '<c:val><c:numRef><c:f>$q!${abs(s.values)}</c:f>$numCache</c:numRef></c:val>'
          '${type == 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>');
    }
    const axIds = '<c:axId val="111111111"/><c:axId val="222222222"/>';
    final plot = switch (type) {
      'pie' => '<c:pieChart><c:varyColors val="1"/>$ser<c:firstSliceAng val="0"/></c:pieChart>',
      'line' => '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>$ser<c:marker val="1"/>$axIds</c:lineChart>',
      _ => '<c:barChart><c:barDir val="${type == 'barh' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>$ser<c:gapWidth val="80"/>$axIds</c:barChart>',
    };
    final axes = isPie
        ? ''
        : '<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${type == 'barh' ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
            '<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${type == 'barh' ? 'b' : 'l'}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
    final title = spec.title.isEmpty
        ? '<c:autoTitleDeleted val="1"/>'
        : '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1400" b="1"/><a:t>${_escape(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>';
    return '$_head<c:chartSpace xmlns:c="$_ns/drawingml/2006/chart" xmlns:a="$_ns/drawingml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships">'
        '<c:lang val="zh-CN"/><c:roundedCorners val="0"/><c:chart>$title<c:plotArea><c:layout/>$plot$axes</c:plotArea>'
        '<c:legend><c:legendPos val="${isPie ? 'r' : 'b'}"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>'
        '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:latin typeface="等线"/><a:ea typeface="等线"/></a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr></c:chartSpace>';
  }

  static (int, int) anchorCell(String? anchor, int maxCol, int k) {
    final m = anchor == null ? null : RegExp(r'^\$?([A-Za-z]+)\$?(\d+)$').firstMatch(anchor.trim());
    if (m != null) return (_colIndex(m[1]!.toUpperCase()) - 1, int.parse(m[2]!) - 1);
    return (maxCol + 1, 1 + k * 18);
  }

  /* ── 格式 ── */
  Map<String, String> _expandFormats(Map<String, String> formats, _Grid grid) {
    final out = <String, String>{};
    for (final e in formats.entries) {
      final key = normalizeFormat(e.value);
      for (final ref in _Grid.rangeRefs(e.key)) {
        out[ref] = key;
      }
    }
    return out;
  }

  /// 模型给的格式名 → 内部名 (认中英文 / 符号写法); 不认识的是 general
  static String normalizeFormat(String raw) => switch (raw.trim().toLowerCase()) {
        'percent' || '%' || 'pct' || '百分比' => 'percent',
        'percent0' || '0%' => 'percent0',
        'percent1' || '0.0%' => 'percent1',
        'money' || 'currency' || 'cny' || 'rmb' || '¥' || '金额' => 'money',
        'thousands' || 'comma' || '千分位' => 'thousands',
        'decimal' || '0.00' || '小数' => 'decimal',
        'int' || 'integer' || '0' || '整数' => 'int',
        'date' || '日期' => 'date',
        _ => 'general',
      };

  /// 内部格式名 → (内置 numFmtId, 自定义格式码); 自定义的 id 由调用方分配
  static ({int id, String? code}) numFmtOf(String key) => switch (key) {
        'money' => (id: 164, code: '"¥"#,##0.00'),
        'percent1' => (id: 165, code: '0.0%'),
        _ => (id: _fmtIds[key] ?? 0, code: null),
      };

  static String formatLabel(String key) => _fmtNames[key] ?? key;

  /// 在一张表 (格子原文, 公式格写 "=...") 上算一个公式: double / String, 算不了是 null
  static Object? evaluate(List<List<String>> rows, String formula) {
    final f = formula.trim();
    if (!f.startsWith('=') || f.length < 2) return null;
    try {
      final v = _Parser(f.substring(1), _Grid(rows)).parse();
      if (v is double && v.isFinite) return v;
      if (v is String) return v;
      if (v is bool) return v ? 'TRUE' : 'FALSE';
    } catch (_) {/* 算不了交给表格软件 */}
    return null;
  }

  static String numText(double v) => _num(v);

  /// 区域 → 格子列表 (A1:C3 → A1 B1 C1 A2 ...)
  static List<String> refsOf(String range) => _Grid.rangeRefs(range);

  /// 公式没指定格式时按引用猜: 单格除以绝对引用 (=H2/$H$5) → 百分比; SUM / AVERAGE 这类沿用被引用格子的格式
  String _guessFormulaFormat(String formula, Map<String, String> fmtMap, _Grid grid) {
    final f = formula.toUpperCase();
    if (RegExp(r'^=\s*[A-Z$]+\d+\s*/\s*\$?[A-Z]+\$?\d+\s*$').hasMatch(f) && f.contains('\$')) return 'percent';
    /* 乘除混算的单位会变 (单价 × 数量), 只在纯加总 / 取值类公式里沿用 */
    if (RegExp(r'[*/^]').hasMatch(f.substring(1))) return 'general';
    for (final m in RegExp(r'\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?').allMatches(f)) {
      final refs = m[3] == null ? ['${m[1]}${m[2]}'] : _Grid.rangeRefs('${m[1]}${m[2]}:${m[3]}${m[4]}');
      for (final r in refs) {
        final fm = fmtMap[r];
        if (fm != null && fm != 'general' && fm != 'date') return fm;
      }
    }
    return 'general';
  }

  static String _shownWidth(Object? v, String fmt) {
    if (v is double) {
      if (fmt.startsWith('percent')) return '${(v * 100).toStringAsFixed(2)}%';
      if (fmt == 'money') return '¥${v.toStringAsFixed(2)}';
      return _num(v);
    }
    return '$v';
  }

  /* ── 单元格文字 → 值 ── */
  static ({bool isFormula, String text, double? number, String? fmt}) _parseCell(String raw) {
    final t = raw.trim();
    if (t.startsWith('=') && t.length > 1) return (isFormula: true, text: t, number: null, fmt: null);
    if (RegExp(r'^-?\d+(\.\d+)?$').hasMatch(t)) return (isFormula: false, text: t, number: double.parse(t), fmt: null);
    final pct = RegExp(r'^(-?\d+(?:\.\d+)?)\s*%$').firstMatch(t);
    if (pct != null) {
      final d = pct[1]!.contains('.') ? 'percent1' : 'percent0';
      return (isFormula: false, text: t, number: double.parse(pct[1]!) / 100, fmt: d);
    }
    final money = RegExp(r'^[¥￥$]\s*(-?[\d,]+(?:\.\d+)?)$').firstMatch(t);
    if (money != null && RegExp(r'^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$').hasMatch(money[1]!)) {
      return (isFormula: false, text: t, number: double.parse(money[1]!.replaceAll(',', '')), fmt: 'money');
    }
    if (RegExp(r'^-?\d{1,3}(,\d{3})+(\.\d+)?$').hasMatch(t)) {
      return (isFormula: false, text: t, number: double.parse(t.replaceAll(',', '')), fmt: t.contains('.') ? 'decimal' : 'thousands');
    }
    return (isFormula: false, text: raw, number: null, fmt: null);
  }

  static String _num(double v) {
    if (v == v.roundToDouble() && v.abs() < 1e15) return v.toInt().toString();
    final s = v.toStringAsPrecision(15);
    return s.contains('e') ? s : s.replaceFirst(RegExp(r'\.?0+$'), '');
  }

  static String _sheetTitle(String name) {
    final clean = name.replaceAll(RegExp(r'[\[\]:*?/\\]'), ' ').trim();
    final runes = (clean.isEmpty ? 'Sheet1' : clean).runes.toList();
    return String.fromCharCodes(runes.length > 31 ? runes.sublist(0, 31) : runes);
  }

  static String _coreProps() {
    final now = '${DateTime.now().toUtc().toIso8601String().split('.').first}Z';
    return '$_head<cp:coreProperties xmlns:cp="$_ns/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:creator>Neox</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">$now</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">$now</dcterms:modified></cp:coreProperties>';
  }

  static int _colIndex(String col) => col.codeUnits.fold(0, (a, c) => a * 26 + (c - 64));
  static String _colName(int i) {
    var n = i + 1;
    final sb = StringBuffer();
    while (n > 0) {
      final r = (n - 1) % 26;
      sb.write(String.fromCharCode(65 + r));
      n = (n - 1) ~/ 26;
    }
    return sb.toString().split('').reversed.join();
  }

  static String _escape(String s) =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/// 表格数据 + 公式求值 (只为写缓存值; 真重算交给 Excel / WPS)。
/// 支持: 数字 / 格子 / 区域, + - * / ^ & 比较, 括号, 百分号,
/// SUM AVERAGE MIN MAX COUNT COUNTA ROUND ROUNDUP ROUNDDOWN ABS IF IFERROR SUMIF COUNTIF AVERAGEIF PRODUCT INT MOD SQRT LEN CONCAT。
/// 算不了的公式不写缓存值, 回执里列出来。
class _Grid {
  _Grid(this.rows);
  final List<List<String>> rows;

  final _cache = <String, Object?>{};
  final _visiting = <String>{};

  static (int, int)? parseRef(String ref) {
    final m = RegExp(r'^\$?([A-Za-z]+)\$?(\d+)$').firstMatch(ref.trim());
    if (m == null) return null;
    return (XlsxBuilder._colIndex(m[1]!.toUpperCase()) - 1, int.parse(m[2]!) - 1);
  }

  static List<String> rangeRefs(String range) {
    final parts = range.trim().split('!').last.split(':');
    final a = parseRef(parts.first);
    if (a == null) return const [];
    final b = parts.length > 1 ? parseRef(parts[1]) ?? a : a;
    final out = <String>[];
    for (var r = math.min(a.$2, b.$2); r <= math.max(a.$2, b.$2); r++) {
      for (var c = math.min(a.$1, b.$1); c <= math.max(a.$1, b.$1); c++) {
        out.add('${XlsxBuilder._colName(c)}${r + 1}');
      }
    }
    return out;
  }

  String raw(String ref) {
    final p = parseRef(ref);
    if (p == null || p.$2 >= rows.length || p.$1 >= rows[p.$2].length) return '';
    return rows[p.$2][p.$1];
  }

  Map<String, Object?> evaluate(XlsxBuildReport report) {
    final out = <String, Object?>{};
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        final t = rows[r][c].trim();
        if (!t.startsWith('=') || t.length < 2) continue;
        final ref = '${XlsxBuilder._colName(c)}${r + 1}';
        report.formulas++;
        final v = value(ref);
        if (v is double && v.isFinite || v is String) {
          out[ref] = v;
          report.formulasComputed++;
          report.computed.add('$ref=${v is double ? XlsxBuilder._num(double.parse(v.toStringAsFixed(4))) : v}');
        } else {
          report.formulaErrors.add('$ref $t');
        }
      }
    }
    return out;
  }

  /// 格子的值: double / String / null (空) / _Err
  Object? value(String ref) {
    ref = ref.toUpperCase().replaceAll('\$', '');
    if (_cache.containsKey(ref)) return _cache[ref];
    if (_visiting.contains(ref)) return const _Err('循环引用');
    _visiting.add(ref);
    final t = raw(ref).trim();
    Object? v;
    if (t.isEmpty) {
      v = null;
    } else if (t.startsWith('=')) {
      try {
        v = _Parser(t.substring(1), this).parse();
      } catch (_) {
        v = const _Err('算不了');
      }
    } else {
      final c = XlsxBuilder._parseCell(t);
      v = c.number ?? t;
    }
    _visiting.remove(ref);
    _cache[ref] = v;
    return v;
  }
}

class _Err {
  const _Err(this.msg);
  final String msg;
}

class _Parser {
  _Parser(this.src, this.grid);
  final String src;
  final _Grid grid;
  var _i = 0;

  Object? parse() {
    final v = _compare();
    _ws();
    if (_i < src.length) throw const FormatException('多余字符');
    if (v is List) return v.isEmpty ? null : v.first;
    return v;
  }

  void _ws() {
    while (_i < src.length && src[_i] == ' ') {
      _i++;
    }
  }

  bool _eat(String s) {
    _ws();
    if (src.startsWith(s, _i)) {
      _i += s.length;
      return true;
    }
    return false;
  }

  Object? _compare() {
    var l = _concat();
    for (final op in ['<>', '>=', '<=', '=', '>', '<']) {
      if (_eat(op)) {
        final r = _concat();
        final a = _scalar(l), b = _scalar(r);
        int cmp;
        if (a is double && b is double) {
          cmp = a.compareTo(b);
        } else {
          cmp = '${a ?? ''}'.compareTo('${b ?? ''}');
        }
        final res = switch (op) { '<>' => cmp != 0, '>=' => cmp >= 0, '<=' => cmp <= 0, '=' => cmp == 0, '>' => cmp > 0, _ => cmp < 0 };
        l = res;
        break;
      }
    }
    return l;
  }

  Object? _concat() {
    var l = _add();
    while (_eat('&')) {
      final r = _add();
      l = '${_text(_scalar(l))}${_text(_scalar(r))}';
    }
    return l;
  }

  Object? _add() {
    var l = _mul();
    while (true) {
      if (_eat('+')) {
        l = _n(l) + _n(_mul());
      } else if (_eat('-')) {
        l = _n(l) - _n(_mul());
      } else {
        return l;
      }
    }
  }

  Object? _mul() {
    var l = _pow();
    while (true) {
      if (_eat('*')) {
        l = _n(l) * _n(_pow());
      } else if (_eat('/')) {
        final d = _n(_pow());
        if (d == 0) throw const FormatException('除以 0');
        l = _n(l) / d;
      } else {
        return l;
      }
    }
  }

  Object? _pow() {
    var l = _unary();
    while (_eat('^')) {
      l = math.pow(_n(l), _n(_unary())).toDouble();
    }
    return l;
  }

  Object? _unary() {
    if (_eat('-')) return -_n(_unary());
    if (_eat('+')) return _n(_unary());
    var v = _atom();
    if (_eat('%')) v = _n(v) / 100;
    return v;
  }

  Object? _atom() {
    _ws();
    if (_eat('(')) {
      final v = _compare();
      if (!_eat(')')) throw const FormatException(')');
      return v;
    }
    if (_eat('"')) {
      final end = src.indexOf('"', _i);
      if (end < 0) throw const FormatException('"');
      final s = src.substring(_i, end);
      _i = end + 1;
      return s;
    }
    final num = RegExp(r'\d+(\.\d+)?').matchAsPrefix(src, _i);
    if (num != null) {
      _i = num.end;
      return double.parse(num[0]!);
    }
    final fn = RegExp(r'([A-Za-z][A-Za-z0-9.]*)\s*\(').matchAsPrefix(src, _i);
    if (fn != null) {
      _i = fn.end;
      final args = <Object?>[];
      _ws();
      if (!_eat(')')) {
        do {
          args.add(_compare());
        } while (_eat(','));
        if (!_eat(')')) throw const FormatException(')');
      }
      return _call(fn[1]!.toUpperCase(), args);
    }
    final ref = RegExp(r"(?:'[^']+'!|[A-Za-z0-9_]+!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?").matchAsPrefix(src, _i);
    if (ref != null) {
      _i = ref.end;
      final txt = ref[0]!;
      if (txt.contains('!')) throw const FormatException('跨表引用不预算');
      if (txt.contains(':')) return [for (final r in _Grid.rangeRefs(txt)) grid.value(r)];
      final v = grid.value(txt);
      if (v is _Err) throw FormatException(v.msg);
      return v;
    }
    if (_eat('TRUE')) return true;
    if (_eat('FALSE')) return false;
    throw const FormatException('认不出');
  }

  Object? _scalar(Object? v) {
    if (v is List) return v.isEmpty ? null : v.first;
    if (v is _Err) throw FormatException(v.msg);
    return v;
  }

  double _n(Object? v) {
    v = _scalar(v);
    if (v == null) return 0;
    if (v is double) return v;
    if (v is bool) return v ? 1 : 0;
    final d = double.tryParse('$v'.replaceAll(',', ''));
    if (d == null) throw const FormatException('不是数字');
    return d;
  }

  static String _text(Object? v) {
    if (v == null) return '';
    if (v is double) return XlsxBuilder._num(v);
    if (v is bool) return v ? 'TRUE' : 'FALSE';
    return '$v';
  }

  Iterable<double> _nums(List<Object?> args) sync* {
    for (final a in args) {
      if (a is List) {
        for (final x in a) {
          if (x is double) yield x;
          if (x is _Err) throw FormatException(x.msg);
        }
      } else if (a != null) {
        yield _n(a);
      }
    }
  }

  bool _matches(Object? v, Object? crit) {
    final c = _scalar(crit);
    if (c is double) return v is double && v == c;
    final s = '$c';
    final m = RegExp(r'^(<>|>=|<=|=|>|<)?(.*)$').firstMatch(s)!;
    final op = m[1] ?? '=';
    final target = double.tryParse(m[2]!);
    if (target != null && v is double) {
      return switch (op) { '<>' => v != target, '>=' => v >= target, '<=' => v <= target, '>' => v > target, '<' => v < target, _ => v == target };
    }
    final eq = '${v ?? ''}' == m[2];
    return op == '<>' ? !eq : eq;
  }

  Object? _call(String name, List<Object?> args) {
    switch (name) {
      case 'SUM':
        return _nums(args).fold<double>(0, (a, b) => a + b);
      case 'AVERAGE':
        final l = _nums(args).toList();
        if (l.isEmpty) throw const FormatException('空');
        return l.reduce((a, b) => a + b) / l.length;
      case 'MIN':
        final l = _nums(args).toList();
        return l.isEmpty ? 0.0 : l.reduce(math.min);
      case 'MAX':
        final l = _nums(args).toList();
        return l.isEmpty ? 0.0 : l.reduce(math.max);
      case 'COUNT':
        return _nums(args).length.toDouble();
      case 'COUNTA':
        var n = 0;
        for (final a in args) {
          if (a is List) {
            n += a.where((x) => x != null && '$x'.isNotEmpty).length;
          } else if (a != null) {
            n++;
          }
        }
        return n.toDouble();
      case 'PRODUCT':
        return _nums(args).fold<double>(1, (a, b) => a * b);
      case 'ROUND' || 'ROUNDUP' || 'ROUNDDOWN':
        final x = _n(args[0]);
        final d = args.length > 1 ? _n(args[1]).toInt() : 0;
        final f = math.pow(10, d).toDouble();
        final y = x * f;
        final r = name == 'ROUND' ? y.roundToDouble() : (name == 'ROUNDUP' ? (y < 0 ? y.floorToDouble() : y.ceilToDouble()) : (y < 0 ? y.ceilToDouble() : y.floorToDouble()));
        return r / f;
      case 'ABS':
        return _n(args[0]).abs();
      case 'INT':
        return _n(args[0]).floorToDouble();
      case 'MOD':
        return _n(args[0]) % _n(args[1]);
      case 'SQRT':
        return math.sqrt(_n(args[0]));
      case 'IF':
        final c = _scalar(args[0]);
        final truthy = c is bool ? c : (c is double ? c != 0 : '${c ?? ''}'.isNotEmpty);
        return truthy ? _scalar(args.length > 1 ? args[1] : true) : _scalar(args.length > 2 ? args[2] : false);
      case 'IFERROR':
        return _scalar(args[0]);
      case 'LEN':
        return _text(_scalar(args[0])).length.toDouble();
      case 'CONCAT' || 'CONCATENATE':
        return args.map((a) => a is List ? a.map(_text).join() : _text(_scalar(a))).join();
      case 'SUMIF' || 'COUNTIF' || 'AVERAGEIF':
        final range = args[0] is List ? args[0] as List : [args[0]];
        final sumRange = args.length > 2 && args[2] is List ? args[2] as List : range;
        final hits = <double>[];
        var count = 0;
        for (var i = 0; i < range.length; i++) {
          if (_matches(range[i], args[1])) {
            count++;
            final v = i < sumRange.length ? sumRange[i] : null;
            if (v is double) hits.add(v);
          }
        }
        if (name == 'COUNTIF') return count.toDouble();
        if (name == 'SUMIF') return hits.fold<double>(0, (a, b) => a + b);
        if (hits.isEmpty) throw const FormatException('空');
        return hits.reduce((a, b) => a + b) / hits.length;
      default:
        throw FormatException('不预算 $name');
    }
  }
}
