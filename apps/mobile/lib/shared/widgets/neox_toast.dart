/// neox_toast.dart — 全局提示: 屏幕顶部一颗小胶囊, 不挡输入框, 自己消失.
///
/// 2026-10-08 用户: 「全局的通知全部换掉, 太丑了, 还影响我输入」—— 原来是 Material 的 SnackBar,
/// 一条黑色长条压在输入框上, 打字时正好盖住。
///
/// 全 app 有 77 处 `ScaffoldMessenger.of(context).showSnackBar(...)`, 逐个改既容易漏、以后新写的也会回到老样子。
/// 所以在最外层换掉 ScaffoldMessenger: [NeoxScaffoldMessenger] 接住每一条 SnackBar, 文字 (和可选的一个按钮)
/// 交给顶部的 [NeoxToastLayer] 画; 原 SnackBar 换成一条看不见、不占地方的占位, 只为让调用方拿到的
/// controller / hideCurrentSnackBar 这些语义照旧。内容不是纯文字的 SnackBar 原样显示 (目前没有)。
library;

import 'dart:async';

import 'package:flutter/material.dart';

class _ToastData {
  _ToastData(this.text, this.actionLabel, this.onAction, this.id);
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;
  final int id;
}

class NeoxToast {
  NeoxToast._();

  static final ValueNotifier<_ToastData?> _current = ValueNotifier(null);
  static Timer? _timer;
  static int _seq = 0;

  static void show(String text, {String? actionLabel, VoidCallback? onAction, Duration? duration}) {
    _timer?.cancel();
    _current.value = _ToastData(text, actionLabel, onAction, ++_seq);
    /* 纯文字 2.5 秒够读完一句; 带按钮的多留一会儿给人去点 */
    final d = duration ?? (actionLabel == null ? const Duration(milliseconds: 2500) : const Duration(seconds: 5));
    _timer = Timer(d, hide);
  }

  static void hide() {
    _timer?.cancel();
    _current.value = null;
  }
}

/// 套在 MaterialApp.builder 里, 盖在所有页面 (含弹窗、底部面板) 之上。
class NeoxToastLayer extends StatelessWidget {
  const NeoxToastLayer({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        child,
        Positioned(
          top: MediaQuery.paddingOf(context).top + 8,
          left: 16,
          right: 16,
          child: ValueListenableBuilder<_ToastData?>(
            valueListenable: NeoxToast._current,
            builder: (context, data, _) => AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              transitionBuilder: (child, anim) => FadeTransition(
                opacity: anim,
                child: SlideTransition(
                  position: Tween(begin: const Offset(0, -0.4), end: Offset.zero).animate(anim),
                  child: child,
                ),
              ),
              child: data == null ? const SizedBox.shrink() : _ToastPill(key: ValueKey(data.id), data: data),
            ),
          ),
        ),
      ],
    );
  }
}

class _ToastPill extends StatelessWidget {
  const _ToastPill({super.key, required this.data});
  final _ToastData data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final fg = scheme.onInverseSurface;
    final pill = Material(
      color: scheme.inverseSurface.withValues(alpha: 0.94),
      elevation: 6,
      shadowColor: Colors.black26,
      borderRadius: BorderRadius.circular(22),
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 10, data.actionLabel == null ? 16 : 6, 10),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                data.text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(color: fg, fontSize: 14, height: 1.35),
              ),
            ),
            if (data.actionLabel != null) ...[
              const SizedBox(width: 4),
              TextButton(
                style: TextButton.styleFrom(
                  foregroundColor: fg,
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
                onPressed: () {
                  NeoxToast.hide();
                  data.onAction?.call();
                },
                child: Text(data.actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
    /* 没按钮的提示不吃点击 —— 盖在顶栏上也不挡人点返回 / 菜单 */
    return Center(child: data.actionLabel == null ? IgnorePointer(child: pill) : pill);
  }
}

/// 接住全 app 的 showSnackBar, 改成顶部胶囊 (见文件头)。
class NeoxScaffoldMessenger extends ScaffoldMessenger {
  const NeoxScaffoldMessenger({super.key, required super.child});

  @override
  ScaffoldMessengerState createState() => _NeoxScaffoldMessengerState();
}

class _NeoxScaffoldMessengerState extends ScaffoldMessengerState {
  @override
  ScaffoldFeatureController<SnackBar, SnackBarClosedReason> showSnackBar(
    SnackBar snackBar, {
    AnimationStyle? snackBarAnimationStyle,
  }) {
    final text = _plainText(snackBar.content);
    if (text == null || text.trim().isEmpty) {
      return super.showSnackBar(snackBar, snackBarAnimationStyle: snackBarAnimationStyle);
    }
    final action = snackBar.action;
    final custom = snackBar.duration != const SnackBar(content: SizedBox()).duration;
    NeoxToast.show(
      text.trim(),
      actionLabel: action?.label,
      onAction: action?.onPressed,
      duration: custom ? snackBar.duration : null,
    );
    /* 看不见的占位: 透明、无阴影、零内容, 只为把 controller / hide 语义交还给调用方 */
    return super.showSnackBar(
      SnackBar(
        content: const SizedBox.shrink(),
        duration: snackBar.duration,
        behavior: SnackBarBehavior.floating,
        backgroundColor: Colors.transparent,
        elevation: 0,
        padding: EdgeInsets.zero,
        dismissDirection: DismissDirection.none,
      ),
      snackBarAnimationStyle: AnimationStyle.noAnimation,
    );
  }

  @override
  void hideCurrentSnackBar({SnackBarClosedReason reason = SnackBarClosedReason.hide}) {
    NeoxToast.hide();
    super.hideCurrentSnackBar(reason: reason);
  }

  @override
  void removeCurrentSnackBar({SnackBarClosedReason reason = SnackBarClosedReason.remove}) {
    NeoxToast.hide();
    super.removeCurrentSnackBar(reason: reason);
  }

  @override
  void clearSnackBars() {
    NeoxToast.hide();
    super.clearSnackBars();
  }
}

String? _plainText(Widget w) {
  if (w is Text) return w.data ?? w.textSpan?.toPlainText();
  if (w is RichText) return w.text.toPlainText();
  return null;
}
