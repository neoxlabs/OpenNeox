/// phone_tools.dart — Pilot 在手机上的手脚 (2026-10-01).
///
/// 两家对标 (Dots / Muse) 在手机上都只是个聊天窗口; 这里把安卓的本事交给 agent:
/// 打电话、发短信、读短信 (验证码)、联系人、系统日历、系统闹钟 / 计时、定位、开 App / 深链、看通知、
/// 传感器 (温湿度 / 光照 / 气压 / 在不在动 / 电池)、静默拍照 (DeviceSense.kt)。
/// 原生实现在 android/.../PhoneToolsBridge.kt, 走 MethodChannel `neox.phone/tools`。
///
/// 权限: 工具第一次用到哪项才要哪项。拿不到就如实回报, 不假装做成 ——
///   打电话例外: 没权限时打开拨号盘把号码填好, 你按一下就通 (并告诉模型是这样)。
/// 写动作 (打电话 / 发短信 / 往日历里加): 按审批档问你 —— 「全部放行」不问, 其余两档弹确认。
///
/// iOS 上这些都没有 (系统不给), 工具表里不出现。
library;

import 'dart:async' show unawaited;
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../../device/geo_coord.dart';
import '../phone_use_policy.dart';
import 'outward_send_guard.dart';
import 'phone_batch.dart';
import 'phone_control.dart';
import 'snapshot_diff.dart';

const _ch = MethodChannel('neox.phone/tools');

/// 宿主给的确认: true = 用户同意 (或审批档是全部放行)
typedef PhoneConfirm = Future<bool> Function(String title, String detail);

/// 安卓上才有的手机工具全家
List<sdk.AgentTool> buildPhoneTools(PhoneConfirm confirm) {
  if (!Platform.isAndroid) return const [];
  final tools = <sdk.AgentTool>[
    PhoneCallTool(confirm),
    SendSmsTool(confirm),
    ReadSmsTool(),
    ContactsTool(),
    PhoneCalendarTool(confirm),
    AlarmTool(),
    LocationTool(),
    AppsTool(),
    NotificationsTool(),
    SensorsTool(),
    CameraTool(),
    PhoneUiTool(confirm),
  ];
  /* pilot:D-05 批量动作: 一次调用里按顺序做几步, 少来回几轮 (只做 phone_ui / open_app) */
  tools.add(PhoneBatchTool((name) => tools.where((t) => t.spec.name == name).firstOrNull));
  return tools;
}

// ───────────────────────── 公共 ─────────────────────────

/// 按需要权限。两分钟没人理授权框 (人走开了) 就当没给 —— agent 那一轮不能一直挂着。
Future<bool> _ensure(List<String> perms) async {
  final r = await _ch
      .invokeMethod<Map>('ensure', {'permissions': perms})
      .timeout(const Duration(minutes: 2), onTimeout: () => null);
  return r != null && perms.every((p) => r[p] == true);
}

Future<Object?> _call(String method, [Map<String, Object?>? args]) => _ch.invokeMethod<Object?>(method, args);

sdk.ToolResult _out(Object? r) {
  if (r is Map && r['error'] != null) return sdk.ToolResult.error(r['error'].toString());
  return sdk.ToolResult.ok(jsonEncode(r));
}

String _s(Map<String, Object?> a, String k) => (a[k] as String?)?.trim() ?? '';

String _clock(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int v) => v.toString().padLeft(2, '0');
  return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}';
}

/// 短信摘要 → 一行一条 (pilot:D-10).
///
/// 原生侧只回发件方 / 时间 / 验证码 / 金额, 正文不出手机; 这里再把字段摆成人能读的一行。
/// 就算哪天桥上多带了别的字段 (比如旧的 `text`), 这个函数也只认这四样 —— 最后一道保险。
String formatSmsDigestLines(List<Object?> rows) {
  final lines = <String>[];
  for (final row in rows) {
    if (row is! Map) continue;
    final at = row['at'];
    final clock = at is int ? _clock(at) : '';
    final from = (row['from'] ?? '').toString();
    final bits = <String>[];
    final code = row['code'];
    if (code != null && code.toString().isNotEmpty) bits.add('验证码 $code');
    final amount = row['amount'];
    if (amount != null && amount.toString().isNotEmpty) bits.add('金额 $amount');
    if (bits.isEmpty) bits.add('无验证码 / 金额 (正文不出手机)');
    lines.add('[$clock] $from: ${bits.join(' · ')}');
  }
  return lines.isEmpty ? '没有符合的短信' : lines.join('\n');
}

