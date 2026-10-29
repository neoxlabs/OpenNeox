/// tool_group_row.dart — 活动收拢行 (对齐桌面 atl-activity digest / Cursor).
///
/// 视觉 (默认一行):
///   `[layers] 执行命令 · 读取 ×2 · 编辑  +37 −32  ✓ ▾`
///   跑着时标题 shimmer; 点开才看逐条 tool / thinking
///
/// 分组规则:
///   tool + agent_thinking 连续段合成一组 (thinking 不再打断);
///   user_message / agent_text 打断。即使只有 1 个 tool 也走收拢行。
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';
import '../../../shared/widgets/neox_scaffold.dart';
import '../models/payload_utils.dart';
import '../state/timeline_state.dart';
import 'message_widgets.dart' show ThinkingFold;
import '../tool_renderers.dart' as toolr;
import 'shimmer_text.dart';
import 'streaming_widgets.dart' show LiveOutputTail;
import 'tool_block.dart';
import 'artifact_card.dart';
import 'tool_result_cards.dart';
import 'tool_image_seen_card.dart' show isPlanNudge, parseToolImageInjection;
import 'package:neox_app/core/i18n/tr.dart';

/// 时间轴渲染单元: 单条 entry 或一组活动 (tool + thinking).
sealed class TimelineRenderItem {
  const TimelineRenderItem();

  String get key;
}

class SingleRenderItem extends TimelineRenderItem {
  const SingleRenderItem(this.entry);
  final TimelineEntry entry;

  @override
  String get key => 'entry-${entry.id}-${entry.sequence}';
}

class ToolGroupRenderItem extends TimelineRenderItem {
  ToolGroupRenderItem(this.entries);

  /// 组内全部活动 entry (tool + agent_thinking).
  final List<TimelineEntry> entries;

  /* 2026-09-22: 下面四项原来是 getter —— 每读一次就 `where().toList()` 重新分配
   * 一整个列表。而一次渲染里 (ToolGroupRow.build + _headline) 要读它们 5 次,
   * 而 streaming 期间这行每 32ms 重建一次。late final 只算一次。
   * (代价是不能 const 构造 —— 但调用点本来也没用 const。) */
  late final List<TimelineEntry> tools = entries
      .where((e) => e.kind == 'tool')
      .toList(growable: false);

  late final List<TimelineEntry> thinkings = entries
      .where((e) => e.kind == 'agent_thinking')
      .toList(growable: false);

  late final bool anyRunning = entries.any((e) => e.pending || e.streaming);

  late final bool anyFailed = tools.any((e) => !e.pending && !e.toolSuccess);

  @override
  String get key => 'toolgroup-${entries.first.id}';
}

/// 时间线按哪个模式画 (陶土稿 v5「时间线按模式分」).
///   code —— 一轮折成一行灰字, 展开是纯文字日志 (无图标、整宽)
///   work —— 按计划用大白话, 工具细节藏在步骤里, 成品卡是主角
///   chat —— 过程只有一行「搜了 8 个网页 · 想了 4 秒」, 回答像文章
enum TimelineMode { chat, work, code }

/// 一轮回复的「过程」—— 这一轮里所有工具 / 思考 / 中间的说明文字, 收成一行.
///
/// 跟 [ToolGroupRenderItem] 的区别: 那个按「连续的工具段」分组, 中间一句说明文字就断成两组,
/// 一屏好几条「7 actions」; 这里按**轮**收 (两条用户消息之间), 只把最后的回答留在外面。
class ProcessRenderItem extends TimelineRenderItem {
  ProcessRenderItem(this.entries, {required this.running, required this.isLatestTurn, this.answering = false, this.isTail = true});

  /// 过程 entry (tool / agent_thinking / 中间的 agent_text), 按时间顺序
  final List<TimelineEntry> entries;

  /// 这一轮还在跑 (最新一轮 && agent 在跑)
  final bool running;
  final bool isLatestTurn;

