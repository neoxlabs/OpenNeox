/// markdown_normalize_test.dart — LLM 不严谨 markdown 的补偿规则.
///
/// 真机对比桌面发现 (2026-07-28): 模型输出 `##2. design/foo.md (192行)`,
/// 桌面渲染成标题, 手机原样显示 `##2. …` 字面量。原因是 CommonMark 要求 ATX 标题
/// 的 `#` 后必须有空格, 手机用的解析器严格遵守, 桌面那套宽松。
///
/// 这里锁住补偿规则本身, 尤其是**不该动的地方绝不能动** (代码块 / 正文里的 # / 链接锚点)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/widgets/markdown_view.dart';

void main() {
  group('ATX 标题缺空格 → 补上', () {
    test('真机原样例: ##2. 带行内代码', () {
      expect(
        normalizeLlmMarkdown('##2. `design/agent-workspace-v3.md` (192行)'),
        '## 2. `design/agent-workspace-v3.md` (192行)',
      );
    });

    test('1~6 级都补', () {
      for (var n = 1; n <= 6; n++) {
        final hashes = '#' * n;
        expect(normalizeLlmMarkdown('$hashes标题'), '$hashes 标题');
      }
    });

    test('已经有空格的不动', () {
      const s = '## 正常标题';
      expect(normalizeLlmMarkdown(s), s);
    });

    test('7 个 # 不是标题, 不动', () {
      const s = '#######不是标题';
      expect(normalizeLlmMarkdown(s), s);
    });
  });

  group('有序列表缺空格 → 补上', () {
    test('1.foo → 1. foo', () {
      expect(normalizeLlmMarkdown('1.第一项'), '1. 第一项');
    });

    test('保留缩进', () {
      expect(normalizeLlmMarkdown('   2.缩进项'), '   2. 缩进项');
    });

    test('已有空格不动', () {
      const s = '1. 正常项';
      expect(normalizeLlmMarkdown(s), s);
    });
  });

  group('不该动的绝不动', () {
    test('代码块内的 ## 与 1. 原样保留', () {
      const src = '''
正文

```python
##这是注释不是标题
1.这是代码不是列表
```

##标题该补
''';
      final out = normalizeLlmMarkdown(src);
      expect(out, contains('##这是注释不是标题'), reason: '代码块内不能改');
      expect(out, contains('1.这是代码不是列表'), reason: '代码块内不能改');
      expect(out, contains('## 标题该补'), reason: '代码块外要补');
    });

    test('~~~ 围栏同样保护', () {
      const src = '~~~\n##fenced\n~~~\n##outside';
      final out = normalizeLlmMarkdown(src);
      expect(out, contains('##fenced'));
      expect(out, contains('## outside'));
    });

    test('行中间的 # 不动 (话题标签 / 锚点)', () {
      const s = '见 issue #123 和 https://x.com/a#anchor';
      expect(normalizeLlmMarkdown(s), s);
    });

    test('小数不当成列表 (行首)', () {
      /* "3.14 是圆周率" 行首确实形如序号, CommonMark 也会当列表 —
       * 这里只要保证行为可预期、不抛异常即可, 不追求语义猜测。 */
      expect(() => normalizeLlmMarkdown('3.14 是圆周率'), returnsNormally);
    });

    test('普通段落原样返回同一实例 (无改动时零拷贝)', () {
      const s = '这是一段普通正文, 没有任何需要补的地方';
      expect(identical(normalizeLlmMarkdown(s), s), isTrue);
    });
  });

  group('混合文档', () {
    test('多处补齐且顺序不乱', () {
      const src = '##1. 第一节\n正文\n##2. 第二节\n2.子项';
      expect(
        normalizeLlmMarkdown(src),
        '## 1. 第一节\n正文\n## 2. 第二节\n2. 子项',
      );
    });
  });

  group('版本号 / 小数不能被当成有序列表', () {
    /* 2026-09-18 渲染台截图抓到: 更新日志第一行 `3.3.9 → 3.4.0。` 被补成
     * `3. 3.9 → 3.4.0。`, 渲出来是一个序号 3 的列表项, 版本号断成两截。 */
    test('版本号原样不动', () {
      for (final s in const [
        '3.3.9 → 3.4.0。',
        '1.0.0 发布',
        '升到 2.6.0',
      ]) {
        expect(normalizeLlmMarkdown(s), s, reason: s);
      }
    });

    test('小数原样不动', () {
      expect(normalizeLlmMarkdown('1.5 倍速'), '1.5 倍速');
      expect(normalizeLlmMarkdown('2.0 版本'), '2.0 版本');
    });

    test('真的缺空格的有序列表仍然要补', () {
      expect(normalizeLlmMarkdown('1.先做这个'), '1. 先做这个');
      expect(normalizeLlmMarkdown('2.再做那个'), '2. 再做那个');
      expect(normalizeLlmMarkdown('  3.缩进的一项'), '  3. 缩进的一项');
    });
  });
}
