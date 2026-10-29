/// docx_builder.dart — 手机本机新建 Word (纯 Dart OOXML)。
///
/// 第一版只认「# 标题」和普通段落: 模型写的 Markdown 表格原样变成一行行「| a | b |」,
/// 列表、**加粗** 全是字面符号 (2026-10-16 排查)。这一版认 Markdown 常用写法:
///   # / ## / ### 标题 (真「标题 1/2/3」样式, Word 导航窗格能用) · - / * / 1. 列表 ·
///   | 表格 | (第一行表头, 加底色) · **加粗** · > 引用 · --- 分页
/// 部件写全 (styles.xml 带中文字体 + docProps), WPS / 微信预览才不出空白。
library;

import 'dart:typed_data';

import 'package:archive/archive.dart';

class DocxBuildReport {
  int headings = 0;
  int paragraphs = 0;
  int bullets = 0;
  int tables = 0;
  int pageBreaks = 0;

  String describe() => [
        '标题 $headings 个',
        '段落 $paragraphs 段',
        if (bullets > 0) '列表 $bullets 条',
        if (tables > 0) '表格 $tables 张',
        if (pageBreaks > 0) '分页 $pageBreaks 处',
      ].join(' · ');
}

class DocxBuilder {
  DocxBuilder(this.markdown);

  final String markdown;
  final report = DocxBuildReport();

