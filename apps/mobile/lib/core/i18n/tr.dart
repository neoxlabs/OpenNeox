/* 界面文案英文化 (2026-09-24)
 *
 * 为什么不是 .arb + gen-l10n:
 *   全 app 1300 多条中文硬编码在 127 个文件里, 逐条改成 key 引用改动面太大、容易漏。
 *   这里用"中文原文即 key": 代码里写 tr('中文'), 界面语言是中文时原样返回,
 *   是英文时查 en_strings.dart 的对照表。没翻到的条目退回中文原文 (不会显示成 key)。
 *
 * 带插值的句子 (tr('已用 $pct%')): 调用时拿到的是插值后的整句,
 *   对照表里的 key 用 {} 占位 ('已用 {}%'), 这里编译成正则按位置取值, 填进英文模板。
 *   英文语序不同时英文模板用 {0} {1} 指定取第几个。
 *
 * 语言来源: 系统 (或 Android 13+ 的单应用语言) —— 以 zh 开头用中文, 其余一律英文。
 * 只翻界面文案; 日志、正则、比较用的中文、发给模型的提示词都不经过这里。 */
import 'dart:ui' show PlatformDispatcher;

import 'en_strings.dart';

/// 测试用: 固定界面语言 ('zh' / 'en')。flutter test 默认 en-US, 而现有测试断言的是中文文案,
/// test/flutter_test_config.dart 里统一设成 'zh'; 要测英文的用例自己改成 'en' 再还原。
String? debugUiLanguageOverride;

bool get isEnglishUi {
  final forced = debugUiLanguageOverride;
  if (forced != null) return forced != 'zh';
  final locales = PlatformDispatcher.instance.locales;
  final code = locales.isEmpty ? 'zh' : locales.first.languageCode;
  return code != 'zh';
}

final Map<String, String> _memo = {};
List<(RegExp, String)>? _templates;

List<(RegExp, String)> _compileTemplates() {
  /* 固定字越多的模板越先试: 按表里的顺序取第一个命中时, 「已用 {}」会先吞掉「已用 7 秒」,
   * 英文界面出来是「7 秒 used」 */
  final all = kEnStrings.keys.where((zh) => zh.contains('{}')).toList();
  final order = {for (var i = 0; i < all.length; i++) all[i]: i};
  /* 同长度保持表内原顺序 (List.sort 不稳定) */
  final keys = all
    ..sort((a, b) {
      final d = b.replaceAll('{}', '').length.compareTo(a.replaceAll('{}', '').length);
      return d != 0 ? d : order[a]!.compareTo(order[b]!);
    });
  return [
    for (final zh in keys)
      (RegExp('^${zh.split('{}').map(RegExp.escape).join('([\\s\\S]*?)')}\$'), kEnStrings[zh]!),
  ];
}

/* 中文量词不分单复数, 英文模板统一写复数; 填进去的数恰好是 1 时改回单数 ("1 devices" → "1 device") */
final _singular = RegExp(
  r'(?<![\d.,])1 (device|day|hour|minute|second|model|line|range|question|agent|step|action|time|file|command|task|session|token)s\b',
);

String _fill(String en, List<String> values) {
  var auto = 0;
  return en
      .replaceAllMapped(RegExp(r'\{(\d*)\}'), (m) {
        final idx = m.group(1)!.isEmpty ? auto++ : int.parse(m.group(1)!);
        return idx < values.length ? values[idx] : '';
      })
      .replaceAllMapped(_singular, (m) => '1 ${m.group(1)}');
}

/// 界面文案: 中文界面原样返回, 英文界面返回对照译文 (没有译文时退回原文)。
String tr(String zh) {
  if (!isEnglishUi) return zh;
  final exact = kEnStrings[zh];
  if (exact != null) return exact;
  final cached = _memo[zh];
  if (cached != null) return cached;
  for (final (re, en) in (_templates ??= _compileTemplates())) {
    final m = re.firstMatch(zh);
    if (m != null) {
      final values = [for (var i = 1; i <= m.groupCount; i++) m.group(i) ?? ''];
      final r = _fill(en, values);
      if (_memo.length > 2000) _memo.clear();
      return _memo[zh] = r;
    }
  }
  return zh;
}

/// 星期几 (DateTime.weekday 1..7): 中文「周一」, 英文「Mon」。
/// 原来六个地方各写一份 `'周${['一', …][w - 1]}'`, 英文界面全是「周三」(2026-10-14 补译时统一)。
String trWeekday(int weekday) => isEnglishUi
    ? const ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekday - 1]
    : '周${const ['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}';
