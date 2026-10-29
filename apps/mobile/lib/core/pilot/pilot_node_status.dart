/// pilot_node_status.dart — 这台手机作为节点, 跟云端它之间的心跳与最近动作 (pilot:D-18)。
///
/// 连接页要回答两个问题: 「这台手机现在算不算在线」「它最近拿这台手机办过什么」。
/// 心跳本来就是 90s 一拍 (commercial/pilot/neox_pilot_cloud.dart), 以前只报给云端,
/// 手机上没有任何地方读它 —— 用户只能猜。这里只存状态, 不发网络请求。
///
/// 判在线用的是「通道还连着」+「心跳多久没到」两件事:
///   - 通道断了 → 没连上 (心跳再新也不代表现在能办事)
///   - 连着、心跳 <60s → 在线
///   - 连着、心跳超过 3 分钟没到 (两拍都没回来) → 心跳停了
/// 中间那段 (60s~3min) 仍算在线, 但副标题会写「有点久」—— 一拍没回来不等于断了。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 心跳多久算新鲜。云端 `<device-state>` 也按「多久没报到」判断节点在不在线。
const pilotNodeFreshBeat = Duration(seconds: 60);

/// 连着但多久没心跳算「停了」。留两拍余量, 不要一拍没到就报警。
const pilotNodeStaleBeat = Duration(minutes: 3);

enum PilotNodeLink { online, stale, offline }

class PilotNodeStatus {
  const PilotNodeStatus({
    this.connected = false,
    this.lastBeatAt,
    this.lastAction,
    this.lastActionAt,
    this.lastActionOk = true,
  });

  /// 中继通道此刻是不是已认证 (掉线 / 换号时 false)
  final bool connected;

  /// 最近一次 `pilot.hello` 成功回来的时刻
  final DateTime? lastBeatAt;

  /// 最近一条它推过来让手机办的动作 (工具名), 没办过 = null
  final String? lastAction;
  final DateTime? lastActionAt;

  /// 那条动作办成了没有
  final bool lastActionOk;
}

PilotNodeLink pilotNodeLink(PilotNodeStatus s, DateTime now) {
  if (!s.connected) return PilotNodeLink.offline;
  final beat = s.lastBeatAt;
  if (beat == null) return PilotNodeLink.online;
  return now.difference(beat) < pilotNodeStaleBeat ? PilotNodeLink.online : PilotNodeLink.stale;
}

/// 右边那个词
String pilotNodeLinkLabel(PilotNodeStatus s, DateTime now, {String Function(String)? t}) {
  final tr = t ?? (String x) => x;
  return switch (pilotNodeLink(s, now)) {
    PilotNodeLink.online => tr('在线'),
    PilotNodeLink.stale => tr('心跳停了'),
    PilotNodeLink.offline => tr('没连上'),
  };
}

/// 下面那行灰字: 心跳多久了
///
/// [t] 是界面翻译函数 (英文界面传 tr); 不传就按中文原样拼 —— 纯逻辑测试用它, 不依赖 i18n。
String pilotNodeBeatLabel(PilotNodeStatus s, DateTime now, {String Function(String)? t}) {
  final tr = t ?? (String x) => x;
  final beat = s.lastBeatAt;
  if (!s.connected) return beat == null ? tr('还没连上过') : '${tr('上次报到')} ${pilotAgoShort(beat, now, t: t)}';
  if (beat == null) return tr('刚连上');
  final age = now.difference(beat);
  if (age < pilotNodeFreshBeat) return '${tr('心跳正常')} · ${pilotAgoShort(beat, now, t: t)}';
  if (age < pilotNodeStaleBeat) return '${tr('心跳')} ${pilotAgoShort(beat, now, t: t)} · ${tr('有点久')}';
  return '${tr('心跳停在')} ${pilotAgoShort(beat, now, t: t)}';
}

/// 最近替它办的事: 一句人话 + 多久以前 (+ 没办成)
String pilotNodeActionLabel(PilotNodeStatus s, DateTime now, {String Function(String)? t}) {
  final tr = t ?? (String x) => x;
  final tool = s.lastAction;
  final at = s.lastActionAt;
  if (tool == null || tool.isEmpty || at == null) return tr('还没替它办过事');
  final base = '${pilotActionName(tool, t: t)} · ${pilotAgoShort(at, now, t: t)}';
  return s.lastActionOk ? base : '$base · ${tr('没办成')}';
}

/// 工具名 → 用户看得懂的动作名。手机工具在 core/local_agent/tools/phone_tools.dart。
String pilotActionName(String tool, {String Function(String)? t}) {
  final tr = t ?? (String x) => x;
  return switch (tool) {
    'phone_call' => tr('打电话'),
    'send_sms' => tr('发短信'),
    'read_sms' => tr('看短信'),
    'contacts_search' => tr('查联系人'),
    'phone_calendar' => tr('看日历'),
    'set_alarm' => tr('定闹钟'),
    'get_location' => tr('定位'),
    'open_app' => tr('打开 App'),
    'read_notifications' => tr('看通知'),
    'sensors' => tr('读传感器'),
    'phone_ui' => tr('操作手机'),
    'camera' => tr('拍照'),
    _ => tool.isEmpty ? tr('办事') : tool,
  };
}

/// 「刚刚 / 12 秒前 / 3 分钟前」—— 只做界面用, 不参与判断
String pilotAgoShort(DateTime at, DateTime now, {String Function(String)? t}) {
  final tr = t ?? (String x) => x;
  final d = now.difference(at);
  if (d.isNegative || d.inSeconds < 5) return tr('刚刚');
  if (d.inSeconds < 60) return tr('${d.inSeconds} 秒前');
  if (d.inMinutes < 60) return tr('${d.inMinutes} 分钟前');
  if (d.inHours < 24) return tr('${d.inHours} 小时前');
  return tr('${d.inDays} 天前');
}

/// 心跳 / 连接 / 最近动作的唯一写入口。云端连接 (NeoxPilotCloud) 往里写, 连接页读。
class PilotNodeStatusNotifier extends Notifier<PilotNodeStatus> {
  @override
  PilotNodeStatus build() => const PilotNodeStatus();

  void markConnected(bool connected) {
    if (state.connected == connected) return;
    state = PilotNodeStatus(
      connected: connected,
      lastBeatAt: state.lastBeatAt,
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
      lastActionOk: state.lastActionOk,
    );
  }

  void markBeat([DateTime? at]) {
    state = PilotNodeStatus(
      connected: state.connected,
      lastBeatAt: at ?? DateTime.now(),
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
      lastActionOk: state.lastActionOk,
    );
  }

  /// 它推过来让手机办的一条动作 (phone.exec)。没办成也要记 —— 用户要知道上次没成。
  void markAction(String tool, {bool ok = true, DateTime? at}) {
    if (tool.isEmpty) return;
    state = PilotNodeStatus(
      connected: state.connected,
      lastBeatAt: state.lastBeatAt,
      lastAction: tool,
      lastActionAt: at ?? DateTime.now(),
      lastActionOk: ok,
    );
  }
}

final pilotNodeStatusProvider = NotifierProvider<PilotNodeStatusNotifier, PilotNodeStatus>(PilotNodeStatusNotifier.new);
