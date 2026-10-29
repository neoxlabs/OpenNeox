/// composer_pending_provider.dart — 通用"填入 composer"通道.
///
/// 用途: 首页 dashboard 的场景卡点击 → 提示文本要塞到 StageInput 的
/// TextEditingController. 两个 widget 各自独立, 用 provider 中转:
///   1. dashboard: ref.read(composerPendingTextProvider.notifier).state = prompt;
///   2. StageInput: 在 build 里 ref.listen; 检测到非 null 就设置 _ctrl.text + 清空 provider.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

final composerPendingTextProvider = StateProvider<String?>((ref) => null);

/// 同一个通道, 塞的是图片文件路径: 长按生成的图 →「继续改这张」, 输入框把它挂成参考图。
final composerPendingImageProvider = StateProvider<String?>((ref) => null);
