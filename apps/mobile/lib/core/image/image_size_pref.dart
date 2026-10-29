/// image_size_pref.dart — 出图的方 / 横 / 竖 (chat:C4-07).
///
/// 以前尺寸只存在于工具参数里 (`generate_image` 的 `size` enum), 用户在 Chat 里
/// 根本选不了, 只能赌模型自己判断 —— 于是「海报做成方的、手机壁纸做成横的」。
/// 现在输入框的 [+] 菜单里能选, 记在本地:
///   · 选过 → 这一档就是强约束: 模型自己填的 size 会被它替换 (用户明确要的优先);
///   · 没选 (自动) → 照旧由模型按场景判断, 工具默认方图。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

const _kPref = 'neox_image_size';

enum ImageSize {
  square('1024x1024'),
  landscape('1536x1024'),
  portrait('1024x1536');

  const ImageSize(this.wire);

  /// 发给网关 / 厂商的尺寸串.
  final String wire;

  String get label => switch (this) {
    ImageSize.square => tr('方图'),
    ImageSize.landscape => tr('横图'),
    ImageSize.portrait => tr('竖图'),
  };

  /// 一句话说明用在哪 (选择面板里的小字).
  String get hint => switch (this) {
    ImageSize.square => tr('头像、图标、方版海报'),
    ImageSize.landscape => tr('封面、横版配图、桌面壁纸'),
    ImageSize.portrait => tr('手机壁纸、竖版海报、故事图'),
  };

  /// 占位骨架跟成品同一个比例 (出图那一下不跳版).
  double get aspectRatio => switch (this) {
    ImageSize.square => 1,
    ImageSize.landscape => 1536 / 1024,
    ImageSize.portrait => 1024 / 1536,
  };

  static ImageSize fromWire(String? wire) => ImageSize.values.firstWhere(
    (s) => s.wire == wire,
    orElse: () => ImageSize.square,
  );
}

/// null = 自动 (模型按场景判断).
class ImageSizePrefController extends StateNotifier<ImageSize?> {
  ImageSizePrefController(this._prefs)
    : super(_read(_prefs.getString(_kPref)));

  final SharedPreferences _prefs;

  static ImageSize? _read(String? wire) =>
      ImageSize.values.where((s) => s.wire == wire).firstOrNull;

  void set(ImageSize? size) {
    state = size;
    if (size == null) {
      _prefs.remove(_kPref);
    } else {
      _prefs.setString(_kPref, size.wire);
    }
  }
}

final imageSizePrefProvider =
    StateNotifierProvider<ImageSizePrefController, ImageSize?>(
      (ref) => ImageSizePrefController(ref.watch(sharedPreferencesProvider)),
    );
