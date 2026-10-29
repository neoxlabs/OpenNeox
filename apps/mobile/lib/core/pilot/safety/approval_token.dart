/// approval_token.dart — 节点写动作的批准令牌 (pilot D-01, 2026-10-18).
///
/// 云端 / 电脑推来的 `phone.exec` 以前一律免确认 (confirm 恒为 true): 日历写入、设置改动、
/// phone_ui 里的点按, 只要推过来就执行。现在写动作必须带 `approval`:
///
///   `v1.<base64url(payload)>.<base64url(hmac)>`   key = 通道共享的 relaySessionKey
///   payload = `{"t":"phone","a":"send_sms","d":"<sha256(参数)>","e":过期毫秒,"n":"nonce"}`
///
/// 验签用 `package:crypto` 的同步 HMAC-SHA256 (跟 `core/crypto/hmac.dart` 同一个库)。
/// 线格式与 TS 侧 `packages/core/src/services/pilotApproval.ts` 逐字节一致:
/// 两边的测试用同一组固定向量, 谁改坏了编码都会红。
library;

import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

const String approvalVersion = 'v1';
const int approvalTtlMs = 10 * 60 * 1000;

/// 写动作 = 会改变现实的: 发短信 / 打电话 / 定闹钟 / 往日历里加 / 在别的 App 里点按和填字。
/// 读动作 (read_sms / contacts_search / get_location / read_notifications / sensors / snapshot) 不要令牌。
/// batch 整批按写动作处理: 里面可能含点按 / 填字, 令牌绑定整组 steps, 少一步都验不过。
const Set<String> _writeActions = {'send_sms', 'phone_call', 'set_alarm', 'phone_calendar', 'phone_ui', 'batch'};
const Map<String, Set<String>> _writeOps = {
  'phone_calendar': {'add'},
  'phone_ui': {'tap', 'tap_at', 'type'},
};

class ApprovalToken {
  const ApprovalToken({
    required this.tool,
    required this.action,
    required this.digest,
    required this.expiresAt,
    required this.nonce,
  });

  final String tool;
  final String action;
  final String digest;
  final int expiresAt;
  final String nonce;
}

/// 这个动作要不要批准令牌
bool requiresApproval(String action, [Map<String, Object?> args = const {}]) {
  if (!_writeActions.contains(action)) return false;
  final ops = _writeOps[action];
  if (ops == null) return true;
  return ops.contains(args['op']);
}

/// 稳定序列化: 键排序、丢掉 null 以外的无关值 —— 必须跟 TS 的 canonicalJson 逐字节一致
String canonicalJson(Object? value) {
  if (value == null) return 'null';
  if (value is num) return _number(value);
  if (value is String) return jsonEncode(value);
  if (value is bool) return value ? 'true' : 'false';
  if (value is List) return '[${value.map(canonicalJson).join(',')}]';
  if (value is Map) {
    final keys = value.keys.map((k) => k.toString()).toList()..sort();
    final parts = <String>[];
    for (final k in keys) {
      parts.add('${jsonEncode(k)}:${canonicalJson(value[k])}');
    }
    return '{${parts.join(',')}}';
  }
  return 'null';
}

/// JS 的 JSON.stringify 把 7.0 写成 "7", Dart 会写成 "7.0" —— 按 JS 的写法对齐
String _number(num v) {
  if (v is int) return v.toString();
  final d = v.toDouble();
  if (!d.isFinite) return 'null';
  if (d == d.truncateToDouble() && d.abs() < 1e21) return d.toInt().toString();
  return d.toString();
}

String argsDigest(Object? args) => sha256.convert(utf8.encode(canonicalJson(args ?? const {}))).toString();

String _b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
List<int>? _b64urlDecode(String s) {
  try {
    return base64Url.decode(base64Url.normalize(s));
  } catch (_) {
    return null;
  }
}

String _mac(String versioned, List<int> key) =>
    _b64url(Hmac(sha256, key).convert(utf8.encode(versioned)).bytes);

