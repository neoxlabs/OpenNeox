import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/office/office_doc.dart';
import 'package:neox_app/core/local_agent/office/xlsx_builder.dart';

String _part(List<int> bytes, String name) =>
    utf8.decode(ZipDecoder().decodeBytes(bytes).findFile(name)?.content ?? const []);

void _out(String name, List<int> bytes) {
  final dir = Platform.environment['NEOX_OFFICE_OUT'];
  if (dir != null) File('$dir/$name').writeAsBytesSync(bytes);
}

void main() {
  /* 2026-10-16 实测场景: 3 产品 × 6 月, 合计行列 + 占比公式 + 柱状图。旧版公式全成了文字 */
  test('销售表: 真公式 + 缓存值 + 百分比 + 柱状图', () {
    final rows = [
      ['产品', '1月', '2月', '3月', '4月', '5月', '6月', '合计', '占比'],
      ['A', '100', '120', '130', '90', '110', '150', '=SUM(B2:G2)', '=H2/\$H\$5'],
      ['B', '80', '95', '70', '100', '120', '130', '=SUM(B3:G3)', '=H3/\$H\$5'],
      ['C', '60', '75', '85', '95', '80', '70', '=SUM(B4:G4)', '=H4/\$H\$5'],
      ['合计', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)', '=SUM(E2:E4)', '=SUM(F2:F4)', '=SUM(G2:G4)', '=SUM(H2:H4)', '=SUM(I2:I4)'],
    ];
    final b = XlsxBuilder([
      XlsxSheetSpec(name: '销售', rows: rows, charts: [
        XlsxChartSpec(type: 'bar', title: '各产品月销售', categories: 'A2:A4', series: [
          for (final c in ['B', 'C', 'D']) (name: '${c}1', values: '${c}2:${c}4'),
        ]),
      ]),
    ]);
    final bytes = b.build();
    _out('sales.xlsx', bytes);
    final sheet = _part(bytes, 'xl/worksheets/sheet1.xml');
    expect(sheet, contains('<f>SUM(B2:G2)</f><v>700</v>'));
    expect(sheet, contains('<f>SUM(H2:H4)</f><v>1760</v>'));
    expect(sheet, contains('<f>H2/\$H\$5</f><v>0.397727272727273</v>'));
    expect(sheet, contains('<f>SUM(I2:I4)</f><v>1</v>'));
    /* 占比列和它的合计都是百分比样式 */
    final pctStyle = RegExp(r'<c r="I2" s="(\d+)"').firstMatch(sheet)![1];
    expect(RegExp(r'<c r="I5" s="(\d+)"').firstMatch(sheet)![1], isNot('0'));
    expect(_part(bytes, 'xl/styles.xml'), contains('numFmtId="10"'));
    expect(pctStyle, isNotNull);
    expect(sheet, contains('state="frozen"'));
    expect(sheet, contains('<drawing r:id="rId1"/>'));
    expect(_part(bytes, 'xl/charts/chart1.xml'), contains('<c:barDir val="col"/>'));
    expect(_part(bytes, '[Content_Types].xml'), contains('/xl/charts/chart1.xml'));
    expect(b.report.formulas, 14);
    expect(b.report.formulasComputed, 14);
    expect(b.report.charts, 1);
    expect(b.report.formats, contains('百分比'));
    expect(b.report.describe(), contains('公式 14 个'));
    /* 公式格的值 outline 能读到 */
    expect(OfficeDoc.open('x.xlsx', bytes).outline(), contains('销售!H2'));
  });

  test('文字里的 % ¥ 千分位存成数字 + 格式; 多表 / 合并 / 饼图 / 折线', () {
    final b = XlsxBuilder([
      XlsxSheetSpec(name: '预算', rows: [
        ['项目', '金额', '占比'],
        ['场地', '¥3,000', '30%'],
        ['餐饮', '¥7,000', '70%'],
        ['合计', '=SUM(B2:B3)', '=SUM(C2:C3)'],
      ], merges: ['A6:C6'], charts: [
        XlsxChartSpec(type: 'pie', title: '预算构成', categories: 'A2:A3', series: [(name: '金额', values: 'B2:B3')]),
      ]),
      XlsxSheetSpec(name: '趋势', rows: [
        ['月', '人数'],
        ['1月', '1,200'],
        ['2月', '1,500'],
        ['均值', '=AVERAGE(B2:B3)'],
        ['判断', '=IF(B3>B2,"增长","下降")'],
      ], formats: {'B2:B4': 'thousands'}, charts: [
        XlsxChartSpec(type: 'line', categories: 'A2:A3', series: [(name: 'B1', values: 'B2:B3')]),
      ]),
    ]);
    final bytes = b.build();
    _out('budget.xlsx', bytes);
    final s1 = _part(bytes, 'xl/worksheets/sheet1.xml');
    expect(s1, contains('<v>3000</v>'));
    expect(s1, contains('<v>0.3</v>'));
    expect(s1, contains('<f>SUM(B2:B3)</f><v>10000</v>'));
    expect(s1, contains('<mergeCell ref="A6:C6"/>'));
    final s2 = _part(bytes, 'xl/worksheets/sheet2.xml');
    expect(s2, contains('<f>AVERAGE(B2:B3)</f><v>1350</v>'));
    expect(s2, contains('t="str"'));
    expect(s2, contains('<f>IF(B3&gt;B2,&quot;增长&quot;,&quot;下降&quot;)</f><v>增长</v>'));
    expect(_part(bytes, 'xl/charts/chart1.xml'), contains('<c:pieChart>'));
    expect(_part(bytes, 'xl/charts/chart2.xml'), contains('<c:lineChart>'));
    expect(_part(bytes, 'xl/workbook.xml'), contains('name="趋势"'));
    expect(_part(bytes, 'xl/styles.xml'), contains('formatCode="&quot;¥&quot;#,##0.00"'));
    expect(b.report.charts, 2);
    expect(b.report.formats, containsAll(['金额 ¥', '百分比', '千分位']));
  });

  test('算不了的公式照样写真公式, 回执列出来', () {
    final b = XlsxBuilder([
      XlsxSheetSpec(name: 'S', rows: [
        ['a', 'b'],
        ['1', '=VLOOKUP(A2,Other!A:B,2,0)'],
      ]),
    ]);
    final bytes = b.build();
    expect(_part(bytes, 'xl/worksheets/sheet1.xml'), contains('<f>VLOOKUP(A2,Other!A:B,2,0)</f></c>'));
    expect(b.report.formulaErrors.single, startsWith('B2'));
    expect(b.report.describe(), contains('没法预先算值'));
  });

  /* 改用户发来的表: 加公式列 / 格式 / 图表都在原文件上做, 不重建 (2026-10-16 实测模型重建了一份, 原格式全丢) */
  test('改已有表: set_format 留原样式只换数字格式, add_chart 加原生图表', () {
    final src = File('test/fixtures/office/sample.xlsx').readAsBytesSync();
    final d = OfficeDoc.open('x.xlsx', src);
    final name = d.sheetGrids().first.name;
    final rows = d.sheetGrids().first.rows;
    final last = rows.length;
    d.setCell('$name!D1', '占比');
    for (var r = 2; r <= last; r++) {
      d.setCell('$name!D$r', '=B$r/SUM(\$B\$2:\$B\$$last)');
    }
    expect(d.setFormat('$name!D2:D$last', 'percent'), last - 1);
    expect(d.setFormat('$name!B2:B$last', 'money'), greaterThan(0));
    d.addChart(XlsxChartSpec(type: 'bar', title: '销售', categories: 'A2:A$last', series: [(name: 'B1', values: 'B2:B$last')]), sheet: name);
    d.addChart(XlsxChartSpec(type: 'pie', title: '占比', categories: 'A2:A$last', series: [(name: 'B1', values: 'B2:B$last')]), sheet: name);
    final bytes = d.save();
    _out('edited-chart.xlsx', bytes);
    final ct = _part(bytes, '[Content_Types].xml');
    expect(ct, contains('/xl/charts/chart1.xml'));
    expect(ct, contains('/xl/charts/chart2.xml'));
    expect(ct, contains('/xl/drawings/drawing1.xml'));
    expect(_part(bytes, 'xl/drawings/drawing1.xml').split('<xdr:twoCellAnchor').length, 3);
    expect(_part(bytes, 'xl/styles.xml'), contains('formatCode="&quot;¥&quot;#,##0.00"'));
    /* 原来的格子一个不少 */
    expect(OfficeDoc.open('x.xlsx', bytes).outline(), contains(OfficeDoc.open('x.xlsx', src).sheetGrids().first.rows[1][0]));
  });

  test('set_cell 写公式是真公式', () {
    final made = OfficeDoc.createXlsx([['a', 'b'], ['1', '2']]);
    final d = OfficeDoc.open('x.xlsx', made)
      ..setCell('C2', '=A2+B2')
      ..setCell('D2', '=C2*10');
    final edited = d.save();
    /* 带上算好的值 (链式: D2 引用刚写进去的 C2) */
    expect(_part(edited, 'xl/worksheets/sheet1.xml'), contains('<f>A2+B2</f><v>3</v>'));
    expect(_part(edited, 'xl/worksheets/sheet1.xml'), contains('<f>C2*10</f><v>30</v>'));
    expect(_part(edited, 'xl/workbook.xml'), contains('fullCalcOnLoad'));
  });
}
