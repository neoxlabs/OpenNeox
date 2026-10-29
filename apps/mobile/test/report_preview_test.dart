/// report_preview_test.dart — 完成卡展开时的报告预览裁剪.
///
/// 子 agent 的 `<summary>` 常是「过程碎碎念 + 结构化报告」拼在一起, 整段铺进主
/// timeline 又长又混 (2026-07-29 真机: 一张完成卡撑了三屏)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/system_turn_card.dart';

void main() {
  test('有标题时从第一个标题起 — 过程铺垫被剥掉', () {
    const src = '''
331 个 SQL 文件, 量很大。我先梳理目录结构, 再分批读取。让我先了解各组目录的
组织方式。有 331 个文件。我来按模块分批读取。现在我已经有足够的数据来整理报告。

# SQL 文件审计报告

总计: 331 个 SQL 文件。
''';
    final p = reportPreview(src);
    expect(p.text.startsWith('# SQL 文件审计报告'), isTrue);
    expect(p.text.contains('我先梳理目录结构'), isFalse);
    expect(p.truncated, isFalse);
  });

  test('标题就在开头时不动它', () {
    const src = '# 报告\n\n正文一行。';
    final p = reportPreview(src);
    expect(p.text, src.trim());
    expect(p.truncated, isFalse);
  });

  test('没有标题时保持原样 (不能把纯文本摘要吞掉)', () {
    const src = '就是一段没有标题的普通结论文本。';
    final p = reportPreview(src);
    expect(p.text, src);
    expect(p.truncated, isFalse);
  });

  test('短前言 (<60 字) 不当作铺垫剥掉', () {
    const src = '结论如下:\n\n# 报告\n正文';
    final p = reportPreview(src);
    expect(p.text.startsWith('结论如下'), isTrue);
  });

  test('超长时截断, 且不留半截表格', () {
    final rows = List.generate(80, (i) => '| file-$i.sql | 说明$i |').join('\n');
    final src = '# 报告\n\n开头说明。\n\n| 文件 | 说明 |\n| --- | --- |\n$rows';
    final p = reportPreview(src);
    expect(p.truncated, isTrue);
    expect(p.text.length, lessThan(src.length));
    /* 关键: 结尾不能停在表格行上 */
    expect(p.text.trimRight().split('\n').last.trimLeft().startsWith('|'), isFalse);
  });

  test('空摘要不炸', () {
    final p = reportPreview('   ');
    expect(p.text, '');
    expect(p.truncated, isFalse);
  });
}
