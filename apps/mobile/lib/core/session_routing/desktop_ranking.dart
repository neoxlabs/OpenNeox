/// desktop_ranking.dart — 多台已配对电脑时"该用哪一台"的排序规则.
///
/// 抽成纯函数 (用取值回调而不是接口, 因为 PairedDesktop 是 drift 生成的、改不了继承)
/// 是为了能直接单测 —— 这条规则出过一次很贵的 P0, 必须有回归护栏。
library;

/// 按"最该用哪台"排序: **当前正连着的排第一**, 其余按最近连接时间倒序.
///
/// ## 为什么必须排序 (2026-07-28 真机实锤的 P0)
///
/// 原来 SessionRouter 里是 `getAll().where(可连).first` —— **完全没有排序**, 拿到的
/// 是 DAO 的插入顺序, 也就是用户**最早配对**的那台电脑。对任何用了一段时间、换过
/// 电脑或换过网的用户, 那台大概率早就关机/换网段了。
///
/// 坏链路是完整的一条:
///   1. 用户选「运行位置 = 我的电脑」并发送
///   2. 路由取到失联的老电脑
///   3. `_createDesktopSession` 发现"没连在这台上", 于是 `connectToDesktop(老电脑)`
///      —— **把当前那条健康的 WS 连接顶掉**
///   4. `_waitForDesktopReady` 空等 12s 超时 → 抛 "电脑暂时连不上"
///   5. 老电脑从此占住 activeDesktopDeviceId, 每 20s 重连一个跨网段的旧地址永不收敛;
///      设备页把老电脑标成「当前」、顶部显示「未连接电脑」—— 而刚配好的那台其实
///      WS 早就 authenticated 了
///
/// 也就是说: **发送这个动作本身是连接被劫持的元凶**。把已连接的那台排到第一位,
/// `_createDesktopSession` 的 `connectedToTarget` 判定直接命中, 整条坏链路消失。
///
/// ## 第二条: 服务端说它还活着的优先 (2026-08-09 真机实锤)
///
/// 上面那条修的是"别拿插入顺序第一台", 但排序依据仍然只有 `lastConnectedAt`
/// —— 也就是**手机自己的历史记忆**。同一台 Mac 改过名或重装之后, 账号下会留
/// 两条记录 (device_id 和 pubkey 都变了, 名字也不同, 按名字去重也合不掉)。
/// 实测数据: 账号里同时有 `Mac` 和 `kimberly-air-11531`, 其实是同一台机器。
/// 手机自动连的是 `Mac` —— 因为它碰巧有更晚的 lastConnectedAt —— 而两分钟前
/// 还在 announce 的 `kimberly-air-11531` 被跳过。用户看到的是"电脑明明开着,
/// 手机却一直连不上"。
///
/// `/api/v1/devices/my` 一直在返回 `last_announce_at`, 客户端一直扔掉。
/// **谁还活着是服务端知道的事实, 不该靠客户端的历史记忆去猜。**
/// 所以排序改成: 连着的 > 最近还在上报的 > 最近连过的。
///
/// [liveDeviceId] 是当前 WS **真正连着**的那台; 未连接时必须传 null ——
/// 不能把"曾经 active"当成"连着", 那正是老 bug 的粘性来源。
List<T> rankDesktopsForRouting<T>(
  List<T> desktops, {
  required String Function(T) deviceId,
  /// epoch 毫秒; null = 从没连上过.
  required int? Function(T) lastConnectedAt,
  /// epoch 毫秒.
  required int Function(T) pairedAt,
  /// epoch 毫秒; 服务端记的"最后一次上报存活". null = 服务端没给 (老服务端/
  /// 用户扫码 pair 的机器不归账号 sync 管).
  int? Function(T)? lastAnnounceAt,
  String? liveDeviceId,
  /// 判定"最近还活着"的窗口. 超过它的 announce 一律当成过期,
  /// 退回按 lastConnectedAt 排 —— 昨天上报过不代表现在开着.
  Duration freshWindow = const Duration(minutes: 10),
  /// 现在时刻 (可注入, 便于测试).
  DateTime? now,
}) {
  if (desktops.length <= 1) return desktops;
  final nowMs = (now ?? DateTime.now()).millisecondsSinceEpoch;
  final freshCutoff = nowMs - freshWindow.inMilliseconds;

  /// 服务端在 [freshWindow] 内见过它 —— "现在还活着"的证据.
  bool isFresh(T d) {
    final at = lastAnnounceAt?.call(d);
    return at != null && at >= freshCutoff;
  }

  final ranked = [...desktops];
  ranked.sort((a, b) {
    if (liveDeviceId != null) {
      final aLive = deviceId(a) == liveDeviceId;
      final bLive = deviceId(b) == liveDeviceId;
      if (aLive != bLive) return aLive ? -1 : 1;
    }
    /* 第一层: 服务端此刻还见得到的 —— 一台"正在线"的机器压过任何历史记录,
     * 哪怕从没连上过。这是唯一能让**新配的电脑**立刻胜出的依据。 */
    final aFresh = isFresh(a);
    final bFresh = isFresh(b);
    if (aFresh != bFresh) return aFresh ? -1 : 1;

    /* 第二层: **两台都还活着** → 按用户自己的使用习惯排 (最近连过的那台在前)。
     *
     * 2026-09-22 用户实拍: 账号下有 Mac 和 Windows 两台, 都开着 (都 fresh), 但手机
     * 每次自动连接都去 Windows —— 因为这一层原来在比 announce 的秒级新旧, 而那是
     * "谁刚上报过", 不是"用户平时用哪台"。两台都活着的时候, 前者不该压过后者。
     *
     * 这条**只在该改的时候改结果**: 需要两台都不缺 lastConnectedAt 且不同。08-09
     * 修的那个场景 (改过名留下的死记录, 它时间戳新但**不 fresh**) 仍然由第一层拦下,
     * 见下方第三层的原注释。 */
    if (aFresh && bFresh) {
      final ac = lastConnectedAt(a);
      final bc = lastConnectedAt(b);
      if (ac != null && bc != null && ac != bc) return bc.compareTo(ac);
    }

    /* 第三层: 两边都有上报时间 → 直接比谁更近, **不看新鲜窗口**.
     *
     * 2026-08-09 第二次实测才补上这层。第一版只在"都新鲜"时才比 announce,
     * 于是真实数据 (air 11.6 小时前 / Mac 36.7 天前) 两台都落在 10 分钟窗口外,
     * 规则整个退回 lastConnectedAt —— 又选中了那台 36 天没露面的 Mac。
     * 差着两个数量级还一视同仁, 是把"窗口"这个工具用错了地方:
     * 窗口只该用来判断"算不算在线", 而不该在都不在线时抹平它们的差距。
     * 11 小时前露过面的机器, 任何情况下都比 36 天前的更可能是用户现在那台。 */
    final aa = lastAnnounceAt?.call(a);
    final ba = lastAnnounceAt?.call(b);
    if (aa != null && ba != null && aa != ba) return ba.compareTo(aa);
    final av = lastConnectedAt(a) ?? pairedAt(a);
    final bv = lastConnectedAt(b) ?? pairedAt(b);
    return bv.compareTo(av);
  });
  return ranked;
}

