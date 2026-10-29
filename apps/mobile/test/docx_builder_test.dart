import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/office/docx_builder.dart';
import 'package:neox_app/core/local_agent/office/office_doc.dart';

String _doc(List<int> bytes) => utf8.decode(ZipDecoder().decodeBytes(bytes).findFile('word/document.xml')!.content);

void main() {
  /* 旧版 Markdown 表格 / 列表 / 加粗全是字面符号 (2026-10-16) */
  test('Markdown → 真标题样式 / 列表 / 表格 / 加粗 / 分页', () {
    const md = '# 季度工作总结\n'
        '\n'
        '本季度营收 **3.5 亿元**, 同比增长 12%。\n'
        '## 主要成果\n'
        '- 上线新版 App\n'
        '  - 日活翻倍\n'
        '1. 签约 3 家客户\n'
        '2) 完成融资\n'
        '3.5 亿元不是编号\n'
        '| 指标 | Q2 | Q3 |\n'
        '|---|---|---|\n'
        '| 营收 | 3.1 | **3.5** |\n'
        '> 备注: 数据未审计\n'
        '---\n'
        '## 下季度计划\n';
    final b = DocxBuilder(md);
    final bytes = b.build();
    final dir = Platform.environment['NEOX_OFFICE_OUT'];
    if (dir != null) File('$dir/report.docx').writeAsBytesSync(bytes);
    final x = _doc(bytes);
    expect(x, contains('<w:pStyle w:val="Heading1"/>'));
    expect(x, contains('<w:pStyle w:val="Heading2"/>'));
    expect(x, contains('<w:b/></w:rPr><w:t xml:space="preserve">3.5 亿元</w:t>'));
    expect(x, isNot(contains('**')));
    expect(x, isNot(contains('|')));
    expect(x, contains('<w:tbl>'));
    expect(x, contains('<w:tblHeader/>'));
    expect(x, contains('<w:br w:type="page"/>'));
    expect(x, contains('3.5 亿元不是编号'));
    expect(b.report.tables, 1);
    expect(b.report.bullets, 4);
    expect(b.report.headings, 3);
    /* outline 还能读出来 (改 Word 走同一套) */
    expect(OfficeDoc.open('a.docx', bytes).outline(), contains('季度工作总结'));
  });
}
