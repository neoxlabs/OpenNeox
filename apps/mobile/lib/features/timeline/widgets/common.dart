/// common.dart — timeline 各 row 共享的小 widget.
///
/// 收: MiniHeader (label+ts) / DividerLine / ProgressLine / ConnectionBanner.
///
/// 注 — CursorBlink / TypingDots / Markdown 各自独立文件, 因为它们使用频率更高,
/// 单独 import 让 widget 树读起来更清晰.
library;

import 'package:flutter/material.dart';

import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';

import '../../../core/network/ws_client_provider.dart';
import '../models/payload_utils.dart' show fmtTime;
import 'package:neox_app/core/i18n/tr.dart';

/// 每条消息顶部的小 label — "AGENT" "你" "THINKING" 等 + HH:mm 时间.
class MiniHeader extends StatelessWidget {
  const MiniHeader({
    super.key,
    required this.label,
    required this.ts,
    this.icon,
  });
  final String label;
  final int ts;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12, color: mute),
            const SizedBox(width: 6),
          ],
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: mute,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.6,
              fontSize: 12,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            fmtTime(ts),
            style: theme.textTheme.labelSmall?.copyWith(
              color: mute.withValues(alpha: 0.7),
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}

/// "—— 文字 ——" 分隔线 — session_done 等 meta 事件用.
class DividerLine extends StatelessWidget {
  const DividerLine({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 10, NeoxIndent.gutter, 10),
      child: Row(
        children: [
          Expanded(
            child: Divider(
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
              thickness: 0.5,
            ),
          ),
          const SizedBox(width: 12),
          Text(
            text,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Divider(
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
              thickness: 0.5,
            ),
          ),
        ],
      ),
    );
  }
}

/// 小 spinner + 单行文字 — "progress" kind 用.
class ProgressLine extends StatelessWidget {
  const ProgressLine({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 4, NeoxIndent.gutter, 4),
      child: Row(
        children: [
          SizedBox(
            width: 10,
            height: 10,
            child: CircularProgressIndicator(strokeWidth: 1.4, color: mute),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodySmall?.copyWith(color: mute),
            ),
          ),
        ],
      ),
    );
  }
}

/// 已有消息的会话在补进度时的细条 (跟 [ConnectionBanner] 同高同样式)。
///
/// 回前台 / 重连后, 连接看着是「已连接」, 实际还在探活、在补错过的消息 —— 原来这段时间什么都不显示,
/// 屏上是离开前的旧进度, 用户以为没刷新 (2026-09-29)。空会话不用它: 列表中间已有加载动画。
/// [failed] = 补失败了, 给重试。
class SyncStrip extends StatelessWidget {
  const SyncStrip({super.key, required this.failed, this.onRetry});
  final bool failed;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = failed ? theme.colorScheme.error : theme.colorScheme.onSurfaceVariant;
    return Container(
      width: double.infinity,
      color: color.withValues(alpha: 0.08),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
      child: Row(
        children: [
          if (failed)
            Icon(Icons.sync_problem, size: 13, color: color)
          else
            SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.5, color: color),
            ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              failed ? tr('没同步到最新进度') : tr('正在同步最新进度'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall?.copyWith(color: color, fontWeight: FontWeight.w500),
            ),
          ),
          if (failed && onRetry != null)
            InkWell(
              onTap: onRetry,
              child: Text(
                tr('重试'),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 顶部连接状态: 页面顶栏下面居中一颗小胶囊 (陶土稿, 跟 NeoxToast 同一套圆角/字号) — WsConnectionState 非 connected 时显.
///
/// 只换外观: 什么时候显示、文案来源、重连调用都在调用方 / 连接层, 这里不改。
/// 断开态可点 ([onRetry] 有值时) —— 「已断开 · 点一下重连」。
class ConnectionBanner extends StatelessWidget {
  const ConnectionBanner({
    super.key,
    required this.state,
    this.msg,
    this.transport,
    this.action,
    this.onRetry,
  });
  final WsConnectionState state;
  final String? msg;

  /// transport — 决定文案口径: 云端 / 我的电脑。
  final WsTransport? transport;

  /// 右侧动作 (e.g. 桌面失联时的「云端接管」按钮) — 调用方按登录态/开关决定给不给.
  final Widget? action;

  /// 断开态点一下调这个重连 (调用方决定给不给; 不给就只显示文字).
  final VoidCallback? onRetry;

  bool get _isCloudAgent => transport == WsTransport.cloudAgent;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final Color bg;
    final Color fg;
    final String text;
    final Widget leading;
    var tappable = false;
    switch (state) {
      case WsConnectionState.connecting:
        bg = c.tint;
        fg = c.grey;
        /* 连接层此刻在做什么, 它自己说得比这里准 ("正在唤醒电脑" / "正在远程连接")。
         * 原来无条件盖成"正在连接你的电脑…", 于是唤醒电脑那几秒用户以为卡住了。 */
        text = _shortOrNull(msg) ??
            (_isCloudAgent ? tr('正在启动云端任务') : tr('正在连接电脑'));
        leading = ClaySpinner(size: 11, color: fg);
        break;
      case WsConnectionState.error:
        bg = c.redSoft;
        fg = c.redInk;
        text = _humanizeError(msg);
        leading = Icon(Icons.cloud_off_outlined, size: 13, color: fg);
        break;
      case WsConnectionState.disconnected:
        bg = c.tint;
        fg = c.ink;
        if (_isCloudAgent) {
          text = tr('云端任务已断开');
        } else {
          text = tr('已断开 · 点一下重连');
          tappable = onRetry != null;
        }
        leading = Icon(Icons.refresh_rounded, size: 13, color: c.cobalt);
        break;
      case WsConnectionState.connected:
        return const SizedBox.shrink();
    }
    final pill = Container(
      constraints: const BoxConstraints(maxWidth: 320),
      padding: const EdgeInsets.fromLTRB(12, 5, 12, 5),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(15)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          leading,
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              /* 硬闸: 胶囊永远一行 (换行会把它撑高, 顶掉输入框上方的空间)。文案短是前提。 */
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: fg, height: 1.2),
            ),
          ),
          if (action != null) ...[
            const SizedBox(width: 8),
            action!,
          ],
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
      child: Center(
        child: tappable ? GestureDetector(onTap: onRetry, child: pill) : pill,
      ),
    );
  }

