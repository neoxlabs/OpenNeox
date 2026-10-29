/// run_target.dart — App 内部运行目标。
///
/// 产品层只露「手机 / 我的电脑 / 云端托管」这种人能理解的选择；
/// 技术层再落到四种目标:
///   1. phoneLocal: 手机本机运行 + NeoxCloud 模型网关
///   2. desktopLan: 手机连接同 Wi-Fi 下的电脑
///   3. desktopRelay: 手机经云中继连接自己的电脑
///   4. cloudAgent: NeoxCloud 托管 Agent
library;
import 'package:neox_app/core/i18n/tr.dart';

enum NeoxRunTarget { phoneLocal, desktopLan, desktopRelay, cloudAgent }

const String kPhoneLocalDeviceId = '__neox_phone_local__';

bool isPhoneLocalDeviceId(String? deviceId) => deviceId == kPhoneLocalDeviceId;

String runTargetTag(NeoxRunTarget target) {
  switch (target) {
    case NeoxRunTarget.phoneLocal:
      return tr('手机');
    case NeoxRunTarget.desktopLan:
      return tr('电脑 · 同 Wi-Fi');
    case NeoxRunTarget.desktopRelay:
      return tr('电脑 · 远程');
    case NeoxRunTarget.cloudAgent:
      return tr('云端');
  }
}
