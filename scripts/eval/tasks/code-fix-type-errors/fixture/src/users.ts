import type { User } from './types.ts';

export function displayName(user: User): string {
  return user.name.toUpperCase();
}

export function findUser(users, id) {
  return users.find((u) => u.id === id);
}

export function roleCount(user: User): number {
  return user.roles;
}
