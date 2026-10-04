export interface CloudSession {
  readonly id: string;
  readonly userId?: string;
}

export interface MembershipStatus {
  readonly plan?: string;
  readonly active: boolean;
}

export interface RemoteModel {
  readonly id: string;
  readonly displayName?: string;
}

export interface ProviderConfig {
  readonly id: string;
  readonly protocol: string;
  readonly baseUrl?: string;
}

export interface CatalogItem {
  readonly id: string;
  readonly name: string;
}

export interface CloudCapabilities {
  readonly enabled: boolean;
  readonly auth: {
    getSession(): Promise<CloudSession | null>;
    login(): Promise<CloudSession>;
    logout(): Promise<void>;
  };
  readonly membership: {
    getStatus(): Promise<MembershipStatus | null>;
  };
  readonly modelGateway: {
    listModels(): Promise<RemoteModel[]>;
    getProviderConfig(): Promise<ProviderConfig | null>;
  };
  readonly marketplace: {
    listCatalog(): Promise<CatalogItem[]>;
    resolveDownload(id: string): Promise<string | null>;
  };
  readonly cloudSession: {
    available(): boolean;
  };
}

declare global {
  var __NEOX_CLOUD__: boolean | undefined;
}

/**
 * Disabled capability implementation used by public builds.
 *
 * Read operations return empty local-safe values. Operations that would
 * require an authenticated hosted service fail explicitly so callers cannot
 * accidentally treat the disabled contract as a working service.
 */
const unavailable = (): never => {
  throw new Error('Cloud capabilities are not enabled in this build.');
};

export const noopCloud: CloudCapabilities = {
  enabled: false,
  auth: {
    getSession: async () => null,
    login: async () => unavailable(),
    logout: async () => undefined,
  },
  membership: { getStatus: async () => null },
  modelGateway: {
    listModels: async () => [],
    getProviderConfig: async () => null,
  },
  marketplace: {
    listCatalog: async () => [],
    resolveDownload: async () => null,
  },
  cloudSession: { available: () => false },
};

let implementation: CloudCapabilities = noopCloud;

/** Build-time switch injected by the desktop bundler; Node hosts default off. */
const buildCloudEnabled = globalThis.__NEOX_CLOUD__ === true;

/**
 * Register an optional hosted implementation supplied by a private build.
 * Public builds ignore registrations and keep the disabled implementation.
 */
export function registerCloud(next: CloudCapabilities): void {
  if (!buildCloudEnabled) {
    implementation = noopCloud;
    return;
  }
  implementation = next;
}

/** Return the active cloud capability implementation. */
export function cloud(): CloudCapabilities {
  return implementation;
}

export const cloudEnabled = (): boolean => implementation.enabled;
