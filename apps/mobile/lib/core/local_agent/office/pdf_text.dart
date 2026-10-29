/// pdf_text.dart — 手机本机从 PDF 里抽文字 (纯 Dart, 不靠工具包)。
///
/// 2026-10-16: 手机本机对话发 PDF 直接被拦「手机上读不了这种文件」, 而 PDF 是用户最常发的文件。
/// 工具包 (Linux) 默认不装, 不能指望 pdftotext。这里做够用的一版:
///   · 对象 / 对象流 (PDF 1.5 ObjStm) 都认, FlateDecode 解压
///   · 每页按 Resources → Font → ToUnicode 建码表 (中文 PDF 全是 CID 字体, 不查表就是乱码)
///   · 文本操作符 Tj / TJ / ' / " + Td / TD / T* / Tm 换行
/// 不做: 加密 PDF、扫描件 (图片里的字) —— 这两种如实报出来。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

class PdfTextError implements Exception {
  PdfTextError(this.message);
  final String message;
  @override
  String toString() => message;
}

class PdfText {
  PdfText._(this._bytes) : _src = latin1.decode(_bytes, allowInvalid: true);

  final Uint8List _bytes;
  final String _src;

  /// 对象号 → 对象正文 (dict 文本 + 可能的 stream 字节)
  final Map<int, _Obj> _objs = {};

  /// 每页一段文字。扫描件 / 抽不出字时抛 [PdfTextError]。
  static List<String> extractPages(Uint8List bytes, {int maxPages = 300}) {
    if (bytes.length < 8 || latin1.decode(bytes.sublist(0, 5), allowInvalid: true) != '%PDF-') {
      throw PdfTextError('不是有效的 PDF 文件');
    }
    final p = PdfText._(bytes).._index();
    if (p._src.contains('/Encrypt')) {
      /* 只有权限密码 (能打开不能复制) 的也加密了内容流, 解不开 */
      throw PdfTextError('这个 PDF 加了密, 手机上读不了文字');
    }
    final pages = p._pages();
    final out = <String>[];
    for (final page in pages.take(maxPages)) {
      try {
        out.add(_unifyRadicals(p._pageText(page)));
      } catch (_) {
        out.add('');
      }
    }
    if (out.every((t) => t.trim().isEmpty)) {
      throw PdfTextError('这个 PDF 里没有可复制的文字 (可能是扫描件 / 图片), 手机上读不了');
    }
    return out;
  }

  /// 整本拼成一段, 每页带页码
  static String extract(Uint8List bytes) {
    final pages = extractPages(bytes);
    return [
      for (var i = 0; i < pages.length; i++)
        if (pages[i].trim().isNotEmpty) '--- 第 ${i + 1} 页 ---\n${pages[i].trim()}',
    ].join('\n\n');
  }

  /// 康熙部首 → 统一汉字 (NFKC 那一段)。Chrome / Skia 出的中文 PDF 把「方」「⾦」这些字的 ToUnicode
  /// 写成部首码位 (U+2F45 ⽅), 看着一样, 但模型搜「金额」搜不到「⾦额」。
  static const _kangxi =
      '一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉釆里金長門阜隶隹雨靑非面革韋韭音頁風飛食首香馬骨高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠';

  static String _unifyRadicals(String s) {
    if (!s.runes.any((r) => (r >= 0x2F00 && r <= 0x2FD5) || r == 0x2E9F || r == 0x2EF3)) return s;
    final kx = _kangxi.runes.toList();
    final sb = StringBuffer();
    for (final r in s.runes) {
      if (r >= 0x2F00 && r <= 0x2FD5) {
        sb.writeCharCode(kx[r - 0x2F00]);
      } else if (r == 0x2E9F) {
        sb.write('母');
      } else if (r == 0x2EF3) {
        sb.write('龟');
      } else {
        sb.writeCharCode(r);
      }
    }
    return sb.toString();
  }

  /* ───────────── 对象 ───────────── */

