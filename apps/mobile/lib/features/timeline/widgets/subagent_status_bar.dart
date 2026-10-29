/// subagent_status_bar.dart — 输入框上方的「N 个 agent 运行中」状态条.
///
/// 只在**有子 agent 在跑**时占位, 跑完立即消失 (明康拍板: 不留常驻条)。
/// 点它弹出 agent 菜单 (名字 / 状态 / 耗时), 点某个 agent → 子 agent 悬浮窗。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/theme/neox_tokens.dart';
import '../state/subagent_registry.dart';
import 'subagent_page.dart';
import 'package:neox_app/core/i18n/tr.dart';

class SubagentStatusBar extends ConsumerStatefulWidget {
  const SubagentStatusBar({super.key, required this.sessionId});

  final String sessionId;

  @override
  ConsumerState<SubagentStatusBar> createState() => _SubagentStatusBarState();
}

class _SubagentStatusBarState extends ConsumerState<SubagentStatusBar> {
  Timer? _tick;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// 只有条子在的时候才跑 1s 计时器刷耗时 — 没 agent 在跑时不空转.
  void _syncTicker(bool visible) {
    if (visible && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!visible && _tick != null) {
      _tick!.cancel();
      _tick = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final running = ref.watch(runningSubagentsProvider(widget.sessionId));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _syncTicker(running.isNotEmpty);
    });
    if (running.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final now = DateTime.now().millisecondsSinceEpoch;
    /* 单个时直接显名字 + 耗时; 多个时显数量, 细节留给菜单 */
    final label = running.length == 1
        ? '${running.first.displayName} · ${formatElapsed(running.first.elapsed(now))}'
        : tr('${running.length} 个 agent 运行中');

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.lg,
        0,
        NeoxSpace.lg,
        NeoxSpace.xs,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(NeoxRadius.chip),
          onTap: _openMenu,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: NeoxSpace.sm,
              vertical: NeoxSpace.xs + 1,
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 11,
                  height: 11,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.4,
                    color: scheme.primary,
                  ),
                ),
                const SizedBox(width: NeoxSpace.sm),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Icon(
                  Icons.expand_less_rounded,
                  size: 16,
                  color: scheme.hintInk,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openMenu() async {
    final picked = await showSubagentMenu(context, sessionId: widget.sessionId);
    if (picked == null || !mounted) return;
    await openSubagentSession(
      context,
      parentSessionId: widget.sessionId,
      agentId: picked,
    );
  }
}

/// agent 菜单 — 列出本会话所有子 agent (在跑的排前).
/// 返回用户点中的 agentId (子会话 id); 关掉菜单不选返 null.
/// 悬浮窗由调用方在菜单关闭后打开 — 菜单自身的 context 随 route 一起销毁, 不能拿来 push。
Future<String?> showSubagentMenu(
  BuildContext context, {
  required String sessionId,
}) {
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (_) => _SubagentMenu(sessionId: sessionId),
  );
}

class _SubagentMenu extends ConsumerWidget {
  const _SubagentMenu({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    /* 只列真子 agent — Explore 是工具调用, 在 timeline 工具组里已有交代 */
    final all = [...ref.watch(realSubagentsProvider(sessionId))]
      ..sort((a, b) {
        if (a.running != b.running) return a.running ? -1 : 1;
        return b.startedAt.compareTo(a.startedAt);
      });

    return SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: const BorderRadius.vertical(
            top: Radius.circular(NeoxRadius.card),
          ),
        ),
        padding: const EdgeInsets.only(bottom: NeoxSpace.sm),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.lg,
                NeoxSpace.md,
                NeoxSpace.lg,
                NeoxSpace.sm,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.smart_toy_outlined,
                    size: 15,
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: NeoxSpace.sm),
                  Text(
                    tr('子 agent'),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            if (all.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoxSpace.lg,
                  0,
                  NeoxSpace.lg,
                  NeoxSpace.lg,
                ),
                child: Text(
                  tr('这轮还没派过子 agent'),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                itemCount: all.length,
                itemBuilder: (context, i) {
                  final s = all[i];
                  return ListTile(
                    dense: true,
                    leading: s.running
                        ? SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 1.6,
                              color: scheme.primary,
                            ),
                          )
                        : Icon(
                            s.success
                                ? Icons.check_rounded
                                : Icons.error_outline,
                            size: 17,
                            color: s.success
                                ? scheme.onSurfaceVariant
                                : scheme.error,
                          ),
                    title: Text(
                      s.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                    subtitle: Text(
                      subagentStatusLine(s),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                    trailing: Icon(
                      Icons.chevron_right_rounded,
                      size: 18,
                      color: scheme.hintInk,
                    ),
                    onTap: () => Navigator.of(context).pop(s.agentId),
                  );
                },
              ),
            ),
            if (all.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoxSpace.lg,
                  NeoxSpace.xs,
                  NeoxSpace.lg,
                  0,
                ),
                child: Text(
                  tr('共 ${all.length} 个 · ${all.where((s) => s.running).length} 个在跑'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.hintInk,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
