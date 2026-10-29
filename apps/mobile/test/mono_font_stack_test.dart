/// 等宽字体必须走 NeoxMono, 不许各处写死 'monospace'.
///
/// 2026-09-18: 仓里 31 处各自写 `fontFamily: 'monospace'`。那是 **Android** 的通用族名,
/// Flutter 在 **iOS 上解析不了它** —— 行内代码、工具参数、配对码这些地方在 iOS 上会静默
/// 退回系统默认字体, 等宽外观全丢 (代码和路径挤在一起, 对不齐也认不出)。
///
/// 它不报错、不崩、类型也对, 只是长得不对 —— 所以在 Android 上开发的人永远看不到。
/// 判据: 除了 NeoxMono 自己的定义, 源码里不许再出现裸的 'monospace'。
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/shared/theme/neox_tokens.dart';

void main() {
  test('源码里不许再写死 fontFamily: \'monospace\'', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      /* NeoxMono 自己要写那个字面量 (它就是那条唯一真相) */
      if (f.path.endsWith('shared/theme/neox_tokens.dart')) continue;
      final src = f.readAsStringSync();
      for (final (i, line) in src.split('\n').indexed) {
        if (RegExp(r"""fontFamily:\s*['"]monospace['"]""").hasMatch(line)) {
          offenders.add('${f.path}:${i + 1}');
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          '这些地方写死了 Android 的族名, iOS 上会退回非等宽字体。\n'
          '改成 fontFamily: NeoxMono.family + fontFamilyFallback: NeoxMono.fallback\n  '
          '${offenders.join('\n  ')}',
    );
  });

  _semanticColorGate();

  test('回退链里必须有 iOS 能用的等宽字体', () {
    /* 少了这个, iOS 上整条链都落不到实处 —— 这道闸就只是换了个写法而已 */
    expect(NeoxMono.fallback, contains('Menlo'));
    expect(NeoxMono.family, 'monospace');
    expect(NeoxMono.fallback, isNotEmpty);
  });
}

/// 语义色也不许写死 Material 的 shadeN.
///
/// 2026-09-18: 仓里 16 处写 `Colors.green.shade700` / `Colors.red.shade700` /
/// `Colors.orange.shade700`。Material 的 shadeN **深浅主题下是同一个值** ——
/// #388E3C 在浅底 (#F5F5F4) 上对比 4.3 勉强够, 放到近黑底 (#0F0F0F) 上只剩 3.0。
/// 而这几个颜色正是工具卡的 ✓/✗、diff 的 +/− 的唯一区分: 深色下变成"看得见但读不准"。
///
/// 改成 ColorScheme 的 okInk / errInk / warnInk (按 brightness 给两套值)。
void _semanticColorGate() {
  test('语义色走主题, 不写死 Colors.xxx.shadeN', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      final src = f.readAsStringSync();
      for (final (i, line) in src.split('\n').indexed) {
        /* 注释里可以引用这些名字来解释历史 */
        final t = line.trimLeft();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        if (RegExp(r'Colors\.(green|red|orange)\.shade\d+').hasMatch(line)) {
          offenders.add('${f.path}:${i + 1}');
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          '这些颜色在深色主题下对比不足 (shadeN 两个主题同一个值)。\n'
          '用 scheme.okInk / scheme.errInk / scheme.warnInk\n  '
          '${offenders.join('\n  ')}',
    );
  });
}
