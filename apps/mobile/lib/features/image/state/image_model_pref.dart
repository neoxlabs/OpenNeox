/// image_model_pref.dart — 用户在图片工作台选的出图模型.
///
/// **为什么需要存** (2026-09-18 用户: 「图片工作台没有显示模型列表 显示的还是文字的」)
///
/// 图片页的 ⋯ 里有一行「图像模型」, 但它打开的是**聊天**模型列表 (openModelSheet
/// 没有图片这个概念), 于是:
///   · 列出来的全是文字模型 —— 用户看到的就是"显示的还是文字的";
///   · 选中之后写的是 selectedModelProvider, 那是聊天模型; 出图这条路
///     (image_studio_providers) 压根不读它, 而是每次自己 pickImageModel() 自动挑。
/// 也就是说那一行点了等于没点, 而界面上它看起来是能选的。
///
/// 所以这里补上"用户选的出图模型"这个位置 —— 没选过时仍然自动挑
/// (pickImageModel 的 preferred 参数一直留着这个缝, 只是从来没人往里传)。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

const _kPref = 'neox_image_model';

class ImageModelPrefController extends StateNotifier<String?> {
  ImageModelPrefController(this._prefs) : super(_norm(_prefs.getString(_kPref)));

  final SharedPreferences _prefs;

  static String? _norm(String? v) =>
      (v != null && v.trim().isNotEmpty) ? v.trim() : null;

  /// null = 清掉偏好, 回到自动挑 (换代时自动跟上新模型).
  void set(String? modelId) {
    final v = _norm(modelId);
    state = v;
    if (v == null) {
      _prefs.remove(_kPref);
    } else {
      _prefs.setString(_kPref, v);
    }
  }
}

final imageModelPrefProvider =
    StateNotifierProvider<ImageModelPrefController, String?>(
      (ref) => ImageModelPrefController(ref.watch(sharedPreferencesProvider)),
    );
