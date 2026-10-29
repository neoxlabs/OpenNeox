import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/ws_client_provider.dart';
import 'package:neox_app/features/home/state/connection_guard.dart';

WsClientState ws(
  WsConnectionState c, {
  String? desktop = 'mac',
  WsTransport t = WsTransport.lan,
}) =>
    WsClientState(connection: c, transport: t, activeDesktopDeviceId: desktop);

ConnectionGuardAction decide(WsClientState? prev, WsClientState next,
        {String? session = 'mac'}) =>
    decideConnectionGuard(prev: prev, next: next, sessionDesktopId: session);

void main() {
  const connected = WsConnectionState.connected;
  const connecting = WsConnectionState.connecting;
  const error = WsConnectionState.error;
  const disconnected = WsConnectionState.disconnected;

  group('断线', () {
    test('连着 → 断了: 开始宽限, 不立刻踢 (Wi-Fi 抖一下不该把人赶回首页)', () {
      expect(decide(ws(connected), ws(error)), ConnectionGuardAction.startGrace);
    });

    test('重连中失败 (connecting → error) 也算断线的一跳', () {
      expect(decide(ws(connecting), ws(error)), ConnectionGuardAction.startGrace);
    });

    test('慢速档落成 disconnected 同样开始宽限', () {
      expect(decide(ws(connected), ws(disconnected)),
          ConnectionGuardAction.startGrace);
    });

    test('宽限期内连回来 → 取消', () {
      expect(decide(ws(connecting), ws(connected)),
          ConnectionGuardAction.cancelGrace);
    });

    test('正在重连不开始也不取消', () {
      expect(decide(ws(error), ws(connecting)), ConnectionGuardAction.none);
    });

    test('本来就没连着 (断网时自己点开看历史) 不管', () {
      expect(decide(ws(disconnected), ws(disconnected)),
          ConnectionGuardAction.none);
      expect(decide(ws(error), ws(error)), ConnectionGuardAction.none);
    });
  });

  group('换电脑 / 主动断开', () {
    test('连到另一台电脑 → 立刻离开 (屏幕上不能还是上一台的对话)', () {
      expect(decide(ws(connected), ws(connecting, desktop: 'win')),
          ConnectionGuardAction.leaveNow);
    });

    test('用户主动断开 (状态重置, 设备 id 清空) → 立刻离开', () {
      expect(decide(ws(connected), WsClientState.initial),
          ConnectionGuardAction.leaveNow);
    });

    test('设备 id 没变 (同一台重连) 不算换电脑', () {
      expect(decide(ws(error), ws(connected)), ConnectionGuardAction.cancelGrace);
    });

    test('只看变化: 连着 B 时打开 A 上的会话, 没有变化就不踢', () {
      expect(
        decide(ws(connected, desktop: 'win'), ws(connected, desktop: 'win')),
        ConnectionGuardAction.none,
      );
    });
  });

  group('不受电脑连接影响的会话', () {
    test('没有会话 / 手机本地 / 云端 / 画布 (sessionDesktopId=null)', () {
      expect(decide(ws(connected), ws(error), session: null),
          ConnectionGuardAction.cancelGrace);
      expect(decide(ws(connected), WsClientState.initial, session: null),
          ConnectionGuardAction.cancelGrace);
    });

    test('云端 agent 连接的变化不碰电脑会话', () {
      expect(
        decide(ws(connected),
            ws(connected, desktop: 'cloud', t: WsTransport.cloudAgent)),
        ConnectionGuardAction.none,
      );
    });
  });

  group('projectBelongsToOtherDesktop', () {
    test('项目在 mac 上, 现在连的是 win → 是别的电脑的', () {
      expect(
        projectBelongsToOtherDesktop(
            projectDesktopId: 'mac', ws: ws(connected, desktop: 'win')),
        isTrue,
      );
    });

    test('同一台 / 老数据没记电脑 / 还没连上任何电脑 → 不算', () {
      expect(projectBelongsToOtherDesktop(projectDesktopId: 'mac', ws: ws(connected)),
          isFalse);
      expect(projectBelongsToOtherDesktop(projectDesktopId: null, ws: ws(connected, desktop: 'win')),
          isFalse);
      expect(projectBelongsToOtherDesktop(projectDesktopId: 'mac', ws: WsClientState.initial),
          isFalse);
    });
  });
}