  /// 连接层已经写好的短句直接用; 长句 (原始错误串) 返回 null 交给 [_humanizeError].
  ///
  /// 阈值 14 个字 —— 再长在窄屏 (X200 PRO mini) 上就换行, 横幅高度跟着翻倍。
  static String? _shortOrNull(String? raw) {
    final s = raw?.trim();
    if (s == null || s.isEmpty) return null;
    if (s.contains('\n') || s.runes.length > 14) return null;
    return s;
  }

  /// 把原始错误码转成用户能看懂的中文提示。
  ///
  /// 2026-09-18: 全部压到一句、不带"请…""Neox 会…"这类解释。用户原话
  /// "提示语不能废话 字体不能过大"。理由必须有 (说清是谁不在线), 但不铺开讲。
  String _humanizeError(String? raw) {
    final isCloudAgent = _isCloudAgent;
    if (raw == null || raw.isEmpty) {
      return isCloudAgent ? tr('云端任务不可用') : tr('电脑连不上');
    }
    /* 连接层自己给的短句 (「电脑没接入远程通道」「远程没连上 · 20 秒后重试」)
     * 比这里的翻译准, 直接用 —— 原来会被下面的规则盖掉。 */
    final short = _shortOrNull(raw);
    if (short != null) return short;

    final low = raw.toLowerCase();
    if (low.contains('未连接 desktop') ||
        low.contains('bad state') ||
        low.contains('no active client')) {
      return isCloudAgent ? tr('云端任务已断开') : tr('电脑未连接');
    }
    if (low.contains('timeout') || low.contains('timed out')) {
      return isCloudAgent ? tr('云端任务启动慢') : tr('电脑没响应');
    }
    if (low.contains('401') ||
        low.contains('unauthorized') ||
        low.contains('invalid token')) {
      return tr('登录已过期');
    }
    if (low.contains('socketexception') ||
        low.contains('connection refused') ||
        low.contains('failed host lookup')) {
      return tr('网络不可达');
    }
    if (low.contains('target offline') || low.contains('device offline')) {
      return isCloudAgent ? tr('云端任务已停止') : tr('电脑不在线');
    }
    /* 兜底: 原始错误串不给用户看 —— 它只会换行、撑高、且没人看得懂 */
    return isCloudAgent ? tr('云端任务不可用') : tr('电脑连不上');
  }
}
