/// inline_approval_strip.dart — 输入框上方的审批小泥板 (陶土稿 v5「审批卡要小」).
///
///   ● 要运行 · Mac                         还有 1 个
///     会在 ordersys 里执行这条命令
///   ┌ $ rm -rf build && npm run build ┐       ← 等宽浅槽, 点开看完整参数
///   拒绝            本次都允许    [允许]      ← 32 高, 墨色「允许」靠右
///
/// 约 150 高, 只摆一件事; 多个待批时只露第一个, 右上角写还有几个。
/// 2026-07-20 用户拍板「审批做在输入框那头」—— 仍贴着输入框, 只是从框里挪到框上面一块独立的板。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/friendly_error.dart';
import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../timeline/models/payload_utils.dart';
import '../../timeline/tool_renderers.dart' as toolr;
import '../state/session_location_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 有待批的工具调用时, 输入框上方的一块小板. 没有时零占位.
class ApprovalDock extends ConsumerWidget {
  const ApprovalDock({super.key, required this.sessionId});
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(sessionPendingApprovalsProvider(sessionId));
    if (list.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: _ApprovalSlab(
        key: ValueKey(list.first.requestId),
        sessionId: sessionId,
        approval: list.first,
        more: list.length - 1,
      ),
    );
  }
}

/// 一次审批要说的三件事: 干什么 (动词) / 对象 (等宽) / 会有什么后果
({String verb, String? target, String consequence}) approvalSpeech(PendingApproval a, {String? workspace}) {
  final n = a.toolName.toLowerCase();
  String? arg(List<String> keys) {
    for (final k in keys) {
      final v = a.args[k];
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    return null;
  }

  final where = workspace == null ? '' : tr('在 $workspace 里');
  if (n.contains('shell') || n.contains('bash') || n.contains('exec') || n.contains('command')) {
    final cmd = arg(['command', 'cmd', 'script']);
    return (verb: tr('要运行'), target: cmd == null ? null : '\$ $cmd', consequence: a.reason.isNotEmpty ? a.reason : tr('会${where}执行这条命令'));
  }
  if (n == 'write_file' || n == 'create_file') {
    return (verb: tr('要新建'), target: arg(['file_path', 'path']), consequence: a.reason.isNotEmpty ? a.reason : tr('会${where}写入这个文件'));
  }
  if (isDiffToolName(a.toolName) || n.contains('edit')) {
    return (verb: tr('要改'), target: arg(['file_path', 'path']), consequence: a.reason.isNotEmpty ? a.reason : tr('会${where}改动这个文件'));
  }
  if (n.contains('delete') || n.contains('remove')) {
    return (verb: tr('要删除'), target: arg(['file_path', 'path']), consequence: a.reason.isNotEmpty ? a.reason : tr('删了就找不回来'));
  }
  final target = arg(['url', 'query', 'path', 'file_path', 'pattern']) ?? smartArgSummary(a.toolName, a.args);
  return (verb: tr('要用') + friendlyToolName(a.toolName), target: target, consequence: a.reason.isNotEmpty ? a.reason : tr('等你点头才会继续'));
}

class _ApprovalSlab extends ConsumerStatefulWidget {
  const _ApprovalSlab({super.key, required this.sessionId, required this.approval, required this.more});
  final String sessionId;
  final PendingApproval approval;
  final int more;

  @override
  ConsumerState<_ApprovalSlab> createState() => _ApprovalSlabState();
}

class _ApprovalSlabState extends ConsumerState<_ApprovalSlab> {
  bool _busy = false;

  Future<void> _reply(bool approved, {bool remember = false}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(wsClientProvider.notifier).sendInput(
        sessionId: widget.sessionId,
        kind: approved ? 'control:approve' : 'control:reject',
        payload: {
          'request_id': widget.approval.requestId,
          if (widget.approval.allowRemember) 'remember': remember,
        },
      );
      /* 主动清 — 不等 desktop 回响 (RTT), 真 cancelled 到了再 remove 无害 */
      ref.read(pendingApprovalsProvider.notifier).remove(widget.sessionId, widget.approval.requestId);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyError(e, fallback: tr('操作失败，请稍后重试')))),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 完整参数 —— 点命令那一格弹出
  Future<void> _openDetail(String title) async {
    await showClaySheet<void>(
      context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySheetHeader(title: title, subtitle: widget.approval.reason.isEmpty ? null : widget.approval.reason),
            const SizedBox(height: 8),
            toolr.ToolView(toolName: widget.approval.toolName, args: widget.approval.args, result: null),
            const SizedBox(height: 16),
            Row(
              children: [
                ClayButton(
                  label: tr('拒绝'),
                  kind: ClayButtonKind.text,
                  onTap: () {
                    Navigator.pop(ctx);
                    _reply(false);
                  },
                ),
                const Spacer(),
                ClayButton.ink(
                  label: tr('允许'),
                  onTap: () {
                    Navigator.pop(ctx);
                    _reply(true);
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final loc = ref.watch(sessionLocationProvider(widget.sessionId)).valueOrNull;
    final place = switch (loc?.kind) {
      SessionLocationKind.phone => tr('这台手机'),
      SessionLocationKind.cloud => tr('云端'),
      SessionLocationKind.desktop => (loc?.deviceName?.trim().isNotEmpty ?? false) ? loc!.deviceName!.trim() : tr('电脑'),
      _ => null,
    };
    final ws = loc?.workspaceName?.trim();
    final s = approvalSpeech(widget.approval, workspace: (ws == null || ws.isEmpty) ? null : ws);
    final title = place == null ? s.verb : '${s.verb} · $place';
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, color: c.ink, height: 1.35);
    return ClaySlab(
      radius: 18,
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ClayDot(color: c.amber, size: 8),
              const SizedBox(width: 8),
              Expanded(
                child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink)),
              ),
              if (widget.more > 0) Text(tr('还有 ${widget.more} 个'), style: TextStyle(fontSize: 12, color: c.grey)),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 16, top: 2),
            child: Text(s.consequence, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
          ),
          if (s.target != null) ...[
            const SizedBox(height: 8),
            GestureDetector(
              onTap: () => _openDetail(title),
              child: ClayWell(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                child: Text(s.target!, maxLines: 2, overflow: TextOverflow.ellipsis, style: mono),
              ),
            ),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              ClayButton(label: tr('拒绝'), kind: ClayButtonKind.text, size: ClayButtonSize.small, onTap: _busy ? null : () => _reply(false)),
              const Spacer(),
              if (widget.approval.allowRemember) ...[
                ClayButton(
                  label: tr('本次都允许'),
                  kind: ClayButtonKind.clay,
                  size: ClayButtonSize.small,
                  onTap: _busy ? null : () => _reply(true, remember: true),
                ),
                const SizedBox(width: 8),
              ],
              ClayButton.ink(label: tr('允许'), size: ClayButtonSize.small, busy: _busy, onTap: _busy ? null : () => _reply(true)),
            ],
          ),
        ],
      ),
    );
  }
}
