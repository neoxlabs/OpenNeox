/// drawer_session_tree_test.dart — 抽屉里 sub-agent 子会话的嵌套摊平.
///
/// 桌面把每个 sub-agent 落成一条 parent_session_id=父 的真实子会话, session.list
/// 会把它们一起带下来。抽屉不能把它们当顶层会话平铺 —— 一轮派 5 个 agent 就把
/// "最近"刷屏了。这里锁死: 子会话只出现在父下面、缩进一级、顺序稳定。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/storage/database.dart';
import 'package:neox_app/shared/widgets/neox_drawer.dart';

SessionMirrorData s(
  String id, {
  String? parent,
  int at = 0,
}) =>
    SessionMirrorData(
      id: id,
      desktopDeviceId: 'dev',
      title: id,
      lastMessageAt: at,
      createdAt: at,
      isSensitive: false,
      kind: 'chat',
      parentSessionId: parent,
    );

void main() {
  test('子会话嵌在父下面, 不占顶层位置', () {
    final rows = flattenSessionTree([
      s('p1', at: 100),
      s('c1', parent: 'p1', at: 110),
      s('c2', parent: 'p1', at: 120),
      s('p2', at: 200),
    ]);
    expect(
      rows.map((r) => '${r.s.id}@${r.depth}'),
      ['p2@0', 'p1@0', 'c1@1', 'c2@1'],
      reason: '顶层按活跃倒序; 子会话按派出顺序正序跟在父后面',
    );
  });

  test('孤儿子会话 (父不在本地镜像) 仍按顶层显示, 不能凭空消失', () {
    final rows = flattenSessionTree([
      s('orphan', parent: 'gone', at: 50),
      s('p1', at: 100),
    ]);
    expect(rows.map((r) => '${r.s.id}@${r.depth}'), ['p1@0', 'orphan@0']);
  });

  test('没有子会话时行为跟以前一致 (纯活跃倒序)', () {
    final rows = flattenSessionTree([
      s('a', at: 1),
      s('b', at: 3),
      s('c', at: 2),
    ]);
    expect(rows.map((r) => r.s.id), ['b', 'c', 'a']);
    expect(rows.every((r) => r.depth == 0), isTrue);
  });

  test('子会话不会被当成另一个父的子节点 (只认自己的 parent)', () {
    final rows = flattenSessionTree([
      s('p1', at: 100),
      s('p2', at: 200),
      s('c-of-p1', parent: 'p1', at: 150),
    ]);
    expect(rows.map((r) => r.s.id), ['p2', 'p1', 'c-of-p1']);
    expect(rows.last.depth, 1);
  });
}
