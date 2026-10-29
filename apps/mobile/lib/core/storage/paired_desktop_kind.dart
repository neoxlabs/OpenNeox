/// paired_desktop_kind.dart — paired_desktops 行的产品语义分类。
///
/// deviceToken 只能说明是否有 LAN 直连 token；账号自动配对的真实电脑可能
/// 只有 relaySessionKey。不要用 deviceToken=null 直接判断成 Neox Cloud。
library;

import 'database.dart';

bool isCloudAgentPairedDesktop(PairedDesktop desktop) {
  return desktop.deviceToken == null &&
      (desktop.deviceName?.startsWith('☁') ?? false);
}

bool isRealPairedDesktop(PairedDesktop desktop) {
  return !isCloudAgentPairedDesktop(desktop);
}

bool canConnectPairedDesktop(PairedDesktop desktop) {
  final hasLanToken = desktop.deviceToken?.isNotEmpty ?? false;
  final hasRelayKey = desktop.relaySessionKey?.isNotEmpty ?? false;
  return hasLanToken || hasRelayKey;
}

bool isRemoteOnlyPairedDesktop(PairedDesktop desktop) {
  return isRealPairedDesktop(desktop) &&
      !(desktop.deviceToken?.isNotEmpty ?? false) &&
      (desktop.relaySessionKey?.isNotEmpty ?? false);
}
