# apps/mobile · Mobile 客户端

> Neox 三端架构的 **移动端** (iOS + Android)
> 跟 Neox Desktop + NeoxCloud 协同, 实现 "Desktop + Cloud + Mobile" 完整闭环
> 详见 `内部设计文档` (v3.0)

## 它是怎么到这儿的

2026-09-21 从独立仓 `MK-CO/Neox-App` 并进来，跟 `apps/cli` / `apps/desktop` 并排。
开源仓 `neoxlabs/OpenNeox` 早就是这个结构，商业版这一步一直没做，于是同一个
`neox_app` 在两处以两种布局存在了一段时间。那个独立仓保留为历史存档，不再更新。

**开源版的 `apps/mobile` 是这份代码减掉云和账号层** —— 导出时按目录整棵删掉
(`scripts/public-export.json` 的 exclude), 剩下的必须原样能编译:

| 商业目录 | 内容 |
|---|---|
| `lib/core/account/` | 会员、内购、账号注销、内容举报 |
| `lib/core/auth/` | NeoxCloud 登录、Apple/Google 原生登录、设备指纹、OAuth |
| `lib/core/cloud_agent/` | 云端会话注册表、云能力开关 |
| `lib/features/auth/` · `lib/features/cloud/` | 登录 / 注册 / 找回密码页、云端任务页 |
| `lib/commercial/` | 商业版注册点 `CommercialEdition` + 中继客户端、presence、自动配对、会话索引、托管模型网关 / 托管出图、账户 / 会员 / 设备同步界面、额度条、举报 |
| `test/commercial/` | 上面这些的测试 |

### 发行版接缝 (`lib/core/edition/edition.dart`)

共享代码需要商业能力时**只问 `NeoxEdition`**: 能力 (登录态 / 远程中继 / 托管模型网关 /
托管出图 / 云端会话 / 在线信号) 和界面插槽 (设置页账户卡 / 会员格 / 抽屉底栏 /
额度条 / 设备页同步 / 举报)。每个成员都带"没有这项能力"时的默认实现 —— 那就是
开源版 (`OpenEdition`) 的行为。商业实现只在 `lib/commercial/commercial_edition.dart`
注册一次。

| 入口 | 发行版 | 用法 |
|---|---|---|
| `lib/main.dart` | 商业版 | 默认入口: `flutter run` / `flutter build` / Xcode Archive / `scripts/build-release.sh` 都不用带 `-t` |
| `lib/main_open.dart` | 开源版 | `flutter run -t lib/main_open.dart` · `flutter build apk -t lib/main_open.dart` |

商业版占着默认的 `main.dart` 是刻意的: 发布链上任何一环漏写 `-t`, 打出来的也不会是
一个没有登录的包。导出时 `scripts/public-overlay/files/apps/mobile/lib/main.dart`
(`main_open.dart` 的逐字副本) 顶替 `main.dart`。

**闸**: `node scripts/check-mobile-edition.mjs` (`npm run check:mobile-edition`, 已并进
`check:arch`) —— 共享 Dart 文件 import 商业目录即红 (唯一例外是 `main.dart` 那一行
注册), 并核对 `main_open.dart` 与覆盖层一致。加 `--analyze` 会把 `apps/mobile` 拷到
临时目录、真删商业目录、跑 `flutter analyze`。新加商业能力时: 在 `edition.dart` 加成员
+ 默认实现, 实现放 `lib/commercial/`, 在 `CommercialEdition` 里覆盖。

`phone_identity.dart` 在 `lib/core/device/` (配对与局域网握手都靠它, 不属于账号),
应用锁屏在 `lib/core/security/`, 字标在 `lib/shared/widgets/neox_wordmark.dart`。

## 技术栈