  /// 过程后面已经开始写回答了 —— 「思考中」和滚动思维链该收起来 (思考那条可能还没收到 done)
  final bool answering;

  late final List<TimelineEntry> tools = entries.where((e) => e.kind == 'tool').toList(growable: false);

  late final List<TimelineEntry> thinkings = entries.where((e) => e.kind == 'agent_thinking').toList(growable: false);

  /// 时间线最末这一段 (后面没有正文 / 别的过程了)
  final bool isTail;

  /* 只有最末一段能算「在跑」: 后面已经冒出正文 / 下一段过程, agent 显然往下走了, 这段里还挂着 pending 的工具
   * 只是 tool_done 没收到 (流式是 best-effort)。原来照算在跑 —— 一轮里好几段同时扫光、各挂一个「正在改文件 69s」、
   * 每段都画一张计划卡 (2026-10-22 用户实拍「顺序不对」「好几个都在扫光」「plan 卡一直在显示」) */
  late final bool anyRunning = running || (isTail && entries.any((e) => e.pending || e.streaming));

  @override
  String get key => 'process-${entries.first.id}';
}

/// 编码模式回答后面那排「login.ts +3 −1」改动文件签 (点了全屏看改动).
class FilesFooterRenderItem extends TimelineRenderItem {
  FilesFooterRenderItem(this.edits, this.anchorKey);

  /// 这一轮里所有改文件 / 写文件的工具 (按时间)
  final List<TimelineEntry> edits;
  final String anchorKey;

  @override
  String get key => 'files-$anchorKey';
}

List<TimelineEntry>? _turnInput;
(bool, TimelineMode)? _turnArgs;
List<TimelineRenderItem>? _turnOutput;

/// 带单槽缓存的 [buildTurnItems] (同 [groupToolEntriesCached] 的理由: streaming 期间每 32ms 重建一次).
List<TimelineRenderItem> buildTurnItemsCached(List<TimelineEntry> entries, {required bool running, required TimelineMode mode}) {
  final cached = _turnOutput;
  if (cached != null && identical(entries, _turnInput) && _turnArgs == (running, mode)) return cached;
  final out = buildTurnItems(entries, running: running, mode: mode);
  _turnInput = entries;
  _turnArgs = (running, mode);
  _turnOutput = out;
  return out;
}

bool _isProcessKind(String k) => k == 'tool' || k == 'agent_thinking';

/* 2026-10-22 用户: 「电脑的图片 code 模式下手机能显示吗, agent 在 view image 的时候」——
 * 工具看图后内核把图包成一条 user_message 回灌给模型 (「[系统注入] 以下 N 张图片是工具 X 的返回内容」),
 * 计划推进提醒也是 user_message。这两种不是用户说的话, 原来却被当成「新的一轮」:
 * 一轮从中间断开, 编码模式下前半截的过程行和后半截各自成段, 跑完的轮也被拆成两轮。
 * 现在只有真的用户消息才分轮; 看图那条照常渲染成「看到的图」卡, 夹在过程行之间 (跟桌面一样)。 */
bool _isUserTurn(TimelineEntry e) {
  if (e.kind != 'user_message') return false;
  final t = e.text ?? '';
  return !isPlanNudge(t) && parseToolImageInjection(t) == null;
}

