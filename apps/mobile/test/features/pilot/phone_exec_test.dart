/// phone_exec 节点入口的接线测试 (pilot:D-01): 写动作没令牌必须在碰设备之前被拒。
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/pilot/safety/approval_token.dart';
import 'package:neox_app/features/pilot/phone_exec.dart';

const List<int> _key = <int>[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

void main() {
  test('写动作没带令牌 → 回 ok:false + needs_approval, 不执行工具', () async {
    final calls = <Map<String, Object?>>[];
    await handlePhoneExec(
      <String, dynamic>{
        'req_id': 'r1',
        'tool': 'send_sms',
        'args': <String, Object?>{'to': '10086', 'text': '在吗'},
      },
      (method, params) async {
        calls.add(<String, Object?>{'method': method, ...params});
        return null;
      },
      key: _key,
    );
    expect(calls, hasLength(1));
    expect(calls.single['method'], 'phone.exec_result');
    expect(calls.single['req_id'], 'r1');
    expect(calls.single['ok'], false);
    expect(calls.single['output'] as String, contains('needs_approval'));
  });

  test('写动作带有效令牌 → 放过批准关 (走到工具层; 测试机不是安卓, 如实说没这个能力)', () async {
    final calls = <Map<String, Object?>>[];
    final args = <String, Object?>{'op': 'add', 'title': '体检'};
    await handlePhoneExec(
      <String, dynamic>{
        'req_id': 'r2',
        'tool': 'phone_calendar',
        'args': args,
        'approval': signApproval(action: 'phone_calendar', args: args, key: _key),
      },
      (method, params) async {
        calls.add(<String, Object?>{'method': method, ...params});
        return null;
      },
      key: _key,
    );
    expect(calls, hasLength(1));
    expect(jsonEncode(calls.single['output']), isNot(contains('needs_approval')));
  });

  test('batch 没有令牌 → 拒 (整批里可能含点按 / 填字)', () async {
    final calls = <Map<String, Object?>>[];
    await handlePhoneExec(
      <String, dynamic>{
        'req_id': 'r4',
        'tool': 'batch',
        'args': <String, Object?>{
          'steps': [
            {'op': 'tap', 'target': 3},
          ],
        },
      },
      (method, params) async {
        calls.add(<String, Object?>{'method': method, ...params});
        return null;
      },
      key: _key,
    );
    expect(calls, hasLength(1));
    expect(calls.single['ok'], false);
    expect(calls.single['output'] as String, contains('needs_approval'));
  });

  test('batch 带有效令牌 → 放过批准关 (测试机不是安卓, 如实说没这个能力)', () async {
    final calls = <Map<String, Object?>>[];
    final args = <String, Object?>{
      'steps': [
        {'op': 'tap', 'target': 3},
      ],
    };
    await handlePhoneExec(
      <String, dynamic>{
        'req_id': 'r5',
        'tool': 'batch',
        'args': args,
        'approval': signApproval(action: 'batch', args: args, key: _key),
      },
      (method, params) async {
        calls.add(<String, Object?>{'method': method, ...params});
        return null;
      },
      key: _key,
    );
    expect(calls, hasLength(1));
    expect(jsonEncode(calls.single['output']), isNot(contains('needs_approval')));
  });

  test('读动作不需要令牌, 照常走到工具层', () async {
    final calls = <Map<String, Object?>>[];
    await handlePhoneExec(
      <String, dynamic>{
        'req_id': 'r3',
        'tool': 'read_sms',
        'args': <String, Object?>{'query': '验证码'},
      },
      (method, params) async {
        calls.add(<String, Object?>{'method': method, ...params});
        return null;
      },
      key: _key,
    );
    expect(calls, hasLength(1));
    expect(jsonEncode(calls.single['output']), isNot(contains('needs_approval')));
  });
}
