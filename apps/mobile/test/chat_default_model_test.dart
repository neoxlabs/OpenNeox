/// chat_default_model_test.dart — Chat 默认模型走低延迟档 (chat:C8-01).
///
/// 「Fast」不是一个思考档位, 而是选哪个模型本身: 默认要落在 Flash / Mini 这类
/// 低延迟档上, 而不是价格最低但可能很慢的那个。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart';
import 'package:neox_app/features/home/state/selected_model_provider.dart';

GatewayModel _m(String id, {double? cost, bool payg = false, String? name}) =>
    GatewayModel(
      id: id,
      name: name ?? id,
      relativeCost: cost,
      payAsYouGo: payg,
    );

void main() {
  test('首选 DeepSeek Flash (按顺序)', () {
    final models = [
      _m('deepseek-v4-pro', cost: 3),
      _m('deepseek-v4.1-flash', cost: 0.5),
    ];
    expect(defaultModelId(models), 'deepseek-v4.1-flash');
  });

  test('没有 DeepSeek 时先看低延迟档, 不直接挑最便宜', () {
    final models = [
      _m('gpt-6-pro', cost: 0.01), /* 便宜但慢 */
      _m('gpt-6-luna-mini', cost: 0.2),
      _m('gpt-6-luna', cost: 0.1),
    ];
    expect(isLowLatencyModelId('gpt-6-luna-mini'), isTrue);
    expect(isLowLatencyModelId('gpt-6-pro'), isFalse);
    expect(defaultModelId(models), 'gpt-6-luna-mini');
  });

  test('一个低延迟档都没有才按最省挑', () {
    final models = [
      _m('claude-opus-4-8', cost: 5),
      _m('claude-sonnet-5', cost: 1),
    ];
    expect(defaultModelId(models), 'claude-sonnet-5');
  });

  test('按量模型不参与默认挑选 (扣的是余额)', () {
    final models = [
      _m('neox-cloud-payg:deepseek-v4.1-flash', cost: 0.01, payg: true),
      _m('gpt-5-mini', cost: 0.3),
    ];
    expect(defaultModelId(models), 'gpt-5-mini');
  });

  test('低延迟档识别: 带 flash / mini / lite / haiku / nano 的型号', () {
    for (final id in [
      'deepseek-v4.1-flash',
      'gpt-5-mini',
      'gemini-3-flash',
      'claude-haiku-4-5',
      'qwen3-nano',
      'doubao-lite-1-6',
    ]) {
      expect(isLowLatencyModelId(id), isTrue, reason: id);
    }
    for (final id in ['deepseek-v4-pro', 'claude-opus-5', 'gpt-5.6-sol']) {
      expect(isLowLatencyModelId(id), isFalse, reason: id);
    }
  });
}
