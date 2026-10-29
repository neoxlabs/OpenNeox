/// 更新后第一次打开的介绍页: 从这一版日志里取前三条 (大字 / 灰字)
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/settings/whats_new.dart';

void main() {
  test('「**大字**：灰字」拆开, 最多三条, 跳过标题行', () {
    const md = '''
## 新功能
- **打开就能说事**：首页只剩输入框，在哪干、用哪个模型都在输入框里选
- **全屏侧栏**：侧栏铺满整屏
- **进度一眼看到** — 执行到第几步，岛上直接写
- **第四条**：不该出现
''';
    final p = whatsNewPages(md);
    expect(p.length, 3);
    expect(p[0].head, '打开就能说事');
    expect(p[0].body, '首页只剩输入框，在哪干、用哪个模型都在输入框里选');
    expect(p[2].head, '进度一眼看到');
    expect(p[2].body, '执行到第几步，岛上直接写');
  });

  test('没有粗体: 冒号前当大字', () {
    final p = whatsNewPages('1. 修复压缩：长对话不再卡住\n2. 短句');
    expect(p[0].head, '修复压缩');
    expect(p[0].body, '长对话不再卡住');
    expect(p[1].head, '短句');
    expect(p[1].body, '');
  });
}
