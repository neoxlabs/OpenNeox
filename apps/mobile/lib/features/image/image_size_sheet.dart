/// image_size_sheet.dart — 方 / 横 / 竖的选择面板 (chat:C4-07).
///
/// 两处入口共用这一份: 图片工作台输入框上的尺寸签名 (点开选), 以及 Chat 的
/// [+] 菜单里那一行。以前尺寸只有工具参数能填, 用户在手机上根本选不到 ——
/// 「海报做成方的、手机壁纸做成横的」就出在这里。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/clay/clay.dart';
import '../../core/image/image_size_pref.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 弹面板选尺寸; 选完写进 [imageSizePrefProvider] (含「自动」)。
Future<void> openImageSizeSheet(BuildContext context, WidgetRef ref) async {
  final current = ref.read(imageSizePrefProvider);
  /* 返回包装一下: 面板被划掉 (null) 跟选了「自动」(size = null) 必须分开 ——
   * 否则随手一划就把用户选的竖图悄悄改回自动。 */
  final picked = await showClaySheet<({ImageSize? size})>(
    context,
    builder: (ctx) => Consumer(
      builder: (ctx, sheetRef, _) {
        final c = ClayInk.of(ctx);
        final now = sheetRef.watch(imageSizePrefProvider);
        Widget row(IconData icon, String title, String hint, ImageSize? value) {
          final on = now == value;
          return ClayRow(
            icon: icon,
            title: title,
            subtitle: hint,
            minHeight: 56,
            trailing: on ? Icon(Icons.check_rounded, size: 20, color: c.ink) : null,
            onTap: () => Navigator.pop(ctx, (size: value)),
          );
        }

        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: Row(
                  children: [
                    Text(
                      tr('出图尺寸'),
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.ink),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Column(
                  children: [
                    row(Icons.crop_square_rounded, tr('自动'), tr('按内容判断: 海报竖、封面横'), null),
                    row(Icons.square_rounded, ImageSize.square.label, ImageSize.square.hint, ImageSize.square),
                    row(Icons.crop_landscape_rounded, ImageSize.landscape.label, ImageSize.landscape.hint, ImageSize.landscape),
                    row(Icons.crop_portrait_rounded, ImageSize.portrait.label, ImageSize.portrait.hint, ImageSize.portrait),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
          ),
        );
      },
    ),
  );
  /* 只记下真正点过的; 划掉面板不改变现有偏好。 */
  if (picked == null || picked.size == current) return;
  ref.read(imageSizePrefProvider.notifier).set(picked.size);
}
