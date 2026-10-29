import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, findUser, roleCount } from '../src/index.ts';
import type { User } from '../src/types.ts';

const users: User[] = [
  { id: 1, name: 'alice', roles: ['admin'] },
  { id: 2, roles: ['user', 'editor'] },
];

test('有名字时用名字大写', () => {
  assert.equal(displayName(users[0]), 'ALICE');
});

test('没有名字时回退到用户 id', () => {
  assert.equal(displayName(users[1]), '用户2');
});

test('按 id 查找', () => {
  assert.equal(findUser(users, 2)?.id, 2);
  assert.equal(findUser(users, 99), undefined);
});

test('角色数量', () => {
  assert.equal(roleCount(users[1]), 2);
});