/// 把用户显式设过的「首选电脑」提到最前 —— 纯函数, 跟上面那套排序配对使用.
///
/// ## 为什么排序函数自己不管这件事 (2026-09-22)
///
/// `rankDesktopsForRouting` 答的是"**客观上**最可能连得上哪台" (连着的 > 服务端说
/// 还活着的 > 最近连过的), 它压根不知道用户想用哪台。偏好必须是它之上的一层:
/// 先用用户的意图, 客观排序只决定"首选不通时先试谁"。
///
/// 这条规则已经在**发消息路由** (`session_router._pickDesktop`) 和**逐台尝试**
/// (`ws_client_provider`) 里各写了一遍, 而**冷启动自动重连**
/// (`startup_coordinator._pickReconnectTarget`) 漏了 —— 于是首选 Mac 的人, 每次
/// 开机第一次连接都被 announce 更新鲜的 Windows 顶掉 (用户实拍)。它恰好是用户最先
/// 看到的那一次连接, 所以症状最刺眼。
///
/// 收成一个纯函数是为了不再有第三次"某一处忘了加": 这条规则已经有三个调用点,
/// 而仓库里"两处规则一分裂就必然漂移"已经吃过一次亏 (见本文件顶部)。
///
/// 首选不在列表里 / 已在首位 / 未设首选 → 原样返回 (不做无谓拷贝)。
/// 用户意图的两层, 叠在客观排序之上: **当前电脑 > 首选电脑 > 客观排序**。
///
/// 当前电脑 = 正连着、或刚断开不久的那台 (WsClientController.currentDesktopId)。
/// 2026-09-26 用户: Wi-Fi 切到远程时「不是切换到当前的电脑」—— 局域网一断,
/// 补连只看首选和心跳, 另一台心跳更新鲜就被连上了。网络变了不等于想换电脑,
/// 所以当前那台压过首选 (用户手动切到别的电脑后, 那台就是当前)。
/// 发消息路由 / 回前台补连 / 启动逐台尝试三处都走这一个函数, 别再各写一遍。
List<T> orderByUserIntent<T>(
  List<T> ranked, {
  String? preferredDeviceId,
  String? currentDeviceId,
  required String Function(T) deviceId,
}) =>
    hoistPreferred(
      hoistPreferred(ranked, preferredDeviceId, deviceId: deviceId),
      currentDeviceId,
      deviceId: deviceId,
    );

List<T> hoistPreferred<T>(
  List<T> ranked,
  String? preferredDeviceId, {
  required String Function(T) deviceId,
}) {
  final want = preferredDeviceId?.trim();
  if (want == null || want.isEmpty) return ranked;
  final idx = ranked.indexWhere((d) => deviceId(d) == want);
  if (idx <= 0) return ranked;
  return [ranked[idx], ...ranked.where((d) => deviceId(d) != want)];
}
