/// phone_tools_main.dart — 手机工具真机/模拟器自测 (仅开发用, 不进正式入口).
///
///   flutter run -t lib/dev/phone_tools_main.dart
///
/// 不走模型: 按钮直接调每个工具的 run(), 结果打在屏上和日志 ([phone-tools])。
/// 验的是原生桥、按需授权、确认框、拿不到权限时的如实回报。
library;

import 'package:flutter/material.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../core/local_agent/tools/phone_tools.dart';

final _nav = GlobalKey<NavigatorState>();

Future<bool> _confirm(String title, String detail) async {
  final ctx = _nav.currentContext;
  if (ctx == null) return false;
  final ok = await showDialog<bool>(
    context: ctx,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: Text(detail),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
        TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('好')),
      ],
    ),
  );
  return ok == true;
}

void main() => runApp(MaterialApp(navigatorKey: _nav, home: const _Probe()));

class _Probe extends StatefulWidget {
  const _Probe();
  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  final tools = {for (final t in buildPhoneTools(_confirm)) t.spec.name: t};
  final log = <String>[];

  static const cases = <(String, String, Map<String, Object?>)>[
    ('闹钟 7:30', 'set_alarm', {'op': 'alarm', 'hour': 7, 'minute': 30, 'label': 'standup'}),
    ('计时 90 秒', 'set_alarm', {'op': 'timer', 'seconds': 90, 'label': 'tea'}),
    ('定位', 'get_location', {}),
    ('找 App: clock', 'open_app', {'op': 'list', 'query': 'clock'}),
    ('导航去机场', 'open_app', {'op': 'uri', 'uri': 'geo:0,0?q=airport'}),
    ('日历: 加', 'phone_calendar', {'op': 'add', 'title': 'Pilot 测试', 'start': '2026-10-02 10:00'}),
    ('日历: 看', 'phone_calendar', {'op': 'list', 'from': '2026-10-02 00:00', 'to': '2026-10-03 00:00'}),
    ('联系人: Test', 'contacts_search', {'query': 'Test'}),
    ('打给 Test (名字)', 'phone_call', {'to': 'Test'}),
    ('打给 10086', 'phone_call', {'to': '10086'}),
    ('短信给 10086', 'send_sms', {'to': '10086', 'text': 'Pilot test'}),
    ('读短信', 'read_sms', {'limit': 3}),
    ('看通知', 'read_notifications', {'limit': 5}),
  ];

  Future<void> _run(String label, String name, Map<String, Object?> args) async {
    final t = tools[name];
    String line;
    if (t == null) {
      line = '$label → 工具不存在';
    } else {
      try {
        final r = await t.run(args, sdk.ToolContext(cancel: sdk.AgentCancelToken()));
        line = '$label → ${r.isError ? "ERR " : ""}${r.output}';
      } catch (e) {
        line = '$label → THROW $e';
      }
    }
    debugPrint('[phone-tools] $line');
    if (mounted) setState(() => log.insert(0, line));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('手机工具 ${tools.length} 个')),
        body: Column(children: [
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final c in cases)
              OutlinedButton(onPressed: () => _run(c.$1, c.$2, c.$3), child: Text(c.$1)),
          ]),
          const Divider(),
          Expanded(child: ListView(children: [for (final l in log) Padding(padding: const EdgeInsets.all(6), child: Text(l))])),
        ]),
      );
}