/// 名字 → 号码: 联系人里唯一命中才用, 多个就让模型问清楚
Future<({String? number, String? name, String? error})> _resolveNumber(String who) async {
  if (RegExp(r'^[+\d][\d\s\-()]{2,}$').hasMatch(who)) return (number: who, name: null, error: null);
  if (!await _ensure(const ['android.permission.READ_CONTACTS'])) {
    return (number: null, name: null, error: '没有联系人权限, 给我号码或在系统设置里允许读联系人');
  }
  final list = await _call('contacts', {'query': who, 'limit': 5});
  if (list is! List || list.isEmpty) return (number: null, name: null, error: '联系人里没找到「$who」');
  if (list.length > 1) {
    final names = list.map((c) => (c as Map)['name']).join('、');
    return (number: null, name: null, error: '「$who」对上了好几个: $names —— 问清楚是哪一个');
  }
  final c = list.first as Map;
  final nums = (c['numbers'] as List).cast<String>();
  if (nums.length > 1) {
    return (number: null, name: c['name'] as String, error: '${c['name']} 有 ${nums.length} 个号码: ${nums.join(', ')} —— 问清楚打哪个');
  }
  return (number: nums.first, name: c['name'] as String, error: null);
}

// ───────────────────────── 电话 / 短信 ─────────────────────────

