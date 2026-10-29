/// 手机本地「对话」的文件附件 → 文本 (2026-09-29 用户: 「Chat 不支持文件附件, Excel 这些要支持」)。
///
/// 手机本地没有电脑那套解析器, 之前一律抛「手机模式暂不支持文件附件」。这里在手机上自己解:
///   xlsx  → 每个 sheet 一张 markdown 表 (sharedStrings + inlineStr + 数值)
///   docx  → 段落 + 表格
///   pptx  → 按页的文字
///   csv / tsv / txt / md / json / 代码 → 原文
/// Office 三件套都是 zip 里的 XML, 用 archive 解包 + 正则取文本, 跟桌面 core 的 sheetOoxml /
/// wordOoxml 同一取舍: 不引 DOM 解析器, 覆盖 Excel / WPS / Numbers 导出的常规结构。
///   pdf   → 文字层 (pdf_text.dart, 2026-10-16 起; 扫描件 / 加密的读不了)
library;

import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:archive/archive.dart';

import 'package:neox_app/core/i18n/tr.dart';

import 'office/pdf_text.dart';

/// 单个附件转出来的文本上限 —— 手机本地模型上下文有限, 再多也是白占
const int kAttachmentTextCap = 60 * 1000;
const int _kMaxRowsPerSheet = 500;
const int _kMaxSheets = 12;

const Set<String> _textExts = {
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'dart', 'lua', 'r', 'csv',
  'tsv', 'srt', 'vtt', 'env', 'properties', 'gradle',
};

/// 选文件那一刻就能判断的"手机本地能不能读" —— 不支持的在贴上时就说, 别等发送失败。
bool attachmentReadableOnPhone(String name) {
  final ext = _ext(name);
  return ext == 'xlsx' ||
      ext == 'xlsm' ||
      ext == 'docx' ||
      ext == 'pptx' ||
      ext == 'pdf' ||
      _textExts.contains(ext);
}

