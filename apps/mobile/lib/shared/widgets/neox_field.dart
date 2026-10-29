/// neox_field.dart — 统一输入框 primitive.
///
/// 一处定义 + 全 app 通用, 防各页面散落不同 padding / 圆角 / border 一致性.
/// 设计: 8px 圆角 + 0.5px outline + 浅 fill, focus 时 outline 加重为 primary.
library;

import 'package:flutter/material.dart';

import '../../shared/theme/neox_tokens.dart';
import 'package:flutter/services.dart' show TextInputFormatter, TextCapitalization;

enum NeoxFieldVariant {
  /// 单行普通输入
  single,

  /// 多行 (1-N 行自适应)
  multi,

  /// 搜索框 (前 search icon + 清除按钮)
  search,
}

class NeoxField extends StatefulWidget {
  const NeoxField({
    super.key,
    required this.controller,
    this.variant = NeoxFieldVariant.single,
    this.hintText,
    this.focusNode,
    this.enabled = true,
    this.maxLines = 1,
    this.minLines = 1,
    this.textInputAction,
    this.onChanged,
    this.onSubmitted,
    this.leading,
    this.trailing,
    this.autofocus = false,
    this.inputFormatters,
    this.textCapitalization = TextCapitalization.none,
  });

  final TextEditingController controller;
  final NeoxFieldVariant variant;
  final String? hintText;
  final FocusNode? focusNode;
  final bool enabled;
  final int maxLines;
  final int minLines;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final Widget? leading;
  final Widget? trailing;
  final bool autofocus;
  final List<TextInputFormatter>? inputFormatters;
  final TextCapitalization textCapitalization;

  @override
  State<NeoxField> createState() => _NeoxFieldState();
}

class _NeoxFieldState extends State<NeoxField> {
  late final FocusNode _focus;
  bool _hasOwnFocus = false;
  bool _isFocused = false;

  @override
  void initState() {
    super.initState();
    if (widget.focusNode == null) {
      _focus = FocusNode();
      _hasOwnFocus = true;
    } else {
      _focus = widget.focusNode!;
    }
    _focus.addListener(_onFocus);
    widget.controller.addListener(_onTextChanged);
  }

  void _onFocus() {
    if (mounted) setState(() => _isFocused = _focus.hasFocus);
  }

  void _onTextChanged() {
    /* 仅 search variant 关心 trailing 清除按钮显隐 */
    if (widget.variant == NeoxFieldVariant.search && mounted) setState(() {});
  }

  @override
  void dispose() {
    _focus.removeListener(_onFocus);
    widget.controller.removeListener(_onTextChanged);
    if (_hasOwnFocus) _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    /* fill 跟 scaffold 同色, 不抢戏; idle 给一个淡 outline 划清边界
     *  (避免 input 完全消失看不出边界), focus 时 outline 加重为 primary. */
    final fill = theme.colorScheme.surface;
    final idleOutline = theme.colorScheme.outlineVariant;
    final focusedOutline = theme.colorScheme.primary;

    final isMulti = widget.variant == NeoxFieldVariant.multi;
    final isSearch = widget.variant == NeoxFieldVariant.search;

    Widget? leadingW = widget.leading;
    if (leadingW == null && isSearch) {
      leadingW = Icon(Icons.search, size: 18, color: mute);
    }

    Widget? trailingW = widget.trailing;
    if (trailingW == null && isSearch && widget.controller.text.isNotEmpty) {
      trailingW = InkWell(
        borderRadius: NeoxRadius.inputR,
        onTap: () {
          widget.controller.clear();
          widget.onChanged?.call('');
        },
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Icon(Icons.close, size: 16, color: mute),
        ),
      );
    }

    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      decoration: BoxDecoration(
        color: fill,
        border: Border.all(
          color: _isFocused ? focusedOutline : idleOutline,
          width: _isFocused ? 1 : 0.5,
        ),
        borderRadius: NeoxRadius.chipR,
      ),
      padding: EdgeInsets.symmetric(horizontal: 12, vertical: isMulti ? 8 : 0),
      child: Row(
        crossAxisAlignment:
            isMulti ? CrossAxisAlignment.start : CrossAxisAlignment.center,
        children: [
          if (leadingW != null) ...[
            Padding(
              padding: EdgeInsets.only(top: isMulti ? 4 : 0, right: 8),
              child: leadingW,
            ),
          ],
          Expanded(
            child: TextField(
              controller: widget.controller,
              focusNode: _focus,
              enabled: widget.enabled,
              maxLines: isMulti ? widget.maxLines : 1,
              minLines: isMulti ? widget.minLines : null,
              textInputAction: widget.textInputAction,
              autofocus: widget.autofocus,
              inputFormatters: widget.inputFormatters,
              textCapitalization: widget.textCapitalization,
              onChanged: widget.onChanged,
              onSubmitted: widget.onSubmitted,
              style: theme.textTheme.bodyMedium?.copyWith(height: 1.45),
              decoration: InputDecoration(
                isCollapsed: true,
                /* 全部 border 状态显式置 none, 否则 global InputDecorationTheme
                 * 的 enabledBorder/focusedBorder/errorBorder 会渗透出来跟
                 * 外层 Container 的 border 叠加, 产生双层嵌套视觉. */
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                errorBorder: InputBorder.none,
                focusedErrorBorder: InputBorder.none,
                /* fill 在外层 Container 给, 内层不再 fill 避免色叠加. */
                filled: false,
                fillColor: Colors.transparent,
                hintText: widget.hintText,
                hintStyle: theme.textTheme.bodyMedium?.copyWith(
                  color: mute.withValues(alpha: 0.7),
                ),
                contentPadding: EdgeInsets.symmetric(vertical: isMulti ? 0 : 12),
              ),
            ),
          ),
          if (trailingW != null) ...[
            const SizedBox(width: 8),
            trailingW,
          ],
        ],
      ),
    );
  }
}