  void _index() {
    for (final m in RegExp(r'(\d+)\s+(\d+)\s+obj\b').allMatches(_src)) {
      final num = int.parse(m[1]!);
      final end = _src.indexOf('endobj', m.end);
      if (end < 0) continue;
      final body = _src.substring(m.end, end);
      final s = body.indexOf('stream');
      if (s >= 0 && RegExp(r'^\s*<<').hasMatch(body)) {
        final dict = body.substring(0, s);
        var dataStart = m.end + s + 6;
        if (_src.startsWith('\r\n', dataStart)) {
          dataStart += 2;
        } else if (_src.startsWith('\n', dataStart) || _src.startsWith('\r', dataStart)) {
          dataStart += 1;
        }
        /* \b 不能少: 「/Length 11 0 R」(间接长度) 没有它会回溯成 Length=1, 流被截成一个字节 */
        final len = int.tryParse(RegExp(r'/Length\s+(\d+)\b(?!\s+\d+\s+R)').firstMatch(dict)?[1] ?? '');
        var dataEnd = len != null && dataStart + len <= _bytes.length ? dataStart + len : _src.indexOf('endstream', dataStart);
        if (dataEnd < 0) dataEnd = end;
        _objs[num] = _Obj(dict, _bytes.sublist(dataStart, dataEnd));
      } else {
        _objs[num] = _Obj(body, null);
      }
    }
    /* 对象流: 里面的对象没有 "N 0 obj" 头, 得解开流按偏移表切 */
    for (final o in _objs.values.toList()) {
      if (o.stream == null || !o.dict.contains('/ObjStm')) continue;
      try {
        final data = latin1.decode(_decode(o), allowInvalid: true);
        final n = int.parse(RegExp(r'/N\s+(\d+)').firstMatch(o.dict)![1]!);
        final first = int.parse(RegExp(r'/First\s+(\d+)').firstMatch(o.dict)![1]!);
        final nums = RegExp(r'\d+').allMatches(data.substring(0, first)).map((x) => int.parse(x[0]!)).toList();
        for (var i = 0; i < n && 2 * i + 1 < nums.length; i++) {
          final start = first + nums[2 * i + 1];
          final stop = i + 1 < n && 2 * i + 3 < nums.length ? first + nums[2 * i + 3] : data.length;
          if (start > data.length || stop > data.length || start > stop) continue;
          _objs.putIfAbsent(nums[2 * i], () => _Obj(data.substring(start, stop), null));
        }
      } catch (_) {/* 坏的对象流跳过 */}
    }
  }

  _Obj? _ref(String? r) {
    if (r == null) return null;
    final m = RegExp(r'^(\d+)\s+\d+\s+R').firstMatch(r.trim());
    return m == null ? null : _objs[int.parse(m[1]!)];
  }

  Uint8List _decode(_Obj o) {
    final data = o.stream!;
    if (!o.dict.contains('/FlateDecode') && !o.dict.contains('/Fl ') && !o.dict.contains('/Fl]')) return data;
    try {
      return Uint8List.fromList(const ZLibDecoder().decodeBytes(data));
    } catch (_) {
      return Uint8List.fromList(Inflate(data).getBytes());
    }
  }

  /// dict 文本里 key 对应的值 (引用 "5 0 R" / 内联 dict / 数组 / 名字)
  static String? _val(String dict, String key) {
    final i = RegExp('/$key(?![A-Za-z0-9])').firstMatch(dict);
    if (i == null) return null;
    var j = i.end;
    while (j < dict.length && ' \r\n\t'.contains(dict[j])) {
      j++;
    }
    if (j >= dict.length) return null;
    if (dict.startsWith('<<', j)) return _balanced(dict, j, '<<', '>>');
    if (dict[j] == '[') return _balanced(dict, j, '[', ']');
    final ref = RegExp(r'\d+\s+\d+\s+R').matchAsPrefix(dict, j);
    if (ref != null) return ref[0];
    final tok = RegExp(r'[^\s/<>\[\]()]+|/[^\s/<>\[\]()]+').matchAsPrefix(dict, j);
    return tok?[0];
  }

  static String _balanced(String s, int start, String open, String close) {
    var depth = 0;
    for (var k = start; k < s.length; k++) {
      if (s.startsWith(open, k)) {
        depth++;
        k += open.length - 1;
      } else if (s.startsWith(close, k)) {
        depth--;
        k += close.length - 1;
        if (depth == 0) return s.substring(start, k + 1);
      }
    }
    return s.substring(start);
  }

  /// 值可能是引用, 解成 dict 文本
  String? _dictOf(String? v) {
    if (v == null) return null;
    if (v.trim().startsWith('<<')) return v;
    return _ref(v)?.dict;
  }

  /* ───────────── 页 ───────────── */

