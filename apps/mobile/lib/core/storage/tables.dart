/// tables.dart — drift 表定义.
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §6.3 Phone 本地数据库 schema.
/// 五张表:
///   - paired_desktops:  已配对的 Desktop 设备 (X25519 pubkey / device_token / ...)
///   - session_mirror:   同步的 session 列表 (Desktop session 镜像)
///   - session_events:   同步的 timeline 事件 (复合主键 session_id + seq)
///   - inbox_pending:    Mode B 离线时排队等 Desktop 上线的指令
///   - chat_turn_samples: Chat 每轮首字打点 (chat:C8-11, 只在本机, 不参与同步)
library;

import 'package:drift/drift.dart';

/// 已配对的 Desktop 设备
class PairedDesktops extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get deviceId => text().unique()();
  TextColumn get deviceName => text().nullable()();
  TextColumn get lastSeenLanIp => text().nullable()();
  IntColumn get lastSeenLanPort => integer().nullable()();

  /// X25519 公钥, 32 bytes
  BlobColumn get desktopPubkey => blob().nullable()();

  /// 派生的 AES-256 session key.
  /// **生产**: key 应该存 flutter_secure_storage, 这里只缓存指针/标识.
  /// MVP 阶段先直接放 db 字段, Phase 2/3 接通时迁移到 secure storage.
  BlobColumn get relaySessionKey => blob().nullable()();

  /// Desktop 颁发的长期 device token (跨 mode 复用)
  TextColumn get deviceToken => text().nullable()();

  IntColumn get pairedAt => integer()();
  IntColumn get lastConnectedAt => integer().nullable()();

  /// 服务端记录的"这台电脑最后一次上报存活"时间 (/api/v1/devices/my 的
  /// last_announce_at)。
  ///
  /// 2026-08-09 加。在此之前这个字段**服务端一直在给, 客户端一直扔掉** ——
  /// 于是"连哪台"只能靠 lastConnectedAt ("我上次连过谁")。真机实测的后果:
  /// 账号下同一台 Mac 因为改过名/重装留了两条记录, 手机自动连的是那台早就死掉的
  /// (它碰巧有更晚的 lastConnectedAt), 而两分钟前还在 announce 的那台被跳过,
  /// 用户看到的是"电脑明明开着却连不上"。
  /// 谁还活着是服务端知道的事实, 不该靠客户端的历史记忆去猜。
  IntColumn get lastAnnounceAt => integer().nullable()();
}

/// 同步的 session 列表 (Desktop session 在 Phone 本地的镜像)
class SessionMirror extends Table {
  /// session uuid, 跟 Desktop 一致
  TextColumn get id => text()();

  TextColumn get desktopDeviceId => text()();
  TextColumn get title => text().nullable()();
  TextColumn get workspaceName => text().nullable()();
  IntColumn get lastMessageAt => integer().nullable()();

  /// 已同步到的 seq 号, 用于增量补传 (协议 §3.5)
  IntColumn get lastSeq => integer().nullable()();

  BoolColumn get isSensitive =>
      boolean().withDefault(const Constant(false))();
  IntColumn get createdAt => integer()();

  /// 会话种类 — 'chat' (默认) | 'image' (图片工作台 / 直连生图会话).
  /// 手机本机 image 会话走 ImageDirectService; 桌面同步来的 image 会话
  /// 在聊天页打开时仍提示「生图结果在电脑端查看」。
  TextColumn get kind => text().withDefault(const Constant('chat'))();

  /// 这次会话跑在哪个模式下 — 'assistant' (对话) | 'work' | 'code'.
  ///
  /// 2026-09-04 补上。此前**模式从来没有被写进会话** —— 它只活在
  /// SharedPreferences 里的一个全局当前值。两个后果:
  ///   1. 已知 bug: 模式决定工作区, 但会话不记模式, 于是切回 code 时没人还原
  ///      项目, code 会话挂在「工作」目录下 (2026-08-31 记过);
  ///   2. 「工作」「编码」拿不出自己的历史 —— 所有会话在数据层是一个样子的。
  ///
  /// nullable: 存量行没有这个值, 不假装它们是 'assistant' —— 读的时候当"未知",
  /// 未知的会话在三个 home 里都显示。给个默认值反而会把一堆 code 会话说成对话。
  TextColumn get agentMode => text().nullable()();

  /// 非空 = 这是父会话派出的 sub-agent 子会话 (桌面 sessions.parent_session_id).
  /// 抽屉里嵌套在父会话下缩进显示, 不在顶层"最近"列表里单独占位。
  TextColumn get parentSessionId => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// session timeline 事件 (Desktop → Phone notification 的本地落盘)
class SessionEvents extends Table {
  TextColumn get sessionId => text()();
  IntColumn get seq => integer()();
  IntColumn get ts => integer()();
  TextColumn get kind => text()();

  /// JSON-encoded payload
  TextColumn get payload => text()();

  @override
  Set<Column> get primaryKey => {sessionId, seq};
}

/// Chat 每轮的首字打点 (chat:C8-11).
///
/// 每发一轮「本机对话」写一行, 方便回答「真的快了没有」:
/// 按会话看轮次 (turn_index), 按模型看 avg / p50 (见 telemetry/chat_metrics.dart)。
/// 纯本机统计, 不上报、不参与桌面同步 —— 数据只用来在设置里给自己看。
class ChatTurnSamples extends Table {
  IntColumn get id => integer().autoIncrement()();

  TextColumn get sessionId => text()();

  /// 会话内第几轮 (1 起, 写入时数已有行数推出)。
  IntColumn get turnIndex => integer()();

  TextColumn get modelId => text()();

  /// 这一轮是不是轻聊天档 (只有搜索 + 画图)。
  BoolColumn get lightChat => boolean().withDefault(const Constant(false))();

  /// 点发送 → 请求真正发出 (ms)。-1 = 没走到发请求。
  IntColumn get sendToRequestMs => integer()();

  /// 请求发出 → 首个可见正文 (ms)。-1 = 没等到字。
  IntColumn get requestToFirstMs => integer()();

  /// 点发送 → 首个可见正文 (ms)。-1 = 报错 / 空回复 / 被取消。
  IntColumn get firstTokenMs => integer()();

  /// 'ok' | 'no_first_token'。
  TextColumn get outcome => text()();

  /// 用户点发送的时刻 (unix ms)。
  IntColumn get createdAt => integer()();
}

/// Mode B 离线 inbox — Phone 发指令时 Desktop 不在线, 排队等上线
class InboxPending extends Table {
  TextColumn get id => text()();
  TextColumn get desktopDeviceId => text()();

  /// JSON-encoded payload (E2E 加密前的明文 — Phone 自己留底备查)
  TextColumn get payload => text()();

  IntColumn get createdAt => integer()();
  IntColumn get deliveredAt => integer().nullable()();

  /// 'queued' | 'sent' | 'acked' | 'expired'
  TextColumn get status => text()();

  @override
  Set<Column> get primaryKey => {id};
}
