/// feature_flags.dart — 编译期功能开关.
///
/// 只放"整块功能要不要对用户存在"这种开关。运行时可切的偏好不在这里
/// (那些在各自的 provider 里)。
library;

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;

/// 云端执行 (cloud agent) 对用户是否可见.
///
/// **2026-09-18 下架, 原因是成本**: 用户原话「云端功能全部下架隐藏 我们现在不支持
/// 成本太高」。云端跑 agent 要我们自己出算力钱, 而手机端的价值主张是"连自己的电脑"
/// —— 云端只是它连不上时的兜底, 却是成本最高的那条路。
///
/// 为什么用开关而不是把代码删掉:
///   · 服务端、协议、ws 客户端里的 cloud 分支都还在, 一起删是几千行的手术,
///     而下架是**商业决定**, 可能随时改回来 (等成本模型或定价变了);
///   · 删了之后想开回来, 要重新长出那些分支 —— 那才是真的高风险;
///   · 开关放一处, "云端在哪些地方露出来"这件事就有唯一真相, 不用满仓库 grep。
///
/// 关掉之后的行为:
///   · 入口一律不渲染 (不是灰掉 —— 灰掉的按钮还是在问"这是什么", 等于没下架);
///   · **已经存在的云端会话仍然能打开能读** —— 用户之前跑的东西不能凭空消失;
///   · 新建会话只在手机 / 电脑之间选。
///
/// **2026-10-11 重新打开**: 用户「手机端最好是云端 …… 现在基本上必须要连电脑」。成本由服务端控:
/// 谁能用看 cloud_agent_feature_flags.allowed_plans (客户端读 allowed_for_me), 每人同时最多 3 个,
/// 空闲 30 分钟的容器自己存档退出。客户端这里只决定「这一版有没有这块功能」。
const bool kCloudAgentEnabled = true;

/// 「自动」选运行位置时会不会落到云端 (2026-10-11 晚: 关)。
///
/// 用户: 「我们对比它俩最大的优势就是手机本地就可以处理, 只需要连我们的 API, 不需要云端 Agent」;
/// 当天下午编码在电脑没连上时被自动落到云端, 拿到「没有 Pod 在 warm 阶段」。
/// 云端只在用户明确选它时才建; 自动 = 电脑 → 手机。
const bool kAutoRouteToCloud = false;

/// UI 要不要露出云端入口 —— **唯一判据**, 所有入口都问它.
///
/// 两个条件缺一不可:
///   · [kCloudAgentEnabled]: 我们这一版有没有把这块功能放出来 (商业决定, 编译期);
///   · 服务端的 `cloud_agent_feature_flags.create_enabled`: 全员开关 (admin 可随时改,
///     不用发包就能生效)。
///
/// **2026-09-18 查生产库发现: 服务端 9/16 就已经关了** (updated_by =
/// ops-20260916-cloud-agent-off)。也就是说云端会话早就建不出来了 ——
/// 但**只有路由层读了这个开关, UI 一处都没读**, 于是入口全都还摆在界面上,
/// 用户点进去才发现不行。这个函数就是为了把"能不能用"和"露不露出来"绑在一起。
///
/// 不影响已存在的云端会话: 那些照样能打开能读 (用户跑过的东西不能凭空消失)。
bool cloudEntriesVisible({required bool serverCreateEnabled}) =>
    kCloudAgentEnabled && serverCreateEnabled;

/// iOS 上有没有接好应用内购买 (2026-09-24: 没有)。
///
/// App Store 3.1.1 / 3.1.3(b): 付费权益在 iOS 上只能走 IAP; 不走 IAP 就不能出现任何购买入口、
/// 兑换码、「升级」引导、指向外部购买的按钮。服务端 `/billing/apple/products` 目前是空的,
/// 于是「升级套餐」一点就是「暂时没有可购买的套餐」—— 审核员必点, 必拒。
/// 在 App Store Connect 建好订阅商品、服务端能返回 productIds 之后再改成 true。
const bool kIosInAppPurchaseReady = false;

/// 界面能不能出现「升级 / 套餐购买 / 兑换码 / 管理订阅」—— **唯一判据**, 所有入口都问它。
/// iOS 没接 IAP 时一律不出现 (不是灰掉); 已付费用户照常登录使用 (3.1.3(b) 多平台服务)。
/// 按 [defaultTargetPlatform] 判, 测试里能用 debugDefaultTargetPlatformOverride 切平台。
bool get purchaseUiAllowed =>
    defaultTargetPlatform != TargetPlatform.iOS || kIosInAppPurchaseReady;