  List<String> _pages() {
    final root = _ref(_val(_src.substring(_src.lastIndexOf('trailer') < 0 ? 0 : _src.lastIndexOf('trailer')), 'Root'))?.dict ??
        _objs.values.map((o) => o.dict).firstWhere((d) => d.contains('/Catalog'), orElse: () => '');
    final out = <String>[];
    void walk(String? node, String? inheritedRes, int depth) {
      if (node == null || depth > 30) return;
      final res = _val(node, 'Resources') ?? inheritedRes;
      if (RegExp(r'/Type\s*/Pages\b').hasMatch(node)) {
        final kids = _val(node, 'Kids') ?? '';
        for (final k in RegExp(r'\d+\s+\d+\s+R').allMatches(kids)) {
          walk(_ref(k[0])?.dict, res, depth + 1);
        }
      } else if (RegExp(r'/Type\s*/Page\b').hasMatch(node)) {
        /* 页对象本身没写 Resources 时用继承的, 拼一个假 key 带下去 */
        out.add(_val(node, 'Resources') == null && res != null ? '$node /Resources $res' : node);
      }
    }

    walk(_dictOf(_val(root, 'Pages')), null, 0);
    if (out.isEmpty) {
      /* 页树坏了: 退回扫所有 /Type /Page 对象 */
      out.addAll(_objs.values.map((o) => o.dict).where((d) => RegExp(r'/Type\s*/Page\b').hasMatch(d)));
    }
    return out;
  }

  /// Resources → 字体表 + XObject 表 (名字 → 对象)
  _Res _resOf(String? resources) {
    final res = _dictOf(resources) ?? '';
    final fonts = <String, _Font>{};
    final xobjs = <String, _Obj>{};
    final fontDict = _dictOf(_val(res, 'Font'));
    if (fontDict != null) {
      for (final m in RegExp(r'/([^\s/<>\[\]()]+)\s+(\d+\s+\d+\s+R)').allMatches(fontDict)) {
        final f = _ref(m[2])?.dict;
        if (f != null) fonts[m[1]!] = _font(f);
      }
    }
    final xDict = _dictOf(_val(res, 'XObject'));
    if (xDict != null) {
      for (final m in RegExp(r'/([^\s/<>\[\]()]+)\s+(\d+\s+\d+\s+R)').allMatches(xDict)) {
        final o = _ref(m[2]);
        if (o?.stream != null && o!.dict.contains('/Form')) xobjs[m[1]!] = o;
      }
    }
    return _Res(fonts, xobjs);
  }

  String _pageText(String page) {
    final res = _resOf(_val(page, 'Resources'));
    var contents = _val(page, 'Contents');
    if (contents == null) return '';
    /* /Contents 5 0 R 指向的可能是一个数组对象 (pdfTeX 就这么写), 不是流 */
    final indirect = contents.startsWith('[') ? null : _ref(contents);
    if (indirect != null && indirect.stream == null && indirect.dict.trim().startsWith('[')) contents = indirect.dict.trim();
    final parts = <Uint8List>[];
    if (contents.startsWith('[')) {
      for (final r in RegExp(r'\d+\s+\d+\s+R').allMatches(contents)) {
        final o = _ref(r[0]);
        if (o?.stream != null) parts.add(_decode(o!));
      }
    } else {
      final o = _ref(contents);
      if (o?.stream != null) parts.add(_decode(o!));
    }
    final sb = StringBuffer();
    for (final p in parts) {
      _runContent(latin1.decode(p, allowInvalid: true), res, sb, 0);
      sb.write('\n');
    }
    return sb.toString().replaceAll(RegExp(r'[ \t]+\n'), '\n').replaceAll(RegExp(r'\n{3,}'), '\n\n');
  }

  final Map<String, _Font> _fontCache = {};

  _Font _font(String dict) => _fontCache.putIfAbsent(dict, () {
        final tu = _ref(_val(dict, 'ToUnicode'));
        final twoByte = dict.contains('/Type0') || dict.contains('Identity-H') || dict.contains('Identity-V');
        if (tu?.stream == null) return _Font({}, twoByte ? 2 : 1);
        try {
          return _Font.fromCMap(latin1.decode(_decode(tu!), allowInvalid: true), twoByte ? 2 : 1);
        } catch (_) {
          return _Font({}, twoByte ? 2 : 1);
        }
      });

  /* ───────────── 内容流 ───────────── */

