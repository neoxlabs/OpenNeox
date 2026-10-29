/// neox_constants.dart — 内置常量, 不让用户配置.
///
/// 商业化产品 = 用户永远不见 server URL / 端口 / 内部 token. 全部硬编码在客户端,
/// 改了 server 地址走发版升级路径 (build-time const, 不走 hot-update).
///
/// 安全:
///   - 暴露给客户端的 URL 不能含 secret. 这个常量只是 NeoxCloud 公网入口.
///   - 真敏感 token (RELAY_INTERNAL_TOKEN / MODEL_GATEWAY_INTERNAL_TOKEN) 永远只在
///     server 端, 客户端用 JWT 鉴权, JWT 由用户登录后才拿得到.
library;

import 'network/edge_route.dart';

/// NeoxCloud 公网入口 — control-plane 和 cloud-relay 都走 nginx 的 80 端口反代,
/// 客户端只看见一个 host. 真业务端口 (3721, 8089) prod 上只 bind 127.0.0.1, 外网够不到.
///
/// nginx 路由:
///   /api/v1/auth/*  → control-plane (3721)
///   /api/*          → control-plane
///   /n1/*           → model-gateway
///   /relay/*        → cloud-relay (8089), 重写去 /relay 前缀
///
/// **生产入口**. 域名里带 "dev" 只是历史命名, 它就是正式环境 —— 别再被名字骗了
/// (2026-08-08 有人照着旧注释"海外开发环境"判定发行包连错了后端, 白紧张一场).
///
/// 换环境用 dart-define 覆盖:
///   flutter build apk --dart-define=NEOX_API_BASE=http://<gateway-host>
const String kNeoxProductionApiBase = 'https://neox-dev.com';

/// 包里配置的接口地址 (dart-define 可换测试环境)。网页链接 (法务页 / 反馈 / 浏览器登录) 用它 ——
/// 那些在浏览器里打开, 不走手机的线路选择。
const String kNeoxConfiguredApiBase = String.fromEnvironment(
  'NEOX_API_BASE',
  defaultValue: kNeoxProductionApiBase,
);

/// App 自己发请求用的接口地址: 按线路自动选择 (Cloudflare / 香港中转, 见 network/edge_route.dart)。
/// getter 不是 const —— 各处 `'$kNeoxCloudBaseUrl/...'` 每次现拼, 切线路立即生效。
String get kNeoxCloudBaseUrl => EdgeRoute.instance.mapBase(kNeoxConfiguredApiBase);

/// 当前包连的是不是生产 —— 关于页据此提示.
///
/// 按**值比对**而不是猜域名里有没有 dev/test/staging 这类词: 生产域名本身就叫
/// neox-dev.com, 名字启发式在这里必然误报。比的是配置值, 不是选线后的地址 (香港入口也是生产)。
bool get kIsProductionApiBase => kNeoxConfiguredApiBase == kNeoxProductionApiBase;

/// cloud-relay 客户端拼的 WS 路径会自动带 /relay/api/v1/relay, 所以这里跟 control-plane
/// 共用同一个 base. 留个独立常量, 后续 relay 上独立域名 (relay.neox.io) 时再分.
/// 同样支持 dart-define 覆盖.
const String kNeoxConfiguredRelayBase = String.fromEnvironment(
  'NEOX_RELAY_BASE',
  defaultValue: kNeoxProductionApiBase,
);

String get kNeoxCloudRelayBaseUrl => EdgeRoute.instance.mapBase(kNeoxConfiguredRelayBase);

/// OAuth client id — 在 NeoxCloud 这边注册的 public client (无需 secret).
/// register / login / refresh 都要带这个.
///
/// 2026-09-25: 原来是 'neox-desktop' —— 手机冒充桌面。三方登录 (Google / Apple / 浏览器) 签的是
/// 'neox-mobile', 续期却报 'neox-desktop', 服务端判 client 不匹配, 15 分钟后就"登录已过期"。
/// 服务端对两个名字互相放行 (过渡期), 老会话续期时会被改记成 mobile。
const String kNeoxOAuthClientId = 'neox-mobile';

/* ── 法务页 (2026-08-08) ────────────────────────────────────────────────────
 *
 * 之前全 app 一条法务链接都没有。Apple 与 Google Play 对**有账号体系**、且
 * 采集设备信息 (我们在算设备指纹并随登录上报) 的 app 都硬性要求隐私政策可达;
 * Play 的"数据安全"表单还要求填写公开的隐私政策 URL。
 *
 * ⚠ 这两个地址必须**真的能打开**才算数 —— 审核员会点。跟着 kNeoxCloudBaseUrl
 *   走是为了让 dev / 生产各自指向自己的那份, 不用改代码; 但页面本身要在
 *   NeoxCloud 侧发布出来。用 dart-define 可以整体换到独立法务域名。
 */
const String kNeoxPrivacyPolicyUrl = String.fromEnvironment(
  'NEOX_PRIVACY_URL',
  defaultValue: '$kNeoxConfiguredApiBase/legal/privacy',
);

const String kNeoxTermsOfServiceUrl = String.fromEnvironment(
  'NEOX_TERMS_URL',
  defaultValue: '$kNeoxConfiguredApiBase/legal/terms',
);

/// 注销账户走不通时的人工兜底邮箱 (服务端接口未上线 / 异常).
/// Apple 接受"app 内发起 + 后端处理", 但不接受点了没反应的假按钮。
const String kNeoxSupportEmail = String.fromEnvironment(
  'NEOX_SUPPORT_EMAIL',
  defaultValue: 'support@neox-dev.com',
);

/// 反馈 / 报 bug: 官网 /feedback 页, 发出去是一封寄到 support@ 的信 (带上是哪个端)
const String kNeoxFeedbackUrl = '$kNeoxConfiguredApiBase/feedback?source=app';

/// 账户概览 (会员档位 / 额度 / 设备数) 的本地缓存键。
///
/// 放这儿而不是放 account_overview_provider 里, 是因为**登出**那条路也要清它 ——
/// 缓存留着的话, 下一个登录的人第一帧会看到上一个账号的 Pro 和额度, 那比"读不到"
/// 严重得多。两处各写一个字面量迟早会漂, 所以只此一份。
const String kAccountOverviewCacheKey = 'neox.account.overview.v1';
