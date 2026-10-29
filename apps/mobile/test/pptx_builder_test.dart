import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/office/office_doc.dart';
import 'package:neox_app/core/local_agent/office/pptx_builder.dart';
import 'package:neox_app/core/local_agent/office/pptx_reader.dart';
import 'dart:typed_data';

/// 4×2 的红色 png
const _png4x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==';

/// 年会策划 —— 用户实拍那一单 (200 人 / 5 万 / 蚌埠 / 30 多个节目)
List<PptSlide> _annual() => [
      PptSlide.fromJson({'layout': 'cover', 'title': '2026 年度总结暨表彰大会', 'subtitle': '策划方案\n安徽蚌埠 · 200 人'}),
      PptSlide.fromJson({
        'layout': 'stats',
        'title': '活动概况',
        'stats': [
          {'value': '200', 'label': '参会人数'},
          {'value': '5 万', 'label': '总预算 (元)'},
          {'value': '30+', 'label': '部门节目'},
        ],
        'bullets': ['地点：蚌埠市区四星酒店宴会厅 (可容纳 250 人)'],
      }),
      PptSlide.fromJson({'layout': 'section', 'title': '活动流程', 'subtitle': '总结 → 表彰 → 节目 → 抽奖'}),
      PptSlide.fromJson({
        'layout': 'table',
        'title': '流程安排',
        'rows': [
          ['时间', '环节', '负责人'],
          ['14:00', '签到 & 合影', '行政部'],
          ['14:30', '年度总结报告', '总经理'],
          ['15:30', '优秀员工表彰', '人力资源部'],
          ['16:30', '部门节目 (上半场)', '各部门'],
          ['18:00', '晚宴 & 节目 (下半场)', '各部门'],
          ['20:30', '抽奖 & 结束', '行政部'],
        ],
      }),
      PptSlide.fromJson({
        'layout': 'bullets',
        'title': '节目安排',
        'bullets': ['每个部门至少 1 个节目：共 30 多个, 每个 ≤ 5 分钟', '形式不限：歌舞、小品、朗诵、乐器都可以', '彩排：活动前一周周五下午统一彩排'],
      }),
      PptSlide.fromJson({
        'layout': 'two_column',
        'title': '预算分配',
        'left_title': '场地 & 餐饮',
        'left': ['宴会厅场租：8,000', '餐标 120 元/人 × 200：24,000'],
        'right_title': '奖品 & 物料',
        'right': ['表彰奖品：8,000', '抽奖奖品：6,000', '舞台 & 布置：4,000'],
      }),
      PptSlide.fromJson({'layout': 'closing', 'title': '谢谢', 'subtitle': '<方案 & 联系人> "行政部"'}),
    ];

void main() {
  test('新建 PPT: 标准部件齐全, 页数对, 能被 OfficeDoc 再读出来', () {
    final bytes = PptxBuilder(slides: _annual(), theme: 'red').build();
    final zip = ZipDecoder().decodeBytes(bytes);
    final names = zip.files.map((f) => f.name).toSet();
    for (final p in [
      '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml', 'ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml',
    ]) {
      expect(names, contains(p));
    }
    for (var i = 1; i <= 7; i++) {
      expect(names, contains('ppt/slides/slide$i.xml'));
      expect(names, contains('ppt/slides/_rels/slide$i.xml.rels'));
    }
    /* 特殊字符要转义 */
    final last = utf8.decode(zip.findFile('ppt/slides/slide7.xml')!.content as List<int>);
    expect(last, contains('&lt;方案 &amp; 联系人&gt; &quot;行政部&quot;'));
    /* 形状 id 不跟 spTree 的 1 撞 */
    expect(RegExp(r'<p:cNvPr id="1" name="[^"]').allMatches(last).length, 0);
    /* 我们自己的改 PPT 能接着改它 (outline 能读出每页的字) */
    final outline = OfficeDoc.open('a.pptx', bytes).outline();
    expect(outline, contains('2026 年度总结暨表彰大会'));
    expect(outline, contains('优秀员工表彰'));
    expect(outline, contains('宴会厅场租'));

    final out = Platform.environment['PPTX_OUT'];
    if (out != null) File(out).writeAsBytesSync(bytes);
  });

  test('带配图的页: 图进 ppt/media, rels 指过去; 预览读回来有图 / 表 / 字', () {
    final png = Uint8List.fromList(base64Decode(_png4x2)); // 4×2 的 png, 测横图裁成框比例
    final slides = [
      PptSlide.fromJson({'layout': 'cover', 'title': '封面带图', 'image': 'images/a.png'}),
      PptSlide.fromJson({'layout': 'image', 'title': '整页大图', 'subtitle': '底部标题带', 'image': 'images/a.png'}),
      PptSlide.fromJson({'layout': 'bullets', 'title': '要点带图', 'bullets': ['一：二', '三'], 'image': 'images/a.png'}),
      PptSlide.fromJson({'layout': 'bullets', 'title': '图没找到', 'bullets': ['照常出'], 'image': 'images/none.png'}),
      ..._annual().where((s) => s.layout == 'table'),
    ];
    final bytes = PptxBuilder(slides: slides, theme: 'green', images: {'images/a.png': png}).build();
    final zip = ZipDecoder().decodeBytes(bytes);
    expect(zip.files.map((f) => f.name), containsAll(['ppt/media/image1.png', 'ppt/media/image2.png', 'ppt/media/image3.png']));
    expect(zip.files.map((f) => f.name), isNot(contains('ppt/media/image4.png')));
    final rels3 = utf8.decode(zip.findFile('ppt/slides/_rels/slide3.xml.rels')!.content as List<int>);
    expect(rels3, contains('../media/image3.png'));
    final s2 = utf8.decode(zip.findFile('ppt/slides/slide2.xml')!.content as List<int>);
    expect(s2, contains('<a:srcRect l="')); // 2:1 的图放进 16:9 框, 左右裁

    final deck = PptxReader(bytes).read();
    expect(deck.slides.length, 5);
    expect(deck.slides[1].shapes.any((s) => s.image != null), isTrue);
    expect(deck.slides[2].shapes.expand((s) => s.paras).map((p) => p.text), contains('要点带图'));
    expect(deck.slides[4].shapes.any((s) => s.table != null && s.table!.length == 7), isTrue);

    final out = Platform.environment['PPTX_OUT2'];
    if (out != null) File(out).writeAsBytesSync(bytes);
  });

  test('没有页就报错', () {
    expect(() => PptxBuilder(slides: const []).build(), throwsArgumentError);
  });
}