  void _runContent(String s, _Res res, StringBuffer out, int depth) {
    final fonts = res.fonts;
    var font = _Font({}, 1);
    final operands = <Object>[];
    double? lastY;
    var i = 0;
    void newline() {
      if (out.isNotEmpty && !out.toString().endsWith('\n')) out.write('\n');
    }

    while (i < s.length) {
      final c = s[i];
      if (' \r\n\t\f\u0000'.contains(c)) {
        i++;
      } else if (c == '%') {
        while (i < s.length && s[i] != '\n' && s[i] != '\r') {
          i++;
        }
      } else if (c == '(') {
        final r = _literal(s, i);
        operands.add(r.$1);
        i = r.$2;
      } else if (c == '<' && i + 1 < s.length && s[i + 1] == '<') {
        final d = _balanced(s, i, '<<', '>>');
        i += d.length;
      } else if (c == '<') {
        final e = s.indexOf('>', i);
        final hex = s.substring(i + 1, e < 0 ? s.length : e).replaceAll(RegExp(r'\s'), '');
        final b = <int>[];
        for (var k = 0; k + 1 < hex.length + 1; k += 2) {
          final h = k + 1 < hex.length ? hex.substring(k, k + 2) : '${hex[k]}0';
          b.add(int.tryParse(h, radix: 16) ?? 0);
        }
        operands.add(Uint8List.fromList(b));
        i = e < 0 ? s.length : e + 1;
      } else if (c == '[') {
        operands.add('[');
        i++;
      } else if (c == ']') {
        final arr = <Object>[];
        while (operands.isNotEmpty && operands.last != '[') {
          arr.insert(0, operands.removeLast());
        }
        if (operands.isNotEmpty) operands.removeLast();
        operands.add(arr);
        i++;
      } else if (c == '/') {
        final m = RegExp(r'/[^\s/<>\[\]()%{}]*').matchAsPrefix(s, i)!;
        operands.add(m[0]!);
        i = m.end;
      } else if (RegExp(r'[-+.\d]').hasMatch(c)) {
        final m = RegExp(r'[-+]?\d*\.?\d+|[-+]?\d+\.').matchAsPrefix(s, i);
        if (m == null) {
          i++;
          continue;
        }
        operands.add(double.tryParse(m[0]!) ?? 0.0);
        i = m.end;
      } else {
        final m = RegExp(r'[A-Za-z\x27"*]+').matchAsPrefix(s, i);
        if (m == null) {
          i++;
          continue;
        }
        final op = m[0]!;
        i = m.end;
        if (op == 'BI') {
          /* 内嵌图片: 跳到 EI */
          final ei = s.indexOf('EI', i);
          i = ei < 0 ? s.length : ei + 2;
        } else if (op == 'Tf' && operands.length >= 2 && operands[operands.length - 2] is String) {
          font = fonts[(operands[operands.length - 2] as String).substring(1)] ?? _Font({}, 1);
        } else if (op == 'Tj' || op == "'" || op == '"') {
          if (op != 'Tj') newline();
          final t = operands.isEmpty ? null : operands.last;
          if (t is Uint8List) out.write(font.decode(t));
        } else if (op == 'TJ') {
          final arr = operands.isEmpty ? null : operands.last;
          if (arr is List) {
            for (final x in arr) {
              if (x is Uint8List) {
                out.write(font.decode(x));
              } else if (x is double && x < -200) {
                /* 大的负字距 = 词间空格 */
                out.write(' ');
              }
            }
          }
        } else if (op == 'Td' || op == 'TD') {
          if (operands.length >= 2 && operands[operands.length - 1] is double && (operands.last as double).abs() > 0.5) newline();
        } else if (op == 'Tm') {
          final y = operands.length >= 6 && operands.last is double ? operands.last as double : null;
          if (y != null && lastY != null && (y - lastY).abs() > 1) newline();
          lastY = y;
        } else if (op == 'T*') {
          newline();
        } else if (op == 'Do' && depth < 8 && operands.isNotEmpty && operands.last is String) {
          /* 表单 XObject: LibreOffice 导出的 PPT 每个文本框都包在一个表单里, 不进去就只剩封面一行 */
          final x = res.xobjs[(operands.last as String).substring(1)];
          if (x != null) {
            final inner = _val(x.dict, 'Resources');
            _runContent(latin1.decode(_decode(x), allowInvalid: true), inner == null ? res : _resOf(inner), out, depth + 1);
            newline();
          }
        } else if (op == 'ET') {
          /* 一个文本块结束不一定换行; Td/Tm 已经处理行 */
        }
        operands.clear();
      }
    }
  }

