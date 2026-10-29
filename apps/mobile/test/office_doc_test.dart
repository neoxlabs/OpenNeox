/// office_doc_test.dart — 手机上改 PPT / Word / Excel (2026-10-11)。
///
/// 样本在 test/fixtures/office (python-pptx / python-docx / openpyxl 生成, 带备注页、跨 run 段落、公式)。
/// 改完的文件写到 build/office_out, 本机可用 python 库再打开一遍验证没改坏 (见文件末尾注释)。
library;

import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/office/office_doc.dart';

OfficeDoc _open(String name) =>
    OfficeDoc.open(name, File('test/fixtures/office/$name').readAsBytesSync());

void _out(String name, List<int> bytes) {
  final dir = Directory('build/office_out')..createSync(recursive: true);
  File('${dir.path}/$name').writeAsBytesSync(bytes);
}

void main() {
  group('PPT', () {
    test('outline 按放映顺序列页和段, 跨 run 的段落拼成一句', () {
      final o = _open('sample.pptx').outline();
      expect(o, contains('共 3 页'));
      expect(o, contains('[s1.p1] 季度汇报'));
      expect(o, contains('负责人：张三'));
      expect(o.indexOf('销售数据'), lessThan(o.indexOf('下一步')));
    });

    test('替换 / 整段改写 / 复制删挪页后结构对', () {
      final d = _open('sample.pptx');
      expect(d.replace('120 万', '150 万'), 1);
      /* 跨 run: 「张」「三」在两个 run 里 */
      expect(d.replace('张三', '李四'), 1);
      d.setText('s1.p1', '第三季度汇报');
      d.duplicateSlide(2);
      d.moveSlide(4, 1);
      d.deleteSlide(2);
      final bytes = d.save();
      _out('edited.pptx', bytes);
      final o = OfficeDoc.open('x.pptx', bytes).outline();
      expect(o, contains('共 3 页'));
      expect(o, contains('[s1.p1] 下一步'));
      expect(o, contains('150 万'));
      expect(o, contains('负责人：李四'));
      expect(o, isNot(contains('张三')));
    });
  });

  group('Word', () {
    test('替换落在一个 run 里只改那个 run; 整段改写', () {
      final d = _open('sample.docx');
      expect(d.outline(), contains('预算：50 万'));
      expect(d.replace('张三', '李四'), 2);
      expect(d.replace('预算：50', '预算：80'), 1);
      final o1 = d.outline();
      final id = RegExp(r'\[(p\d+)\] 项目方案').firstMatch(o1)![1]!;
      d.setText(id, '项目方案 (修订)');
      final bytes = d.save();
      _out('edited.docx', bytes);
      final o = OfficeDoc.open('x.docx', bytes).outline();
      expect(o, contains('项目方案 (修订)'));
      expect(o, contains('本方案由 李四 负责。'));
      expect(o, contains('预算：80 万'));
    });

    test('新建 Word', () {
      final bytes = OfficeDoc.createDocx('# 会议纪要\n\n今天讨论了 <预算> & 排期。');
      _out('new.docx', bytes);
      expect(OfficeDoc.open('x.docx', bytes).outline(), contains('今天讨论了 <预算> & 排期。'));
    });
  });

  group('Excel', () {
    test('看格子 (含公式); 改已有格 / 新格 / 新行', () {
      final d = _open('sample.xlsx');
      final o0 = d.outline();
      expect(o0, contains('销售!A2 = 一月'));
      expect(o0, contains('公式 =SUM(B2:B3)'));
      d.setCell('销售!B2', '130');
      d.setCell('销售!C1', '备注');
      d.setCell('B6', '999');
      expect(d.replace('二月', '2 月'), 1);
      final bytes = d.save();
      _out('edited.xlsx', bytes);
      final o = OfficeDoc.open('x.xlsx', bytes).outline();
      expect(o, contains('销售!B2 = 130'));
      expect(o, contains('销售!C1 = 备注'));
      expect(o, contains('销售!B6 = 999'));
      expect(o, contains('销售!A3 = 2 月'));
    });

    test('新建 Excel', () {
      final bytes = OfficeDoc.createXlsx([
        ['名字', '分数'],
        ['小明', '90'],
      ]);
      _out('new.xlsx', bytes);
      expect(OfficeDoc.open('x.xlsx', bytes).outline(), contains('Sheet1!B2 = 90'));
      expect(OfficeDoc.open('x.xlsx', bytes).outline(), contains('Sheet1!A2 = 小明'));
    });

    /* WPS 手机版 / 微信预览把 inlineStr 格当空, 也要有 styles.xml (2026-10-12 「座位表」打开是空的) */
    test('新建 / 改格都按 Excel 的标准写法: 共享字符串 + 样式表, 不出 inlineStr', () {
      String part(List<int> bytes, String name) =>
          String.fromCharCodes(ZipDecoder().decodeBytes(bytes).findFile(name)?.content ?? const []);
      final made = OfficeDoc.createXlsx([['讲台'], ['张三', '李四', '张三']], sheetName: '座位表');
      expect(part(made, 'xl/worksheets/sheet1.xml'), isNot(contains('inlineStr')));
      expect(part(made, 'xl/styles.xml'), contains('<cellXfs'));
      expect(OfficeDoc.open('x.xlsx', made).outline(), contains('座位表!C2 = 张三'));

      final d = _open('sample.xlsx')..setCell('销售!C1', '备注');
      final edited = d.save();
      /* 样本本身 (openpyxl 生成) 就带 inlineStr, 只看新写进去的那格 */
      final sheets = ZipDecoder().decodeBytes(edited).files.map((f) => f.name).where((n) => n.startsWith('xl/worksheets/'));
      expect(sheets.map((n) => part(edited, n)).join(), contains('<c r="C1" t="s">'));
      expect(OfficeDoc.open('x.xlsx', edited).outline(), contains('销售!C1 = 备注'));
    });
  });

  test('不认识的格式说人话', () {
    expect(() => OfficeDoc.open('a.ppt', File('test/fixtures/office/sample.pptx').readAsBytesSync()),
        throwsA(isA<OfficeEditError>()));
  });
}

/* 本机复核 (改完的文件能被正经库打开):
 *   python3 -c "from pptx import Presentation as P; p=P('build/office_out/edited.pptx'); print([[s.text for s in sl.shapes if s.has_text_frame] for sl in p.slides])"
 *   python3 -c "import docx; print([p.text for p in docx.Document('build/office_out/edited.docx').paragraphs])"
 *   python3 -c "import openpyxl; print(list(openpyxl.load_workbook('build/office_out/edited.xlsx').active.values))"
 */
