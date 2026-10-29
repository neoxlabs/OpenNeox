/// 工具失败输出 → 一句人话 (2026-10-18 用户真机: 失败卡里糊了一段
/// `{"type":"contextual","status":"error",...}` 原始 JSON)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/timeline/models/tool_output_summary.dart';

void main() {
  test('运行时信封: 取 summary 那句人话', () {
    const out = '{"type":"contextual","status":"error","tool":"browser_run",'
        '"summary":"没找到可用的浏览器窗口","content":"{\\"ok\\":false,\\"error\\":\\"No browser surface\\"}"}';
    expect(toolFailureSentence(out), '没找到可用的浏览器窗口');
  });

  test('工具自己 return 的 JSON: 取 error 字段', () {
    expect(toolFailureSentence('{"ok":false,"error":"No browser surface"}'), 'No browser surface');
  });

  test('没有 summary 时退回 message / reason', () {
    expect(toolFailureSentence('{"status":"error","message":"文件不存在"}'), '文件不存在');
    expect(toolFailureSentence('{"status":"error","reason":"路径被拒绝"}'), '路径被拒绝');
  });

  test('content 里再套一层 JSON 也能挖出来', () {
    const out = '{"type":"contextual","status":"error","content":"{\\"ok\\":false,\\"error\\":\\"超时\\"}"}';
    expect(toolFailureSentence(out), '超时');
  });

  test('普通文本取第一行, 压成一行', () {
    expect(toolFailureSentence('\n  命令失败了\n后续堆栈...'), '命令失败了');
  });

  test('多行 JSON 解析失败也不糊一屏: 取第一行', () {
    final out = '{"type":"contextual",\n"status":"error"}';
    expect(toolFailureSentence(out), '{"type":"contextual",');
  });

  test('空输出返回 null (调用方不硬编一句)', () {
    expect(toolFailureSentence(null), isNull);
    expect(toolFailureSentence('   '), isNull);
  });

  test('超长截断加省略号', () {
    final long = 'x' * 400;
    final s = toolFailureSentence(long, max: 40)!;
    expect(s.length, 40);
    expect(s.endsWith('…'), isTrue);
  });
}
