/// error_view.dart — 错误展示, 2 个层次.
///
/// - ErrorLine: 一行简单错误 (session_error / 服务端原生错文案), 红 chip + 文字.
/// - ErrorEnvelopeCard: 完整的网关 envelope (code + message + suggestion + action CTA),
///   跟 Desktop ErrorView 对齐, 让用户点 "重试" / "重选模型" / "联系管理员" 等动作直接修复.
///
/// agent_text 内容如果是 ❌ 开头 + "Suggestion:" 这种格式 (forwarder error_classified 分支输出),
/// 自动派发到 ErrorEnvelopeCard.
library;

import 'package:flutter/material.dart';

import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 1 行错误展示 — session_error 简单 kind 用.
class ErrorLine extends StatelessWidget {
  const ErrorLine({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.errorContainer.withValues(alpha: 0.4),
          border: Border.all(
            color: theme.colorScheme.error.withValues(alpha: 0.4),
          ),
          borderRadius: NeoxRadius.smallR,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.error_outline, size: 14, color: theme.colorScheme.error),
            const SizedBox(width: 8),
            Expanded(
              child: SelectableText(
                text,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 完整 envelope 错误卡 — 用于 agent_text 是 ❌ 开头的失败消息.
///
/// 自动从原文里拆出:
///   line 1: ❌ {title}  (网关 envelope.message)
///   line 2+: 💡 Suggestion: {hint}  (forwarder 加的解决建议)
class ErrorEnvelopeCard extends StatelessWidget {
  const ErrorEnvelopeCard({
    super.key,
    required this.raw,
    this.onPickModel,
    this.onRetry,
    this.alwaysOfferRetry = false,
    this.alwaysOfferModelSwitch = false,
    this.retryLabel,
  });

  /// agent_text 原文, 通常形如:
  ///   "❌ 该模型暂不可用, 请联系管理员或选择其他模型\n\n💡 Suggestion: Please check ..."
  final String raw;

  /// 点 "重选模型" 时触发 — 调用方 (timeline_page) 弹 picker.
  final VoidCallback? onPickModel;

  /// 点 "重试" 时触发 — 对齐桌面 ErrorView, 走 control:retry.
  final VoidCallback? onRetry;

  /// 跳过关键词嗅探直接给「重试」按钮.
  ///
  /// 下面那套 blob.contains 判定是给**桌面透传**的错误信封用的 —— 那些文案由
  /// forwarder 生成, 词汇可预期。客户端自己写的 client_error 不该再猜一遍:
  /// 消息没发出去, 重试永远是有意义的动作。
  /// (实测反例: "该模型已停用, 请选择其他模型" 一个重试关键词都不含, 于是错误卡
  ///  连按钮都不长, 用户依旧无路可走。)
  final bool alwaysOfferRetry;

  /// 同上 — 由调用方判定这是"模型不可用"类错误时直接给「换个模型」.
  final bool alwaysOfferModelSwitch;

  /// 「重试」按钮的文案覆盖 —— 客户端发送失败卡用「重发」(原话还在, 不是重跑任务).
  final String? retryLabel;

  @override
  Widget build(BuildContext context) {
    final lines = raw.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty).toList();
    String title = tr('错误');
    String? message;
    String? suggestion;

    for (final l in lines) {
      if (l.startsWith('❌')) {
        title = l.substring(1).trim();
      } else if (l.startsWith('💡')) {
        final colonIdx = l.indexOf(':');
        suggestion = (colonIdx > 0 ? l.substring(colonIdx + 1) : l.substring(1)).trim();
      } else {
        message = (message == null ? l : '$message\n$l');
      }
    }

    final blob = '$title ${message ?? ''} ${suggestion ?? ''}'.toLowerCase();
    /* 简易判定: title 含 "模型" / "model" / "unavailable" → 显示"换模型"按钮 */
    final showSwitch = onPickModel != null &&
        (alwaysOfferModelSwitch ||
            title.contains('模型') ||
            title.toLowerCase().contains('model') ||
            title.toLowerCase().contains('unavailable'));
    /* upstream / HTTP 5xx / 执行器 / suggestion 提重试 → 显「重试」 */
    final showRetry = onRetry != null &&
        (alwaysOfferRetry ||
            blob.contains('upstream') ||
            blob.contains('http_5') ||
            blob.contains('http 5') ||
            blob.contains('do request failed') ||
            blob.contains('执行器') ||
            blob.contains('自动重试') ||
            blob.contains('重试') ||
            blob.contains('retry') ||
            blob.contains('try again') ||
            blob.contains('rate limit') ||
            blob.contains('timeout') ||
            blob.contains('network'));

    /* 回执, 不是文档 (2026-09-30 真机: 一张卡占了小半屏 —— 大号红标题、带底色的建议框、
     * 一颗黑色大按钮)。现在: 一行「图标 · 原因 · 重试 / 换模型」, 细节是下面一行灰色小字。
     * 细节可长按选中复制 (出问题时截图 / 复制给我们看)。 */
    /* 陶土稿 v5: 一块小泥板 —— 红点 + 原因 (墨色), 灰字细节, 右下角 32 高的陶土小按钮 */
    final c = ClayInk.of(context);
    final detail = [if (message != null) message, if (suggestion != null) suggestion].join('\n');
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 6, 16, 6),
      child: ClaySlab(
        radius: 16,
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.only(top: 6), child: ClayDot(color: c.red, size: 8)),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, height: 1.35, fontWeight: FontWeight.w600, color: c.ink),
                  ),
                ),
              ],
            ),
            if (detail.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 17, top: 3, right: 4),
                child: SelectableText(
                  detail,
                  maxLines: 3,
                  style: TextStyle(fontSize: 12.5, height: 1.4, color: c.grey),
                ),
              ),
            if (showRetry || showSwitch) ...[
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (showSwitch) ClayButton(label: tr('换模型'), kind: ClayButtonKind.clay, size: ClayButtonSize.small, onTap: onPickModel),
                  if (showSwitch && showRetry) const SizedBox(width: 8),
                  if (showRetry) ClayButton.ink(label: retryLabel ?? tr('重试'), size: ClayButtonSize.small, onTap: onRetry),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