class PhoneCallTool implements sdk.AgentTool {
  PhoneCallTool(this.confirm);
  final PhoneConfirm confirm;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'phone_call',
        description: '用这台手机给别人打电话 (真实通话, 用户自己来说)。to 可以是号码或联系人名字; '
            '名字对上多个人时会让你先问清楚。没有拨打权限时会打开拨号盘把号码填好, 用户按一下就通。',
        parameters: {
          'type': 'object',
          'properties': {
            'to': {'type': 'string', 'description': '号码, 或联系人名字 (如 "王总")'},
          },
          'required': ['to'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final who = _s(args, 'to');
    if (who.isEmpty) return const sdk.ToolResult.error('to 不能为空');
    final hit = await _resolveNumber(who);
    if (hit.error != null) return sdk.ToolResult.error(hit.error!);
    final label = hit.name != null ? '${hit.name} · ${hit.number}' : hit.number!;
    if (!await confirm('打给 ${hit.name ?? hit.number}?', label)) {
      return const sdk.ToolResult.error('用户没同意拨打');
    }
    await _ensure(const ['android.permission.CALL_PHONE']);
    final r = await _call('dial', {'number': hit.number});
    if (r is Map && r['dialer'] == true) {
      return sdk.ToolResult.ok('已打开拨号盘并填好 $label, 用户按拨号键就通 (没有直接拨打的权限)');
    }
    return r is Map && r['placed'] == true ? sdk.ToolResult.ok('已拨出: $label') : _out(r);
  }
}

class SendSmsTool implements sdk.AgentTool {
  SendSmsTool(this.confirm, {OutwardSendGuard? guard}) : guard = guard ?? outwardSendGuard;
  final PhoneConfirm confirm;
  final OutwardSendGuard guard;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'send_sms',
        description: '用这台手机发短信。to 是号码或联系人名字。发出去就收不回, 内容要是用户的意思。',
        parameters: {
          'type': 'object',
          'properties': {
            'to': {'type': 'string', 'description': '号码, 或联系人名字'},
            'text': {'type': 'string', 'description': '短信内容'},
          },
          'required': ['to', 'text'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final text = _s(args, 'text');
    if (text.isEmpty) return const sdk.ToolResult.error('text 不能为空');
    final hit = await _resolveNumber(_s(args, 'to'));
    if (hit.error != null) return sdk.ToolResult.error(hit.error!);
    final number = hit.number!;
    /* 同收件人 + 同文本 2 分钟内发过就不发 (S-07) —— 先拦再问, 不给用户弹第二遍确认 */
    if (guard.isDuplicate(recipient: number, text: text)) {
      return const sdk.ToolResult.error('2 分钟内已发过同样内容, 不要重复发送');
    }
    if (!await confirm('发短信给 ${hit.name ?? hit.number}?', text)) {
      return const sdk.ToolResult.error('用户没同意发送');
    }
    if (!await _ensure(const ['android.permission.SEND_SMS'])) {
      return const sdk.ToolResult.error('没有发短信权限 (用户拒绝了授权)');
    }
    final r = await _call('sendSms', {'to': number, 'text': text});
    if (r is Map && r['sent'] == true) {
      guard.remember(recipient: number, text: text);
      return sdk.ToolResult.ok('已发给 ${hit.name ?? hit.number}');
    }
    return _out(r);
  }
}

class ReadSmsTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'read_sms',
        description: '读这台手机收到的短信 (最新在前)。办事要验证码时用: query 填 "验证码" 或发件方, since_minutes 填 5。'
            '只回发件方、时间、验证码、金额 —— 短信正文不出手机, 别的信息读不到。',
        parameters: {
          'type': 'object',
          'properties': {
            'query': {'type': 'string', 'description': '按内容或号码过滤, 可空'},
            'since_minutes': {'type': 'integer', 'description': '只看最近多少分钟, 可空'},
            'limit': {'type': 'integer', 'description': '最多几条, 默认 10'},
          },
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    if (!await _ensure(const ['android.permission.READ_SMS'])) {
      return const sdk.ToolResult.error('没有读短信权限 (用户拒绝了授权)');
    }
    final since = (args['since_minutes'] as num?)?.toInt();
    final r = await _call('readSms', {
      'query': _s(args, 'query').isEmpty ? null : _s(args, 'query'),
      'limit': (args['limit'] as num?)?.toInt() ?? 10,
      'sinceMs': since == null ? null : DateTime.now().subtract(Duration(minutes: since)).millisecondsSinceEpoch,
    });
    if (r is List) {
      if (r.isEmpty) return const sdk.ToolResult.ok('没有符合的短信');
      return sdk.ToolResult.ok(formatSmsDigestLines(r));
    }
    return _out(r);
  }
}

class ContactsTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'contacts_search',
        description: '在这台手机的通讯录里按名字或号码找人。',
        parameters: {
          'type': 'object',
          'properties': {
            'query': {'type': 'string', 'description': '名字或号码的一部分'},
          },
          'required': ['query'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    if (!await _ensure(const ['android.permission.READ_CONTACTS'])) {
      return const sdk.ToolResult.error('没有联系人权限 (用户拒绝了授权)');
    }
    final r = await _call('contacts', {'query': _s(args, 'query'), 'limit': 10});
    if (r is List && r.isEmpty) return const sdk.ToolResult.ok('没找到');
    return _out(r);
  }
}

// ───────────────────────── 日历 / 闹钟 ─────────────────────────

class PhoneCalendarTool implements sdk.AgentTool {
  PhoneCalendarTool(this.confirm);
  final PhoneConfirm confirm;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'phone_calendar',
        description: '这台手机的系统日历 (跟用户日历 App 是同一份)。op=list 看某段时间的安排; op=add 加一个日程。'
            '时间用本地时间 "YYYY-MM-DD HH:mm"。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {'type': 'string', 'enum': ['list', 'add']},
            'from': {'type': 'string', 'description': 'list: 开始, 默认现在'},
            'to': {'type': 'string', 'description': 'list: 结束, 默认往后 1 天'},
            'title': {'type': 'string', 'description': 'add: 标题'},
            'start': {'type': 'string', 'description': 'add: 开始时间'},
            'end': {'type': 'string', 'description': 'add: 结束时间, 默认开始后 1 小时'},
            'location': {'type': 'string'},
            'notes': {'type': 'string'},
          },
          'required': ['op'],
        },
      );

  DateTime? _parse(String s) => s.isEmpty ? null : DateTime.tryParse(s.replaceFirst(' ', 'T'));

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    if (!await _ensure(const ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'])) {
      return const sdk.ToolResult.error('没有日历权限 (用户拒绝了授权)');
    }
    if (_s(args, 'op') == 'add') {
      final title = _s(args, 'title');
      final start = _parse(_s(args, 'start'));
      if (title.isEmpty || start == null) return const sdk.ToolResult.error('add 要 title 和 start ("YYYY-MM-DD HH:mm")');
      final end = _parse(_s(args, 'end')) ?? start.add(const Duration(hours: 1));
      if (!await confirm('加到日历?', '$title · ${_clock(start.millisecondsSinceEpoch)}')) {
        return const sdk.ToolResult.error('用户没同意');
      }
      return _out(await _call('calendarAdd', {
        'title': title,
        'startMs': start.millisecondsSinceEpoch,
        'endMs': end.millisecondsSinceEpoch,
        'location': _s(args, 'location'),
        'notes': _s(args, 'notes'),
      }));
    }
    final from = _parse(_s(args, 'from')) ?? DateTime.now();
    final to = _parse(_s(args, 'to')) ?? from.add(const Duration(days: 1));
    final r = await _call('calendarEvents', {'fromMs': from.millisecondsSinceEpoch, 'toMs': to.millisecondsSinceEpoch});
    if (r is List) {
      if (r.isEmpty) return const sdk.ToolResult.ok('这段时间没有安排');
      return sdk.ToolResult.ok(r.map((e) {
        final m = e as Map;
        final loc = (m['location'] as String?)?.isNotEmpty == true ? ' @ ${m['location']}' : '';
        return m['allDay'] == true ? '[全天] ${m['title']}$loc' : '[${_clock(m['start'] as int)} - ${_clock(m['end'] as int)}] ${m['title']}$loc';
      }).join('\n'));
    }
    return _out(r);
  }
}

class AlarmTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'set_alarm',
        description: '在手机的系统时钟 App 里定闹钟或倒计时 (系统负责响, 不靠 Neox 开着)。'
            'op=alarm 给 hour/minute; op=timer 给 seconds。「X 分钟后提醒我做某事」这种带内容的用 schedule_reminder。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {'type': 'string', 'enum': ['alarm', 'timer']},
            'hour': {'type': 'integer'},
            'minute': {'type': 'integer'},
            'seconds': {'type': 'integer'},
            'label': {'type': 'string'},
          },
          'required': ['op'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final label = _s(args, 'label');
    if (_s(args, 'op') == 'timer') {
      final s = (args['seconds'] as num?)?.toInt() ?? 0;
      if (s <= 0) return const sdk.ToolResult.error('timer 要 seconds > 0');
      final r = await _call('setTimer', {'seconds': s, 'label': label});
      return r is Map && r['ok'] == true ? sdk.ToolResult.ok('已定 $s 秒倒计时') : _out(r);
    }
    final h = (args['hour'] as num?)?.toInt();
    final m = (args['minute'] as num?)?.toInt() ?? 0;
    if (h == null || h < 0 || h > 23 || m < 0 || m > 59) return const sdk.ToolResult.error('alarm 要 hour 0-23, minute 0-59');
    final r = await _call('setAlarm', {'hour': h, 'minute': m, 'label': label});
    return r is Map && r['ok'] == true
        ? sdk.ToolResult.ok('已定闹钟 ${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}')
        : _out(r);
  }
}

// ───────────────────────── 定位 / App / 通知 ─────────────────────────

class LocationTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'get_location',
        description: '这台手机现在在哪 (经纬度)。问附近、路程、天气时先拿它。',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final ok = await _ensure(const ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'])
        .catchError((_) => false);
    if (!ok) {
      /* 只给了大概位置也能用 —— status 里看实际拿到了什么 */
      final st = await _call('status');
      if (st is! Map || st['location'] != true) return const sdk.ToolResult.error('没有定位权限 (用户拒绝了授权)');
    }
    final r = await _call('location');
    if (r is Map && r['lat'] != null) {
      final age = DateTime.now().millisecondsSinceEpoch - (r['at'] as int);
      final when = r['fresh'] == true ? '刚定位' : '${(age / 60000).round()} 分钟前的位置';
      final lat = (r['lat'] as num).toDouble(), lng = (r['lng'] as num).toDouble();
      String f(double v) => v.toStringAsFixed(6);
      final out = StringBuffer('精度约 ${(r['accuracyM'] as num).round()} 米, $when\n');
      /* 地址先给: 模型拿着一对经纬度只能猜在哪 (2026-10-11 用户实拍: 算路程算偏了) */
      final addr = await _call('address', {'lat': lat, 'lng': lng}).catchError((_) => null);
      /* 系统地理编码有时在最前面带一段 Plus Code (WC83+2H9), 对人没用 */
      final cleanAddr = addr is String
          ? addr.replaceFirst(RegExp(r'^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}[,，]?\s*'), '').trim()
          : '';
      if (cleanAddr.isNotEmpty) out.writeln('地址: $cleanAddr');
      if (needsGcj02(lat, lng)) {
        /* 中国大陆: 系统给的是 GPS 原始坐标, 国内地图要 GCJ-02, 直接用会偏几百米 */
        final (gLat, gLng) = wgs84ToGcj02(lat, lng);
        final (bLat, bLng) = gcj02ToBd09(gLat, gLng);
        out
          ..writeln('坐标 (高德 / 腾讯 / geo: 导航 / 国内地图用这个, GCJ-02): ${f(gLat)}, ${f(gLng)}')
          ..writeln('坐标 (百度地图, BD-09): ${f(bLat)}, ${f(bLng)}')
          ..writeln('坐标 (GPS 原始 WGS-84, 只给海外服务 / 算直线距离用): ${f(lat)}, ${f(lng)}')
          ..write('在中国大陆: 拼地图链接、查附近、算路程一律用 GCJ-02 那组。');
      } else {
        out.write('坐标 (WGS-84): ${f(lat)}, ${f(lng)}');
      }
      return sdk.ToolResult.ok(out.toString());
    }
    return _out(r);
  }
}

class AppsTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'open_app',
        description: '打开手机上的 App 或链接。op=list 按名字找装了哪些 App (拿包名); op=open 用包名打开; '
            'op=uri 打开链接或深链 —— 导航用 "geo:0,0?q=目的地", 网页用 https://, 也可以是 App 自己的 scheme。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {'type': 'string', 'enum': ['list', 'open', 'uri']},
            'query': {'type': 'string', 'description': 'list: 名字关键字'},
            'package': {'type': 'string', 'description': 'open: 包名'},
            'uri': {'type': 'string', 'description': 'uri: 要打开的链接'},
          },
          'required': ['op'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    switch (_s(args, 'op')) {
      case 'list':
        final r = await _call('apps', {'query': _s(args, 'query')});
        if (r is List && r.isEmpty) return const sdk.ToolResult.ok('没找到这样的 App');
        return _out(r);
      case 'open':
        /* 一跳出 Neox 悬浮层就亮着 (用户: 「操控的情况下没有全程都有悬浮层」); 只打开不点按的, 结束时不拉回 */
        unawaited(PhoneControl.begin('打开 App', control: false));
        final r = await _call('openApp', {'package': _s(args, 'package')});
        return r is Map && r['ok'] == true ? const sdk.ToolResult.ok('已打开') : _out(r);
      case 'uri':
        final r = await _call('openUri', {'uri': _s(args, 'uri')});
        return r is Map && r['ok'] == true ? const sdk.ToolResult.ok('已打开') : _out(r);
    }
    return const sdk.ToolResult.error('op 只能是 list / open / uri');
  }
}

class NotificationsTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'read_notifications',
        description: '看这台手机最近收到的通知 (微信、外卖、快递、银行…), 最新在前。'
            '只有 Neox 运行后收到的才有; 用户没给「通知使用权」时会打开授权页。',
        parameters: {
          'type': 'object',
          'properties': {
            'limit': {'type': 'integer', 'description': '最多几条, 默认 20'},
          },
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final st = await _call('status');
    if (st is Map && st['notifications'] != true) {
      await _call('openNotificationAccess');
      return const sdk.ToolResult.error('还没有通知使用权, 已打开系统授权页, 请用户打开 Neox Pilot 那一项后再试');
    }
    final r = await _call('notifications', {'limit': (args['limit'] as num?)?.toInt() ?? 20});
    if (r is List) {
      if (r.isEmpty) return const sdk.ToolResult.ok('还没收到通知');
      return sdk.ToolResult.ok(r.map((n) {
        final m = n as Map;
        return '[${_clock(m['at'] as int)}] ${m['app']} · ${m['title']}: ${m['text']}';
      }).join('\n'));
    }
    return _out(r);
  }
}

// ───────────────────────── 感知: 传感器 / 相机 ─────────────────────────

class SensorsTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'sensors',
        description: '读这台手机的传感器: 环境温度 / 湿度 / 光照 / 气压 / 距离 (是不是在口袋里) / 在不在动, 以及电量、是否在充电、电池温度。'
            '大多数手机没有温湿度传感器, 没有的会列在 missing 里 —— 那时说不知道, 别拿电池温度当气温。',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async => _out(await _call('sensors'));
}

