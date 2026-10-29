# iOS 上架清单

> 2026-09-04 建。**代码侧已完成的**打勾, **只能在 Apple 后台做的**单列 ——
> 后者做不完, 前者写得再好也上不了架。

---

## 一、代码侧（已完成）

| 审核条款 | 做了什么 | 代码位置 |
|---|---|---|
| **3.1.1** 应用内购买 | 首发**不带 IAP** (2026-10-08 用户拍板): `kIosInAppPurchaseReady=false`, iOS 上升级/购买/兑换入口一律不渲染; IAP 代码已在, 商品建好后翻开关 | `core/feature_flags.dart`、`core/account/apple_iap.dart` |
| **4.10** 恢复购买 | 随 IAP 一起上 (会员页「恢复购买」) | `iap_sheet.dart` |
| **5.1.2(i)** 发给第三方 AI 前告知+同意 | 首次发送 / 语音对话 / Pilot 前弹一次说明, 不同意不发 | `core/privacy/ai_consent.dart` |
| **5.1.1** 权限说明 | 英文底稿 + `zh-Hans.lproj/InfoPlist.strings`; 存图只要「仅添加」权限 | `ios/Runner/Info.plist` |
| **4.8** 等价隐私登录 | Sign in with Apple，排在其它第三方登录**之上** | `core/auth/apple_native_signin.dart`、服务端 `auth-external/apple.ts` |
| **5.1.1(v)** 注销账号 | app 内发起 + 14 天宽限期 + 可撤销；**没有密码的账号走邮箱验证码**，不设前置门槛 | `core/account/account_deletion.dart`、服务端 `compliance/deletion-stepup.ts` |
| **1.2** UGC / 举报 | 每条回复底下的动作条里有「举报」，理由单选 + 可留言 | `features/timeline/widgets/report_sheet.dart` |

---

## 二、只能在 Apple 后台做的（代码管不到）

- [ ] **App ID** `com.mkco.neox.mobile` 勾上 **Sign In with Apple**
- [ ] **App ID** 勾上 **In-App Purchase**
  （注意：StoreKit 内购**不需要** entitlements 条目。`com.apple.developer.in-app-payments` 是 Apple Pay 的，别加）
- [ ] **App Store Connect** 建订阅商品，把产品 ID 填进 `apple_iap_products` 表：
  ```sql
  INSERT INTO apple_iap_products (product_id, plan_id, period)
  VALUES ('com.mkco.neox.pro.monthly', '<membership_plans.id>', 'monthly');
  ```
- [ ] **App Store Server Notifications V2** 的 URL 指向
  `https://neox-dev.com/api/v1/billing/apple/notifications`
- [ ] 申请 **Small Business Program**（年收入 100 万美元以下，抽成 30% → 15%，白拿的 15 个点）
- [ ] **Email Sources** 注册发信域名 ⚠️
  否则发往 `@privaterelay.appleid.com` 的信会被 Apple **静默丢弃、没有退信**。
  表现是"注销验证码永远收不到"，排查极贵。

---

## 三、审核备注（提交时原样贴进 App Review Information）

> **这条最重要。** 不写的话，审核员打开 app 看到的是一个连不上电脑的空壳，
> 直接 2.1 打回 —— 跟代码质量无关。

**演示账号** (Sign-in required 勾上): 专用审核号 `appreview@neox-dev.com`, 生产库, 手开 Pro 到 2027-10-09。
密码不进仓库, 在 `~/.neox-secrets/app-review.txt`。**别拿它做别的测试** —— 审核员看到的会话列表 / 已登录设备就是它的。
审核员要是真点了注销: 14 天内用这个号重新登录即撤销。

