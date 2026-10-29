import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/office/pdf_text.dart';

void main() {
  /* Chrome 打印的中文 PDF: CID 字体 + ToUnicode, 不查码表就是乱码 */
  test('中文 PDF 抽出文字', () {
    final t = PdfText.extract(File('test/fixtures/office/sample-zh.pdf').readAsBytesSync());
    expect(t, contains('合同摘要'));
    expect(t, contains('北京某某科技有限公司'));
    expect(t, contains('120,000'));
    expect(t, contains('服务费'));
    /* Chrome 把「方」「金」写成康熙部首码位, 要归一 */
    expect(t, contains('甲方'));
    expect(t, contains('合同金额'));
  });

  test('不是 PDF / 空内容如实报', () {
    expect(() => PdfText.extract(Uint8List.fromList('hello'.codeUnits)), throwsA(isA<PdfTextError>()));
  });

  /* 本地拿真实 PDF 批量跑: NEOX_PDF_SAMPLES=<目录> flutter test test/pdf_text_test.dart */
  final dir = Platform.environment['NEOX_PDF_SAMPLES'];
  if (dir != null) {
    test('样本目录逐个抽', () {
      for (final f in Directory(dir).listSync().whereType<File>().where((f) => f.path.endsWith('.pdf'))) {
        final sw = Stopwatch()..start();
        try {
          final t = PdfText.extract(f.readAsBytesSync());
          final chars = t.replaceAll(RegExp(r'\s'), '').length;
          // ignore: avoid_print
          print('${f.uri.pathSegments.last}: $chars 字 ${sw.elapsedMilliseconds}ms | ${t.replaceAll('\n', ' ').substring(0, t.length.clamp(0, 120))}');
        } catch (e) {
          // ignore: avoid_print
          print('${f.uri.pathSegments.last}: 失败 $e ${sw.elapsedMilliseconds}ms');
        }
      }
    });
  }
}
