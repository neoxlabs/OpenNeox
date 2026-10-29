import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProviderSeed {
  id?: string;
  name?: string;
  protocol?: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

export interface CliWorkspaceOptions {
  providers?: ProviderSeed[];
  /** 覆盖/追加写进 config.json 的字段 */
  config?: Record<string, unknown>;
  /** 覆盖/追加环境变量 */
  env?: Record<string, string>;
}

export interface CliWorkspace {
  root: string;
  homeDir: string;
  neoxHome: string;
  cwd: string;
  configPath: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

const BASE_ENV_KEYS = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR',
];

function buildEnv(ws: Pick<CliWorkspace, 'homeDir'>, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = ws.homeDir;
  env.NEOX_HOME_DIRNAME = '.neox';
  env.NEOX_DB_ENCRYPT = '0';
  env.NEOX_USE_DAEMON = '0';
  env.NEOX_DISABLE_AUTO_UPDATE_CHECK = '1';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.TERM = 'xterm-256color';
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  return { ...env, ...(extra || {}) };
}

function providerEntry(seed: ProviderSeed): Record<string, unknown> {
  const now = new Date().toISOString();
  const model = seed.model || 'mock-model';
  return {
    id: seed.id || 'mock-byok',
    name: seed.name || 'Mock BYOK',
    protocol: seed.protocol || 'openai',
    apiKey: seed.apiKey || `sk-mock-${'x'.repeat(30)}`,
    baseUrl: seed.baseUrl,
    models: [{ name: model, createdAt: now }],
    defaultModel: model,
    lastSelectedModel: model,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建隔离的 HOME / config / 工作目录. 用例结束必须 cleanup(). */
export async function createCliWorkspace(opts: CliWorkspaceOptions = {}): Promise<CliWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'neox-cli-e2e-'));
  const homeDir = join(root, 'home');
  const neoxHome = join(homeDir, '.neox');
  const cwd = join(root, 'workspace');
  await mkdir(neoxHome, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const providers: Record<string, unknown> = {};
  for (const seed of opts.providers || []) providers[seed.id || 'mock-byok'] = providerEntry(seed);

  const config: Record<string, unknown> = {
    version: 1,
    _migrationVersion: 1,
    language: 'en',
    hasSeenOnboarding: true,
    defaultAgentMode: 'code',
    approvalMode: 'auto',
    agentApprovalMode: 'auto',
    ...(Object.keys(providers).length > 0
      ? { providers, defaultProviderId: Object.keys(providers)[0] }
      : {}),
    ...(opts.config || {}),
  };
  const configPath = join(neoxHome, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const env = buildEnv({ homeDir }, opts.env);

  return {
    root,
    homeDir,
    neoxHome,
    cwd,
    configPath,
    env,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function writeConfig(ws: CliWorkspace, patch: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(ws.configPath, 'utf8')));
  await writeFile(ws.configPath, JSON.stringify({ ...current, ...patch }, null, 2));
}
