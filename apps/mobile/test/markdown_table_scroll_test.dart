/// markdown_table_scroll_test.dart — markdown 宽表必须横向可滚的回归护栏.
///
/// 真机 bug (2026-07-28): agent 返回一张 4 列目录统计表, 手机宽度放不下, 表格又
/// 不滚, 最后一列被逐字符硬折成 "mo / norep / o, Vu / e3+Vit / ..." —— 连路径
/// `frontend/` 都被拆成 `fronte` + `nd/`, 完全没法读。
///
/// 根因: flutter_markdown_plus 内置了表格横滚, 但**只在 tableColumnWidth 是
/// Fixed/Intrinsic 时启用** (builder.dart 的 tag=='table' 分支); 默认的
/// FlexColumnWidth 落进不滚的 else, 列宽被压进容器 → 逐字折行。
///
/// 这个测试锁住"宽表在窄屏下会产生横向滚动视图"这个行为, 防止以后有人把
/// tableColumnWidth 改回 Flex (改回去编译不会报错, 只有真机上肉眼能发现)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/features/timeline/widgets/markdown_view.dart';

/// 一张远超手机宽度的 4 列表 —— 复刻真机翻车的那张.
const _wideTable = '''
| 目录 | 文件数 | 大小 | 说明 |
|------|--------|------|------|
| `frontend/` | 4,382 | 2.0G | Vben Admin v5 前端 monorepo, Vue3+Vite+pnpm+Turborepo |
| `scripts/` | 15 | 408K | Python 工具脚本（员工导入、库存导入、SQL 执行） |
''';

Future<void> _pumpInPhoneWidth(WidgetTester tester, String md) async {
  /* 用真机的逻辑宽度: 1272 物理 / 3.5 dpr ≈ 363dp */
  tester.view.physicalSize = const Size(1272, 2772);
  tester.view.devicePixelRatio = 3.5;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: MarkdownView(data: md)),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('宽表在手机宽度下产生横向滚动, 而不是压缩列宽', (tester) async {
    await _pumpInPhoneWidth(tester, _wideTable);

    final horizontalScrollers = find.byWidgetPredicate(
      (w) => w is SingleChildScrollView && w.scrollDirection == Axis.horizontal,
    );
    expect(
      horizontalScrollers,
      findsWidgets,
      reason: '表格必须被横向 SingleChildScrollView 包住 — '
          '没有它就会退化成逐字折行 (真机实锤)',
    );
  });

  testWidgets('表格实际宽度超出屏幕 (说明列宽按内容取, 没被压)', (tester) async {
    await _pumpInPhoneWidth(tester, _wideTable);

    final table = find.byType(Table);
    expect(table, findsOneWidget);

    final tableWidth = tester.getSize(table).width;
    final screenWidth = tester.view.physicalSize.width / tester.view.devicePixelRatio;
    expect(
      tableWidth,
      greaterThan(screenWidth),
      reason: '列按内容取宽后总宽应超出屏幕 (靠滚动查看); '
          '若小于等于屏宽说明又被压回去了, 长单元格会逐字折行',
    );
  });

  testWidgets('窄表不需要滚动也能完整显示', (tester) async {
    await _pumpInPhoneWidth(tester, '''
| A | B |
|---|---|
| 1 | 2 |
''');
    expect(find.byType(Table), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('代码块同样保持横向可滚 (原有行为不回退)', (tester) async {
    await _pumpInPhoneWidth(tester, '''
```dart
final veryLongLine = someFunction(withArgument1, withArgument2, withArgument3, withArgument4);
```
''');
    final horizontalScrollers = find.byWidgetPredicate(
      (w) => w is SingleChildScrollView && w.scrollDirection == Axis.horizontal,
    );
    expect(horizontalScrollers, findsWidgets);
  });
}
