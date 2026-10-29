/// 手机本地对话的文件附件 → 文本 (2026-09-29 「Chat 不支持文件附件, Excel 这些要支持」)。
/// 用 archive 现造最小的 xlsx / docx / pptx, 不依赖机器上的真文件。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/attachment_text.dart';
import 'package:neox_app/core/network/attachment_upload.dart';

Uint8List _zip(Map<String, String> files) {
  final a = Archive();
  files.forEach((name, xml) {
    final bytes = utf8.encode(xml);
    a.addFile(ArchiveFile(name, bytes.length, bytes));
  });
  return Uint8List.fromList(ZipEncoder().encode(a));
}

Uint8List _xlsx() => _zip({
      'xl/workbook.xml':
          '<workbook xmlns:r="r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/><sheet name="空表" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml':
          '<sst><si><t>月份</t></si><si><t>收入</t></si><si><r><t>支</t></r><r><t>出</t></r></si><si><t>1 月</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
          '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1200</v></c><c r="C2"><v>800</v></c></row>'
          '<row r="3"><c r="A3" t="inlineStr"><is><t>2 月</t></is></c><c r="C3"><v>950</v></c></row>'
          '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
    });

Uint8List _docx() => _zip({
      'word/document.xml': '<w:document><w:body>'
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>'
          '<w:p><w:r><w:t>第一段 &amp; 内容</w:t></w:r><w:r><w:t>续</w:t></w:r></w:p>'
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>'
          '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
          '<w:p><w:r><w:t>结尾</w:t></w:r></w:p>'
          '</w:body></w:document>',
    });

Uint8List _pptx() => _zip({
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>封面</a:t></a:r><a:r><a:t>标题</a:t></a:r></a:p></p:sld>',
    });

void main() {
  test('xlsx → 每个 sheet 一张 markdown 表; 共享字符串 / 富文本 / inlineStr / 数字都认', () {
    final md = extractAttachmentText('预算.xlsx', _xlsx());
    expect(md, contains('## 预算'));
    expect(md, contains('| 月份 | 收入 | 支出 |'));
    expect(md, contains('| 1 月 | 1200 | 800 |'));
    /* B3 缺失要占位, C3 才落在第三列 */
    expect(md, contains('| 2 月 |  | 950 |'));
    expect(md, contains('## 空表'));
  });

  test('docx → 标题 / 段落 / 表格按顺序', () {
    final t = extractAttachmentText('a.docx', _docx());
    expect(t, contains('# 标题'));
    expect(t, contains('第一段 & 内容续'));
    expect(t.indexOf('| a | b |'), lessThan(t.indexOf('结尾')));
    expect(t, contains('| 1 | 2 |'));
  });

  test('pptx → 按页码排序', () {
    final t = extractAttachmentText('a.pptx', _pptx());
    expect(t.indexOf('## 第 1 页'), lessThan(t.indexOf('## 第 2 页')));
    expect(t, contains('封面标题'));
  });

  test('csv / txt 原文; 二进制不认识的报人话; PDF 指路电脑', () {
    expect(extractAttachmentText('a.csv', Uint8List.fromList(utf8.encode('a,b\n1,2'))), 'a,b\n1,2');
    expect(
      () => extractAttachmentText('x.bin', Uint8List.fromList([0, 1, 2, 255, 0])),
      throwsA(isA<AttachmentTextError>()),
    );
    expect(
      () => extractAttachmentText('x.pdf', Uint8List.fromList([0x25, 0x50, 0x44, 0x46])),
      throwsA(predicate((e) => e.toString().contains('PDF'))),
    );
  });

  test('选文件那一刻就能判断手机能不能读', () {
    expect(attachmentReadableOnPhone('a.xlsx'), isTrue);
    expect(attachmentReadableOnPhone('a.docx'), isTrue);
    expect(attachmentReadableOnPhone('a.md'), isTrue);
    /* 2026-10-16 起手机自己抽 PDF 文字 */
    expect(attachmentReadableOnPhone('a.pdf'), isTrue);
    expect(attachmentReadableOnPhone('a.zip'), isFalse);
  });

  test('大附件分片上传: 片按 4 的倍数切, 顺序编号, session.input 只带 upload_id', () async {
    final bytes = Uint8List.fromList(List.generate(300 * 1024, (i) => i % 251));
    final b64 = base64Encode(bytes);
    final calls = <(String, Map<String, Object?>)>[];
    final received = StringBuffer();
    final out = await uploadLargeAttachments(
      [
        {'kind': 'file', 'name': 'big.csv', 'mime': 'text/csv', 'data_base64': b64, 'size_bytes': bytes.length},
        {'kind': 'file', 'name': 'small.txt', 'mime': 'text/plain', 'data_base64': base64Encode([1, 2, 3])},
      ],
      (method, params) async {
        calls.add((method, params));
        if (method == 'attachment.begin') return {'upload_id': 'up-1'};
        if (method == 'attachment.chunk') {
          final piece = params['data_base64'] as String;
          expect(piece.length % 4, 0);
          expect(piece.length, lessThanOrEqualTo(kUploadChunkB64Chars));
          received.write(piece);
        }
        return {'ok': true};
      },
    );
    expect(out[0]['upload_id'], 'up-1');
    expect(out[0].containsKey('data_base64'), isFalse);
    expect(out[0]['size_bytes'], bytes.length);
    expect(base64Decode(received.toString()), bytes);
    final indexes = [for (final c in calls) if (c.$1 == 'attachment.chunk') c.$2['index']];
    expect(indexes, List.generate(indexes.length, (i) => i));
    expect(calls.last.$1, 'attachment.end');
    /* 小的原样内联 */
    expect(out[1]['data_base64'], isNotNull);
  });
}
