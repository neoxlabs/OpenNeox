/// pilot_avatar.dart — Pilot 头像: 猫 / 柯基静态图 (跟桌面端 PilotFace 同一批素材).
library;

import 'package:flutter/material.dart';

import '../../shared/widgets/asset_px.dart';
import 'pilot_link.dart';

/// 头像图 (按显示尺寸解码) —— 抽屉预热要用同一个键
ImageProvider pilotAvatarImage(PilotLook look, double size) =>
    assetAtHeight(look == PilotLook.corgi ? 'assets/pilot/corgi-idle.webp' : 'assets/pilot/cat-idle.webp', size);

class PilotAvatar extends StatelessWidget {
  const PilotAvatar({super.key, required this.look, this.size = 48, this.ring});

  final PilotLook look;
  final double size;

  /// 通话中 / 来电时外圈亮一圈
  final Color? ring;

  @override
  Widget build(BuildContext context) {
    final img = ClipOval(
      child: Container(
        width: size,
        height: size,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        /* 原图 480×397, 头像多半 26~60 —— 按显示尺寸解码 (见 asset_px.dart); 横图, 按高定, cover 不糊 */
        child: Image(image: pilotAvatarImage(look, size), fit: BoxFit.cover),
      ),
    );
    if (ring == null) return img;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: ring!, width: 2)),
      child: img,
    );
  }
}