/// entries → 按轮的渲染单元.
///
/// 一轮 = 两条 user_message 之间。轮内:
///   · 最后一个工具 / 思考之后的 agent_text = 回答, 留在外面;
///   · 其余工具、思考、夹在中间的 agent_text 收进一个 [ProcessRenderItem] (放在第一条过程出现的位置);
///   · 别的 (出图 / 子 Agent / 压缩 / 检查点 / 错误) 原样单列。
/// 编码模式在回答后面再挂一个 [FilesFooterRenderItem] (这一轮改过文件才有)。
List<TimelineRenderItem> buildTurnItems(List<TimelineEntry> entries, {required bool running, required TimelineMode mode}) {
  final out = <TimelineRenderItem>[];
  var start = 0;
  while (start < entries.length) {
    if (_isUserTurn(entries[start])) {
      out.add(SingleRenderItem(entries[start]));
      start++;
      continue;
    }
    var end = start;
    while (end < entries.length && !_isUserTurn(entries[end])) {
      end++;
    }
    /* 计划提醒手机上不显示 (进度另有「计划 N/M」), 直接从这一轮里拿掉, 免得把过程行切成两段 */
    final turn = entries.sublist(start, end).where((e) => !(e.kind == 'user_message' && isPlanNudge(e.text ?? ''))).toList();
    final latest = end == entries.length;
    final turnRunning = latest && running;
    /* 2026-10-14 用户: 一轮几百步, 中间它说的话被当成「说明」塞进折叠里看不见。
     * 跑着的这一轮: 跟桌面一样往下推 —— 工具 / 思考按连续段收成一组 (折叠, 点开看命令), 它说的话照常是正文;
     * 整轮跑完才收成一行「N 步 · 用时」, 点开还是这个交替的样子 (ProcessRow 展开)。 */
    /* 2026-10-21 用户: 编码模式要跟桌面一样 —— 一段话、一行工具、一段话…… 跑完也不收成整轮一行
     * (收起来后中间的话全被折走, 一屏只剩「7 步 · 改 1 个文件」+ 文件签排成一串)。 */
    if (turnRunning || mode == TimelineMode.code) {
      var i = 0;
      while (i < turn.length) {
        final e = turn[i];
        if (!_isProcessKind(e.kind)) {
          out.add(SingleRenderItem(e));
          i++;
          continue;
        }
        var j = i;
        while (j < turn.length && _isProcessKind(turn[j].kind)) {
          j++;
        }
        /* 一段连续的工具 / 思考 = 一个过程行 (v5 样式: 跑着时露当前一步和输出尾巴, 点开一步一行带命令) */
        final run = turn.sublist(i, j);
        final tail = j == turn.length;
        /* 跑完了的一截空思考 (模型收尾常带) 不出一行「0 步」 */
        final empty = run.every((e) => e.kind == 'agent_thinking' && !e.streaming && (e.thinking ?? e.text ?? '').trim().isEmpty);
        if (empty && !(tail && turnRunning)) {
          i = j;
          continue;
        }
        out.add(ProcessRenderItem(List.unmodifiable(run), running: tail && turnRunning, isLatestTurn: latest, isTail: tail && latest));
        i = j;
      }
      start = end;
      continue;
    }
    /* 回答后面又冒一段思考 (模型收尾常带一截空思考) 不算「回答之前的过程」: 否则最后那句话被当成中间的话
     * 收进「2 步」里, 用户只看见步数看不见答案 (2026-10-15 远程会话实测「OK」被折走)。
     * 那段思考本身照样收进步骤里 (下面按 _isProcessKind 归组)。 */
    final lastText = turn.lastIndexWhere((e) => e.kind == 'agent_text' && (e.text ?? '').trim().isNotEmpty);
    var lastProcess = -1;
    for (var i = turn.length - 1; i >= 0; i--) {
      final k = turn[i].kind;
      if (k == 'tool' || (k == 'agent_thinking' && (lastText < 0 || i < lastText))) {
        lastProcess = i;
        break;
      }
    }
    if (lastProcess < 0) {
      for (final e in turn) {
        if (e.kind == 'agent_thinking') continue;
        out.add(SingleRenderItem(e));
      }
    } else {
      final process = <TimelineEntry>[];
      var processAt = -1;
      final rest = <(int, TimelineEntry)>[];
      for (var i = 0; i < turn.length; i++) {
        final e = turn[i];
        final inProcess = _isProcessKind(e.kind) || (e.kind == 'agent_text' && i < lastProcess && !(e.text ?? '').startsWith('❌'));
        if (inProcess) {
          if (processAt < 0) processAt = rest.length;
          process.add(e);
        } else {
          rest.add((i, e));
        }
      }
      final answering = rest.any((r) => r.$1 > lastProcess && r.$2.kind == 'agent_text' && (r.$2.text ?? '').trim().isNotEmpty);
      for (var r = 0; r < rest.length; r++) {
        if (r == processAt) out.add(ProcessRenderItem(List.unmodifiable(process), running: turnRunning, isLatestTurn: latest, answering: answering, isTail: latest));
        out.add(SingleRenderItem(rest[r].$2));
      }
      if (processAt >= rest.length || processAt < 0) {
        out.add(ProcessRenderItem(List.unmodifiable(process), running: turnRunning, isLatestTurn: latest, answering: answering, isTail: latest));
      }
    }
    start = end;
  }
  return out;
}

