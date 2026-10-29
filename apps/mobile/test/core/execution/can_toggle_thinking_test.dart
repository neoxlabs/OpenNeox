import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/execution/inference_params_provider.dart';

void main() {
  test('能关思考的: DeepSeek 系 (含按量 / BYOK 前缀) 和 neox-free', () {
    for (final id in [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'neox-free',
      'neox-cloud-payg:deepseek-v4-pro',
      'my-relay:deepseek-chat',
    ]) {
      expect(canToggleThinking(id), isTrue, reason: id);
    }
  });

  test('关不掉的不给开关: GLM / GPT', () {
    for (final id in ['glm-5.3', 'glm-5.3-flash', 'gpt-5.6-sol', 'gpt-6.1-sol', '']) {
      expect(canToggleThinking(id), isFalse, reason: id);
    }
  });
}