  static const _ns = 'http://schemas.openxmlformats.org';
  static const _head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  Uint8List build() {
    final body = StringBuffer();
    final lines = markdown.replaceAll('\r\n', '\n').split('\n');
    for (var i = 0; i < lines.length; i++) {
      final raw = lines[i];
      final t = raw.trim();
      if (t.startsWith('|')) {
        final block = <String>[];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          block.add(lines[i].trim());
          i++;
        }
        i--;
        body.write(_table(block));
        continue;
      }
      if (RegExp(r'^(-{3,}|\*{3,})$').hasMatch(t)) {
        report.pageBreaks++;
        body.write('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        continue;
      }
      final h = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(t);
      if (h != null) {
        report.headings++;
        body.write('<w:p><w:pPr><w:pStyle w:val="Heading${h[1]!.length}"/></w:pPr>${_runs(h[2]!)}</w:p>');
        continue;
      }
      final b = RegExp(r'^(\s*)[-*•]\s+(.*)$').firstMatch(raw);
      if (b != null) {
        report.bullets++;
        final level = (b[1]!.replaceAll('\t', '  ').length ~/ 2).clamp(0, 3);
        body.write('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="${420 + level * 420}" w:hanging="300"/></w:pPr>'
            '<w:r><w:t xml:space="preserve">${level == 0 ? '•' : '◦'}  </w:t></w:r>${_runs(b[2]!)}</w:p>');
        continue;
      }
      /* 「1. 」「2) 」「3、」—— 「3.5 亿」这种小数不算 */
      final n = RegExp(r'^(\s*)(\d+)(?:[.)]\s+|、\s*)(.*)$').firstMatch(raw);
      if (n != null) {
        report.bullets++;
        final level = (n[1]!.replaceAll('\t', '  ').length ~/ 2).clamp(0, 3);
        body.write('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="${420 + level * 420}" w:hanging="300"/></w:pPr>'
            '<w:r><w:t xml:space="preserve">${n[2]}. </w:t></w:r>${_runs(n[3]!)}</w:p>');
        continue;
      }
      final q = RegExp(r'^>\s?(.*)$').firstMatch(t);
      if (q != null) {
        report.paragraphs++;
        body.write('<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${_runs(q[1]!)}</w:p>');
        continue;
      }
      /* Markdown 的空行只是分段, 段距由样式给; 再写空段落, 每段之间就空出一大截 */
      if (t.isEmpty) continue;
      report.paragraphs++;
      body.write('<w:p>${_runs(raw)}</w:p>');
    }

    final zip = Archive()
      ..add(ArchiveFile.string('[Content_Types].xml',
          '$_head<Types xmlns="$_ns/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'))
      ..add(ArchiveFile.string('_rels/.rels',
          '$_head<Relationships xmlns="$_ns/package/2006/relationships"><Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
          '<Relationship Id="rId2" Type="$_ns/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
          '<Relationship Id="rId3" Type="$_ns/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'))
      ..add(ArchiveFile.string('docProps/core.xml', _coreProps()))
      ..add(ArchiveFile.string('docProps/app.xml',
          '$_head<Properties xmlns="$_ns/officeDocument/2006/extended-properties"><Application>Neox</Application></Properties>'))
      ..add(ArchiveFile.string('word/_rels/document.xml.rels',
          '$_head<Relationships xmlns="$_ns/package/2006/relationships"><Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'))
      ..add(ArchiveFile.string('word/styles.xml', _styles()))
      ..add(ArchiveFile.string('word/document.xml',
          '$_head<w:document xmlns:w="$_ns/wordprocessingml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships"><w:body>$body'
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'));
    return Uint8List.fromList(ZipEncoder().encode(zip));
  }

  /// **加粗** / *斜体* / `代码` → run
  static String _runs(String text) {
    final out = StringBuffer();
    final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+)`|(?<![*\w])\*([^*\s][^*]*?)\*(?!\*)');
    var last = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > last) out.write(_run(text.substring(last, m.start)));
      if (m[1] != null) {
        out.write(_run(m[1]!, rPr: '<w:b/>'));
      } else if (m[2] != null) {
        out.write(_run(m[2]!, rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>'));
      } else {
        out.write(_run(m[3]!, rPr: '<w:i/>'));
      }
      last = m.end;
    }
    if (last < text.length) out.write(_run(text.substring(last)));
    return out.toString();
  }

  static String _run(String s, {String rPr = ''}) =>
      s.isEmpty ? '' : '<w:r>${rPr.isEmpty ? '' : '<w:rPr>$rPr</w:rPr>'}<w:t xml:space="preserve">${_escape(s)}</w:t></w:r>';

  String _table(List<String> block) {
    List<String> cells(String line) {
      var l = line.trim();
      if (l.startsWith('|')) l = l.substring(1);
      if (l.endsWith('|')) l = l.substring(0, l.length - 1);
      return l.split('|').map((c) => c.trim()).toList();
    }

    final rows = [
      for (final l in block)
        if (!RegExp(r'^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$').hasMatch(l)) cells(l),
    ];
    if (rows.isEmpty) return '';
    report.tables++;
    final cols = rows.fold<int>(0, (m, r) => r.length > m ? r.length : m);
    const total = 9026; // A4 正文宽 (twips)
    /* 列宽按每列最长的字分 (中文算两个), 不然「行动」那列挤成四行、「负责人」那列一半空白 */
    final weight = [
      for (var c = 0; c < cols; c++)
        rows.fold<int>(4, (m, r) {
          final len = c < r.length ? r[c].runes.fold<int>(0, (a, ch) => a + (ch > 0x2E80 ? 2 : 1)) : 0;
          return len > m ? len : m;
        }).clamp(4, 40),
    ];
    final sum = weight.fold<int>(0, (a, b) => a + b);
    final widths = [for (final x in weight) total * x ~/ sum];
    const border = '<w:top w:val="single" w:sz="4" w:color="C8CDD5"/><w:left w:val="single" w:sz="4" w:color="C8CDD5"/><w:bottom w:val="single" w:sz="4" w:color="C8CDD5"/>'
        '<w:right w:val="single" w:sz="4" w:color="C8CDD5"/><w:insideH w:val="single" w:sz="4" w:color="C8CDD5"/><w:insideV w:val="single" w:sz="4" w:color="C8CDD5"/>';
    final sb = StringBuffer('<w:tbl><w:tblPr><w:tblW w:w="$total" w:type="dxa"/><w:tblBorders>$border</w:tblBorders>'
        '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        '<w:tblGrid>${widths.map((w) => '<w:gridCol w:w="$w"/>').join()}</w:tblGrid>');
    for (var r = 0; r < rows.length; r++) {
      final head = r == 0 && rows.length > 1;
      sb.write('<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}');
      for (var c = 0; c < cols; c++) {
        final text = c < rows[r].length ? rows[r][c] : '';
        final runs = head ? _run(text.replaceAll('**', ''), rPr: '<w:b/>') : _runs(text);
        sb.write('<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/>' : ''}</w:tcPr>'
            '<w:p><w:pPr><w:spacing w:after="0"/>${head ? '<w:jc w:val="center"/>' : ''}</w:pPr>$runs</w:p></w:tc>');
      }
      sb.write('</w:tr>');
    }
    sb.write('</w:tbl><w:p/>');
    return sb.toString();
  }

  static String _styles() {
    String heading(int n, int size, String before) =>
        '<w:style w:type="paragraph" w:styleId="Heading$n"><w:name w:val="heading $n"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:pPr><w:keepNext/><w:spacing w:before="$before" w:after="160"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>'
        '<w:rPr><w:b/><w:color w:val="1F2937"/><w:sz w:val="$size"/><w:szCs w:val="$size"/></w:rPr></w:style>';
    return '$_head<w:styles xmlns:w="$_ns/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>'
        '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '${heading(1, 36, '360')}${heading(2, 30, '280')}${heading(3, 26, '200')}'
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>'
        '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C8CDD5"/></w:pBdr><w:ind w:left="300"/></w:pPr><w:rPr><w:color w:val="555B66"/></w:rPr></w:style>'
        '</w:styles>';
  }

  static String _coreProps() {
    final now = '${DateTime.now().toUtc().toIso8601String().split('.').first}Z';
    return '$_head<cp:coreProperties xmlns:cp="$_ns/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:creator>Neox</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">$now</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">$now</dcterms:modified></cp:coreProperties>';
  }

  static String _escape(String s) =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
