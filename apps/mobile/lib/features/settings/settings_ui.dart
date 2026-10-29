/// settings_ui.dart — 设置页的零件 (2026-10-14 陶土稿 v5 改).
///
/// 二级设置页是「安静的列表」: 浅陶底, 顶上 ← + 标题, 内容是一块块泥板分组,
/// 每行 = 陶土方块图标 + 名字 + 灰字当前值 (或开关 / ›)。
/// 纯列表的二级页 (账户、通知、外观、消息、设备、模型、语音) 右上那团陶土都去掉;
/// 只有「先讲清楚是什么」的功能页 (工具包 / 本地模型 / 操作手机 / 云端任务) 顶上放一张插画 ([SettingsFrame.art])。
library;

import 'package:flutter/material.dart';

import '../../core/network/ws_client_provider.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 二级 settings 页面统一壳: ← 标题, 浅陶底.
class SettingsFrame extends StatelessWidget {
  const SettingsFrame({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.hero,
    this.subtitle,
    this.art,
  });

  final String title;
  final Widget body;
  final List<Widget>? actions;

  /// 旧的陶土页头背景图。v5 起纯列表页不放插画, 这个参数不再画 (留着让调用方不用改)
  final String? hero;
  final String? subtitle;

  /// 功能页顶上的一张 v5 插画 (assets/clay/v5/NAME.webp)
  final String? art;

  @override
  Widget build(BuildContext context) {
    return ClayPage(
      title: title,
      subtitle: subtitle,
      actions: actions ?? const [],
      body: art == null
          ? body
          : Column(
              children: [
                SizedBox(height: 150, child: Center(child: ClayArt(art!, height: 150))),
                Expanded(child: body),
              ],
            ),
    );
  }
}

/// 一块独立的泥板 (不是行分组时用)
class SettingsSurface extends StatelessWidget {
  const SettingsSurface({
    super.key,
    required this.child,
    this.margin = const EdgeInsets.fromLTRB(16, NeoxSpace.md, 16, NeoxSpace.sm),
    this.padding = const EdgeInsets.all(NeoxSpace.lg),
    this.color,
  });

  final Widget child;
  final EdgeInsetsGeometry margin;
  final EdgeInsetsGeometry padding;

  /// 旧参数: 泥板只有一种底色, 不再用
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: margin,
      child: ClaySlab(padding: padding, child: SizedBox(width: double.infinity, child: child)),
    );
  }
}

/// 一组行装进一块泥板; 上面可以有一行灰色小标题
class SettingsGroup extends StatelessWidget {
  const SettingsGroup({
    super.key,
    required this.children,
    this.title,
    this.margin = const EdgeInsets.fromLTRB(16, NeoxSpace.sm, 16, NeoxSpace.sm),
    this.dividerIndent,
  });

  final String? title;
  final List<Widget> children;
  final EdgeInsetsGeometry margin;

  /// 行间分隔线的左缩进 (对齐文字左边缘)。不传就看组里第一个 [SettingsRow]
  final double? dividerIndent;

  double _autoIndent() {
    for (final c in children) {
      if (c is SettingsRow) return c.textInset;
    }
    return 64;
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) {
        rows.add(Padding(
          padding: EdgeInsets.only(left: dividerIndent ?? _autoIndent(), right: 16),
          child: Container(height: 0.6, color: c.hairline),
        ));
      }
      rows.add(children[i]);
    }
    return Padding(
      padding: margin,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 0, 8),
              child: Text(title!, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.grey, height: 1.3)),
            ),
          ClaySlab(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(mainAxisSize: MainAxisSize.min, children: rows),
          ),
        ],
      ),
    );
  }
}

/// 旧的陶土小图标名 (assets/clay/i-*.webp) → 陶土方块里的线条图标
final Map<String, IconData> _clayNameIcons = {
  'i-phone': Icons.smartphone_rounded,
  'i-laptop': Icons.laptop_mac_outlined,
  'i-devices': Icons.devices_outlined,
  'i-mail': Icons.mail_outline_rounded,
  'i-chip': Icons.memory_outlined,
  'i-app': Icons.apps_rounded,
  'i-wifi': Icons.wifi_tethering_rounded,
  'i-pulse': Icons.monitor_heart_outlined,
  'i-palette': Icons.palette_outlined,
  'i-mic': Icons.graphic_eq_rounded,
  'i-lock': Icons.lock_outline_rounded,
  'i-info': Icons.info_outline_rounded,
  'i-gem': Icons.diamond_outlined,
  'i-doc': Icons.description_outlined,
  'i-chat': Icons.chat_bubble_outline_rounded,
  'i-key': Icons.vpn_key_outlined,
  'i-cloud': Icons.cloud_outlined,
  'i-shield': Icons.shield_outlined,
  'i-calendar': Icons.calendar_month_outlined,
  'i-refresh': Icons.sync_rounded,
  'i-update': Icons.sync_rounded,
  'i-sun': Icons.light_mode_outlined,
  'i-moon': Icons.dark_mode_outlined,
  'i-person': Icons.person_outline_rounded,
  'i-logout': Icons.logout_rounded,
  'i-trash': Icons.delete_outline_rounded,
  'i-gift': Icons.redeem_outlined,
  'i-receipt': Icons.receipt_long_outlined,
  'i-list': Icons.list_alt_outlined,
  'i-search': Icons.search_rounded,
  'i-route': Icons.route_outlined,
  'i-swap': Icons.swap_horiz_rounded,
  'i-sliders': Icons.tune_rounded,
  'i-wave': Icons.graphic_eq_rounded,
  'i-auto': Icons.brightness_auto_outlined,
  'i-qr': Icons.qr_code_scanner_rounded,
  'i-badge': Icons.badge_outlined,
  'i-team': Icons.workspaces_outline,
};

