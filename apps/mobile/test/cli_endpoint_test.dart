// CLI 终端入口: 子密钥派生必须跟电脑端 (Node crypto.hkdfSync) 逐字节一致, 伪设备 id 拆装要对。
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/crypto/x25519_hkdf.dart';
import 'package:neox_app/core/network/cli_endpoint_id.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

void main() {
  test('deriveCliEndpointKey matches desktop/CLI (Node hkdfSync)', () async {
    final key = await X25519Hkdf.instance.deriveCliEndpointKey(List<int>.filled(32, 7));
    /* node -e "crypto.hkdfSync('sha256', Buffer.alloc(32,7), Buffer.alloc(0), 'neox-cli-endpoint-v1', 32)" */
    expect(_hex(key), '2a6da374e0b1faabdaec879f628eb4de5e7d887dd22027c352f9a63826db8f52');
  });

  test('cli endpoint id round-trip and labels', () {
    final id = makeCliEndpointId('mac-1', 'cli:ab12');
    expect(isCliEndpointId(id), isTrue);
    expect(parseCliEndpointId(id)?.desktopDeviceId, 'mac-1');
    expect(parseCliEndpointId(id)?.endpoint, 'cli:ab12');
    expect(parseCliEndpointId('mac-1'), isNull);
    expect(computerOfSession(id), 'mac-1');
    expect(sessionSourceLabel(id, {'mac-1'}), '终端');
    expect(sessionSourceLabel('mac-1', {'mac-1'}), '客户端');
    expect(sessionSourceLabel('mac-2', {'mac-1'}), isNull);
  });
}
