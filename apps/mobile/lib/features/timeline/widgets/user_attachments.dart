/// 用户气泡里的附件: 图片缩略图 (点开全屏) + 文件 chip (按类型给图标)。
///
/// 数据来自本机留底 (LocalAttachmentStore) —— 电脑回显里没有图, 手机本地会话此前也没落库,
/// 所以时间线上一直只有文字。
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

class UserAttachments extends StatelessWidget {
  const UserAttachments({super.key, required this.items, this.alignStart = false});
  final List<LocalAttachmentRef> items;

  /// 靠左排 (它看过的工具截图那张卡用; 用户气泡里是靠右)
  final bool alignStart;

  @override
  Widget build(BuildContext context) {
    final images = items.where((a) => a.isImage).toList(growable: false);
    final files = items.where((a) => !a.isImage).toList(growable: false);
    return Column(
      crossAxisAlignment: alignStart ? CrossAxisAlignment.start : CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (images.isNotEmpty) _ImageGrid(images: images, alignStart: alignStart),
        for (final f in files)
          Padding(
            padding: const EdgeInsets.only(top: NeoxSpace.xs),
            child: _FileChip(item: f),
          ),
      ],
    );
  }
}

class _ImageGrid extends StatelessWidget {
  const _ImageGrid({required this.images, this.alignStart = false});
  final List<LocalAttachmentRef> images;
  final bool alignStart;

  @override
  Widget build(BuildContext context) {
    /* 1 张: 大图 (最宽 240); 2 张: 并排; ≥3: 三列小格 —— 跟主流 IM 一个习惯 */
    final n = images.length;
    final double cell = n == 1 ? 240 : n == 2 ? 118 : 78;
    return Wrap(
      spacing: NeoxSpace.xs,
      runSpacing: NeoxSpace.xs,
      alignment: alignStart ? WrapAlignment.start : WrapAlignment.end,
      children: [
        for (final img in images)
          _Thumb(item: img, size: cell, square: n > 1),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.item, required this.size, required this.square});
  final LocalAttachmentRef item;
  final double size;
  final bool square;

  @override
  Widget build(BuildContext context) {
    final file = File(item.path);
    final radius = BorderRadius.circular(NeoxRadius.card);
    return GestureDetector(
      onTap: () => _openPreview(context, file),
      child: ClipRRect(
        borderRadius: radius,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: size,
            maxHeight: square ? size : size,
            minWidth: square ? size : 0,
            minHeight: square ? size : 0,
          ),
          child: Image.file(
            file,
            fit: square ? BoxFit.cover : BoxFit.contain,
            /* 解码按显示尺寸缩, 一屏几十张原图不吃内存 */
            cacheWidth: (size * MediaQuery.of(context).devicePixelRatio).round(),
            errorBuilder: (_, __, ___) => _Broken(size: size),
          ),
        ),
      ),
    );
  }

  void _openPreview(BuildContext context, File file) {
    HapticFeedback.selectionClick();
    showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(child: Center(child: Image.file(file))),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.pop(ctx),
              ),
            ),
            Positioned(
              bottom: 16,
              left: 0,
              right: 0,
              child: Center(
                child: FilledButton.tonalIcon(
                  onPressed: () => Share.shareXFiles([XFile(file.path)]),
                  icon: const Icon(Icons.ios_share, size: 18),
                  label: Text(tr('保存或分享')),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Broken extends StatelessWidget {
  const _Broken({required this.size});
  final double size;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: size,
      height: size * 0.66,
      color: scheme.surfaceContainerHighest,
      alignment: Alignment.center,
      child: Icon(Icons.broken_image_outlined, color: scheme.onSurfaceVariant),
    );
  }
}

class _FileChip extends StatelessWidget {
  const _FileChip({required this.item});
  final LocalAttachmentRef item;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final theme = Theme.of(context);
    final (icon, tint) = _iconFor(item.name);
    return GestureDetector(
      onTap: () => Share.shareXFiles([XFile(item.path, name: item.name)]),
      child: Container(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.sm, NeoxSpace.xs + 2, NeoxSpace.md, NeoxSpace.xs + 2),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(NeoxRadius.card),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                color: tint.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, size: 18, color: tint),
            ),
            const SizedBox(width: NeoxSpace.sm),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    item.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium,
                  ),
                  Text(
                    _sizeLabel(item.size),
                    style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static (IconData, Color) _iconFor(String name) {
    final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
    switch (ext) {
      case 'xlsx':
      case 'xls':
      case 'xlsm':
      case 'csv':
      case 'tsv':
        return (Icons.table_chart_outlined, const Color(0xFF1E8E3E));
      case 'docx':
      case 'doc':
        return (Icons.description_outlined, const Color(0xFF1A73E8));
      case 'pptx':
      case 'ppt':
        return (Icons.slideshow_outlined, const Color(0xFFE8710A));
      case 'pdf':
        return (Icons.picture_as_pdf_outlined, const Color(0xFFD93025));
      case 'zip':
      case 'rar':
      case '7z':
        return (Icons.folder_zip_outlined, const Color(0xFF7B61FF));
      case 'md':
      case 'txt':
      case 'log':
        return (Icons.notes_outlined, const Color(0xFF5F6368));
      case 'json':
      case 'yaml':
      case 'yml':
      case 'js':
      case 'ts':
      case 'py':
      case 'dart':
      case 'java':
      case 'kt':
      case 'go':
      case 'rs':
      case 'sh':
      case 'sql':
        return (Icons.code, const Color(0xFF0B8043));
      default:
        return (Icons.insert_drive_file_outlined, const Color(0xFF5F6368));
    }
  }

  static String _sizeLabel(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(bytes < 10240 ? 1 : 0)} KB';
    return '${(bytes / 1048576).toStringAsFixed(1)} MB';
  }
}
