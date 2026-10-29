import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// `inflight[k] ??= work().whenComplete(() => inflight.remove(k))`:
/// 箭头函数把 remove 的返回值 (就是这个 future 自己) 交给 whenComplete, 它会等这个 future 完成 =
/// 等自己, 永远完不成。2026-10-22 查到三处: 看图永远转圈 (图其实已落盘)、会话 attach 第一次之后永远卡死。
/// 写成块体 `() { inflight.remove(k); }` 就没事。
void main() {
  test('lib 里没有 whenComplete(() => xxx.remove(...)) 这种等自己的写法', () {
    final bad = RegExp(r'whenComplete\(\(\)\s*=>\s*[\w.\[\]]+\.remove\(');
    final hits = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        if (bad.hasMatch(lines[i])) hits.add('${f.path}:${i + 1}');
      }
    }
    expect(hits, isEmpty, reason: '改成块体 () { map.remove(k); }');
  });
}