| 维度 | 选型 |
|---|---|
| Framework | **Flutter 3.32+** (Dart 3.8+) |
| 平台 | iOS + Android (双端) |
| 状态管理 | Riverpod 2.5+ |
| 路由 | go_router 14+ |
| 本地存储 | drift (SQLite 类型安全 ORM) |
| 网络 | dio + web_socket_channel |
| 加密 | cryptography (X25519 + AES-GCM) |
| LAN 发现 | multicast_dns (mDNS) |
| 二维码 | mobile_scanner + qr_flutter |
| 音频 | speech_to_text (系统识别, 内联到输入框) |
| 推送 | flutter_local_notifications |
| 安全存储 | flutter_secure_storage |
| i18n | flutter_localizations + intl |

## 三端三 Mode 架构 (本端职责)

```
Mode A · LAN P2P (同 WiFi)
  Phone ←── WSS ──→ Desktop  (mDNS 发现 + QR 配对)

Mode B · E2E Encrypted Cloud Relay (跨网络)
  Phone ←── WSS ──→ NeoxCloud Relay ←── WSS ──→ Desktop
  (X25519 + AES-256-GCM, 云端只转密文)

Mode C · Pure Cloud Agent (出差/无 Desktop)
  Phone ←── WSS ──→ NeoxCloud sandbox VM (agent 真云端跑)
```

完整协议见 Neox 主仓 `内部设计文档`.

## 四种运行目标 (产品层露三个: 手机 / 我的电脑 / 云端)

| 目标 | 路径 | 计费 |
|---|---|---|
| phoneLocal · 订阅 | NeoxCloud `/n1` 网关 (JWT) + **本地 Agent 工具循环** | Neox 积分 |
| phoneLocal · BYOK | 直连厂商 (OpenAI 兼容协议走**工具循环**; Anthropic/Gemini 纯聊天) | 厂商侧, 零账号 |
| desktopLan / desktopRelay | Mode A/B → 桌面 agent | 桌面侧配置 |
| cloudAgent | Mode C → NeoxCloud pod | Neox 订阅 |

### 手机本地 Agent (agentsdk/)

`agentsdk/` 是独立纯 Dart 包 (`neox_agent_sdk`) — 手机脱离桌面也能"干活":
工具调用循环 (ReAct) + 事件流 (kind 对齐 timeline 协议) + 取消 + 轮数/输出上限。
内置工具: `http_fetch` (联网, SSRF 防护) / `workspace_files` (沙箱文件) /
`calculator` (精确算术) / `clock`。宿主注入 LLM (`LlmConnector`) 与设备工具。
详见 `agentsdk/README.md`。

## 项目结构 (2026-07 单页重构后)

```
agentsdk/                      (独立纯 Dart 包: 手机本地 Agent 运行时)
lib/
├── main.dart / app.dart      (入口 + lifecycle + 传输切换提示)
├── core/
│   ├── llm/                  (统一 LLM 网络层: SSE 解码/连接池/重试/取消)
│   ├── byok/                 (BYOK: provider 配置 + 三协议适配器 + 探活)
│   ├── local_agent/          (phone-local: 订阅网关 + BYOK 双路由)
│   ├── network/              (ws client + relay + presence + streaming buffer)
│   ├── crypto/               (X25519 配对 + AES-GCM)
│   ├── storage/              (drift SQLite: paired_desktops/session_mirror/session_events)
│   ├── auth/ account/        (NeoxCloud JWT / 会员快照 / 兑换码 / 积分流水)
│   ├── notifications/        (本地通知 + agent 事件路由 + 远程推送能力保留位)
│   ├── session_routing/      (桌面 > 云端 > 手机 的创建/发送路由)
│   └── discovery/ startup/   (mDNS / 启动编排)
├── features/
│   ├── home/                 (唯一主页: 对话即首页 + 抽屉 + StageInput)
│   ├── timeline/             (状态机 + 渲染: 计划卡/子代理/审批/压缩/重试 pill)
│   ├── settings/             (我 / 会员(升级/兑换/明细) / 设备 / 连接 / 我的模型 Key)
│   ├── cloud/ workspace/ pairing/ life/ voice/
└── shared/                   (Neox 设计系统: tokens / 卡片 / 按钮 / scaffold)
```

**协议**: 跟桌面 mobile-bridge 对齐 `内部设计文档` **v1.1**
(plan_update / subagent_* / context_compaction / checkpoint / stream_retry +
session.subscribe ui_state 快照)。