/// 历史遗留的线条图标 → 陶土方块里画的图标 (有几处用的是 filled / 不顺眼的变体, 统一成圆角线条)
final Map<IconData, IconData> kSettingsClayIcons = {
  Icons.mic_none_outlined: Icons.graphic_eq_rounded,
  Icons.fingerprint: Icons.lock_outline_rounded,
  Icons.info_outline: Icons.info_outline_rounded,
  Icons.feedback_outlined: Icons.chat_bubble_outline_rounded,
  Icons.download_outlined: Icons.sync_rounded,
  Icons.refresh: Icons.sync_rounded,
  Icons.desktop_mac: Icons.laptop_mac_outlined,
  Icons.phone_iphone: Icons.smartphone_rounded,
  Icons.phone_android_outlined: Icons.smartphone_rounded,
};

class SettingsRow extends StatelessWidget {
  const SettingsRow({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.tag,
    this.tagColor,
    this.onTap,
    this.onLongPress,
    this.showChevron = false,
    this.danger = false,
    this.enabled = true,
    this.minHeight,
    this.clay,
  });

  final String title;
  final String? subtitle;
  final IconData? leading;

  /// 旧的陶土小图标名 (`i-phone` …); 现在画成同一种陶土方块
  final String? clay;

  /// 有图标的组, 分隔线缩进到文字左边缘: 14 + 36 + 14
  static const double clayDividerIndent = 64;

  /// 这一行的文字从哪儿起 —— 分组拿它对齐分隔线
  double get textInset => (clay != null || leading != null) ? clayDividerIndent : 16;

  final Widget? trailing;
  final String? tag;
  final Color? tagColor;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool showChevron;
  final bool danger;
  final bool enabled;

  /// 覆盖行高; 默认单行 52 / 带灰字 60
  final double? minHeight;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final canTap = enabled && onTap != null;
    final canLongPress = enabled && onLongPress != null;
    final hasSub = subtitle != null && subtitle!.isNotEmpty;
    final icon = clay != null ? (_clayNameIcons[clay] ?? Icons.circle_outlined) : (kSettingsClayIcons[leading] ?? leading);
    final fg = danger ? c.redInk : c.ink;

