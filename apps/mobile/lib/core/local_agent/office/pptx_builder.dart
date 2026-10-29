/// pptx_builder.dart — 手机上从零新建 PPT (2026-10-12)。
///
/// 用户实拍: 让手机做年会策划 PPT, Agent 回「我没法从零新建 PPT 文件, 只能出 Word 版你自己复制进模板」。
/// 用户: 「新建 PPT 必须要完成」。
///
/// 纯 Dart 拼 OOXML, 不依赖模板文件: 一份完整的包 (母版 + 版式 + 主题 + presProps/viewProps/tableStyles +
/// docProps), 跟 createXlsx 同一个教训 —— 少一个标准部件 WPS / 微信预览就可能打不开或显示空白。
/// 文字都是绝对定位的文本框 (不靠占位符继承), 所以 PowerPoint / WPS / Keynote / 微信预览看到的一样。
///
/// 版式 (layout): cover 封面 / section 章节页 / bullets 要点 / two_column 左右两栏 / table 表格 /
/// stats 大数字 / closing 结束页。16:9, 中文字体微软雅黑。字号按内容多少自动往下收, 不溢出。
library;

import 'dart:typed_data';

import 'package:archive/archive.dart';

/// 一页的内容 —— 从工具参数里来, 字段按版式取用, 多给的忽略
class PptSlide {
  const PptSlide({
    required this.layout,
    this.title = '',
    this.subtitle = '',
    this.bullets = const [],
    this.leftTitle = '',
    this.left = const [],
    this.rightTitle = '',
    this.right = const [],
    this.rows = const [],
    this.stats = const [],
    this.image,
  });

  /// 配图: 工作区里的图片路径 (生图工具画的 / Linux 里画的图表 / 用户发来的照片)。
  /// layout=image 时整页铺满; cover / bullets / closing 带图时图放右半边。
  final String? image;

  final String layout;
  final String title;
  final String subtitle;
  final List<String> bullets;
  final String leftTitle;
  final List<String> left;
  final String rightTitle;
  final List<String> right;
  final List<List<String>> rows;
  final List<({String value, String label})> stats;

  factory PptSlide.fromJson(Map<String, Object?> j) {
    List<String> strs(Object? v) => [for (final x in (v as List?) ?? const []) '${x ?? ''}'.trim()]..removeWhere((s) => s.isEmpty);
    return PptSlide(
      layout: '${j['layout'] ?? 'bullets'}'.trim(),
      title: '${j['title'] ?? ''}'.trim(),
      subtitle: '${j['subtitle'] ?? ''}'.trim(),
      bullets: strs(j['bullets']),
      leftTitle: '${j['left_title'] ?? ''}'.trim(),
      left: strs(j['left']),
      rightTitle: '${j['right_title'] ?? ''}'.trim(),
      right: strs(j['right']),
      rows: [
        for (final r in (j['rows'] as List?) ?? const []) [for (final c in (r as List? ?? const [])) '${c ?? ''}'],
      ],
      stats: [
        for (final s in (j['stats'] as List?) ?? const [])
          if (s is Map) (value: '${s['value'] ?? ''}'.trim(), label: '${s['label'] ?? ''}'.trim()),
      ],
      image: '${j['image'] ?? ''}'.trim().isEmpty ? null : '${j['image']}'.trim(),
    );
  }
}

/// 配色: 主色 + 主色浅底。年会 / 喜庆用 red, 商务默认 blue。
const pptThemes = <String, ({String accent, String tint})>{
  'blue': (accent: '2563EB', tint: 'EEF3FE'),
  'red': (accent: 'C0392B', tint: 'FBEDEB'),
  'green': (accent: '15803D', tint: 'ECF7EF'),
  'purple': (accent: '6D28D9', tint: 'F3EEFC'),
  'orange': (accent: 'C2410C', tint: 'FDF1EA'),
  'dark': (accent: '1F2937', tint: 'F1F2F4'),
};

const _ns = 'http://schemas.openxmlformats.org';
const _head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const _nsP = 'xmlns:a="$_ns/drawingml/2006/main" xmlns:r="$_ns/officeDocument/2006/relationships" xmlns:p="$_ns/presentationml/2006/main"';