```
Neox is an AI assistant. Everything under review works on the phone alone —
no computer is needed.

DEMO ACCOUNT
Tap the menu (top left) › "Not signed in" › Sign in to Neox, then sign in with
the email and password provided in the Sign-In Information fields. The account
has an active plan, so chat, web search, image generation and voice all work.

WHAT TO TRY
• Chat: type any question on the home screen (e.g. "What's the weather in
  San Francisco this weekend?"). Answers can include web sources.
• Images: menu › Images, describe a picture. Generation takes 30–90 seconds.
  Long-press a result to save it to Photos.
• Voice: tap the microphone in the input box to dictate.
• Before the first message the app explains that content is sent to third-party
  AI model providers and asks for permission (Guideline 5.1.2(i)).

ITEMS THAT NEED THE USER'S OWN COMPUTER (not required for review)
"Work" and "Code" modes run tasks on the user's own Mac/PC running the Neox
desktop app; the app explains this and offers Chat instead. The app also looks
for a paired computer on the local network (Bonjour) — finding nothing in the
review environment is expected.

ACCOUNT DELETION (5.1.1(v))
Menu › tap the account name › Account › Delete account. Deletion starts in the
app; the account is disabled immediately and permanently deleted after 14 days.

REPORTING AI CONTENT (1.2)
Every reply has a flag icon under it to report the content.

PURCHASES
The iOS app does not sell anything and contains no purchase links. Users who
already have a Neox plan can sign in and use it (3.1.3(b)).
```

---

## 四、年龄分级

BYOK 让用户可以连任意厂商任意模型，等于 app 内可能产出**未经过滤**的内容。
分级问卷要如实填，评低了会被打回改。

---

## 五、出口合规

`Info.plist` 的 `ITSAppUsesNonExemptEncryption=false`。2026-10-09 用户拍板如实申报:
云中继的 X25519 + AES-GCM 端到端加密在 iOS 上经 `cryptography_flutter` 走系统 CryptoKit,
属「只用 Apple 系统内加密」→ 豁免, 不交文稿。**不要去掉 `cryptography_flutter`**: 回到纯 Dart 实现就成了
「代替系统加密的标准算法」, 要在 App 信息页上传加密文稿。标 true 会要求合规码, 不带码上传直接 409。

---

## 六、构建与上传

```bash
cd apps/mobile
./scripts/build-release.sh ipa                                  # App Store 包 → build/ios/ipa/
IOS_EXPORT=release-testing ./scripts/build-release.sh ipa       # Ad Hoc, 数据线装登记过的 iPhone
xcrun devicectl device install app --device <UDID> build/ios/ipa/*.ipa   # Ad Hoc 直装
# 上传 (App Store Connect 里先建好 App 记录): Apple ID + App 专用密码在 ~/.neox-secrets/apple.env
xcrun altool --upload-app -t ios -f build/ios/ipa/*.ipa -u "$APPLE_ID" -p "$APPLE_APP_SPECIFIC_PASSWORD"
```

- 必须 Xcode 26 (`/Applications/Xcode-26.3.0.app`, 脚本自动指过去, 不动全局 xcode-select);
  Metal 工具链要先 `xcodebuild -downloadComponent MetalToolchain` 一次。
- 部署目标 iOS 15, 只上 iPhone (`TARGETED_DEVICE_FAMILY = 1`)。
- `llama_flutter_android` 的 iOS 端发版时就编不过, `ios/Podfile` 里换成了桩 + 不编 llama.cpp;
  iOS 不提供本机模型 (`kLocalLlmSupported`)。
- iOS 26.2 / 26.3 **模拟器**里所有 emoji 都显示成带问号的方框 —— 模拟器运行时的 bug, 真机和 18.x 模拟器正常, 别去修代码。
- 截图: 6.9 寸 (iPhone 16 Pro Max 模拟器, 1320×2868), 系统语言切英文, `simctl status_bar` 固定 9:41。

## 七、App Store Connect 字段

| 字段 | 填什么 |
|---|---|
| 名称 | Neox (被占就用 `Neox — AI Assistant`) |
| Bundle ID | com.mkco.neox.mobile (已由自动签名注册, 带 Sign in with Apple) |
| SKU | neox-ios |
| 主语言 | English (U.S.) |
| 类别 | Productivity (副: Utilities) |
| 隐私政策 URL | https://neox-dev.com/legal/privacy |
| 支持 URL | https://neox-dev.com/help (`/support` 是 404) |
| 价格 | 免费 |
| App 隐私 (数据收集) | 联系信息-邮箱 (账号); 用户内容-消息/照片/音频 (App 功能); 标识符-设备 ID (App 功能/安全); 使用数据 (分析否); 均**关联用户身份**, **不用于追踪** |
| 年龄分级 | AI 生成内容可能不受过滤 —— 问卷里「无限制网络访问」选是, 预计 12+ |