## 开发

```bash
flutter pub get
flutter run -d ios       # iOS 模拟器
flutter run -d android   # Android 模拟器
flutter build ios --release
flutter build apk --release
```

### Codegen (drift / freezed / json_serializable)

```bash
dart run build_runner build --delete-conflicting-outputs
```

**约定**: `.g.dart` / `.freezed.dart` **入库** (不在 .gitignore 排除), 这样:
- 新 dev / CI clone 后 `flutter pub get` 即可编译, 不必先跑 build_runner
- PR review 能直接看到 schema 变化, drift 表加列也一目了然
- 跟 freezed / drift 官方推荐范式略有差异, 但 Neox monorepo 已经踩过坑 (见 memory `project_npm_ts_strip_types_fix.md` 同思路)

## 历史

- **2026-05-18** 切换技术栈: Kotlin 原生 → Flutter 跨端 (主分支重做)
- **2026-06-28** 单页重构: 3-tab → 对话即首页 + 抽屉 (Claude 式)
- **2026-07-19** 全面重构收官: timeline 协议 v1.1 对齐桌面 / 手机端 BYOK /
  订阅闭环 (升级+兑换码+明细) / 协同硬化 (后台通知+推送能力保留)
- **legacy/kotlin-android** 分支: 原 Kotlin Android-only 版本 (不再维护)

## 发布清单

- [x] Android release 签名脚手架 — `android/key.properties` 存在即真签
      (生成命令见 build.gradle.kts 注释), 无则回落 debug; R8 + proguard 已配
- [x] iOS deployment target 13.0 (pbxproj + Podfile + AppFrameworkInfo)
- [x] 崩溃捕获: 三层 (FlutterError/PlatformDispatcher/zone) → 本地 crash.log,
      设置 → 关于 → 诊断日志可查看/复制/清空
- [x] CI: `.github/workflows/pilot-suites.yml` (PayGuard JVM 单测; `flutter analyze` / APK 仍只在本地跑)
- [x] iOS Info.plist 权限说明 + URL scheme (相机/相册/本地网络/Face ID/OAuth 回调)
      — 缺任意一条都是当场闪退或功能静默失效, 2026-08-08 补齐
- [x] 发布构建强制指定后端: `NEOX_API_BASE=... ./scripts/build-release.sh apk`
      不给就拒绝构建 (默认值是开发环境, 以前会静默打进发行包)
- [x] 版本检查 / 强更闸门 (客户端侧就绪, 等服务端 `/api/v1/app/version`)
- [x] 注销账户入口 (App Store 5.1.1(v) 硬性要求) — 等服务端 `DELETE /api/v1/account`
- [x] 隐私政策 / 服务条款入口 — **页面本身需在 NeoxCloud 侧发布**
- [x] 正式 keystore + `android/key.properties` (已配, 已 gitignore 不入库)
- [x] `ITSAppUsesNonExemptEncryption = false` (按豁免申报;
      **Mode B 端到端加密真上线时要回来重新评估**)
- [ ] iOS 真机 profile + 上架材料 (需 Apple Developer)
- [ ] 远程推送: 云端 APNs/FCM 服务建成后实现 `RemotePushRegistrar`
      (lib/core/notifications/agent_notifier.dart 的能力保留位)
- [x] 语音输入 (speech_to_text 系统识别 → 填输入框; 连续对话模式后续)
      注: 原 `/voice` 全屏占位页已删 (按钮是空 TODO), 真能用的是输入框内联语音
- [ ] i18n 英文化 (global channel)
- [ ] **Phase 3** Mode B E2E Cloud Relay 接通
- [ ] **Phase 4** Mode C 云端 Agent 接通

## 配套仓库

- **Neox Desktop**: 主仓 (Electron + React + neox-core)
- **NeoxCloud**: 后端 monorepo (Node + Go), `apps/cloud-relay` 是 Mode B 入口
- **Neox-App** (本仓库): Mobile 端 (Flutter)
