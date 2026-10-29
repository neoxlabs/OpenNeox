import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PairedMobile } from '../types.js';

const appState = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({
    getAppState: (key: string) => appState.get(key),
    setAppState: (key: string, value: unknown) => { appState.set(key, value); },
    deleteAppState: (key: string) => { appState.delete(key); },
  }),
}));

import {
  _resetDeviceStore,
  addPairedMobile,
  getPairedMobileByToken,
  listPairedMobiles,
  removePairedMobile,
  setPairedMobileName,
} from '../deviceStore.js';

function pairedMobile(input: Partial<Omit<PairedMobile, 'id'>> = {}): Omit<PairedMobile, 'id'> {
  const suffix = input.device_id ?? 'phone-a';
  return {
    device_id: suffix,
    device_name: `Phone ${suffix}`,
    phone_pubkey_b64: Buffer.alloc(32, 1).toString('base64'),
    relay_session_key_b64: Buffer.alloc(32, 2).toString('base64'),
    device_token: `token-${suffix}`,
    paired_at: 1000,
    last_seen_at: null,
    owner_user_id: 'user-a',
    ...input,
  };
}

describe('mobile bridge deviceStore owner isolation', () => {
  beforeEach(() => {
    appState.clear();
    _resetDeviceStore();
  });

  it('scopes token lookup and mutable operations to the current user', () => {
    addPairedMobile(pairedMobile({ device_id: 'phone-a', owner_user_id: 'user-a' }));
    addPairedMobile(pairedMobile({ device_id: 'phone-b', owner_user_id: 'user-b' }));

    expect(getPairedMobileByToken('token-phone-a', { currentUserId: 'user-a' })?.device_id).toBe('phone-a');
    expect(getPairedMobileByToken('token-phone-a', { currentUserId: 'user-b' })).toBeNull();

    expect(removePairedMobile('phone-a', { currentUserId: 'user-b' })).toBe(false);
    expect(setPairedMobileName('phone-a', 'Renamed by B', { currentUserId: 'user-b' })).toBe(false);
    expect(listPairedMobiles({ currentUserId: 'user-a' }).map((m) => m.device_id)).toEqual(['phone-a']);

    expect(setPairedMobileName('phone-a', 'Renamed by A', { currentUserId: 'user-a' })).toBe(true);
    expect(getPairedMobileByToken('token-phone-a', { currentUserId: 'user-a' })?.device_name).toBe('Renamed by A');

    expect(removePairedMobile('phone-a', { currentUserId: 'user-a' })).toBe(true);
    expect(listPairedMobiles({ currentUserId: 'user-a' }).map((m) => m.device_id)).toEqual([]);
    expect(listPairedMobiles({ currentUserId: 'user-b' }).map((m) => m.device_id)).toEqual(['phone-b']);
  });

  it('does not expose legacy account sentinel tokens as LAN auth secrets', () => {
    addPairedMobile(pairedMobile({
      device_id: 'phone-cloud',
      device_token: 'account:phone-cloud',
      owner_user_id: 'user-a',
    }));

    expect(getPairedMobileByToken('account:phone-cloud', { currentUserId: 'user-a' })).toBeNull();
  });
});
