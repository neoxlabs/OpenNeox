/// approval_mode_pref.dart — 审批模式偏好, 跟 Desktop 对齐 3 档.
///
/// 跟 Desktop AgentBridge.approvalMode 同款:
///   - auto       (smart) — Desktop 默认, 部分工具自动放行, 危险工具仍要审批
///   - plan       (manual) — 所有工具都要审批, 跑 plan 模式时常用
///   - yolo       (dangerous) — 全自动放行, 高效但风险大
///
/// 持久化 SharedPreferences, app 重启保留.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import 'package:neox_app/core/i18n/tr.dart';

enum ApprovalMode { auto, plan, yolo }

extension ApprovalModeX on ApprovalMode {
  /// 单字符 icon (A / P / Y) — composer 旁的圆形 badge 用
  String get letter {
    switch (this) {
      case ApprovalMode.auto:
        return 'A';
      case ApprovalMode.plan:
        return 'P';
      case ApprovalMode.yolo:
        return 'Y';
    }
  }

  /// 菜单里那一行显示的档位名.
  ///
  /// 2026-09-22: 原来是 Auto / Plan / YOLO —— 整屏中文里夹三个英文词, 而且
  /// 「Auto」看不出批准行为到底是什么 (自动? 自动批准? 自动拒绝?)。
  /// 改成说行为的中文, 跟下面的 [subtitle] 一脉相承。
  /// [letter] 不动 (A/P/Y 是 composer 那枚圆形 badge 用的, 一字符才放得下)。
  String get label {
    switch (this) {
      case ApprovalMode.auto:
        return tr('自动');
      case ApprovalMode.plan:
        return tr('逐步确认');
      case ApprovalMode.yolo:
        return tr('全部放行');
    }
  }

  String get subtitle {
    switch (this) {
      case ApprovalMode.auto:
        return tr('危险操作才询问（推荐）');
      case ApprovalMode.plan:
        return tr('每一步都先询问');
      case ApprovalMode.yolo:
        return tr('全部自动，不询问');
    }
  }

  /// → Desktop AgentBridge.approvalMode wire 值
  String get wireValue {
    switch (this) {
      case ApprovalMode.auto:
        return 'auto';
      case ApprovalMode.plan:
        return 'manual';
      case ApprovalMode.yolo:
        return 'dangerous';
    }
  }
}

const _kPref = 'neox_approval_mode';

class ApprovalModeController extends StateNotifier<ApprovalMode> {
  ApprovalModeController(this._prefs)
    : super(_decode(_prefs.getString(_kPref)));
  final SharedPreferences _prefs;

  Future<void> set(ApprovalMode m) async {
    state = m;
    await _prefs.setString(_kPref, _encode(m));
  }

  static ApprovalMode _decode(String? raw) {
    switch (raw) {
      case 'yolo':
        return ApprovalMode.yolo;
      case 'plan':
        return ApprovalMode.plan;
      case 'auto':
      default:
        return ApprovalMode.auto;
    }
  }

  static String _encode(ApprovalMode m) {
    switch (m) {
      case ApprovalMode.yolo:
        return 'yolo';
      case ApprovalMode.plan:
        return 'plan';
      case ApprovalMode.auto:
        return 'auto';
    }
  }
}

final approvalModeProvider =
    StateNotifierProvider<ApprovalModeController, ApprovalMode>(
      (ref) => ApprovalModeController(ref.read(sharedPreferencesProvider)),
    );
