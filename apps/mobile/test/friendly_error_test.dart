/// 友好错误文案: 只有「会话找不到」才能说成「任务已不可用」。
/// 2026-09-30 真机: 连着电脑、会话好好的, 发一张图报「任务已不可用，请新建」——
/// 原来任何带 not found / 404 的错误都会落到这句。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/errors/friendly_error.dart';
import 'package:neox_app/core/network/json_rpc.dart';

void main() {
  test('会话真找不到 → 任务已不可用', () {
    expect(friendlyError(StateError('session not found')), '任务已不可用，请新建');
    expect(friendlyError(StateError('session session-123 not found')), '任务已不可用，请新建');
  });

  test('附件 / 方法 / 其它 not found 不再说成任务没了', () {
    expect(
      friendlyError(const RpcError(code: -32602, message: '截图.png: upload not found or not finished (up-1)')),
      '附件没传上去，请重发',
    );
    expect(
      friendlyError(const RpcError(code: -32601, message: 'Method not found: attachment.begin')),
      '当前操作暂时不支持，请更新后重试',
    );
    expect(friendlyError(StateError('file not found'), fallback: 'x'), 'x');
  });

  test('失败卡小字带原话', () {
    expect(errorDetail(StateError('upload not found or not finished (up-1)')), 'upload not found or not finished (up-1)');
  });
}
