export interface MarketplaceCredentialStore {
  get(sourceId: string): Promise<string | undefined>;
  set(sourceId: string, token: string): Promise<void>;
  delete(sourceId: string): Promise<void>;
}

const SERVICE = 'openneox-marketplace-github';

export function createKeytarMarketplaceCredentialStore(): MarketplaceCredentialStore {
  return {
    async get(sourceId) {
      const keytar = await import('keytar');
      return (await keytar.getPassword(SERVICE, sourceId)) ?? undefined;
    },
    async set(sourceId, token) {
      const keytar = await import('keytar');
      await keytar.setPassword(SERVICE, sourceId, token);
    },
    async delete(sourceId) {
      const keytar = await import('keytar');
      await keytar.deletePassword(SERVICE, sourceId);
    },
  };
}

export const unavailableMarketplaceCredentialStore: MarketplaceCredentialStore = {
  async get() { return undefined; },
  async set() { throw new Error('Secure credential storage is unavailable'); },
  async delete() { return undefined; },
};
