import { describe, expect, it } from 'vitest';
import { cloud, cloudEnabled, noopCloud, registerCloud } from './index.js';

describe('cloud capability contract', () => {
  it('uses the disabled implementation by default', async () => {
    expect(cloud()).toBe(noopCloud);
    expect(cloudEnabled()).toBe(false);
    expect(await cloud().auth.getSession()).toBeNull();
    expect(await cloud().membership.getStatus()).toBeNull();
    expect(await cloud().modelGateway.listModels()).toEqual([]);
    expect(await cloud().marketplace.listCatalog()).toEqual([]);
    expect(cloud().cloudSession.available()).toBe(false);
  });

  it('fails explicitly when a disabled operation needs cloud access', async () => {
    await expect(cloud().auth.login()).rejects.toThrow('not enabled');
  });

  it('ignores registrations in a public build', () => {
    registerCloud({ ...noopCloud, enabled: true });
    expect(cloud()).toBe(noopCloud);
    expect(cloudEnabled()).toBe(false);
  });
});
