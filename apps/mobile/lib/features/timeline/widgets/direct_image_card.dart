/// direct_image_card.dart — 直连生图结果卡 (对齐桌面 DirectImageTurns 气质).
///
/// pending: 骨架 + "正在生成"
/// ok: 大图圆角卡
/// error: 友好错误文案
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';
import 'package:flutter/services.dart';

import '../../../core/storage/app_paths.dart';
import '../../../core/image/image_size_pref.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../home/state/composer_pending_provider.dart';
import '../../image/state/image_studio_providers.dart' show ImageStudioSender;
import '../state/timeline_state.dart';
import 'image_generating_canvas.dart';
import 'package:neox_app/core/i18n/tr.dart';

class DirectImageCard extends StatelessWidget {
  const DirectImageCard({super.key, required this.entry});
  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final args = entry.args ?? const <String, dynamic>{};
    final status = (args['status'] as String?) ??
        (entry.pending ? 'pending' : (entry.toolSuccess ? 'ok' : 'error'));
    final chip = (args['chip'] as String?) ?? tr('创建图片');
    /* 出图尺寸 (chat:C4-07): 占位与成品用同一个比例, 出图那一下不跳版 */
    final size = ImageSize.fromWire(args['size'] as String?);
    final turnId = args['turn_id'] as String? ?? entry.turnId;
    final error = (args['error'] as String?) ?? entry.output;
    final paths = <String>[
      /* 存的是绝对路径, iOS 升级后容器 UUID 会变 —— 换到当前容器再找 */
      if (args['paths'] is List)
        ...(args['paths'] as List).whereType<String>().map(AppPaths.rebase),
      if (entry.output != null &&
          entry.output!.isNotEmpty &&
          !entry.output!.startsWith('{') &&
          File(AppPaths.rebase(entry.output!)).existsSync())
        AppPaths.rebase(entry.output!),
    ];

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.xl,
        NeoxSpace.sm,
        NeoxSpace.xl,
        NeoxSpace.sm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.image_outlined,
                size: 14,
                color: scheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(
                chip,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (status == 'pending') ...[
                const SizedBox(width: 8),
                SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: NeoxSpace.sm),
          if (status == 'pending')
            /* 跟成品同为 1:1 方块 —— 出图时原地换成图片, 不跳 (见 image_generating_canvas.dart) */
            ImageGeneratingCanvas(
              aspectRatio: size.aspectRatio,
              /* 取消 (chat:C4-05) —— 任务若已提交, 服务器上照跑, 卡上照实说 */
              onCancel: turnId == null || turnId.isEmpty
                  ? null
                  : () => ImageStudioSender.cancel(turnId),
              /* 事件时间优先 (回到页面也接着数); 秒级时间戳补成毫秒 */
              startedAtMs: entry.timestamp > 0
                  ? (entry.timestamp < 100000000000 ? entry.timestamp * 1000 : entry.timestamp)
                  : (entry.createdAtMs > 0 ? entry.createdAtMs : null),
            )
          else if (status == 'error')
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(NeoxSpace.lg),
              decoration: BoxDecoration(
                color: scheme.errorContainer.withValues(alpha: 0.35),
                borderRadius: NeoxRadius.cardR,
                border: Border.all(
                  color: scheme.error.withValues(alpha: 0.35),
                  width: NeoxStroke.hair,
                ),
              ),
              child: Text(
                _friendlyError(error),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.error,
                  height: 1.4,
                ),
              ),
            )
          else
            ...paths.map((path) => _ImageTile(path: path, aspectRatio: size.aspectRatio)),
        ],
      ),
    );
  }

  String _friendlyError(String? raw) {
    final r = (raw ?? '').toLowerCase();
    if (r.contains('登录') || r.contains('key') || r.contains('401')) {
      return raw ?? tr('密钥无效或需要登录');
    }
    if (r.contains('402') || r.contains('积分') || r.contains('余额')) {
      return raw ?? tr('额度或平台余额不足');
    }
    if (r.contains('不支持')) return raw!;
    if ((raw ?? '').trim().isEmpty) return tr('生图失败, 请稍后重试');
    return raw!.length > 180 ? '${raw.substring(0, 177)}…' : raw;
  }
}

