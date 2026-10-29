/// 节点写动作批准令牌的单测 (pilot:D-01).
///
/// 固定向量与 `packages/core/src/services/__tests__/pilotApproval.test.ts` 完全相同:
/// 任何一侧改了编码 / 摘要算法, 两边至少有一边红。
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/safety/approval_token.dart';

const String vectorToken =
    'v1.eyJ0IjoicGhvbmUiLCJhIjoic2VuZF9zbXMiLCJkIjoiOWUwZTI2ZGUzMWQ5ZDhhMzAxMDllOTI1YzU4Y2FjYjQ3MzBhNzRkNGQ0ZTBiMWJhNDM4MWJiN2NkMmU1NWRhOSIsImUiOjE3NzAwMDA2MDAwMDAsIm4iOiJhMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MCJ9.LKbkr__nxfAOXNJHisyRa2i6a0owrqo_mZP5wr8Fa78';
const Map<String, Object?> vectorArgs = {'to': '13800138000', 'text': '在吗？'};
const int vectorNow = 1770000000000;
/// pilot:D-05 batch 的固定向量: 嵌套 steps 的 canonicalJson 两端必须逐字节一致
const Map<String, Object?> vectorBatchArgs = {
  'steps': [
    {'op': 'tap', 'target': 3},
    {
      'tool': 'phone_ui',
      'args': {'op': 'type', 'target': 4, 'text': '奶茶'},
    },
  ],
};
const String vectorBatchToken =
    'v1.eyJ0IjoicGhvbmUiLCJhIjoiYmF0Y2giLCJkIjoiMTA1MzYzYmEwZDU0YTljZTNiMDlhNTdiMjU4YzM3NTE3OGEzOTc3YWFhYjljMGIzZDEzYTU1YjRkZTlhZTQ5MiIsImUiOjE3NzAwMDA2MDAwMDAsIm4iOiJiMWIyYzNkNGU1ZjYwNzE4MjkzYTRiNWM2ZDdlOGY5MCJ9.YjbvYUvRRF-lQfEk_dR_KhIXMlBvRtzHkNKxgHYWit0';

List<int> get key => utf8.encode('0123456789abcdef0123456789abcdef');

