/// attachment_cards_test.dart — 用户气泡里的图片 / 文件附件卡.
///
/// 用户 2026-09 的话: 「发了图之后只有文字, 图去哪了」。附件卡就是那句话的答案:
/// 图排成缩略图、文件按类型给图标和大小。这里拴住看得见的那几件事。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/attachments/local_attachment_store.dart';
import 'package:neox_app/features/timeline/widgets/message_widgets.dart';
import 'package:neox_app/features/timeline/widgets/user_attachments.dart';

LocalAttachmentRef _file(String name, {int size = 2048, String mime = 'application/octet-stream'}) =>
    LocalAttachmentRef(kind: 'file', name: name, mime: mime, path: '/tmp/$name', size: size);

LocalAttachmentRef _image(String name) =>
    LocalAttachmentRef(kind: 'image', name: name, mime: 'image/png', path: '/tmp/$name.png', size: 1024);

Future<void> _pump(WidgetTester t, Widget child) async {
  t.view.physicalSize = const Size(800, 1600);
  t.view.devicePixelRatio = 1.0;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child))),
  );
  await t.pump();
}

void main() {
  testWidgets('一份文件: 显示名字和大小, 按类型选图标 (表格 / 文档 / 压缩包 / 代码)', (t) async {
    for (final (name, icon) in [
      ('预算.xlsx', Icons.table_chart_outlined),
      ('方案.docx', Icons.description_outlined),
      ('演示.pptx', Icons.slideshow_outlined),
      ('报价.pdf', Icons.picture_as_pdf_outlined),
      ('资料.zip', Icons.folder_zip_outlined),
      ('脚本.dart', Icons.code),
      ('说明.md', Icons.notes_outlined),
      ('其他.bin', Icons.insert_drive_file_outlined),
    ]) {
      await _pump(t, UserAttachments(items: [_file(name)]));
      expect(find.text(name), findsOneWidget);
      expect(find.byIcon(icon), findsOneWidget, reason: '$name 的图标');
    }
  });

  testWidgets('文件大小: 不足 1KB 用 B, 1KB~10KB 留 1 位, 再大取整, 1MB 以上用 MB', (t) async {
    await _pump(t, UserAttachments(items: [
      _file('a.txt', size: 512),
      _file('b.txt', size: 1536),
      _file('c.txt', size: 20 * 1024),
      _file('d.txt', size: 3 * 1024 * 1024),
    ]));
    expect(find.text('512 B'), findsOneWidget);
    expect(find.text('1.5 KB'), findsOneWidget);
    expect(find.text('20 KB'), findsOneWidget);
    expect(find.text('3.0 MB'), findsOneWidget);
  });

  testWidgets('图片排在文件上面; 一个附件都不会少', (t) async {
    await _pump(t, UserAttachments(items: [
      _file('说明.txt'),
      _image('a'),
      _image('b'),
    ]));
    expect(find.byType(Image), findsNWidgets(2));
    expect(find.text('说明.txt'), findsOneWidget);
    /* 图片区的顶不能低于文件 chip 的顶 */
    final imgY = t.getTopLeft(find.byType(Image).first).dy;
    final fileY = t.getTopLeft(find.text('说明.txt')).dy;
    expect(imgY, lessThan(fileY));
  });

  testWidgets('1 张图最大边长 240 —— 一张图不该缩成小方块', (t) async {
    await _pump(t, UserAttachments(items: [_image('only')]));
    final box = t.widget<ConstrainedBox>(
      find.ancestor(of: find.byType(Image).first, matching: find.byType(ConstrainedBox)).first,
    );
    expect(box.constraints.maxWidth, 240);
    expect(box.constraints.maxHeight, 240);
    expect(box.constraints.minWidth, 0, reason: '单图不拉成正方块, 按原比例');
  });

  testWidgets('≥2 张图用方格缩略图 (边长 118 / 3 张以上 78)', (t) async {
    await _pump(t, UserAttachments(items: [_image('a'), _image('b'), _image('c'), _image('d')]));
    final boxes = t
        .widgetList<ConstrainedBox>(
          find.ancestor(of: find.byType(Image), matching: find.byType(ConstrainedBox)),
        )
        .toList();
    expect(boxes.length, 4);
    for (final box in boxes) {
      expect(box.constraints.minWidth, box.constraints.maxWidth, reason: '方格必须有固定宽');
      expect(box.constraints.maxWidth, lessThanOrEqualTo(118));
    }

    await _pump(t, UserAttachments(items: [_image('a'), _image('b'), _image('c')]));
    final three = t
        .widgetList<ConstrainedBox>(
          find.ancestor(of: find.byType(Image), matching: find.byType(ConstrainedBox)),
        )
        .toList();
    expect(three.first.constraints.maxWidth, 78);
  });

  testWidgets('靠左排 (工具截图卡用) 时图片从左边开始', (t) async {
    await _pump(t, UserAttachments(items: [_image('shot')], alignStart: true));
    final wrap = t.widget<Wrap>(find.byType(Wrap));
    expect(wrap.alignment, WrapAlignment.start);
  });

  testWidgets('用户气泡: 只发附件没打字时不再画一行「📎 文件名」', (t) async {
    await _pump(t, const UserMessage(
      text: '📎 预算.xlsx',
      ts: 0,
      attachments: [
        LocalAttachmentRef(kind: 'file', name: '预算.xlsx', mime: 'text/plain', path: '/tmp/a.xlsx', size: 10),
      ],
    ));
    expect(find.text('📎 预算.xlsx'), findsNothing);
    expect(find.text('预算.xlsx'), findsOneWidget);
  });

  testWidgets('用户气泡: 附件 + 真文字时两样都画', (t) async {
    await _pump(t, const UserMessage(
      text: '看看这个预算',
      ts: 0,
      attachments: [
        LocalAttachmentRef(kind: 'file', name: '预算.xlsx', mime: 'text/plain', path: '/tmp/a.xlsx', size: 10),
      ],
    ));
    expect(find.text('看看这个预算'), findsOneWidget);
    expect(find.text('预算.xlsx'), findsOneWidget);
  });

  testWidgets('用户气泡: 没附件时不会多出空白区', (t) async {
    await _pump(t, const UserMessage(text: '普通一句话', ts: 0));
    expect(find.byType(UserAttachments), findsNothing);
    expect(find.text('普通一句话'), findsOneWidget);
  });
}