class _ImageTile extends ConsumerWidget {
  const _ImageTile({required this.path, this.aspectRatio = 1});
  final String path;
  final double aspectRatio;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final file = File(path);
    if (!file.existsSync()) {
      return Text(
        tr('图片文件已丢失'),
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoxSpace.sm),
      child: GestureDetector(
        onTap: () => _openPreview(context, ref, file),
        onLongPress: () => _showActions(context, ref, file),
        child: ClipRRect(
          borderRadius: NeoxRadius.cardR,
          child: AspectRatio(
            aspectRatio: aspectRatio,
            child: Image.file(
              file,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Container(
                color: scheme.surfaceContainerHigh,
                alignment: Alignment.center,
                child: const Icon(Icons.broken_image_outlined),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 长按菜单 (2026-10-05 用户: 「按住图片可以弹出多个, 分享、编辑, 要做好逻辑」)。
  /// 以前长按直接弹系统分享, 想接着改这张图只能先存相册再从相册选回来。
  static Future<void> _showActions(BuildContext context, WidgetRef ref, File file) async {
    HapticFeedback.mediumImpact();
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: Text(tr('继续改这张')),
              onTap: () => Navigator.pop(ctx, 'edit'),
            ),
            ListTile(
              leading: const Icon(Icons.download_outlined),
              title: Text(tr('保存到相册')),
              onTap: () => Navigator.pop(ctx, 'save'),
            ),
            ListTile(
              leading: const Icon(Icons.ios_share),
              title: Text(tr('分享')),
              onTap: () => Navigator.pop(ctx, 'share'),
            ),
          ],
        ),
      ),
    );
    if (!context.mounted || action == null) return;
    switch (action) {
      case 'edit':
        ref.read(composerPendingImageProvider.notifier).state = file.path;
      case 'save':
        await _saveToGallery(context, file);
      case 'share':
        await _shareImage(context, file);
    }
  }

  static Future<void> _saveToGallery(BuildContext context, File file) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      /* iOS 存进具名相簿要「完整读取相册」权限 —— 只为存一张图就要看用户全部照片, 审核按 5.1.1 会挑。
       * iOS 只存进相机胶卷, 走「仅添加」权限; 安卓照旧建 Neox 相簿。 */
      final toAlbum = !Platform.isIOS;
      if (!await Gal.hasAccess(toAlbum: toAlbum) && !await Gal.requestAccess(toAlbum: toAlbum)) {
        messenger.showSnackBar(SnackBar(content: Text(tr('需要相册权限 — 到系统设置里打开'))));
        return;
      }
      await Gal.putImage(file.path, album: toAlbum ? 'Neox' : null);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(tr('已保存到相册'))));
    } catch (e) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(tr('保存失败: $e'))));
    }
  }

  static Future<void> _shareImage(BuildContext context, File file) async {
    final box = context.findRenderObject() as RenderBox?;
    try {
      await Share.shareXFiles(
        [XFile(file.path, name: file.uri.pathSegments.last)],
        sharePositionOrigin:
            box == null ? null : box.localToGlobal(Offset.zero) & box.size,
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(tr('分享失败: $e'))));
    }
  }

  void _openPreview(BuildContext context, WidgetRef ref, File file) {
    HapticFeedback.selectionClick();
    showDialog<void>(
      context: context,
      builder: (ctx) {
        return Dialog(
          backgroundColor: Colors.black,
          insetPadding: const EdgeInsets.all(12),
          child: Stack(
            children: [
              InteractiveViewer(
                child: Center(child: Image.file(file)),
              ),
              Positioned(
                top: 8,
                right: 8,
                child: IconButton(
                  icon: const Icon(Icons.close, color: Colors.white),
                  onPressed: () => Navigator.pop(ctx),
                ),
              ),
              /* 保存/分享 —— 之前生成的图只能看不能拿走, 存不进相册也发不出去,
               * 而"画完把图发给人"本来就是画图的目的。系统面板同时提供
               * 「存储到图片」「发微信」「AirDrop」, 比自己做一个下载目录实在。 */
              Positioned(
                bottom: 16,
                left: 0,
                right: 0,
                child: Center(
                  child: FilledButton.tonalIcon(
                    onPressed: () {
                      Navigator.pop(ctx);
                      _showActions(context, ref, file);
                    },
                    icon: const Icon(Icons.more_horiz, size: 18),
                    label: Text(tr('保存 / 分享 / 继续改')),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
