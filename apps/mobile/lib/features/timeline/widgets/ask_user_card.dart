/// ask_user_card.dart — Agent 中途追问用户的卡片.
///
/// `ask_user_needed` 是 agent loop 的阻塞点: 用户在手机上回答后, 通过
/// control:ask_user_reply 回到 Desktop/Cloud runtime, 解除 ask_user Promise 并继续执行.
library;

import 'package:flutter/material.dart';

import '../../../shared/clay/clay.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/friendly_error.dart';
import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../shared/widgets/neox_field.dart';
import 'package:neox_app/core/i18n/tr.dart';

class AskUserCard extends ConsumerStatefulWidget {
  const AskUserCard({
    super.key,
    required this.sessionId,
    required this.askUser,
  });

  final String sessionId;
  final PendingAskUser askUser;

  @override
  ConsumerState<AskUserCard> createState() => _AskUserCardState();
}

class _AskUserCardState extends ConsumerState<AskUserCard> {
  final Map<String, TextEditingController> _customCtrls = {};
  final Map<String, Set<String>> _selected = {};
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _resetLocalState();
  }

  @override
  void didUpdateWidget(covariant AskUserCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.askUser.requestId != widget.askUser.requestId) {
      _resetLocalState();
    }
  }

  @override
  void dispose() {
    for (final c in _customCtrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _resetLocalState() {
    for (final c in _customCtrls.values) {
      c.dispose();
    }
    _customCtrls.clear();
    _selected.clear();
    for (final q in widget.askUser.questions) {
      _customCtrls[q.question] = TextEditingController();
      _selected[q.question] = <String>{};
    }
  }

  TextEditingController _controllerFor(String question) {
    return _customCtrls.putIfAbsent(question, TextEditingController.new);
  }

  String _answerFor(PendingAskUserQuestion q) {
    final custom = _controllerFor(q.question).text.trim();
    if (custom.isNotEmpty) return custom;
    final selected = _selected[q.question] ?? const <String>{};
    if (selected.isEmpty) return '';
    return selected.join(', ');
  }

  bool get _allAnswered =>
      widget.askUser.questions.isNotEmpty &&
      widget.askUser.questions.every((q) => _answerFor(q).isNotEmpty);

  Map<String, String> _answers() {
    final answers = <String, String>{};
    for (final q in widget.askUser.questions) {
      final answer = _answerFor(q);
      if (answer.isNotEmpty) answers[q.question] = answer;
    }
    return answers;
  }

  void _pickOption(PendingAskUserQuestion q, PendingAskUserOption option) {
    if (_busy) return;
    setState(() {
      final selected = _selected.putIfAbsent(q.question, () => <String>{});
      if (q.multiSelect) {
        if (!selected.remove(option.label)) selected.add(option.label);
      } else {
        selected
          ..clear()
          ..add(option.label);
      }
      _controllerFor(q.question).clear();
    });
  }

  Future<void> _submit() async {
    if (_busy || !_allAnswered) return;
    setState(() => _busy = true);
    final answers = _answers();
    try {
      final ws = ref.read(wsClientProvider.notifier);
      final result = await ws.sendInputForResult(
        sessionId: widget.sessionId,
        kind: 'control:ask_user_reply',
        payload: {'request_id': widget.askUser.requestId, 'answers': answers},
      );
      if (result is Map && result['ignored'] == true) {
        throw StateError(tr('当前电脑版本过旧，不支持回答追问'));
      }
      final status = result is Map ? result['status']?.toString() : null;
      if (status == 'orphan') {
        await ws.sendInput(
          sessionId: widget.sessionId,
          kind: 'user_message',
          payload: {'text': _formatAnswersForMessage(answers)},
        );
        if (mounted) _toast(tr('原请求已失效，已按普通消息发送回答'));
      }
      ref
          .read(pendingAskUsersProvider.notifier)
          .remove(widget.sessionId, widget.askUser.requestId);
      _close();
    } catch (e) {
      if (mounted) _toast(friendlyError(e, fallback: tr('提交失败，请稍后重试')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 卡片在底部抽屉里: 答完 / 跳过 / 在别处被答掉, 抽屉都要自己收起。
  /// 原来只删了待答列表, 抽屉里那张卡还静态地挂着 (2026-09-30 「确认已生效, 卡片还在」)。
  bool _closed = false;
  void _close() {
    if (_closed || !mounted) return;
    _closed = true;
    Navigator.of(context).maybePop();
  }

  /// 跳过这次追问 —— 用户明确表达"不答了, 继续" (2026-09-22).
  ///
  /// 协议里 `replyAskUser` 只认 answers (没有 skip 态), 所以发一份**空答案**:
  /// 目标是让 agent 那侧别再等 —— 它拿到的是"回答为空", 而不是永远挂起的 Promise。
  ///
  /// 本地**无论成败都撤掉这行**: 用户已经说了"要下去", 不能因为一次 RPC 失败
  /// 就把他钉回原来那个"退不出去"的界面 —— 那正是他要逃离的状态。
  Future<void> _skip() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(wsClientProvider.notifier).sendInputForResult(
        sessionId: widget.sessionId,
        kind: 'control:ask_user_reply',
        payload: {
          'request_id': widget.askUser.requestId,
          'answers': const <String, String>{},
        },
      );
    } catch (e) {
      debugPrint('[ask_user] skip rpc failed: $e');
    } finally {
      ref
          .read(pendingAskUsersProvider.notifier)
          .remove(widget.sessionId, widget.askUser.requestId);
      if (mounted) setState(() => _busy = false);
      _close();
    }
  }

  String _formatAnswersForMessage(Map<String, String> answers) {
    return widget.askUser.questions
        .map((q) => 'Q: ${q.question}\nA: ${answers[q.question] ?? ''}')
        .join('\n\n');
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    /* 别处答掉了 (电脑上作答 / 超时 / 会话中断) → 这条从待答列表消失 → 抽屉跟着收 */
    ref.listen<List<PendingAskUser>>(
      sessionPendingAskUsersProvider(widget.sessionId),
      (_, next) {
        if (!next.any((a) => a.requestId == widget.askUser.requestId)) _close();
      },
    );
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final qs = widget.askUser.questions;
    /* 抽屉排版 (2026-09-30 用户: 「Ask 卡片在手机上的 UI 需要优化」):
     * 原来是给 timeline 内嵌设计的 —— 13px 字、15px 图标、6px 行距, 挪进抽屉后又挤又小,
     * 选项点不准。现在按底部抽屉排: 问题用正文大小、选项是整行可点的圆角块 (≥48 高),
     * 确认 / 跳过钉在底部, 问题多了中间滚动, 按钮不会被推出屏幕。 */
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
              child: Row(
                children: [
                  ClayTile(icon: Icons.help_outline_rounded, size: 30, bead: ClayInk.of(context).amber),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      tr('Agent 在等你回答'),
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                  if (qs.length > 1)
                    Text(
                      tr('${qs.length} 个问题'),
                      style: theme.textTheme.labelMedium?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                children: [
                  for (var i = 0; i < qs.length; i++) ...[
                    if (i > 0) const SizedBox(height: 20),
                    _QuestionBlock(
                      index: i,
                      total: qs.length,
                      question: qs[i],
                      controller: _controllerFor(qs[i].question),
                      selected: _selected[qs[i].question] ?? const <String>{},
                      busy: _busy,
                      onPick: _pickOption,
                      onCustomChanged: (v) {
                        setState(() {
                          if (v.trim().isNotEmpty) _selected[qs[i].question]?.clear();
                        });
                      },
                      onSubmit: _submit,
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
              child: SafeArea(
                top: false,
                child: Row(
                  children: [
                    ClayButton(label: tr('跳过'), kind: ClayButtonKind.text, onTap: _busy ? null : _skip),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ClayButton.ink(
                        label: _allAnswered ? tr('确认') : tr('请先回答所有问题'),
                        size: ClayButtonSize.large,
                        expand: true,
                        busy: _busy,
                        onTap: _busy || !_allAnswered ? null : _submit,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuestionBlock extends StatelessWidget {
  const _QuestionBlock({
    required this.index,
    required this.total,
    required this.question,
    required this.controller,
    required this.selected,
    required this.busy,
    required this.onPick,
    required this.onCustomChanged,
    required this.onSubmit,
  });

  final int index;
  final int total;
  final PendingAskUserQuestion question;
  final TextEditingController controller;
  final Set<String> selected;
  final bool busy;
  final void Function(PendingAskUserQuestion, PendingAskUserOption) onPick;
  final ValueChanged<String> onCustomChanged;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (total > 1)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                '${index + 1} / $total',
                style: theme.textTheme.labelMedium?.copyWith(color: mute, fontWeight: FontWeight.w600),
              ),
            ),
          Text(
            question.question,
            style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600, height: 1.45),
          ),
          if (question.multiSelect)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(tr('可多选'), style: theme.textTheme.labelMedium?.copyWith(color: mute)),
            ),
          if (question.options.isNotEmpty) ...[
            const SizedBox(height: 10),
            for (final option in question.options)
              _OptionRow(
                question: question,
                option: option,
                selected: selected.contains(option.label),
                busy: busy,
                onTap: () => onPick(question, option),
              ),
          ],
          const SizedBox(height: 4),
          NeoxField(
            controller: controller,
            variant: NeoxFieldVariant.multi,
            minLines: 1,
            maxLines: 3,
            enabled: !busy,
            hintText: question.options.isEmpty ? tr('输入回答') : tr('或输入自定义回答'),
            textInputAction: TextInputAction.done,
            onChanged: onCustomChanged,
            onSubmitted: (_) => onSubmit(),
          ),
        ],
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.question,
    required this.option,
    required this.selected,
    required this.busy,
    required this.onTap,
  });

  final PendingAskUserQuestion question;
  final PendingAskUserOption option;
  final bool selected;
  final bool busy;
  final VoidCallback onTap;

  /// 陶土稿 v5: 选项是一根根陶土条 (≥48 高), 选中 = 右边实心墨圆白勾、字加粗; 不描边、不换底色
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ClaySlab(
        radius: 14,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        onTap: busy ? null : onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 26),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      option.label,
                      style: TextStyle(
                        fontSize: 14.5,
                        color: c.ink,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                        height: 1.35,
                      ),
                    ),
                    if ((option.description ?? '').isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(option.description!, style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.4)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 10),
              if (selected)
                const ClayCheck(filled: true, size: 22)
              else
                Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    shape: question.multiSelect ? BoxShape.rectangle : BoxShape.circle,
                    borderRadius: question.multiSelect ? BorderRadius.circular(6) : null,
                    border: Border.all(color: c.line, width: 1.4),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 追问入口 —— timeline 里只留**一行**紧凑提示, 点开才弹完整表单.
///
/// 2026-09-22 用户实拍: 「绘画在手机上永远都是这个 ask 卡片…它本质上应该是可以取消的,
/// 它就可以像下面抽屉一样弹出来让你去选选项, 如果不选也可以下去」。
///
/// 原来整个表单是**内嵌在 timeline 里**的: 两个问题带上选项和自定义输入框能占满一整屏,
/// 把对话整段挤走 —— 用户连往上翻历史都做不到; 更糟的是它**没有任何关闭路径**,
/// agent 那边作废了 (超时/在电脑上答过/协议里的 dismissed) 它也照样杵在那儿。
///
/// 现在: timeline 里只有这一行, 完整表单进底部抽屉。
///   · 抽屉可以下拉关掉 —— 不选也能回去看 timeline (用户要的"不选也可以下去")
///   · 卡片在别处被解决时, 这一行会跟着消失 (见 agentStreamForwarder 的 ask_user_expired)
///   · 还有多个追问时, 行里标出总数, 逐个点开
class AskUserStack extends ConsumerWidget {
  const AskUserStack({super.key, required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(sessionPendingAskUsersProvider(sessionId));
    if (list.isEmpty) return const SizedBox.shrink();
    final c = ClayInk.of(context);
    /* 电脑终端里先答了: 卡片不撤, 翻成「已答」并显示答案 —— 用户要能看出是谁答的、答了什么
     * (2026-10-18)。还有待答的就先露待答的那个。 */
    final pending = list.where((x) => !x.answered).toList();
    final first = pending.isNotEmpty ? pending.first : list.first;
    final more = (pending.isNotEmpty ? pending.length : list.length) - 1;
    if (first.answered) {
      final summary = (first.answers ?? const <String, String>{})
          .values
          .where((v) => v.trim().isNotEmpty)
          .join('；');
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        child: ClaySlab(
          radius: 16,
          padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
          child: Row(
            children: [
              ClayDot(color: c.green, size: 8),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      more > 0 ? tr('已在电脑上回答 · 还有 $more 条') : tr('已在电脑上回答'),
                      style: TextStyle(fontSize: 12, color: c.greenInk, fontWeight: FontWeight.w600),
                    ),
                    if (summary.isNotEmpty)
                      Text(summary, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: c.ink, height: 1.35)),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }
    /* 第一个问题直接露出来 —— 比「需要确认 · 1 个问题」多给一眼信息 */
    final q = first.questions.isEmpty ? '' : first.questions.first.question.trim();

    void open(AskUserCard card) {
      showClaySheet<void>(context, scrollable: false, builder: (_) => card);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: ClaySlab(
        radius: 16,
        padding: const EdgeInsets.fromLTRB(14, 11, 10, 11),
        onTap: () => open(AskUserCard(sessionId: sessionId, askUser: first)),
        child: Row(
          children: [
            ClayDot(color: c.amber, size: 8),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    more > 0 ? tr('在等你回答 · 还有 $more 条') : tr('在等你回答'),
                    style: TextStyle(fontSize: 12, color: c.amberInk, fontWeight: FontWeight.w600),
                  ),
                  if (q.isNotEmpty)
                    Text(q, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: c.ink, height: 1.35)),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 20, color: c.faint),
          ],
        ),
      ),
    );
  }
}
