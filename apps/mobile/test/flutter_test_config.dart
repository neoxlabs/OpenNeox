import 'dart:async';

import 'package:neox_app/core/i18n/tr.dart';

/* 全局测试配置 (flutter test 自动加载同目录及子目录的这个文件)。
 * 测试环境默认 en-US, 会让 tr() 返回英文; 现有用例断言的都是中文文案, 这里固定成中文。 */
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugUiLanguageOverride = 'zh';
  await testMain();
}
