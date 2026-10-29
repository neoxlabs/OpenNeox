/// image_model_pick_test.dart — 图片模型挑选.
///
/// 这个功能存在的理由是一个连环错 (2026-08-11 模拟器实测):
/// 生图先是用了聊天模型 (deepseek-v4-flash), 去掉之后又回落到硬编码的
/// `gpt-image-1` —— 而网关早换代成 gpt-image-2 了, 两次都是「该模型已停用」。
///
/// 所以这里锁的核心是: **不能把聊天模型当图片模型**, 以及**换代要能自动跟上**。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/image/image_model_pick.dart';

/// 2026-08-11 从模拟器上抄的真实网关列表 (节选, 含实际在列的图片模型)
const _real = [
  'claude-haiku-4-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'deepseek-reasoner',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'or-free-auto',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro',
  'gemini-3.6-flash',
  'nano-banana-2',
  'glm-5.1',
  'glm-5.2',
  'gpt-image-2',
  'gpt-image-2-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-oss-20b',
];

void main() {
  group('识别出图模型', () {
    test('名字里带 image 的算', () {
      expect(looksLikeImageModel('gpt-image-2'), isTrue);
      expect(looksLikeImageModel('gpt-image-2-pro'), isTrue);
    });

    test('出图家族的专有名字也算 (名字里没有 image)', () {
      expect(looksLikeImageModel('nano-banana-2'), isTrue);
      expect(looksLikeImageModel('flux-1.1-pro'), isTrue);
      expect(looksLikeImageModel('dall-e-3'), isTrue);
      expect(looksLikeImageModel('seedream-4'), isTrue);
    });

    test('聊天模型一律不算 — 这是整个 bug 的根源', () {
      for (final m in [
        'deepseek-v4-flash',
        'claude-opus-5',
        'gpt-5.4',
        'gpt-oss-20b',
        'glm-5.2',
        'gemini-3.6-flash',
        'or-free-auto',
      ]) {
        expect(looksLikeImageModel(m), isFalse, reason: '$m 被误判成图片模型了');
      }
    });
  });

  group('从真实列表里挑', () {
    test('挑到 gpt-image-2-pro (同族版本号最大 + 加强版)', () {
      expect(pickImageModel(_real), 'gpt-image-2-pro');
    });

    test('换代自动跟上 —— 这就是不写死型号的意义', () {
      /* 服务端把 image-2 换成 image-3 的那天, 客户端不用改一行代码 */
      final next = [..._real.where((m) => !m.startsWith('gpt-image')), 'gpt-image-3'];
      expect(pickImageModel(next), 'gpt-image-3');
    });

    test('用户显式选过的优先, 不替他改主意', () {
      expect(pickImageModel(_real, preferred: 'nano-banana-2'), 'nano-banana-2');
    });

    test('显式偏好已经下架 → 回落到自动挑, 不是直接失败', () {
      expect(pickImageModel(_real, preferred: 'gpt-image-1'), 'gpt-image-2-pro');
    });

    test('一个图片模型都没有 → null, 让服务端给权威错误', () {
      /* 宁可 null 也不要随便塞一个聊天模型上去 —— 那会得到一句
       * 让人摸不着头脑的「该模型已停用」而不是"这里没有图片模型"。 */
      expect(pickImageModel(const ['claude-opus-5', 'gpt-5.4']), isNull);
      expect(pickImageModel(const []), isNull);
    });
  });
}