  /// (...) 字面字符串 → 字节; 返回 (字节, 结束位置)
  static (Uint8List, int) _literal(String s, int start) {
    final b = <int>[];
    var depth = 0;
    var i = start;
    while (i < s.length) {
      final c = s.codeUnitAt(i);
      if (c == 0x5C /* \ */ && i + 1 < s.length) {
        final n = s[i + 1];
        const esc = {'n': 10, 'r': 13, 't': 9, 'b': 8, 'f': 12, '(': 40, ')': 41, '\\': 92};
        if (esc.containsKey(n)) {
          b.add(esc[n]!);
          i += 2;
        } else if (RegExp(r'[0-7]').hasMatch(n)) {
          final m = RegExp(r'[0-7]{1,3}').matchAsPrefix(s, i + 1)!;
          b.add(int.parse(m[0]!, radix: 8) & 0xFF);
          i = m.end;
        } else if (n == '\r' || n == '\n') {
          i += 2;
          if (n == '\r' && i < s.length && s[i] == '\n') i++;
        } else {
          b.add(n.codeUnitAt(0));
          i += 2;
        }
        continue;
      }
      if (c == 0x28) {
        depth++;
        if (depth > 1) b.add(c);
      } else if (c == 0x29) {
        depth--;
        if (depth == 0) return (Uint8List.fromList(b), i + 1);
        b.add(c);
      } else {
        b.add(c & 0xFF);
      }
      i++;
    }
    return (Uint8List.fromList(b), s.length);
  }
}

class _Res {
  _Res(this.fonts, this.xobjs);
  final Map<String, _Font> fonts;
  final Map<String, _Obj> xobjs;
}

class _Obj {
  _Obj(this.dict, this.stream);
  final String dict;
  final Uint8List? stream;
}

class _Font {
  _Font(this.map, this.codeBytes);

  /// 字符码 → Unicode 文字
  final Map<int, String> map;

  /// 每个字符码几个字节 (CID 字体 2, 简单字体 1)
  final int codeBytes;

  factory _Font.fromCMap(String cmap, int defaultBytes) {
    final map = <int, String>{};
    var bytes = defaultBytes;
    final cs = RegExp(r'begincodespacerange\s*<([0-9A-Fa-f]+)>').firstMatch(cmap);
    if (cs != null) bytes = (cs[1]!.length / 2).ceil().clamp(1, 4);
    String hexToStr(String h) {
      final units = <int>[];
      for (var k = 0; k + 3 < h.length + 1 && k + 4 <= h.length; k += 4) {
        units.add(int.parse(h.substring(k, k + 4), radix: 16));
      }
      if (units.isEmpty && h.isNotEmpty) units.add(int.parse(h, radix: 16));
      return String.fromCharCodes(units);
    }

    for (final block in RegExp(r'beginbfchar([\s\S]*?)endbfchar').allMatches(cmap)) {
      for (final m in RegExp(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>').allMatches(block[1]!)) {
        map[int.parse(m[1]!, radix: 16)] = hexToStr(m[2]!);
      }
    }
    for (final block in RegExp(r'beginbfrange([\s\S]*?)endbfrange').allMatches(cmap)) {
      for (final m in RegExp(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])').allMatches(block[1]!)) {
        final lo = int.parse(m[1]!, radix: 16), hi = int.parse(m[2]!, radix: 16);
        if (hi - lo > 65535) continue;
        if (m[4] != null) {
          final base = m[4]!;
          final head = base.length > 4 ? hexToStr(base.substring(0, base.length - 4)) : '';
          final last = int.parse(base.length > 4 ? base.substring(base.length - 4) : base, radix: 16);
          for (var c = lo; c <= hi; c++) {
            map[c] = head + String.fromCharCode(last + c - lo);
          }
        } else {
          final items = RegExp(r'<([0-9A-Fa-f]+)>').allMatches(m[5]!).map((x) => x[1]!).toList();
          for (var k = 0; k < items.length && lo + k <= hi; k++) {
            map[lo + k] = hexToStr(items[k]);
          }
        }
      }
    }
    return _Font(map, bytes);
  }

  String decode(Uint8List b) {
    if (map.isEmpty) {
      if (codeBytes == 2) return ''; // CID 字体没码表: 抽不出, 别出乱码
      return latin1.decode(b, allowInvalid: true).replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F]'), '');
    }
    final sb = StringBuffer();
    for (var i = 0; i + codeBytes <= b.length; i += codeBytes) {
      var code = 0;
      for (var k = 0; k < codeBytes; k++) {
        code = (code << 8) | b[i + k];
      }
      final t = map[code];
      if (t != null) {
        sb.write(t);
      } else if (codeBytes == 1 && code >= 32 && code < 127) {
        sb.writeCharCode(code);
      }
    }
    return sb.toString();
  }
}
