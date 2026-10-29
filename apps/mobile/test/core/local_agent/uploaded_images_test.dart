/// uploaded_images_test.dart — chat:C4-09 用户发的图一律落进工作区.
///
/// 要修的病: 对话模式 (`chat_mode: true`) 发的图以前不落盘, 于是「改成水彩」
/// 时模型找不到图, 只能让用户报路径。现在两种模式都存。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/uploaded_images.dart';

void main() {
  test('每张图都存, 返回文件名 + 相对路径', () async {
    final calls = <String>[];
    final out = await persistUploadedImages(
      [
        (name: 'cat.png', bytes: [1, 2, 3]),
        (name: 'dog.jpg', bytes: [4, 5]),
      ],
      save: (name, bytes) async {
        calls.add('$name:${bytes.length}');
        return 'uploads/$name';
      },
    );

    expect(calls, ['cat.png:3', 'dog.jpg:2']);
    expect(out, [
      (name: 'cat.png', path: 'uploads/cat.png'),
      (name: 'dog.jpg', path: 'uploads/dog.jpg'),
    ]);
  });

  test('没文件名的图也给个不会被覆盖的名字', () async {
    final now = DateTime.fromMillisecondsSinceEpoch(1700000000000);
    final names = <String>[];
    final out = await persistUploadedImages(
      [
        (name: '', bytes: [1]),
        (name: '  ', bytes: [2]),
      ],
      save: (name, _) async {
        names.add(name);
        return 'uploads/$name';
      },
      now: now,
    );

    expect(names, ['photo-1700000000000.jpg', 'photo-1700000000000-1.jpg']);
    expect(out, hasLength(2));
  });

  test('某一张存不下: 跳过那张, 别的照存, 不整轮失败', () async {
    final out = await persistUploadedImages(
      [
        (name: 'ok.png', bytes: [1]),
        (name: 'broken.png', bytes: [2]),
      ],
      save: (name, _) async => name == 'broken.png' ? null : 'uploads/$name',
    );

    expect(out, [(name: 'ok.png', path: 'uploads/ok.png')]);
  });

  test('一张图都没有: 空结果, 不调 save', () async {
    var called = false;
    final out = await persistUploadedImages(
      const [],
      save: (_, __) async {
        called = true;
        return 'x';
      },
    );

    expect(out, isEmpty);
    expect(called, isFalse);
  });
}