bool _isActivityEntry(TimelineEntry e) =>
    e.kind == 'tool' || e.kind == 'agent_thinking';

/* [groupToolEntries] 的单槽缓存 —— 2026-09-22.
 *
 * 它在 TimelineMessageList.build 里每帧被调, 而 streaming 期间列表每 32ms 重建
 * 一次: 长会话 (几百条 entry) 每次都要 O(n) 走一遍, 并对每个连续段做一次 sublist
 * 分配。传进来的 entries 在两次 flush 之间通常是**同一个 List 实例** (provider 只在
 * 内容真变时才换新对象), 所以按 `identical` 判命中就够了。
 *
 * 只留**最后一份**而不是做个 Map: 调用方几乎总是拿着同一份 entries 连着调多次,
 * 单槽已经吃掉绝大部分重复; 而且它不会随着会话增长去持有旧列表 —— 用 Map 的话,
 * 已经离开屏幕的那几段 entry 会被缓存键一直钉在内存里。 */
List<TimelineEntry>? _groupedInput;
List<TimelineRenderItem>? _groupedOutput;

/// 带单槽缓存的 [groupToolEntries].
List<TimelineRenderItem> groupToolEntriesCached(List<TimelineEntry> entries) {
  final cached = _groupedOutput;
  if (cached != null && identical(entries, _groupedInput)) return cached;
  final out = groupToolEntries(entries);
  _groupedInput = entries;
  _groupedOutput = out;
  return out;
}

/// entries → 渲染单元.
///
/// 连续 tool / thinking 收成一组 (对齐桌面 activity digest 一行);
/// agent_text / user 打断。有 tool 的组即使只有 1 条也走 [ToolGroupRow]。
List<TimelineRenderItem> groupToolEntries(List<TimelineEntry> entries) {
  final out = <TimelineRenderItem>[];
  var i = 0;
  while (i < entries.length) {
    final e = entries[i];
    if (!_isActivityEntry(e)) {
      out.add(SingleRenderItem(e));
      i++;
      continue;
    }
    var j = i;
    while (j < entries.length && _isActivityEntry(entries[j])) {
      j++;
    }
    final run = entries.sublist(i, j);
    final hasTool = run.any((x) => x.kind == 'tool');
    if (hasTool) {
      out.add(ToolGroupRenderItem(List.unmodifiable(run)));
    } else {
      /* 纯 thinking 段 — 只保留有内容的, 各自折叠行 (仍是单行) */
      for (final t in run) {
        final body = (t.thinking ?? t.text ?? '').trim();
        if (body.isEmpty && !t.streaming) continue;
        out.add(SingleRenderItem(t));
      }
    }
    i = j;
  }
  return out;
}

/// 聚合行组件 — 默认一行 digest.
class ToolGroupRow extends StatefulWidget {
  const ToolGroupRow({super.key, required this.group, this.sessionId});

  final ToolGroupRenderItem group;
  final String? sessionId;

