
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ModelCommandContext } from '../commands/model.js';

/** 顶层子命令: `neox <name> ...` —— 跑完即退, 不进 REPL。 */
export interface CliSubcommand {
  readonly names: readonly string[];
  run(args: string[]): Promise<number>;
  /** `neox --help` 子命令段的一行 (已排版好的整行, 不含换行) */
  readonly helpLine?: string;
  readonly helpBefore?: string;
}

/** REPL 内 slash 命令的宿主依赖 —— main.ts 提供。 */
export interface CliSlashCommandDeps {
  /** 登录/登出后刷新 banner 账号行 */
  refreshAccountStatus?: () => void;
  /** REPL 模式下把命令的 console 输出送进 Ink 的命令输出区 (不传 = 直写 stdout) */
  printOutput?: (lines: string[]) => void;
}

export interface CliSlashCommand {
  /** 含前导斜杠, 如 '/login' */
  readonly names: readonly string[];
  run(args: string[], deps: CliSlashCommandDeps): Promise<void>;
}

/** `/` 菜单里的一项。description 在调用时取 (随语言切换)。 */
export interface CliSlashMenuItem {
  readonly name: string;
  description(): string;
  readonly hasSubMenu?: boolean;
  visible?(): boolean;
}

export type CliAccountTone = 'cyan' | 'green' | 'gray';

/** refreshAccount 操作 CLI 状态用的窄接口 —— main.ts 的 NeoxCLI 实现它。 */
export interface CliAccountHost {
  /** 重读磁盘上的 provider 配置 (登录/登出后 sentinel 会增删) */
  reloadProviderState(): void;
  getProviderStore(): ProviderStore;
  getProviderId(): string;
  getProviderDisplayName(): string;
  /** 切到 entry + model, 刷新运行态并推给 UI (调用方负责 setDefaultProvider 等落盘) */
  switchProvider(entry: ProviderConfigEntry, model: string): void;
  /** 清空当前 model (没有可切的 provider 时) */
  clearModel(): void;
  addInfo(text: string, details?: string, level?: 'info' | 'warning' | 'success'): void;
  setAccount(text: string, tone: CliAccountTone): void;
  /** 重吐一份静态 header (账号行变了之后) */
  refreshHeader(): void;
  rebuildCompatProfile(): void;
}

/** 云端模型来源 (neox model ls 的 NeoxCloud 段) */
export interface CliCloudModelEntry {
  id: string;
  providerName: string;
  plan?: string | null;
  capability?: string;
}

/** 账号 / 订阅能力。公开版为 null。 */
export interface CliAccount {
  isLoggedIn(): boolean;
  /** 本地登录凭据里的用户 id —— 尽早喂给 setCurrentUserId; 没登录 = null */
  currentUserId(): string | null;

  /** 进程最早期 (main.ts 模块体开头): 设备指纹注入 signer + 一次性配置迁移。不得抛。 */
  onProcessStart(): void;
  /** 设备指纹 —— 传给 runtime adapter (worker 线程拿不到主进程 globalThis) */
  deviceFp(): string;
  /** 任何 adapter.connect() 之前: routing 惰性激活 + 网关 key 续期。不得抛。 */
  prepareRouting(): Promise<void>;
  /** 交互模式长开: 低频续期 tick (定时器 unref) */
  startRoutingWatch(): void;

  /** 启动期 provider 检查的账号那段 (会员预热 / 过期处理 / 桌面 SSO)。'ready' = 调用方直接 return。 */
  checkProviderReady(store: ProviderStore): Promise<'ready' | 'continue'>;
  /** 首启引导里选了"登录" —— 跑完登录并接管进程 (内部 exit)。 */
  runOnboardingLogin(): Promise<void>;

  /** 托管 provider (neox-cloud) 的初始 model */
  resolveManagedInitialModel(provider: ProviderConfigEntry): string | undefined;
  /** 托管 provider 启动期校验: 当前 model 已不在套餐里就打 warn (不阻塞) */
  warnIfManagedModelNotAllowed(model: string): void;
  /** 服务端给的模型上限 (上下文窗口 / 最大输出); 没有 = undefined */
  serverModelLimits(modelId: string): { contextWindow?: number; maxOutputTokens?: number } | undefined;

  /** 启动 banner 的账号行 */
  bannerAccount(hasDefaultProvider: boolean): { text: string; tone: CliAccountTone };
  /** 开屏公告: 同步读缓存 (没有 = null), 并在后台刷新缓存供下次启动用 */
  heroNotice?(): { title: string; severity: 'info' | 'warn' | 'critical'; link?: string | null } | null;
  /** 开屏的额度条: 同步读缓存里当前生效的额度窗口 (没有缓存 / 不限额 = null) */
  heroUsage?(): { label: string; percent: number } | null;
  /** 登录/登出/刷新失败后重算账号相关运行态与 banner */
  refreshAccount(host: CliAccountHost): void;
  /** token 刷新失败 (401/403) 时回调 —— 用来刷 banner */
  onRefreshFailed(cb: () => void): void;

  /** /model 交互菜单: 登录时先出订阅菜单。'not-applicable' = 没登录, 直接走 BYOK。 */
  runModelMenu(ctx: ModelCommandContext): Promise<'handled' | 'fall-through-byok' | 'not-applicable'>;
  /** /stats 的 "账号 / 订阅" 段 (已着色的行) */
  statsLines(): string[];
  /** neox model ls 的云端段。cloudOnly = 用户指定了 --source=cloud (没登录要报错而不是静默) */
  listCloudModels(opts: { cloudOnly: boolean }): Promise<{ models: CliCloudModelEntry[]; errors: string[] }>;}

export interface CliEdition {
  /** 只用于日志 / 测试 */
  readonly id: string;
  readonly subcommands: readonly CliSubcommand[];
  readonly slashCommands: readonly CliSlashCommand[];
  /** `/` 菜单项, 插在 /exit 之后 (账号分类) */
  readonly slashMenuItems: readonly CliSlashMenuItem[];
  /** Tab 补全提示, 插在 /quit 之后 */
  readonly commandHints: readonly string[];
  /** `neox --help` 末尾 "更多信息" 段的行 */
  readonly helpFooterLines: readonly string[];
  readonly account: CliAccount | null;
}

export const OPEN_EDITION: CliEdition = Object.freeze({
  id: 'open',
  subcommands: [],
  slashCommands: [],
  slashMenuItems: [],
  commandHints: [],
  helpFooterLines: [],
  account: null,
});

let current: CliEdition = OPEN_EDITION;
let registered = false;

/** 只许调一次 (商业入口)。第二次调用抛错 —— 两个发行版叠在一起一定是入口接错了。 */
export function registerCliEdition(edition: CliEdition): void {
  if (registered) {
    throw new Error(`CLI edition already registered (${current.id}); refusing to replace with ${edition.id}`);
  }
  current = edition;
  registered = true;
}

export function getCliEdition(): CliEdition {
  return current;
}

/** 按名字找顶层子命令 (early command router / did-you-mean 用) */
export function findCliSubcommand(name: string): CliSubcommand | undefined {
  return current.subcommands.find((c) => c.names.includes(name));
}

/** 按名字找 slash 命令 */
export function findCliSlashCommand(name: string): CliSlashCommand | undefined {
  return current.slashCommands.find((c) => c.names.includes(name));
}

/** 仅测试用: 复位到公开版 */
export function __resetCliEditionForTests(): void {
  current = OPEN_EDITION;
  registered = false;
}