/* 16:9, EMU */
const _w = 12192000;
const _h = 6858000;
const _in = 914400;

const _ink = '1F2937';
const _soft = '4B5563';
const _faint = '9CA3AF';
const _font = 'Microsoft YaHei';

class PptxBuilder {
  PptxBuilder({required this.slides, String theme = 'blue', this.images = const {}})
      : _c = pptThemes[theme] ?? pptThemes['blue']!;

  final List<PptSlide> slides;
  final ({String accent, String tint}) _c;

  /// 配图: PptSlide.image 的路径 → 图片字节 (png / jpg; 读文件是调用方的事, 这里保持纯函数)
  final Map<String, Uint8List> images;
  /* 形状 id 每页从 2 起: 1 是 spTree 自己 (nvGrpSpPr), 重号 PowerPoint 会报「需要修复」 */
  int _id = 2;

  /// 当前这页的配图 (rels 里固定 rId2) 和像素尺寸; 没图 = null
  ({int w, int h})? _pic;

  Uint8List build() {
    if (slides.isEmpty) throw ArgumentError('slides 是空的');
    final zip = Archive();
    void add(String path, String xml) => zip.add(ArchiveFile.string(path, xml));
    final n = slides.length;

    add('[Content_Types].xml', '$_head<Types xmlns="$_ns/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
        '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
        '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'
        '${[for (var i = 1; i <= n; i++) '<Override PartName="/ppt/slides/slide$i.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'].join()}'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
    add('_rels/.rels', '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
        '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        '<Relationship Id="rId2" Type="$_ns/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="$_ns/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
    final now = '${DateTime.now().toUtc().toIso8601String().split('.').first}Z';
    add('docProps/core.xml', '$_head<cp:coreProperties xmlns:cp="$_ns/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>${_esc(slides.first.title)}</dc:title><dc:creator>Neox</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">$now</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">$now</dcterms:modified></cp:coreProperties>');
    add('docProps/app.xml', '$_head<Properties xmlns="$_ns/officeDocument/2006/extended-properties"><Application>Neox</Application><Slides>$n</Slides></Properties>');

    add('ppt/presentation.xml', '$_head<p:presentation $_nsP saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        '<p:sldIdLst>${[for (var i = 0; i < n; i++) '<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>'].join()}</p:sldIdLst>'
        '<p:sldSz cx="$_w" cy="$_h"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
    add('ppt/_rels/presentation.xml.rels', '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
        '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        '<Relationship Id="rId2" Type="$_ns/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
        '<Relationship Id="rId3" Type="$_ns/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>'
        '<Relationship Id="rId4" Type="$_ns/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>'
        '<Relationship Id="rId5" Type="$_ns/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>'
        '${[for (var i = 0; i < n; i++) '<Relationship Id="rId${10 + i}" Type="$_ns/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>'].join()}'
        '</Relationships>');
    add('ppt/presProps.xml', '$_head<p:presentationPr $_nsP/>');
    add('ppt/viewProps.xml', '$_head<p:viewPr $_nsP><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>');
    add('ppt/tableStyles.xml', '$_head<a:tblStyleLst xmlns:a="$_ns/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>');
    add('ppt/theme/theme1.xml', _theme());
    add('ppt/slideMasters/slideMaster1.xml', '$_head<p:sldMaster $_nsP><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${_tree('')}</p:cSld>'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>');
    add('ppt/slideMasters/_rels/slideMaster1.xml.rels', '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
        '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        '<Relationship Id="rId2" Type="$_ns/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
    add('ppt/slideLayouts/slideLayout1.xml', '$_head<p:sldLayout $_nsP type="blank" preserve="1"><p:cSld name="Blank">${_tree('')}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
    add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
        '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');

    for (var i = 0; i < n; i++) {
      _id = 2;
      final s = slides[i];
      /* 配图: 只收 png / jpg (老版 PowerPoint 不认 webp), 量不出尺寸的也不要 */
      final img = s.image == null ? null : images[s.image];
      final kind = img == null ? null : _imageKind(img);
      final dims = img == null ? null : _imageSize(img);
      _pic = kind == null || dims == null ? null : dims;
      if (_pic != null) zip.add(ArchiveFile('ppt/media/image${i + 1}.$kind', img!.length, img));
      final (bg, body) = _slide(s, i + 1, n);
      add('ppt/slides/slide${i + 1}.xml', '$_head<p:sld $_nsP><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="$bg"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${_tree(body)}</p:cSld>'
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
      add('ppt/slides/_rels/slide${i + 1}.xml.rels', '$_head<Relationships xmlns="$_ns/package/2006/relationships">'
          '<Relationship Id="rId1" Type="$_ns/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
          '${_pic != null ? '<Relationship Id="rId2" Type="$_ns/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.$kind"/>' : ''}'
          '</Relationships>');
    }
    return Uint8List.fromList(ZipEncoder().encodeBytes(zip));
  }

  // ═══════════════════════ 各版式 ═══════════════════════

  (String, String) _slide(PptSlide s, int no, int total) {
    final a = _c.accent;
    switch (s.layout) {
      case 'image':
        /* 整页大图, 底部一条半透明深色带压标题 (没图就退成封面样式) */
        if (_pic == null) return _slide(PptSlide(layout: 'cover', title: s.title, subtitle: s.subtitle), no, total);
        final bandH = (s.subtitle.isEmpty ? 1.5 : 2.0) * _in;
        return ('000000', [
          _picture(x: 0, y: 0, w: _w, h: _h),
          _rect(x: 0, y: _h - bandH.round(), w: _w, h: bandH.round(), fill: '000000', alpha: 55),
          _text(x: _in, y: _h - bandH.round() + (0.25 * _in).round(), w: _w - 2 * _in, h: (0.9 * _in).round(), anchor: 'ctr',
              paras: [_p([_r(s.title, sz: _fit(s.title, base: 36, perLine: 24, minSize: 24), color: 'FFFFFF', bold: true)])]),
          if (s.subtitle.isNotEmpty)
            _text(x: _in, y: _h - (0.85 * _in).round(), w: _w - 2 * _in, h: (0.6 * _in).round(),
                paras: [_p([_r(s.subtitle, sz: 18, color: 'FFFFFF')])]),
        ].join());
      case 'cover':
      case 'closing':
        /* 主色满底, 白字; 标题下一根短白线。带图: 右边 45% 是图, 字收在左边 */
        final title = s.title.isEmpty ? (s.layout == 'closing' ? '谢谢' : '') : s.title;
        final textW = _pic == null ? _w - 2 * _in : (_w * 0.55).round() - (1.4 * _in).round();
        final tSize = _fit(title, base: 54, perLine: _pic == null ? 16 : 9, minSize: 32);
        return (a, [
          if (_pic != null) _picture(x: (_w * 0.55).round(), y: 0, w: _w - (_w * 0.55).round(), h: _h),
          _text(x: _in, y: (2.1 * _in).round(), w: textW, h: (1.9 * _in).round(), anchor: 'b',
              paras: [_p([_r(title, sz: tSize, color: 'FFFFFF', bold: true)])]),
          _rect(x: _in, y: (4.15 * _in).round(), w: (1.1 * _in).round(), h: 50800, fill: 'FFFFFF'),
          if (s.subtitle.isNotEmpty)
            _text(x: _in, y: (4.4 * _in).round(), w: textW, h: (1.4 * _in).round(),
                paras: [for (final line in s.subtitle.split('\n')) _p([_r(line, sz: 22, color: 'FFFFFF')], after: 4)]),
        ].join());
      case 'section':
        /* 浅底, 左边大号序号 + 标题 */
        return (_c.tint, [
          _rect(x: 0, y: 0, w: (0.22 * _in).round(), h: _h, fill: a),
          _text(x: _in, y: (2.0 * _in).round(), w: (2.2 * _in).round(), h: (1.6 * _in).round(), anchor: 'ctr',
              paras: [_p([_r(_sectionNo(no).toString().padLeft(2, '0'), sz: 80, color: a, bold: true)])]),
          _text(x: (3.3 * _in).round(), y: (2.0 * _in).round(), w: _w - (4.3 * _in).round(), h: (1.6 * _in).round(), anchor: 'ctr',
              paras: [
                _p([_r(s.title, sz: _fit(s.title, base: 40, perLine: 18, minSize: 28), color: _ink, bold: true)]),
                if (s.subtitle.isNotEmpty) _p([_r(s.subtitle, sz: 20, color: _soft)], before: 8),
              ]),
        ].join());
      case 'two_column':
        final colW = ((_w - 2 * _in - (0.5 * _in).round()) / 2).round();
        final colH = _h - (3.1 * _in).round();
        final sz = [_bulletSize(s.left, colW, boxH: colH), _bulletSize(s.right, colW, boxH: colH)].reduce((a, b) => a < b ? a : b);
        String col(int x, String head, List<String> items) => [
              if (head.isNotEmpty) ...[
                _rect(x: x, y: (1.75 * _in).round(), w: colW, h: (0.5 * _in).round(), fill: _c.tint),
                _text(x: x, y: (1.75 * _in).round(), w: colW, h: (0.5 * _in).round(), anchor: 'ctr', inset: 120000,
                    paras: [_p([_r(head, sz: 18, color: a, bold: true)])]),
              ],
              _text(x: x, y: ((head.isEmpty ? 1.75 : 2.4) * _in).round(), w: colW, h: _h - ((head.isEmpty ? 2.45 : 3.1) * _in).round(),
                  paras: [for (final b in items) _bullet(b, sz)]),
            ].join();
        return ('FFFFFF', _titleBar(s) + col(_in, s.leftTitle, s.left) + col(_in + colW + (0.5 * _in).round(), s.rightTitle, s.right) + _pageNo(no));
      case 'table':
        return ('FFFFFF', _titleBar(s) + _table(s.rows) + _pageNo(no));
      case 'stats':
        final items = s.stats.take(4).toList();
        if (items.isEmpty) return ('FFFFFF', _titleBar(s) + _pageNo(no));
        final gap = (0.35 * _in).round();
        final cardW = ((_w - 2 * _in - gap * (items.length - 1)) / items.length).round();
        final cards = StringBuffer();
        for (var i = 0; i < items.length; i++) {
          final x = _in + i * (cardW + gap);
          final y = (2.2 * _in).round();
          cards
            ..write(_rect(x: x, y: y, w: cardW, h: (2.6 * _in).round(), fill: _c.tint))
            ..write(_rect(x: x, y: y, w: cardW, h: 50800, fill: a))
            ..write(_text(x: x, y: y + (0.35 * _in).round(), w: cardW, h: (1.2 * _in).round(), anchor: 'ctr', align: 'ctr',
                paras: [_p([_r(items[i].value, sz: _fit(items[i].value, base: 48, perLine: items.length > 3 ? 5 : 7, minSize: 28), color: a, bold: true)], align: 'ctr')]))
            ..write(_text(x: x, y: y + (1.6 * _in).round(), w: cardW, h: (0.8 * _in).round(), align: 'ctr',
                paras: [_p([_r(items[i].label, sz: 16, color: _soft)], align: 'ctr')]));
        }
        final foot = s.bullets.isEmpty
            ? ''
            : _text(x: _in, y: (5.15 * _in).round(), w: _w - 2 * _in, h: (1.2 * _in).round(),
                paras: [for (final b in s.bullets) _bullet(b, 16)]);
        return ('FFFFFF', _titleBar(s) + cards.toString() + foot + _pageNo(no));
      default: // bullets
        /* 带图: 字占左边 55%, 图放右边 */
        final full = _w - 2 * _in;
        final textW = _pic == null ? full : (full * 0.55).round();
        final sz = _bulletSize(s.bullets, textW);
        final picX = _in + textW + (0.4 * _in).round();
        return ('FFFFFF', _titleBar(s) +
            _text(x: _in, y: (1.75 * _in).round(), w: textW, h: _h - (2.45 * _in).round(),
                paras: [for (final b in s.bullets) _bullet(b, sz)]) +
            (_pic == null ? '' : _picture(x: picX, y: (1.75 * _in).round(), w: _w - _in - picX, h: _h - (2.55 * _in).round())) +
            _pageNo(no));
    }
  }

  /// 章节页的序号 = 到这一页为止第几个 section (不是页码)
  int _sectionNo(int slideNo) => slides.take(slideNo).where((s) => s.layout == 'section').length;

  /// 内容页的标题: 左上大字 + 下面一根主色短线 (副标题跟在标题右边的小灰字)
  String _titleBar(PptSlide s) => [
        _text(x: _in, y: (0.45 * _in).round(), w: _w - 2 * _in, h: (0.9 * _in).round(), anchor: 'b',
            paras: [
              _p([
                _r(s.title, sz: _fit(s.title, base: 32, perLine: 26, minSize: 24), color: _ink, bold: true),
                if (s.subtitle.isNotEmpty) _r('   ${s.subtitle}', sz: 16, color: _faint),
              ]),
            ]),
        _rect(x: _in, y: (1.42 * _in).round(), w: (0.8 * _in).round(), h: 38100, fill: _c.accent),
      ].join();

  String _pageNo(int no) => _text(x: _w - (1.6 * _in).round(), y: _h - (0.6 * _in).round(), w: (1.0 * _in).round(), h: (0.35 * _in).round(),
      align: 'r', paras: [_p([_r('$no', sz: 11, color: _faint)], align: 'r')]);

  String _table(List<List<String>> rows) {
    final data = rows.where((r) => r.any((c) => c.trim().isNotEmpty)).toList();
    if (data.isEmpty) return '';
    final cols = data.map((r) => r.length).reduce((a, b) => a > b ? a : b);
    final width = _w - 2 * _in;
    /* 列宽按每列最长的字分 (中文算 2), 每列至少 1/(2×列数) */
    final need = List<double>.filled(cols, 1);
    for (final r in data) {
      for (var c = 0; c < r.length; c++) {
        final w = r[c].runes.fold<double>(0, (a, ch) => a + (ch > 0x2E80 ? 2 : 1.1));
        if (w > need[c]) need[c] = w;
      }
    }
    final sum = need.fold<double>(0, (a, b) => a + b);
    final floor = 1 / (2 * cols);
    final share = [for (final x in need) (x / sum).clamp(floor, 1.0)];
    final shareSum = share.fold<double>(0, (a, b) => a + b);
    final colW = [for (final x in share) (width * x / shareSum).round()];
    final avail = _h - (2.45 * _in).round();
    final rowH = (avail / data.length).clamp(300000, 520000).round();
    final sz = data.length > 12 ? 11 : data.length > 8 ? 13 : 15;
    String cell(String t, {required bool head, required bool band}) {
      final fill = head ? _c.accent : (band ? _c.tint : 'FFFFFF');
      return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${_p([_r(t, sz: sz, color: head ? 'FFFFFF' : _ink, bold: head)])}</a:txBody>'
          '<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">'
          '<a:lnL w="0"><a:noFill/></a:lnL><a:lnR w="0"><a:noFill/></a:lnR><a:lnT w="0"><a:noFill/></a:lnT>'
          '<a:lnB w="9525"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:lnB>'
          '<a:solidFill><a:srgbClr val="$fill"/></a:solidFill></a:tcPr></a:tc>';
    }
    final trs = StringBuffer();
    for (var r = 0; r < data.length; r++) {
      trs.write('<a:tr h="$rowH">');
      for (var c = 0; c < cols; c++) {
        trs.write(cell(c < data[r].length ? data[r][c] : '', head: r == 0, band: r.isEven && r > 0));
      }
      trs.write('</a:tr>');
    }
    final id = _id++;
    return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="$id" name="Table $id"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
        '<p:xfrm><a:off x="$_in" y="${(1.75 * _in).round()}"/><a:ext cx="$width" cy="${rowH * data.length}"/></p:xfrm>'
        '<a:graphic><a:graphicData uri="$_ns/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>'
        '<a:tblGrid>${[for (final w in colW) '<a:gridCol w="$w"/>'].join()}</a:tblGrid>$trs</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  }

  // ═══════════════════════ 积木 ═══════════════════════

  /// 标题字号: 一行装不下就往下收 (按「每行约 perLine 个中文字」估)
  static int _fit(String t, {required int base, required int perLine, required int minSize}) {
    final len = t.runes.fold<double>(0, (a, ch) => a + (ch > 0x2E80 ? 1 : 0.55));
    if (len <= perLine) return base;
    final scaled = (base * perLine / len).floor();
    return scaled < minSize ? minSize : scaled;
  }

  /// 要点字号: 从 28 往下试, 取放得进文本框的最大一档 (按每档实际折几行 × 行高 + 段前距算)。
  /// 第一版按「总行数」查表, 行数是按 24pt 估的, 字号一降每行能装更多字 —— 手机实做的 27 页
  /// 里 6 条要点被压到 16pt, 下半页全空着 (2026-10-12)。
  static int _bulletSize(List<String> items, int boxW, {int boxH = _h - 2240280 /* 2.45 英寸: 标题区 + 页脚 */}) {
    final lens = [for (final b in items) b.runes.fold<double>(0, (a, ch) => a + (ch > 0x2E80 ? 1 : 0.55))];
    final wIn = boxW / _in - 0.35; // 减掉项目符号缩进
    final hPt = boxH / 12700;
    for (final sz in const [28, 26, 24, 22, 20, 18, 16, 15, 14]) {
      final perLine = wIn * 72 / sz; // 中文字宽 ≈ 字号
      var lines = 0;
      for (final l in lens) {
        lines += (l / perLine).ceil().clamp(1, 99);
      }
      /* 行高 1.15 × 字号 × 1.2 (字体自身行距) + 每段前距 0.3 × 字号 */
      final need = lines * sz * 1.15 * 1.2 + lens.length * sz * 0.3;
      if (need <= hPt) return sz;
    }
    return 14;
  }

  String _bullet(String text, int sz) {
    /* 「标题：说明」或「标题: 说明」→ 冒号前加粗 */
    final m = RegExp(r'^(.{1,16}?)[：:]\s*(.+)$').firstMatch(text);
    final runs = m == null
        ? [_r(text, sz: sz, color: _ink)]
        : [_r('${m[1]}：', sz: sz, color: _ink, bold: true), _r(m[2]!, sz: sz, color: _soft)];
    final indent = (sz * 12700 * 1.1).round();
    return '<a:p><a:pPr marL="$indent" indent="-$indent"><a:lnSpc><a:spcPct val="115000"/></a:lnSpc><a:spcBef><a:spcPts val="${sz * 30}"/></a:spcBef>'
        '<a:buClr><a:srgbClr val="${_c.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>${runs.join()}</a:p>';
  }

  static String _p(List<String> runs, {String? align, int before = 0, int after = 0}) =>
      '<a:p><a:pPr${align == null ? '' : ' algn="$align"'}>'
      '${before > 0 ? '<a:spcBef><a:spcPts val="${before * 100}"/></a:spcBef>' : ''}'
      '${after > 0 ? '<a:spcAft><a:spcPts val="${after * 100}"/></a:spcAft>' : ''}'
      '<a:buNone/></a:pPr>${runs.join()}</a:p>';

  static String _r(String t, {required int sz, required String color, bool bold = false}) =>
      '<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz * 100}"${bold ? ' b="1"' : ''} dirty="0">'
      '<a:solidFill><a:srgbClr val="$color"/></a:solidFill><a:latin typeface="$_font"/><a:ea typeface="$_font"/><a:cs typeface="$_font"/></a:rPr>'
      '<a:t>${_esc(t)}</a:t></a:r>';

  String _text({required int x, required int y, required int w, required int h, required List<String> paras,
      String anchor = 't', String? align, int inset = 0}) {
    final id = _id++;
    return '<p:sp><p:nvSpPr><p:cNvPr id="$id" name="Text $id"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$w" cy="$h"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="$inset" tIns="0" rIns="$inset" bIns="0" anchor="$anchor"><a:noAutofit/></a:bodyPr><a:lstStyle/>'
        '${paras.isEmpty ? '<a:p><a:endParaRPr lang="zh-CN"/></a:p>' : paras.join()}</p:txBody></p:sp>';
  }

  /// [alpha]: 不透明度百分比 (100 = 不透明)
  String _rect({required int x, required int y, required int w, required int h, required String fill, int alpha = 100}) {
    final id = _id++;
    final clr = alpha >= 100 ? '<a:srgbClr val="$fill"/>' : '<a:srgbClr val="$fill"><a:alpha val="${alpha * 1000}"/></a:srgbClr>';
    return '<p:sp><p:nvSpPr><p:cNvPr id="$id" name="Shape $id"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$w" cy="$h"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        '<a:solidFill>$clr</a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>';
  }

  /// 这页的配图铺进 (x,y,w,h): 按框的比例从图中间裁 (cover), 不拉伸变形
  String _picture({required int x, required int y, required int w, required int h}) {
    final p = _pic!;
    final id = _id++;
    final boxR = w / h, imgR = p.w / p.h;
    var crop = '';
    if (imgR > boxR) {
      final cut = ((1 - boxR / imgR) / 2 * 100000).round(); // 左右各裁
      crop = '<a:srcRect l="$cut" r="$cut"/>';
    } else if (imgR < boxR) {
      final cut = ((1 - imgR / boxR) / 2 * 100000).round(); // 上下各裁
      crop = '<a:srcRect t="$cut" b="$cut"/>';
    }
    return '<p:pic><p:nvPicPr><p:cNvPr id="$id" name="Picture $id"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        '<p:blipFill><a:blip r:embed="rId2"/>${crop.isEmpty ? '<a:srcRect/>' : crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        '<p:spPr><a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$w" cy="$h"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  }

  /// png / jpeg; 别的格式 → null (不放进 PPT)
  static String? _imageKind(Uint8List b) {
    if (b.length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return 'png';
    if (b.length > 3 && b[0] == 0xFF && b[1] == 0xD8) return 'jpeg';
    return null;
  }

  /// 读图片像素尺寸 (PNG 的 IHDR / JPEG 的 SOF 段)
  static ({int w, int h})? _imageSize(Uint8List b) {
    if (_imageKind(b) == 'png' && b.length > 24) {
      int u32(int o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
      final w = u32(16), h = u32(20);
      return w > 0 && h > 0 ? (w: w, h: h) : null;
    }
    if (_imageKind(b) == 'jpeg') {
      var i = 2;
      while (i + 9 < b.length) {
        if (b[i] != 0xFF) { i++; continue; }
        final m = b[i + 1];
        final len = (b[i + 2] << 8) | b[i + 3];
        if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) {
          final h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
          return w > 0 && h > 0 ? (w: w, h: h) : null;
        }
        i += 2 + len;
      }
    }
    return null;
  }

  static String _tree(String body) =>
      '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>$body</p:spTree>';

  String _theme() {
    String clr(String name, String v) => '<a:$name><a:srgbClr val="$v"/></a:$name>';
    const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
    const ln = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
    const eff = '<a:effectStyle><a:effectLst/></a:effectStyle>';
    return '$_head<a:theme xmlns:a="$_ns/drawingml/2006/main" name="Neox"><a:themeElements>'
        '<a:clrScheme name="Neox"><a:dk1><a:srgbClr val="$_ink"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
        '${clr('dk2', _soft)}${clr('lt2', _c.tint)}${clr('accent1', _c.accent)}${clr('accent2', '64748B')}${clr('accent3', 'F59E0B')}'
        '${clr('accent4', '10B981')}${clr('accent5', '8B5CF6')}${clr('accent6', 'EF4444')}${clr('hlink', _c.accent)}${clr('folHlink', '6B7280')}</a:clrScheme>'
        '<a:fontScheme name="Neox"><a:majorFont><a:latin typeface="$_font"/><a:ea typeface="$_font"/><a:cs typeface=""/></a:majorFont>'
        '<a:minorFont><a:latin typeface="$_font"/><a:ea typeface="$_font"/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="Neox"><a:fillStyleLst>$fill$fill$fill</a:fillStyleLst><a:lnStyleLst>$ln$ln$ln</a:lnStyleLst>'
        '<a:effectStyleLst>$eff$eff$eff</a:effectStyleLst><a:bgFillStyleLst>$fill$fill$fill</a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
  }

  static String _esc(String s) => s
      .replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F]'), '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
}