    final trailingChildren = <Widget>[
      if (trailing != null) trailing!,
      if (tag != null) SettingsTag(label: tag!, color: tagColor ?? c.grey),
      if (showChevron) Icon(Icons.chevron_right_rounded, size: 20, color: c.faint),
    ];

    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: InkWell(
        onTap: canTap ? onTap : null,
        onLongPress: canLongPress ? onLongPress : null,
        borderRadius: BorderRadius.circular(16),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: minHeight ?? (hasSub ? 60 : 52)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Row(
              children: [
                if (icon != null) ...[
                  ClayTile(icon: icon, size: 36, iconColor: danger ? c.redInk : null),
                  const SizedBox(width: 14),
                ],
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: fg, height: 1.3),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (hasSub)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            subtitle!,
                            style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.3),
                            /* 一行 (2026-09-17 用户: 「文字废话多、换行, 组件越来越大」) */
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
                if (trailingChildren.isNotEmpty) ...[
                  const SizedBox(width: 10),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (var i = 0; i < trailingChildren.length; i++) ...[
                        if (i > 0) const SizedBox(width: 6),
                        trailingChildren[i],
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 设置行里的开关 —— **必须用这个, 不要直接写 Switch** (陶土开关: 开 = 墨色轨道)
class SettingsSwitch extends StatelessWidget {
  const SettingsSwitch({super.key, required this.value, this.onChanged});

  final bool value;
  final ValueChanged<bool>? onChanged;

  /// 开关允许占的高度
  static const double height = 34;

  @override
  Widget build(BuildContext context) => SizedBox(height: height, child: Center(child: ClaySwitch(value: value, onChanged: onChanged)));
}

/// 行尾小签: 「3.10.25 可更新」淡蓝签 / 状态签. 颜色是语义色时用对应的陶土签
class SettingsTag extends StatelessWidget {
  const SettingsTag({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 140),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(999)),
      child: Text(
        label,
        style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600, height: 1.1),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// 圆头像: 名字首字母
class SettingsAvatar extends StatelessWidget {
  const SettingsAvatar({
    super.key,
    required this.label,
    this.size = 48,
    this.color,
  });

  final String label;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: c.fill,
        boxShadow: clayShadow(c, lift: 0.8),
      ),
      alignment: Alignment.center,
      child: Text(
        settingsInitialLetter(label),
        style: TextStyle(fontSize: size * 0.42, color: color ?? c.ink, fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// 一块空状态泥板: 陶土方块 + 一句粗话 + 一句灰话 (+ 一个动作)
class SettingsEmptyBlock extends StatelessWidget {
  const SettingsEmptyBlock({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.action,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return SettingsSurface(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 10),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      child: Row(
        children: [
          ClayTile(icon: kSettingsClayIcons[icon] ?? icon, size: 40),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink)),
                const SizedBox(height: 3),
                Text(subtitle, style: TextStyle(fontSize: 12.5, color: c.grey), maxLines: 1, overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
          if (action != null) ...[const SizedBox(width: 10), action!],
        ],
      ),
    );
  }
}

/* 会员/账单相关的格式化 (refreshSettingsAccount / settingsPlanColor /
 * settingsSubscriptionLabel / settingsPeriodLine / settingsBillingLine) 在
 * commercial/settings/membership_format.dart —— 它们的入参就是会员与账单模型,
 * 放在这里会让所有设置页都依赖账号体系。 */

String settingsInitialLetter(String value) {
  final s = value.trim();
  return s.isEmpty ? 'N' : s.substring(0, 1).toUpperCase();
}

String settingsTitleCase(String value) {
  final s = value.trim();
  if (s.isEmpty) return 'Free';
  return s.substring(0, 1).toUpperCase() + s.substring(1);
}

String settingsFormatInt(int value) {
  final neg = value < 0;
  final raw = value.abs().toString();
  final buf = StringBuffer();
  for (var i = 0; i < raw.length; i++) {
    if (i > 0 && (raw.length - i) % 3 == 0) buf.write(',');
    buf.write(raw[i]);
  }
  return neg ? '-$buf' : buf.toString();
}

String settingsFormatDate(DateTime value) {
  final local = value.toLocal();
  return '${local.year}.${_two(local.month)}.${_two(local.day)}';
}

String settingsRelativeTime(DateTime? value) {
  if (value == null) return tr('未同步');
  final diff = DateTime.now().difference(value.toLocal());
  if (diff.inMinutes < 1) return tr('刚刚');
  if (diff.inHours < 1) return tr('${diff.inMinutes} 分钟前');
  if (diff.inDays < 1) return tr('${diff.inHours} 小时前');
  if (diff.inDays < 30) return tr('${diff.inDays} 天前');
  return settingsFormatDate(value);
}

String? settingsConnectionModeLabel(WsClientState state) {
  if (state.connection == WsConnectionState.disconnected) return null;
  switch (state.transport) {
    case WsTransport.lan:
      return tr('同 Wi-Fi');
    case WsTransport.cloudRelay:
      return tr('远程');
    case WsTransport.cloudAgent:
      return tr('云端');
    case WsTransport.none:
      return null;
  }
}

String settingsConnectionTitle(WsClientState state) {
  final isCloudTask = state.transport == WsTransport.cloudAgent;
  switch (state.connection) {
    case WsConnectionState.connected:
      return isCloudTask ? tr('云端任务运行中') : tr('已连接');
    case WsConnectionState.connecting:
      return isCloudTask ? tr('正在启动云端') : tr('正在连接');
    case WsConnectionState.error:
      return tr('连接失败');
    case WsConnectionState.disconnected:
      return tr('未连接');
  }
}

/// 状态副标题 —— 空字符串表示"没有别的可说", 调用方不要渲染这一行.
///
/// 2026-09-17 用户: 「连接的提示语废话太多, 解释一堆」。标题只说通没通, 走哪条路交给角标
/// (settingsConnectionModeLabel), 副标题只在**还有别的信息**时出现 (没连上时该干什么)。
String settingsConnectionSubtitle(WsClientState state) {
  switch (state.connection) {
    case WsConnectionState.connected:
    case WsConnectionState.connecting:
      return '';
    case WsConnectionState.error:
      return tr('点电脑重试');
    case WsConnectionState.disconnected:
      return tr('打开电脑端 Neox');
  }
}

Color settingsConnectionColor(ThemeData theme, WsClientState state) {
  switch (state.connection) {
    case WsConnectionState.connected:
      return NeoxClaudePalette.success;
    case WsConnectionState.connecting:
      return NeoxClaudePalette.warning;
    case WsConnectionState.error:
      return theme.colorScheme.error;
    case WsConnectionState.disconnected:
      return theme.colorScheme.onSurfaceVariant;
  }
}

IconData settingsConnectionIcon(WsClientState state) {
  switch (state.connection) {
    case WsConnectionState.connected:
      return state.transport == WsTransport.cloudAgent ? Icons.cloud_outlined : Icons.laptop_mac_outlined;
    case WsConnectionState.connecting:
      return Icons.sync_rounded;
    case WsConnectionState.error:
      return Icons.error_outline_rounded;
    case WsConnectionState.disconnected:
      return Icons.laptop_mac_outlined;
  }
}

String _two(int n) => n < 10 ? '0$n' : '$n';
