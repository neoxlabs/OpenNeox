/// snapshot_diff.dart — 读屏增量: 同一屏再读只回变了的控件 (pilot:D-04, 2026-10-18).
///
/// 现在每一步动作之后都回整屏控件 (`[12] 按钮 「下单」` …)。一屏 150 个控件、2–4k token,
/// 十步就是几万 —— 可同一屏里通常只变了一两个控件的字 (输入框里多了个字符、按钮从「去结算」
/// 变成「提交订单」)。这里按「上一次给模型看的那一屏」逐条比, 没变的折叠成 `[3-12] 同上`,
/// 只把变了的整行发出去。省的是每一轮的输入 token, 首字也跟着快。
///
/// 两条不肯省的规矩:
///   · **按整行 (含编号) 比**, 不按控件文字比。编号是模型点按的依据: 控件一增一删, 后面的编号
///     整体位移, 那时按行比一定不等 → 整段重发。宁可多传一点, 也不让模型拿着 `[7] 同上`
///     去点一个已经换到别处的按钮。
///   · **换 App、翻过页 (read_text)、认不出编号、隔了两分钟** 一律不做增量, 整屏回。
///     最后一条是因为基线活在进程里, 看不见对话: 用户隔一阵换个事重新开始, 模型上下文中早就
///     没有上一屏了, 这时回「[1-50] 同上」等于让它拿一份自己没见过的表去点 —— 宁可整屏重发。
///
/// 增量只是「省」, 不能是「挡」: 模型上下文里没有上一屏时 (压缩过 / 刚接手) 用 full=true 拿整屏,
/// 这个开关在 phone_ui 的参数里。
library;

/// 一个控件在屏上占的文本 (可能不止一行: 控件字里带换行时, 续行算同一个控件).
class SnapshotChunk {
  const SnapshotChunk(this.index, this.text);

  /// 屏幕上的编号 (`[12]` 里的 12); 认不出来时是 null, 这一屏不折叠
  final int? index;

  /// 这个控件的完整文本 (含编号那行 + 续行)
  final String text;
}

/// 一次读屏交给模型的文本.
class SnapshotDiffOutput {
  const SnapshotDiffOutput({
    required this.text,
    required this.incremental,
    required this.total,
    required this.changed,
  });

  /// 真正发出去的控件文本
  final String text;

  /// false = 整屏 (第一次 / 换了 App / 翻过页 / 整屏基本都变了)
  final bool incremental;

  /// 这一屏一共有多少个控件
  final int total;

  /// 其中变了的 (或新出现的) 有几个
  final int changed;

  /// 折叠掉的有几个
  int get collapsed => incremental ? total - changed : 0;
}

/// 一屏屏比下去的那份「上次」. 一个进程共用一份 (本地 agent 和电脑推过来的 phone.exec 都走这里).
class SnapshotDiff {
  SnapshotDiff({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;
  String? _key;
  List<SnapshotChunk>? _last;
  DateTime? _lastAt;

  /// 隔这么久没读屏, 就当下一屏是新的对话 (模型上下文里没有上一屏了)
  static const idleReset = Duration(minutes: 2);

  /// 比较用的前缀: 整行文本是否一模一样
  static final _numbered = RegExp(r'^\[(\d+)\]');

  /// 忘掉上一屏 (翻页了 / 换界面了 / 测试用)
  void reset() {
    _key = null;
    _last = null;
    _lastAt = null;
  }

  /// 上次给模型看的那一屏, 没读过时是 null (调试 / 测试看状态用)
  List<SnapshotChunk>? get last => _last;

  /// 把整屏控件文本切成一条条控件. 首行没有 `[n]` 时整块算一个认不出编号的块.
  static List<SnapshotChunk> parse(String elements) {
    final out = <SnapshotChunk>[];
    for (final line in elements.split('\n')) {
      if (line.isEmpty) continue;
      final m = _numbered.firstMatch(line);
      if (m != null) {
        out.add(SnapshotChunk(int.tryParse(m.group(1)!), line));
      } else if (out.isNotEmpty) {
        /* 控件字里的换行: 并到上一条, 不单独算一个编号 (否则会凭空多出 [n]) */
        final prev = out.removeLast();
        out.add(SnapshotChunk(prev.index, '${prev.text}\n$line'));
      } else {
        out.add(SnapshotChunk(null, line));
      }
    }
    return out;
  }

  /// 比一次. [appKey] 是当前前台 App (包名), 换了就不折叠; [full] 强制整屏.
  SnapshotDiffOutput apply({required String appKey, required String elements, bool full = false}) {
    final chunks = parse(elements);
    final whole = SnapshotDiffOutput(
      text: elements,
      incremental: false,
      total: chunks.length,
      changed: chunks.length,
    );
    final prev = _last;
    /* 认不出编号 (界面结构变了 / 原生换了格式) 就不折叠 —— 比对结果不可信时宁可不省 */
    if (prev != null && !prev.every((c) => c.index != null)) {
      _key = null;
      _last = null;
      _lastAt = null;
    }
    final now = _clock();
    final fresh = _lastAt != null && now.difference(_lastAt!) <= idleReset;
    final baseline = _key == appKey && fresh ? _last : null;
    if (full || baseline == null || baseline.isEmpty || chunks.any((c) => c.index == null)) {
      _key = appKey;
      _last = chunks;
      _lastAt = now;
      return whole;
    }

    final same = List<bool>.generate(
      chunks.length,
      (i) => i < baseline.length && baseline[i].text == chunks[i].text,
    );
    final parts = <String>[];
    var changed = 0;
    var i = 0;
    while (i < chunks.length) {
      if (same[i]) {
        var j = i;
        while (j + 1 < chunks.length && same[j + 1]) {
          j++;
        }
        final a = chunks[i].index!;
        final b = chunks[j].index!;
        parts.add(a == b ? '[$a] 同上' : '[$a-$b] 同上');
        i = j + 1;
      } else {
        parts.add(chunks[i].text);
        changed++;
        i++;
      }
    }
    if (chunks.length < baseline.length) {
      parts.add('(上次还有 ${baseline.length - chunks.length} 个控件, 这次没了)');
    }
    final text = parts.join('\n');
    _key = appKey;
    _last = chunks;
    _lastAt = now;
    /* 折叠之后反而更长 (整屏几乎都变了) 就没必要折, 还给整屏 */
    if (elements.isNotEmpty && text.length >= elements.length) return whole;
    return SnapshotDiffOutput(
      text: text,
      incremental: true,
      total: chunks.length,
      changed: changed,
    );
  }
}

/// 全进程共用的一份 (phone_ui 是静态状态, 跟 [_lastShotScale] 同一套路)
final SnapshotDiff snapshotDiff = SnapshotDiff();