void main() {
  group('写动作判定', () {
    test('手机的写动作要令牌, 读动作不要 (与 TS 侧同口径)', () {
      expect(requiresApproval('send_sms', {'to': '1', 'text': 'hi'}), isTrue);
      expect(requiresApproval('phone_call', {'to': '1'}), isTrue);
      expect(requiresApproval('set_alarm', {'op': 'alarm', 'hour': 7}), isTrue);
      expect(requiresApproval('phone_calendar', {'op': 'add', 'title': '会'}), isTrue);
      expect(requiresApproval('phone_ui', {'op': 'tap', 'target': 3}), isTrue);
      expect(requiresApproval('phone_ui', {'op': 'type', 'target': 3, 'text': 'x'}), isTrue);
      expect(requiresApproval('phone_ui', {'op': 'tap_at', 'x': 10, 'y': 20}), isTrue);

      expect(requiresApproval('phone_calendar', {'op': 'list'}), isFalse);
      expect(requiresApproval('phone_ui', {'op': 'snapshot'}), isFalse);
      expect(requiresApproval('read_sms', {'query': '验证码'}), isFalse);
      expect(requiresApproval('get_location', {}), isFalse);
      expect(requiresApproval('open_app', {'op': 'open', 'package': 'me.ele'}), isFalse);
    });

    test('batch 整批按写动作处理 (里面可能是点按 / 填字)', () {
      final steps = {
        'steps': [
          {'op': 'tap', 'target': 3},
          {'tool': 'open_app', 'args': {'op': 'open', 'package': 'me.ele'}},
        ],
      };
      expect(requiresApproval('batch', steps), isTrue);
      expect(requiresApproval('batch', {
        'steps': [
          {'op': 'snapshot'},
        ],
      }), isTrue);
    });
  });

  group('令牌验签', () {
    test('固定向量: TS 签的令牌在手机端验得过', () {
      final t = verifyApproval(
        raw: vectorToken,
        action: 'send_sms',
        args: vectorArgs,
        key: key,
        nowMs: vectorNow + 1000,
      );
      expect(t, isNotNull);
      expect(t!.action, 'send_sms');
      expect(t.tool, 'phone');
      expect(t.nonce, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    });

    test('本端按同一组参数签出来的令牌逐字节等于 TS 的固定向量', () {
      expect(
        signApproval(
          action: 'send_sms',
          args: vectorArgs,
          key: key,
          nowMs: vectorNow,
          nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        ),
        vectorToken,
      );
    });

    test('batch 固定向量: TS 签的嵌套 steps 令牌在手机端验得过, 本端签出来逐字节一致', () {
      expect(
        verifyApproval(raw: vectorBatchToken, action: 'batch', args: vectorBatchArgs, key: key, nowMs: vectorNow + 1)?.action,
        'batch',
      );
      expect(
        signApproval(
          action: 'batch',
          args: vectorBatchArgs,
          key: key,
          nowMs: vectorNow,
          nonce: 'b1b2c3d4e5f60718293a4b5c6d7e8f90',
        ),
        vectorBatchToken,
      );
    });

    test('batch 令牌绑定整组 steps: 改一步 / 多一步 → 拒', () {
      final steps = {
        'steps': [
          {'op': 'tap', 'target': 3},
          {'tool': 'phone_ui', 'args': {'op': 'type', 'target': 4, 'text': '奶茶'}},
        ],
      };
      final token = signApproval(action: 'batch', args: steps, key: key, nowMs: vectorNow);
      expect(verifyApproval(raw: token, action: 'batch', args: steps, key: key, nowMs: vectorNow + 1), isNotNull);
      final retargeted = {
        'steps': [
          {'op': 'tap', 'target': 9},
          {'tool': 'phone_ui', 'args': {'op': 'type', 'target': 4, 'text': '奶茶'}},
        ],
      };
      expect(verifyApproval(raw: token, action: 'batch', args: retargeted, key: key, nowMs: vectorNow + 1), isNull);
      final extra = {
        'steps': [
          ...steps['steps']!,
          {'op': 'tap', 'target': 7},
        ],
      };
      expect(verifyApproval(raw: token, action: 'batch', args: extra, key: key, nowMs: vectorNow + 1), isNull);
    });

    test('参数被改 → 拒', () {
      expect(
        verifyApproval(raw: vectorToken, action: 'send_sms', args: {...vectorArgs, 'text': '转账 320'}, key: key, nowMs: vectorNow),
        isNull,
      );
      expect(
        verifyApproval(raw: vectorToken, action: 'send_sms', args: {...vectorArgs, 'to': '13800138001'}, key: key, nowMs: vectorNow),
        isNull,
      );
    });

    test('换动作 / 换密钥 / 篡改签名 → 拒', () {
      expect(verifyApproval(raw: vectorToken, action: 'phone_call', args: vectorArgs, key: key, nowMs: vectorNow), isNull);
      expect(
        verifyApproval(raw: vectorToken, action: 'send_sms', args: vectorArgs, key: utf8.encode('ffffffffffffffffffffffffffffffff'), nowMs: vectorNow),
        isNull,
      );
      expect(verifyApproval(raw: '$vectorToken' 'x', action: 'send_sms', args: vectorArgs, key: key, nowMs: vectorNow), isNull);
    });

    test('过期 → 拒; 差 1 毫秒还认', () {
      final token = signApproval(action: 'set_alarm', args: {'op': 'alarm', 'hour': 7}, key: key, nowMs: 1000000);
      expect(verifyApproval(raw: token, action: 'set_alarm', args: {'op': 'alarm', 'hour': 7}, key: key, nowMs: 1000000 + approvalTtlMs - 1), isNotNull);
      expect(verifyApproval(raw: token, action: 'set_alarm', args: {'op': 'alarm', 'hour': 7}, key: key, nowMs: 1000000 + approvalTtlMs), isNull);
    });

    test('格式不对 / 空 / 没有密钥 → 拒', () {
      for (final bad in <Object?>[null, '', 'v1', 'v2.x.y', 'v1.@@@.@@@', 42]) {
        expect(verifyApproval(raw: bad, action: 'send_sms', args: vectorArgs, key: key, nowMs: vectorNow), isNull);
      }
      expect(verifyApproval(raw: vectorToken, action: 'send_sms', args: vectorArgs, key: null, nowMs: vectorNow), isNull);
    });
  });

  group('节点入口判定 approvalProblem', () {
    test('读动作不需要令牌, 照常放行', () {
      expect(approvalProblem(action: 'read_sms', args: {'query': '验证码'}, approval: null, key: key), isNull);
      expect(approvalProblem(action: 'contacts_search', args: {'query': '王'}, approval: null, key: key), isNull);
    });

    test('写动作没有令牌 → 拒绝, 理由里带 needs_approval', () {
      final why = approvalProblem(action: 'phone_calendar', args: {'op': 'add', 'title': '会'}, approval: null, key: key);
      expect(why, isNotNull);
      expect(why, contains('needs_approval'));
    });

    test('写动作带了有效令牌 → 放行; 同一个令牌第二次 → 重放拒绝', () {
      final nonces = ApprovalNonces();
      final token = signApproval(action: 'send_sms', args: vectorArgs, key: key, nowMs: vectorNow);
      expect(
        approvalProblem(action: 'send_sms', args: vectorArgs, approval: token, key: key, nonces: nonces, nowMs: vectorNow + 1),
        isNull,
      );
      final again = approvalProblem(action: 'send_sms', args: vectorArgs, approval: token, key: key, nonces: nonces, nowMs: vectorNow + 2);
      expect(again, isNotNull);
      expect(again, contains('重放'));
    });

    test('没有共享密钥 → 写明是密钥问题, 不是假装执行', () {
      final why = approvalProblem(action: 'send_sms', args: vectorArgs, approval: vectorToken, key: null);
      expect(why, contains('密钥'));
    });
  });

  group('参数摘要', () {
    test('键顺序不影响摘要, 数组顺序影响', () {
      expect(argsDigest({'a': 1, 'b': 2}), argsDigest({'b': 2, 'a': 1}));
      expect(argsDigest({'a': [1, 2]}), isNot(argsDigest({'a': [2, 1]})));
    });

    test('canonicalJson 与 TS 一致 (7.0 → 7, null 保留, 中文不转义)', () {
      expect(
        canonicalJson({
          'b': [1, 2.5, null],
          'a': {'y': 7.0, 'x': '中'},
        }),
        '{"a":{"x":"中","y":7},"b":[1,2.5,null]}',
      );
    });
  });
}