  @override
  State<ToolGroupRow> createState() => _ToolGroupRowState();
}

/// 工具种类 → 动词 + 计量 (「编辑了 2 个文件」「运行了 3 条命令」).
enum _ToolKind { edit, read, search, shell, explore, doc, other }

_ToolKind _kindOf(String? rawName) {
  final n = (rawName ?? '').toLowerCase();
  /* 手机 Agent 的文档 / 工作区工具: 一次 outline 也带着 edit 字样, 不能数成「编辑了 N 个文件」 */
  if (n == 'office_edit' || n == 'workspace_files') return _ToolKind.doc;
  /* 等后台进程输出 / 停进程不是「运行命令」 */
  if (n == 'bash_output' || n == 'bash_kill') return _ToolKind.other;
  if (isDiffToolName(n) || n.contains('write') || n.contains('edit'))
    return _ToolKind.edit;
  if (n.contains('read') || n.contains('list_dir') || n == 'glob')
    return _ToolKind.read;
  if (n.contains('shell') ||
      n.contains('bash') ||
      n.contains('exec') ||
      n.contains('python') ||
      n.contains('javascript')) {
    return _ToolKind.shell;
  }
  if (n.contains('search') || n.contains('grep') || n.contains('web_'))
    return _ToolKind.search;
  if (n.contains('explore') || n.contains('task')) return _ToolKind.explore;
  return _ToolKind.other;
}

String _verbOf(_ToolKind k, String? rawName) => switch (k) {
  _ToolKind.edit =>
    (rawName ?? '').toLowerCase().contains('write') ? tr('写入') : tr('编辑'),
  _ToolKind.read => tr('读取'),
  _ToolKind.search => tr('搜索'),
  _ToolKind.shell => tr('运行'),
  _ToolKind.explore => tr('探索'),
  _ToolKind.doc => tr('处理文件'),
  _ToolKind.other => friendlyToolName(rawName ?? tr('操作')),
};

