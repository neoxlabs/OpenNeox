/// model_row_label_test.dart — 模型行/chip 上的"模型名 vs 服务商"拆分.
///
/// 2026-09-18 用户实录: 输入框 chip 上是「m5x:deep…」——服务商前缀把模型名挤没了;
/// 同时要求 BYOK 模型在模型面板里"同一行显示它的服务商名称"。
///
/// 名字有两种来源, 拆法必须都认:
///   · 手机网关拼的  `deepseek-v4.1 · 我的中转`
///   · 电脑列表给的  `m5x:deepseek-v4.1`  (providerId 前缀)
/// 拆错的后果是 chip 上看不出用的哪个模型 —— 而那正是发送前唯一要确认的事。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/home/widgets/stage_input.dart';

void main() {
  group('手机网关格式: 模型 · 服务商', () {
    test('模型名取前半, 服务商取后半', () {
      expect(modelRowName('m5x:ds', 'deepseek-v4.1 · 我的中转'), 'deepseek-v4.1');
      expect(modelRowProvider('m5x:ds', 'deepseek-v4.1 · 我的中转'), '我的中转');
    });
  });

  group('电脑列表格式: providerId:模型', () {
    test('冒号前是服务商, 冒号后是模型', () {
      expect(
        modelRowName('m5x:deepseek-v4.1', 'm5x:deepseek-v4.1'),
        'deepseek-v4.1',
      );
      expect(modelRowProvider('m5x:deepseek-v4.1', 'm5x:deepseek-v4.1'), 'm5x');
    });

    test('订阅模型的 neox-cloud 前缀同样不占模型名的位置', () {
      expect(
        modelRowName('neox-cloud:kimi-k3', 'neox-cloud:kimi-k3'),
        'kimi-k3',
      );
    });
  });

  group('拆不出来就不编', () {
    test('普通模型名原样返回, 服务商为 null', () {
      expect(modelRowName('kimi-k3', 'Kimi K3'), 'Kimi K3');
      expect(modelRowProvider('kimi-k3', 'Kimi K3'), isNull);
    });

    test('「智能」这种没有服务商的展示名不被误拆', () {
      expect(modelRowName('auto', '智能'), '智能');
      expect(modelRowProvider('auto', '智能'), isNull);
    });

    test('冒号在最前/最后这类脏数据不产出空字符串', () {
      expect(modelRowProvider(':x', ':x'), isNull);
      expect(modelRowName('x:', 'x:'), '');
      expect(modelRowProvider('x:', 'x:'), 'x');
    });
  });
}