class AttachmentTextError implements Exception {
  AttachmentTextError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// 附件 → 给模型看的文本。不支持 / 解不开 → [AttachmentTextError] (带人话)。
/// 同 [extractAttachmentText], PDF 放后台 isolate 抽 (大文件一两秒, 别卡界面)。
/// isolate 里只跑 PdfText —— tr() 读 PlatformDispatcher, 不能在后台 isolate 调。
Future<String> extractAttachmentTextAsync(String name, Uint8List bytes) async {
  if (_ext(name) != 'pdf') return extractAttachmentText(name, bytes);
  String text;
  try {
    text = await Isolate.run(() => PdfText.extract(bytes));
  } on PdfTextError catch (e) {
    throw AttachmentTextError(tr(e.message));
  }
  return _cap(text);
}

String _cap(String text) => text.length > kAttachmentTextCap
    ? '${text.substring(0, kAttachmentTextCap)}\n\n…[文档过长, 已截断前 $kAttachmentTextCap 字, 原文 ${text.length} 字]'
    : text;

String extractAttachmentText(String name, Uint8List bytes) {
  final ext = _ext(name);
  String text;
  if (ext == 'xlsx' || ext == 'xlsm') {
    text = _xlsxToMarkdown(_unzip(name, bytes));
  } else if (ext == 'docx') {
    text = _docxToText(_unzip(name, bytes));
  } else if (ext == 'pptx') {
    text = _pptxToText(_unzip(name, bytes));
  } else if (ext == 'pdf') {
    /* 2026-10-16 起手机自己抽 PDF 文字 (pdf_text.dart); 扫描件 / 加密的如实报 */
    try {
      text = PdfText.extract(bytes);
    } on PdfTextError catch (e) {
      throw AttachmentTextError(tr(e.message));
    }
  } else if (ext == 'xls' || ext == 'doc' || ext == 'ppt') {
    throw AttachmentTextError(
      tr('老格式 (.xls/.doc/.ppt) 手机上读不了，另存为 .xlsx/.docx/.pptx 再发'),
    );
  } else if (_textExts.contains(ext) || _looksLikeText(bytes)) {
    text = _decodeText(name, bytes);
  } else {
    throw AttachmentTextError(
      tr('手机上暂时读不了这种文件，支持 Excel / Word / PPT / 文本；切到「我的电脑」可以处理更多类型'),
    );
  }
  return _cap(text);
}

String _ext(String name) {
  final i = name.lastIndexOf('.');
  return i < 0 ? '' : name.substring(i + 1).toLowerCase();
}

Archive _unzip(String name, Uint8List bytes) {
  try {
    return ZipDecoder().decodeBytes(bytes);
  } catch (_) {
    throw AttachmentTextError(tr('$name 打不开，文件可能损坏'));
  }
}

String? _entry(Archive zip, String path) {
  final f = zip.findFile(path);
  if (f == null) return null;
  return utf8.decode(f.content, allowMalformed: true);
}

bool _looksLikeText(Uint8List bytes) {
  final probe = bytes.length > 65536 ? bytes.sublist(0, 65536) : bytes;
  if (probe.contains(0)) return false;
  final s = utf8.decode(probe, allowMalformed: true);
  if (s.isEmpty) return true;
  var bad = 0;
  for (final c in s.runes) {
    if (c == 0xFFFD) bad++;
  }
  return bad / s.length < 0.002;
}

String _decodeText(String name, Uint8List bytes) {
  if (!_looksLikeText(bytes)) {
    throw AttachmentTextError(tr('$name 不是文本文件'));
  }
  return utf8.decode(bytes, allowMalformed: true);
}

/* ─── XML 文本工具 ─────────────────────────────────────────────────────── */

String _unescapeXml(String s) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAllMapped(RegExp(r'&#x([0-9a-fA-F]+);'), (m) => String.fromCharCode(int.parse(m[1]!, radix: 16)))
    .replaceAllMapped(RegExp(r'&#(\d+);'), (m) => String.fromCharCode(int.parse(m[1]!)))
    .replaceAll('&amp;', '&');

/// 取一段 XML 里所有 `<tag ...>文本</tag>` 拼起来 (tag 形如 `t` / `w:t` / `a:t`)
String _innerTexts(String xml, String tag) {
  final re = RegExp('<$tag(?:\\s[^>]*)?>([^<]*)</$tag>');
  final sb = StringBuffer();
  for (final m in re.allMatches(xml)) {
    sb.write(_unescapeXml(m[1]!));
  }
  return sb.toString();
}

Iterable<String> _blocks(String xml, String tag) sync* {
  final re = RegExp('<$tag(?:\\s[^>]*)?>(.*?)</$tag>', dotAll: true);
  for (final m in re.allMatches(xml)) {
    yield m[1]!;
  }
}

String _mdCell(String v) => v.replaceAll('|', r'\|').replaceAll(RegExp(r'[\r\n]+'), ' ');

/* ─── xlsx ─────────────────────────────────────────────────────────────── */

String _xlsxToMarkdown(Archive zip) {
  final workbook = _entry(zip, 'xl/workbook.xml');
  if (workbook == null) throw AttachmentTextError(tr('不是有效的 Excel 文件'));

  /* rId → 路径 */
  final rels = _entry(zip, 'xl/_rels/workbook.xml.rels') ?? '';
  final relMap = <String, String>{};
  for (final m in RegExp(r'<Relationship\b([^>]*)/?>').allMatches(rels)) {
    final attrs = m[1]!;
    final id = RegExp(r'\bId="([^"]+)"').firstMatch(attrs)?[1];
    final target = RegExp(r'\bTarget="([^"]+)"').firstMatch(attrs)?[1];
    if (id != null && target != null) {
      relMap[id] = target.startsWith('/') ? target.substring(1) : 'xl/$target';
    }
  }

  /* 共享字符串: 每个 <si> 里所有 <t> 拼起来 (富文本会拆成多个 <r><t>) */
  final sharedXml = _entry(zip, 'xl/sharedStrings.xml') ?? '';
  final shared = [for (final si in _blocks(sharedXml, 'si')) _innerTexts(si, 't')];

  final sections = <String>[];
  var sheetCount = 0;
  for (final m in RegExp(r'<sheet\b([^>]*)/?>').allMatches(workbook)) {
    final attrs = m[1]!;
    final name = _unescapeXml(RegExp(r'\bname="([^"]*)"').firstMatch(attrs)?[1] ?? 'Sheet');
    final rid = RegExp(r'\br:id="([^"]+)"').firstMatch(attrs)?[1];
    sheetCount++;
    if (sheetCount > _kMaxSheets) continue;
    final path = rid == null ? null : relMap[rid];
    final sheetXml = path == null ? null : _entry(zip, path);
    if (sheetXml == null) continue;
    sections.add('## $name\n\n${_sheetToTable(sheetXml, shared)}');
  }
  if (sheetCount > _kMaxSheets) {
    sections.add('_..还有 ${sheetCount - _kMaxSheets} 个 sheet 已省略_');
  }
  if (sections.isEmpty) throw AttachmentTextError(tr('Excel 里没有可读的工作表'));
  return sections.join('\n\n');
}

int _colIndex(String ref) {
  var n = 0;
  for (final ch in ref.codeUnits) {
    if (ch >= 65 && ch <= 90) {
      n = n * 26 + (ch - 64);
    } else {
      break;
    }
  }
  return n == 0 ? 1 : n;
}

String _sheetToTable(String xml, List<String> shared) {
  final rows = <List<String>>[];
  var truncated = 0;
  for (final row in _blocks(xml, 'row')) {
    if (rows.length >= _kMaxRowsPerSheet) {
      truncated++;
      continue;
    }
    final cells = <String>[];
    final cellRe = RegExp(r'<c\b([^>]*?)(?:/>|>(.*?)</c>)', dotAll: true);
    for (final c in cellRe.allMatches(row)) {
      final attrs = c[1]!;
      final body = c[2] ?? '';
      final ref = RegExp(r'\br="([A-Z]+)\d+"').firstMatch(attrs)?[1];
      final col = ref == null ? cells.length + 1 : _colIndex(ref);
      while (cells.length < col - 1) {
        cells.add('');
      }
      final type = RegExp(r'\bt="([^"]+)"').firstMatch(attrs)?[1];
      String value;
      if (type == 's') {
        final idx = int.tryParse(_innerTexts(body, 'v').trim());
        value = idx != null && idx >= 0 && idx < shared.length ? shared[idx] : '';
      } else if (type == 'inlineStr') {
        value = _innerTexts(body, 't');
      } else if (type == 'b') {
        value = _innerTexts(body, 'v').trim() == '1' ? 'TRUE' : 'FALSE';
      } else {
        value = _unescapeXml(_innerTexts(body, 'v'));
      }
      if (cells.length == col - 1) {
        cells.add(value);
      } else {
        cells[col - 1] = value;
      }
    }
    /* 全空行不占位 */
    if (cells.any((v) => v.trim().isNotEmpty)) rows.add(cells);
  }
  if (rows.isEmpty) return '_(空 sheet)_';
  var width = 0;
  for (final r in rows) {
    if (r.length > width) width = r.length;
  }
  final lines = <String>[];
  for (var i = 0; i < rows.length; i++) {
    final r = [...rows[i], for (var k = rows[i].length; k < width; k++) ''];
    lines.add('| ${r.map(_mdCell).join(' | ')} |');
    if (i == 0) lines.add('| ${List.filled(width, '---').join(' | ')} |');
  }
  if (truncated > 0) {
    lines.add('');
    lines.add('_..$truncated 行已省略 (单 sheet 上限 $_kMaxRowsPerSheet 行)_');
  }
  return lines.join('\n');
}

/* ─── docx ─────────────────────────────────────────────────────────────── */

String _docxToText(Archive zip) {
  final doc = _entry(zip, 'word/document.xml');
  if (doc == null) throw AttachmentTextError(tr('不是有效的 Word 文件'));
  final body = RegExp(r'<w:body>(.*)</w:body>', dotAll: true).firstMatch(doc)?[1] ?? doc;
  final out = <String>[];
  /* 表格和段落按出现顺序: 先把表格整块替换成占位, 再顺序输出 */
  final tables = <String>[];
  final withPlaceholders = body.replaceAllMapped(
    RegExp(r'<w:tbl>(.*?)</w:tbl>', dotAll: true),
    (m) {
      final rows = <String>[];
      for (final tr in _blocks(m[1]!, 'w:tr')) {
        final cells = [for (final tc in _blocks(tr, 'w:tc')) _mdCell(_innerTexts(tc, 'w:t'))];
        rows.add('| ${cells.join(' | ')} |');
        if (rows.length == 1) rows.add('| ${List.filled(cells.length, '---').join(' | ')} |');
      }
      tables.add(rows.join('\n'));
      return '<w:p><w:t>\u0000TBL${tables.length - 1}\u0000</w:t></w:p>';
    },
  );
  for (final p in _blocks(withPlaceholders, 'w:p')) {
    final text = _innerTexts(p, 'w:t');
    final tbl = RegExp('\u0000TBL(\\d+)\u0000').firstMatch(text);
    if (tbl != null) {
      out.add(tables[int.parse(tbl[1]!)]);
      continue;
    }
    if (text.trim().isEmpty) continue;
    final style = RegExp(r'<w:pStyle w:val="([^"]+)"').firstMatch(p)?[1] ?? '';
    final h = RegExp(r'^(?:Heading|heading|标题)\s?(\d)$').firstMatch(style);
    out.add(h != null ? '${'#' * int.parse(h[1]!)} $text' : text);
  }
  return out.join('\n\n');
}

/* ─── pptx ─────────────────────────────────────────────────────────────── */

String _pptxToText(Archive zip) {
  final slides = <int, String>{};
  for (final f in zip.files) {
    final m = RegExp(r'^ppt/slides/slide(\d+)\.xml$').firstMatch(f.name);
    if (m == null) continue;
    final xml = _entry(zip, f.name);
    if (xml == null) continue;
    final paras = <String>[];
    for (final p in _blocks(xml, 'a:p')) {
      final t = _innerTexts(p, 'a:t');
      if (t.trim().isNotEmpty) paras.add(t);
    }
    slides[int.parse(m[1]!)] = paras.join('\n');
  }
  if (slides.isEmpty) throw AttachmentTextError(tr('不是有效的 PPT 文件'));
  final keys = slides.keys.toList()..sort();
  return [for (final k in keys) '## 第 $k 页\n\n${slides[k]}'].join('\n\n');
}