/// 代你在别的 App 里点 (NeoxAccessibilityService.kt)。用户在 设置 → 无障碍 打开后才能用。
class PhoneUiTool implements sdk.AgentTool {
  PhoneUiTool(this._confirm, {SnapshotDiff? diff}) : _diff = diff ?? snapshotDiff;
  final PhoneConfirm _confirm;
  /// 上一次给模型看的那一屏 (pilot:D-04 增量读屏). 换 App / 翻页 / 出错就清空
  final SnapshotDiff _diff;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'phone_ui',
        description: 'Phone Use: 像人一样操作手机上的 App (读微信 / QQ 聊天、点外卖、叫车、查订单、改设置)。先用 open_app 打开目标 App, 再: '
            'op=snapshot 看当前屏幕, 控件带编号 (同一个界面再看一次只回变了的控件, 没变的显示成 [3-12] 同上, 编号照样能点; '
            '上下文里没有上一屏时用 full=true 要整屏); op=tap target=编号 点它; op=type target=编号 text=… 往输入框填字; '
            'op=scroll direction=down|up; op=back / home; op=screenshot 截图看 (控件读不出字、或要看图片 / 表情 / 文件卡片时), 再 op=tap_at x y expect=按钮上的字 按截图坐标点 '
            '(expect 会先对一遍: 坐标上现在读到的不是这几个字就拒点, 说明界面改版了, 重截一张再看)。'
            'op=read_text pages=N direction=up: 读一整段 —— 往上翻 N 屏 (默认 3, 最多 15), 把文字按时间顺序拼好, 每行标「对方 / 我 / ·(时间、系统提示)」, '
            '[方括号] 里是头像 / 图片 / 语音的描述 (群聊里「张三头像」后面那句就是张三说的)。\n'
            '读微信 (com.tencent.mm) / QQ (com.tencent.mobileqq): open_app → 首页 read_text pages=1 看最近会话和未读 → tap 那个会话 → read_text pages=3 读聊天 → '
            '有图片要看再 screenshot。找不到会话就点顶部搜索 type 名字。读完 back 回去, 别停在别人的聊天里。'
            '⚠️ QQ / 微信首页的会话列表别往下拉 (scroll up / read_text 往上翻) —— 会拉出小程序面板; 已经拉出来了就 op=back 收回去。\n'
            '多个任务 (先看 QQ 再去 B 站) 一件做完再开下一个 App, 不用回 Neox, 直接 open_app 下一个。\n'
            '每个动作完成后会自动返回新的屏幕。要付钱 / 提交订单的按钮、聊天 App 里的「发送」都会被拦下: 先 report_to_user(blocked) 说清楚让用户拍板, 同意后带 confirmed=true 再点。'
            '用户在「设置 → Phone Use」里可以限定哪些 App 能碰, 被拦了就如实告诉用户。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {'type': 'string', 'enum': ['snapshot', 'read_text', 'tap', 'tap_at', 'type', 'scroll', 'back', 'home', 'screenshot']},
            'pages': {'type': 'integer', 'description': 'read_text: 翻几屏 (1~15)'},
            'target': {'type': 'integer', 'description': 'snapshot 里的编号'},
            'text': {'type': 'string'},
            'direction': {'type': 'string', 'enum': ['down', 'up']},
            'x': {'type': 'number', 'description': 'tap_at: 截图上的横坐标 (像素)'},
            'y': {'type': 'number'},
            'expect': {'type': 'string', 'description': 'tap_at: 你从截图上看到的按钮 / 文字。坐标上读到的对不上就拒点 (App 改版时防止点错)'},
            'confirmed': {'type': 'boolean', 'description': '用户已经同意付钱 / 下单'},
            'full': {'type': 'boolean', 'description': 'snapshot: 忽略增量, 回整屏控件'},
          },
          'required': ['op'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final op = _s(args, 'op');
    /* 全局悬浮层「Neox 正在操控 · 在读内容」+ 停止 (ControlOverlay.kt): 每一步之前就亮, 整个操控过程不断 */
    unawaited(PhoneControl.begin(PhoneControl.stepOf(op)));
    final call = <String, Object?>{'op': op, ...args, ...(await PhoneUsePolicy.load()).toArgs()}
      ..remove('full'); // full 是本地的增量开关, 原生不认
    /* 截图坐标 → 屏幕坐标: 截图被缩到长边 1280, 模型按截图像素给, 这里乘回去 */
    if (op == 'tap_at' && _lastShotScale > 0 && _lastShotScale < 1) {
      call['x'] = ((args['x'] as num?) ?? 0) / _lastShotScale;
      call['y'] = ((args['y'] as num?) ?? 0) / _lastShotScale;
    }
    var r = await _call('ui', call);
    /* 不在允许名单 → 问用户一次 (2026-10-12 用户: 「不在允许名单里, 就让用户授权, 授权完下次就畅通无阻」):
     * 回到 Neox 弹框 → 同意就加进允许名单 → 重新打开那个 App, 接着做刚才这一步 */
    if (r is Map && r['needs_grant'] == true) {
      final pkg = '${r['package'] ?? ''}';
      final label = '${r['label'] ?? pkg}';
      await PhoneControl.bringNeoxFront();
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final ok = await _confirm(
        '允许 Neox 操作「$label」?',
        'Agent 要在「$label」里帮你看屏幕、点按。允许后以后就不再问; 随时可以在 设置 → Phone Use 里移除。\n'
            '在聊天 App 里发消息、在任何 App 里付钱, 仍然每次都会先问你。',
      );
      if (!ok) {
        /* pilot:D-11 记住拒绝: 用户这一次说不, 就记进禁止名单 —— 下次不再弹, 也不再骚扰用户。
         * 要改回来去 设置 → Phone Use → 禁止名单 移除。 */
        await (await PhoneUsePolicy.load()).refused(pkg).save();
        return sdk.ToolResult.error('用户没有允许操作「$label」, 已记下这个决定: 以后不会再问, 也别再试这个 App; '
            '如实告诉用户已记进 设置 → Phone Use 的禁止名单, 想改在那里移除');
      }
      final pol = await PhoneUsePolicy.load();
      if (!pol.allow.contains(pkg)) await pol.copyWith(allow: [...pol.allow, pkg]).save();
      unawaited(PhoneControl.begin(PhoneControl.stepOf(op)));
      await _call('openApp', {'package': pkg});
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      r = await _call('ui', {...call, ...(await PhoneUsePolicy.load()).toArgs()});
    }
    if (r is Map && r['error'] == 'not_enabled') {
      _diff.reset();
      await _call('openAccessibilitySettings');
      return const sdk.ToolResult.error('还没开「无障碍」里的 Neox Pilot, 已在手机上打开设置页: 请用户找到 Neox Pilot 打开后再试 (只需开一次)');
    }
    if (r is! Map) return _out(r);
    if (r['error'] != null) {
      /* 出错 (多半是编号过期 / 点了没反应): 下一步该重读屏幕, 那就给它整屏而不是「同上」 */
      _diff.reset();
      /* 被禁止名单拦下 = 没在操控, 收起 (不拉回, 让模型自己说明) */
      if (r['blocked'] == true) unawaited(PhoneControl.end(returnHome: false));
      return sdk.ToolResult.error(r['error'].toString());
    }
    if (r['path'] != null) {
      _lastShotScale = (r['scale'] as num?)?.toDouble() ?? 1;
      return sdk.ToolResult.ok(jsonEncode({'photo_path': r['path'], 'width': r['width'], 'height': r['height']}));
    }
    if (op == 'read_text') {
      _diff.reset(); // 翻过页了, 旧编号作废
      final t = '${r['text'] ?? ''}'.trim();
      return sdk.ToolResult.ok('「${r['app']}」翻了 ${r['pages']} 屏${r['truncated'] == true ? ' (太长, 只留最近的)' : ''}:\n'
          '${t.isEmpty ? '(这一屏读不出文字, 用 screenshot 看图)' : t}\n(读完翻页了, 要点按先 snapshot 拿新编号)');
    }
    /* pilot:D-04 同一个界面再看一次, 只把变了的控件发出去; 没变的那几段折叠成「[3-12] 同上」 */
    final snap = _diff.apply(
      appKey: '${r['package'] ?? r['app'] ?? ''}',
      elements: '${r['elements'] ?? ''}',
      full: args['full'] == true,
    );
    final head = [
      if (r['did'] != null) '${r['did']}。',
      '现在在「${r['app']}」, 屏幕上 ${r['count']} 个控件:',
    ].join(' ');
    final note = snap.incremental
        ? '\n(这次只列变了的 ${snap.changed} 个控件: [3-12] 同上 = 编号和上次一样、内容没变, 照样能点; 要整屏用 full=true)'
        : '';
    /* 点完自检 (pilot:D-07): 前台 App 换人了就如实说, 别让模型按原计划继续 */
    final warn = r['warning'] != null ? '\n(自检: ${r['warning']})' : '';
    return sdk.ToolResult.ok('$head\n${snap.text}$note$warn${r['hint'] != null ? '\n(${r['hint']})' : ''}');
  }

  static double _lastShotScale = 1;
}

class CameraTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'camera',
        description: '用这台手机静默拍一张照片 (不弹相机界面), 看用户眼前 / 身边是什么。facing=back 后摄 (默认), front 前摄。'
            '手机得在用户手上、Neox 开着 (安卓不许后台开相机)。拍别人或私密场合前先问。',
        parameters: {
          'type': 'object',
          'properties': {
            'facing': {'type': 'string', 'enum': ['back', 'front']},
          },
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    if (!await _ensure(const ['android.permission.CAMERA'])) return const sdk.ToolResult.error('没有相机权限 (用户拒绝了授权)');
    final r = await _call('takePhoto', {'front': _s(args, 'facing') == 'front'});
    if (r is Map && r['path'] != null) {
      /* photo_path: 电脑上的 Pilot 经 phone.exec 调用时, phone_exec.dart 认这个字段把图片一起传回去 */
      return sdk.ToolResult.ok(jsonEncode({'photo_path': r['path'], 'width': r['width'], 'height': r['height']}));
    }
    return _out(r);
  }
}
