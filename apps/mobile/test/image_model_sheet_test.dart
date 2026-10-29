/// image_model_sheet_test.dart — 图片工作台的「图像模型」必须是图像模型.
///
/// 2026-09-18 用户: 「图片工作台没有显示模型列表 显示的还是文字的」。
///
/// 那一行原来打开的是聊天模型列表, 选中之后写 selectedModelProvider ——
/// 而出图那条路 (image_studio_providers) 压根不读它, 自己 pickImageModel()
/// 自动挑。所以点了等于没点, 但界面上它看起来能选。
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/image/image_model_pick.dart';

/// 读源码但**剥掉注释** —— 修这处时旧写法被抄进注释里解释"为什么不能这么写",
/// 不剥的话闸会被自己的解释打中 (同 test/history_load_test.dart)。
String readCode(String path) {
  final out = <String>[];
  var inBlock = false;
  for (final line in File(path).readAsLinesSync()) {
    final t = line.trimLeft();
    if (inBlock) {
      if (t.contains('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!line.contains('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.add(line);
  }
  return out.join('\n');
}

void main() {
  group('列表判据跟发请求时用的是同一个', () {
    test('文字模型一个都不算图像模型', () {
      for (final id in const [
        'deepseek-v4-flash',
        'claude-opus-5',
        'gpt-5',
        'qwen-max',
        'kimi-k2',
      ]) {
        expect(
          looksLikeImageModel(id),
          isFalse,
          reason: '$id 被列进图像模型的话, 选了发过去必被服务端拒',
        );
      }
    });

    test('出图模型认得出来 (名字里没 image 的那些也要)', () {
      for (final id in const [
        'gpt-image-2',
        'gpt-image-2-pro',
        'nano-banana-2',
        'flux-1.1-pro',
        'seedream-4',
        'imagen-4',
        'dall-e-3',
      ]) {
        expect(looksLikeImageModel(id), isTrue, reason: '$id 该出现在图片页的列表里');
      }
    });

    test('用户选过的优先, 没选过按版本挑最新', () {
      const list = ['gpt-image-1', 'gpt-image-2', 'nano-banana-2', 'gpt-5'];
      /* 版本号同为 2 时按名字定序 (不是"哪个更好"—— 我们没有那个判据) */
      expect(pickImageModel(list), 'gpt-image-2');
      expect(pickImageModel(list, preferred: 'gpt-image-1'), 'gpt-image-1');
      /* 选过的模型下架了就别硬用它 —— 回到自动挑 */
      expect(pickImageModel(list, preferred: 'gpt-image-9'), 'gpt-image-2');
      /* 版本号更大的压过同族老版本 */
      expect(
        pickImageModel(const ['gpt-image-1', 'gpt-image-3']),
        'gpt-image-3',
      );
      /* 一个出图模型都没有时给 null, 由服务端说权威的话 */
      expect(pickImageModel(const ['gpt-5']), isNull);
    });
  });

  group('接线', () {
    test('出图走 imageModelPref, 不走聊天模型', () {
      final src = readCode('lib/features/image/state/image_studio_providers.dart');
      expect(src.contains('preferred: _ref.read(imageModelPrefProvider)'), isTrue);
      /* 聊天模型混进出图请求正是 2026-08-11 那个 bug */
      expect(src.contains('selectedModelProvider'), isFalse);
    });

    test('图片页那一行开 imageOnly, 并且写的是图像模型偏好', () {
      final src = readCode('lib/features/home/widgets/stage_input.dart');
      expect(src.contains('openModelSheet(context, ref, imageOnly: true)'), isTrue);
      expect(src.contains('imageModelPrefProvider.notifier).set(picked)'), isTrue);
      /* sheet 里必须真的过滤, 否则 imageOnly 只是个名字 */
      expect(src.contains('entries.where((m) => !m.payg && looksLikeImageModel(m.id))'), isTrue);
    });
  });
}