/// 一组工具的一句话: 「编辑了 1 个文件，运行了 2 条命令」.
///
/// 2026-09-17 对标 Claude 手机端 ("Edited 1 files, ran 2 commands"): 原来是
/// 「编辑 · 命令 ×2 toolRiskEvaluator.ts…」—— 等宽字体 + 类型词 + 被截断的文件名, 读起来像日志。
/// 手机上这一行要回答的只是"它刚才干了几件什么事", 细节在点开的列表里。
@visibleForTesting
String toolGroupSentence(Iterable<String?> toolNames) {
  final counts = <_ToolKind, int>{};
  for (final n in toolNames) {
    final k = _kindOf(n);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  final parts = <String>[
    if ((counts[_ToolKind.edit] ?? 0) > 0) tr('编辑了 ${counts[_ToolKind.edit]} 个文件'),
    if ((counts[_ToolKind.read] ?? 0) > 0) tr('读取了 ${counts[_ToolKind.read]} 个文件'),
    if ((counts[_ToolKind.search] ?? 0) > 0)
      tr('搜索了 ${counts[_ToolKind.search]} 次'),
    if ((counts[_ToolKind.shell] ?? 0) > 0)
      tr('运行了 ${counts[_ToolKind.shell]} 条命令'),
    if ((counts[_ToolKind.explore] ?? 0) > 0)
      tr('探索了 ${counts[_ToolKind.explore]} 次'),
    if ((counts[_ToolKind.doc] ?? 0) > 0)
      tr('处理了 ${counts[_ToolKind.doc]} 次文件'),
    if ((counts[_ToolKind.other] ?? 0) > 0)
      tr('执行了 ${counts[_ToolKind.other]} 步操作'),
  ];
  return parts.isEmpty ? tr('思考') : parts.join(isEnglishUi ? ', ' : '，');
}

/// 一步的说明: 优先用模型自己写的 description ("List changed files for commit"), 没有再摘参数.
String _stepDetail(TimelineEntry e) {
  final desc = e.args?['description'];
  if (desc is String && desc.trim().isNotEmpty) return desc.trim();
  final s = smartArgSummary(e.toolName ?? '', e.args) ?? '';
  /* 文件类只留文件名: 手机一行放不下 packages/kernel/src/core/…, 截出来的前缀全是一样的;
   * 完整路径点开这一步的详情里有。 */
  final k = _kindOf(e.toolName);
  if ((k == _ToolKind.edit || k == _ToolKind.read) && s.contains('/')) {
    final head = s.split('·').first.trim();
    final rest = s.substring(head.length);
    return '${head.split('/').last}$rest';
  }
  return s;
}

class _ToolGroupRowState extends State<ToolGroupRow> {
  /// 收起行: (标题, 跑着时的当前步骤说明, +行, −行, 失败数)
  (String, String, int, int, int) _headline() {
    final tools = widget.group.tools;
    final stats = aggregateDiffStats(
      tools.map((e) => (toolName: e.toolName, args: e.args)),
    );
    final running = tools.where((e) => e.pending).toList();
    if (running.isNotEmpty) {
      final cur = running.last;
      final k = _kindOf(cur.toolName);
      final live = diffLineStats(cur.toolName, cur.args);
      return (
        tr('正在${_verbOf(k, cur.toolName)}'),
        _stepDetail(cur),
        live.adds > 0 ? live.adds : stats.adds,
        live.dels > 0 ? live.dels : stats.dels,
        0,
      );
    }
    if (tools.isEmpty && widget.group.thinkings.any((e) => e.streaming)) {
      return (tr('思考中'), '', 0, 0, 0);
    }
    final failed = tools.where((e) => !e.toolSuccess).length;
    return (
      toolGroupSentence(tools.map((e) => e.toolName)),
      '',
      stats.adds,
      stats.dels,
      failed,
    );
  }

  void _openDetails(String title) {
    /* 2026-09-22 用户: 「工具渲染…是在打开一个小抽屉后进行渲染, 这存在可读性很差、
     * 没有用满宽度等细节问题」。改成整页:
     *   · 弹层在宽屏上被 Material 限宽到 640dp, 手机上两侧还各留一圈浮层边距;
     *     而工具详情恰恰是最吃宽度的东西 (命令回显要按列看、diff 一行两列),
     *     窄一截就直接体现为频繁折行 —— 那正是"可读性差"的来源。
     *   · 它本来就是"越看越长"的内容 (一条命令 + 它的输出 + 它改的 diff),
     *     不该寄生在一个占屏高 85% 的浮层里。
     * 原来选弹层的理由 (原地展开会把对话推下去、收起时滚动位置已丢) 在整页里不成立:
     * push / 返回天然保留列表位置。 */
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            ToolGroupPage(title: title, entries: widget.group.entries),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final running = widget.group.anyRunning;
    final (title, current, adds, dels, failed) = _headline();
    /* 14 而不是 15 (2026-09-18): 正文同时从 15 抬到 16.5, 两边只差 1.5 号时层级几乎
     * 不存在 —— 满屏一样重, "哪句是答案、哪行是过程"要靠读才分得出 (用户拿同类产品
     * 对比: "字体 大小 对比 等 很清晰啊 我们的差远了")。
     * 工具行是**过程**, 它该明显退到正文后面: 字号差 2.5 号 + 已经有的弱色。 */
    final textStyle = TextStyle(
      fontSize: 14,
      height: 1.35,
      color: running ? scheme.onSurface : scheme.onSurfaceVariant,
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 2, 6, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          /* 不走 TimelineRow: 那个行给左侧图标留了固定宽度, 没有图标也空着, 这一行就比正文
           * 缩进一截。数字和箭头紧跟文字 (不推到最右), 读起来是一句话而不是一张表。 */
          InkWell(
            onTap: () => _openDetails(title),
            borderRadius: NeoxRadius.smallR,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Flexible(
                    child: ShimmerText(
                      current.isNotEmpty ? '$title · $current' : title,
                      active: running,
                      maxLines: 1,
                      style: textStyle,
                    ),
                  ),
                  if (failed > 0)
                    Text(
                      tr(' · $failed 步失败'),
                      maxLines: 1,
                      style: textStyle.copyWith(color: scheme.error),
                    ),
                  if (adds > 0 || dels > 0) ...[
                    const SizedBox(width: 8),
                    DiffStatsChip(adds: adds, dels: dels),
                  ],
                  if (running) ...[
                    const SizedBox(width: 8),
                    _RunningPulse(color: scheme.onSurfaceVariant),
                  ],
                  const SizedBox(width: 2),
                  Icon(
                    Icons.chevron_right_rounded,
                    size: 18,
                    color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
                  ),
                ],
              ),
            ),
          ),
          /* 产物下载卡 —— 放在折叠**外面**, 永远可见.
           * 这是这一组工具真正交付的东西 (那份 PPT/表格), 藏进折叠里等于没有:
           * 用户根本不知道要点开才能拿到文件。 */
          for (final e in widget.group.tools)
            if (e.artifacts != null && e.artifacts!.isNotEmpty)
              ArtifactStrip(entry: e),
          /* 搜索来源 / 我的位置 —— 同理放折叠外面 (见 tool_result_cards.dart) */
          for (final e in widget.group.tools)
            if (toolResultCardFor(e) case final card?) card,
        ],
      ),
    );
  }
}

