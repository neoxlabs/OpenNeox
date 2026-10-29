/// onboarding_copy_test.dart — 引导页只许"简单介绍", 不许写作文.
///
/// 2026-09-18 用户原话:
///   "引导界面字体废话太多，字体偏大，组件也偏大"
///   "废话不要多 就是简单介绍 不是教育 不是写作文!!我是商业产品!"
///
/// 之前是这样的:
///   标题 '会干活的 AI，\n不只是会聊天'        ← 35px 衬线, 还硬折成两行
///   正文 '把要办的事说一句，它自己查资料、算数、读写文件，一路做到能交付为止。'  ← 17.5px 三行
/// 三页加起来是一篇说明文。用户第一次打开 app 看到的不该是课文。
///
/// 这道闸只管**量**, 不管写得好不好 —— 好不好没法自动判, 但"又变长了"可以。
/// 判据故意宽松到"正常写作绝不会碰到"的程度: 碰到了就是又开始解释了。
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 标题上限 —— 一行能放下的字数 (27px 衬线 @ 6 寸屏约 12 字)
const int _kTitleMax = 14;

/// 正文上限 —— 两行封顶
const int _kBodyMax = 26;

void main() {
  final src = File('lib/features/onboarding/onboarding_page.dart').readAsStringSync();

  /// 取 `title: '…'` / `body: '…'` 里的中文串 (只认单行字面量 —— 多行拼接本身就是超长的信号)。
  /// 2026-09-24 起文案包在 tr('…') 里 (英文化), 两种写法都认。
  List<String> literals(String field) => RegExp("$field: (?:tr\\()?'([^']*)'")
      .allMatches(src)
      .map((m) => m.group(1)!)
      .where((s) => RegExp(r'[一-鿿]').hasMatch(s))
      .toList();

  test('引导页的标题必须一行放得下', () {
    final titles = literals('title');
    expect(titles, isNotEmpty, reason: '一条都没取到 = 闸空跑了 (字段名或写法变了)');
    for (final t in titles) {
      expect(
        t.runes.length,
        lessThanOrEqualTo(_kTitleMax),
        reason: '标题「$t」超过 $_kTitleMax 字 —— 会被折成两行, 标题就占掉三行高度',
      );
      expect(
        t.contains(r'\n'),
        isFalse,
        reason: '标题「$t」写了硬换行 —— 放不下就把话说短, 不是折行',
      );
    }
  });

  test('引导页的正文最多一句话', () {
    final bodies = literals('body');
    expect(bodies, isNotEmpty, reason: '一条都没取到 = 闸空跑了');
    for (final b in bodies) {
      expect(
        b.runes.length,
        lessThanOrEqualTo(_kBodyMax),
        reason: '正文「$b」超过 $_kBodyMax 字 —— 引导页是简单介绍, 不是说明文',
      );
      /* 分号/顿号堆叠 = 在列举功能。第一次打开 app 的人不需要功能清单。 */
      final enumerating = b.split(RegExp('[；;、]')).length - 1;
      expect(
        enumerating,
        lessThanOrEqualTo(1),
        reason: '正文「$b」在列举 —— 挑最重要的一件说, 别罗列',
      );
    }
  });

  test('字号不许回到"偏大"那一档', () {
    /* 27 / 15 是 2026-09-18 定的; 直接用 headlineLarge(35) / bodyLarge(17.5) 就是回头路 */
    expect(src, contains('fontSize: 27'), reason: '标题字号被改掉了');
    expect(src, contains('fontSize: 15,'), reason: '正文字号被改掉了');
  });
}