/// 签发 —— 只在测试和「本机自己造一条请求」时用; 线上由脑子 (容器 / 配对桌面) 签
String signApproval({
  required String action,
  required Map<String, Object?> args,
  required List<int> key,
  int? nowMs,
  String? nonce,
  String tool = 'phone',
}) {
  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final payload = jsonEncode({
    't': tool,
    'a': action,
    'd': argsDigest(args),
    'e': now + approvalTtlMs,
    'n': nonce ?? _b64url(List<int>.generate(16, (_) => Random.secure().nextInt(256))),
  });
  final versioned = '$approvalVersion.${_b64url(utf8.encode(payload))}';
  return '$versioned.${_mac(versioned, key)}';
}

/// 验签: 签名不对 / 参数被改 / 过期 / 格式不对 → null
ApprovalToken? verifyApproval({
  required Object? raw,
  required String action,
  required Map<String, Object?> args,
  required List<int>? key,
  int? nowMs,
  String tool = 'phone',
}) {
  if (key == null || key.isEmpty || raw is! String || raw.isEmpty) return null;
  final parts = raw.split('.');
  if (parts.length != 3 || parts.first != approvalVersion) return null;
  final versioned = '$approvalVersion.${parts[1]}';
  final want = _mac(versioned, key);
  if (!_constantTimeEquals(parts[2], want)) return null;

  final body = _b64urlDecode(parts[1]);
  if (body == null) return null;
  Object? decoded;
  try {
    decoded = jsonDecode(utf8.decode(body));
  } catch (_) {
    return null;
  }
  if (decoded is! Map) return null;
  final t = decoded['t'];
  final a = decoded['a'];
  final d = decoded['d'];
  final e = decoded['e'];
  final n = decoded['n'];
  if (t != 'phone' && t != 'computer') return null;
  if (a is! String || d is! String || n is! String || n.isEmpty || e is! num) return null;

  final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
  final expiresAt = e.toInt();
  if (expiresAt <= now) return null;
  if (t != tool || a != action) return null;
  if (d != argsDigest(args)) return null;

  return ApprovalToken(tool: t as String, action: a, digest: d, expiresAt: expiresAt, nonce: n);
}

bool _constantTimeEquals(String a, String b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}

/// 同一个令牌只能用一次 (重放拒绝)。进程重启即清空 —— 令牌只有 10 分钟寿命。
class ApprovalNonces {
  final Map<String, int> _seen = <String, int>{};

  /// true = 第一次见到 (放行), false = 重放
  bool consume(ApprovalToken token, {int? nowMs}) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    _seen.removeWhere((_, exp) => exp <= now);
    if (_seen.containsKey(token.nonce)) return false;
    _seen[token.nonce] = token.expiresAt;
    return true;
  }
}

/// 节点入口的判定: null = 放行; 否则是拒绝理由 (给大脑看, 让它如实告诉用户)
String? approvalProblem({
  required String? action,
  required Map<String, Object?> args,
  required Object? approval,
  required List<int>? key,
  ApprovalNonces? nonces,
  int? nowMs,
}) {
  if (action == null || action.isEmpty) return null;
  if (!requiresApproval(action, args)) return null;
  if (key == null || key.isEmpty) {
    return '这台手机没有和大脑共享的密钥, 不能执行写动作 ($action)。让用户重连一次 (needs_approval)';
  }
  final token = verifyApproval(raw: approval, action: action, args: args, key: key, nowMs: nowMs);
  if (token == null) {
    return '这个写动作没有带有效的批准令牌 ($action), 已拒绝执行 (needs_approval)。'
        '重试同一条请求不会变好: 如果是电脑 / 手机版本不一致, 让用户把两端都更新到最新版';
  }
  final store = nonces ?? _nodeNonces;
  if (!store.consume(token, nowMs: nowMs)) {
    return '这个批准令牌已经用过一次了 ($action), 拒绝重放 (needs_approval)';
  }
  return null;
}

/// 节点进程级的 nonce 表 (phone_exec.dart 每次请求共用)
final ApprovalNonces _nodeNonces = ApprovalNonces();