/// 一组工具的详情页: 一步一行 (动词 + 说明), 竖线串起来; 点某一步展开它的详情.
///
/// 2026-09-22: 原来是底部弹层。用户实拍「可读性很差、没有用满宽度」—— 弹层在宽屏上
/// 被 Material 限宽到 640dp, 手机上两侧还要留一圈浮层边距, 而这里的内容偏偏最吃
/// 宽度 (命令回显要按列读、diff 一行两列), 窄一截就直接变成频繁折行。整页之后可用
/// 宽度只受页面边距约束。弹层时代"不推走对话、不丢滚动位置"的好处, push/返回同样有。
class ToolGroupPage extends StatefulWidget {
  const ToolGroupPage({super.key, required this.title, required this.entries});

  final String title;
  final List<TimelineEntry> entries;

  @override
  State<ToolGroupPage> createState() => _ToolGroupPageState();
}

class _ToolGroupPageState extends State<ToolGroupPage> {
  final Set<String> _open = {};

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final steps = widget.entries
        .where(
          (e) =>
              e.kind == 'tool' ||
              (e.kind == 'agent_thinking' &&
                  ((e.thinking ?? e.text ?? '').trim().isNotEmpty ||
                      e.streaming)),
        )
        .toList(growable: false);
    return NeoxScaffold.compact(
      title: widget.title,
      body: ListView.builder(
        /* 左右各留 16 就够 —— 这页的主角是内容 (命令 / diff / 输出) 本身, 不是列表的
         * 装饰边距。弹层时代这里还额外套着一圈浮层边距, 三样叠起来吃掉近 80px
         * 可用宽度, 那些"要按列读"的输出就是在这时候开始无谓折行的。 */
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
        itemCount: steps.length,
        itemBuilder: (context, i) {
          final e = steps[i];
          final key = '${e.id}-${e.sequence}';
          final open = _open.contains(key);
          final isTool = e.kind == 'tool';
          final kind = _kindOf(e.toolName);
          final verb = isTool ? _verbOf(kind, e.toolName) : tr('思考');
          final detail = isTool
              ? _stepDetail(e)
              : (e.thinking ?? e.text ?? '').trim().split('\n').first;
          final failed = isTool && !e.pending && !e.toolSuccess;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              InkWell(
                borderRadius: NeoxRadius.smallR,
                onTap: () =>
                    setState(() => open ? _open.remove(key) : _open.add(key)),
                child: IntrinsicHeight(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      /* 左列: 图标 + 连到下一步的竖线 */
                      SizedBox(
                        width: 28,
                        child: Column(
                          children: [
                            const SizedBox(height: 12),
                            Icon(
                              isTool
                                  ? toolIcon(e.toolName ?? '')
                                  : Icons.psychology_outlined,
                              size: 18,
                              color: failed
                                  ? scheme.error
                                  : scheme.onSurfaceVariant,
                            ),
                            if (i < steps.length - 1)
                              Expanded(
                                child: Container(
                                  width: 1,
                                  margin: const EdgeInsets.only(top: 6),
                                  color: scheme.outline,
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: verb,
                                  style: TextStyle(
                                    color: scheme.onSurface,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                                if (detail.isNotEmpty)
                                  TextSpan(
                                    text: '  $detail',
                                    style: TextStyle(
                                      color: scheme.onSurfaceVariant,
                                    ),
                                  ),
                              ],
                            ),
                            maxLines: open ? 4 : 1,
                            overflow: TextOverflow.ellipsis,
                            /* 跟上面那条 textStyle 同档 (14) —— 展开后的每一条
                                   * 工具行也是过程, 不该跟正文一样重 */
                            style: const TextStyle(fontSize: 14, height: 1.35),
                          ),
                        ),
                      ),
                      if (e.pending || e.streaming)
                        Padding(
                          padding: const EdgeInsets.only(left: 8, top: 14),
                          child: _RunningPulse(color: scheme.onSurfaceVariant),
                        ),
                    ],
                  ),
                ),
              ),
              if (open)
                Padding(
                  /* 不再缩进 38px —— 展开出来的是**内容块** (命令 / diff / 输出),
                         * 不是上一行的文字续行。缩进只会让本就要按列对齐的东西更早
                         * 折行, 那正是用户说的"没有用满宽度"。 */
                  padding: const EdgeInsets.only(bottom: 10),
                  child: isTool
                      ? _StepBody(entry: e)
                      : ThinkingFold(
                          dense: true,
                          text: (e.thinking ?? e.text ?? '').trim().isEmpty
                              ? '…'
                              : (e.thinking ?? e.text ?? ''),
                          ts: e.timestamp,
                          streaming: e.streaming,
                          durationMs: e.thinkingDurationMs,
                        ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// 弹层里某一步的详情: 直接给内容 (命令 / diff / 输出)。
/// 不套 ToolBlock —— 它自带一条折叠头, 点开这一步还要再点一次才看得到东西。
class _StepBody extends StatelessWidget {
  const _StepBody({required this.entry});
  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final args = e.args;
    String? command;
    for (final k in const ['command', 'cmd', 'code', 'script']) {
      final v = args?[k];
      if (v is String && v.isNotEmpty) {
        command = v;
        break;
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (e.pending && (e.liveOutput ?? '').isNotEmpty)
          LiveOutputTail(command: command, text: e.liveOutput ?? ''),
        toolr.ToolView(
          toolName: e.toolName ?? 'tool',
          args: args,
          result: e.output != null
              ? {'content': e.output, 'ok': e.toolSuccess}
              : null,
        ),
      ],
    );
  }
}

class _RunningPulse extends StatefulWidget {
  const _RunningPulse({required this.color});
  final Color color;

  @override
  State<_RunningPulse> createState() => _RunningPulseState();
}

class _RunningPulseState extends State<_RunningPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.35, end: 1).animate(_c),
      child: Text(
        '●',
        style: TextStyle(
          fontSize: 11,
          height: 1,
          color: widget.color,
          fontFamily: NeoxMono.family,
          fontFamilyFallback: NeoxMono.fallback,
        ),
      ),
    );
  }
}
