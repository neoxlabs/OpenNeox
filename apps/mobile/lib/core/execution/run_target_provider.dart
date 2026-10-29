/// run_target_provider.dart — 用户显式选择的「运行位置」偏好.
///
/// 问题 (2026-07-19 用户拍板): 之前 sessionRouter 隐式"桌面>云>手机"自动挑,
/// 用户不知道会话跑在哪、有没有工具能力 — phone-local 只是 chat (无工具),
/// 却跟完整 agent (桌面/云) 长得一样, 概念混乱.
///
/// 新模型: 运行位置 = 能力档位, 用户显式可见可切:
///   auto    — 智能选择 (电脑 > 云端 > 手机), 默认
///   desktop — 我的电脑 · 完整 Agent (工具/文件/终端)
///   cloud   — 云端 · 完整 Agent (托管沙箱)
///   phone   — 手机 · 快速聊天 (直连模型, 无工具)
///
/// 偏好只影响**新会话**的创建路由; 已有会话的运行位置在创建时固定
/// (sessionMirror.desktopDeviceId 是真相).
library;

import 'package:flutter/material.dart' show IconData, Icons;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;
import '../feature_flags.dart';
import '../network/ws_client_provider.dart';
import '../storage/database.dart';
import '../storage/paired_desktop_kind.dart';
import 'package:neox_app/core/i18n/tr.dart';

enum RunTargetPref { auto, desktop, cloud, phone }

extension RunTargetPrefX on RunTargetPref {
  String get label {
    switch (this) {
      case RunTargetPref.auto:
        return tr('自动');
      case RunTargetPref.desktop:
        return tr('我的电脑');
      case RunTargetPref.cloud:
        return tr('云端');
      case RunTargetPref.phone:
        return tr('本机');
    }
  }

  /// 能力档位说明 — 一行说清「在哪跑、能干什么、代价」, 不让用户猜.
  String get capability {
    switch (this) {
      case RunTargetPref.auto:
        /* 云端没放出来时别在说明里承诺它 —— 用户会去找那一档, 找不到就以为坏了 */
        return kCloudAgentEnabled ? tr('电脑在线用电脑，不在线就上云端') : tr('优先电脑，其次手机');
      case RunTargetPref.desktop:
        return tr('用电脑上的文件、终端和软件');
      case RunTargetPref.cloud:
        return tr('不用开电脑，手机锁屏也继续跑');
      case RunTargetPref.phone:
        /* 说"文件"指的是 agent 自己的沙箱工作区, 不是手机上的文件 ——
         * phone-local 明确拒收文件附件。而 Gemini BYOK 走纯聊天连这些也没有,
         * 那一档由输入框的运行位置面板按当前模型另行标注 (phoneLocalUsesToolLoop)。 */
        return tr('联网、写文件、操作手机，App 关了就停');
    }
  }

  /// 陶土图标 (assets/clay): 运行位置面板和 [+] 菜单用
  String get clay {
    switch (this) {
      case RunTargetPref.auto:
        return 'i-route';
      case RunTargetPref.desktop:
        return 'i-laptop';
      case RunTargetPref.cloud:
        return 'i-cloud';
      case RunTargetPref.phone:
        return 'i-phone';
    }
  }

  IconData get icon {
    switch (this) {
      case RunTargetPref.auto:
        /* 曾经是 auto_awesome (✨) —— 烂大街的 AI 装饰, 跟"自动选运行位置"这个
         * 语义也没关系 (用户: "样式太丑 AI 味道浓郁")。改成分叉箭头: 自动 = 在几条
         * 路里挑一条。 */
        return Icons.alt_route;
      case RunTargetPref.desktop:
        return Icons.computer_outlined;
      case RunTargetPref.cloud:
        return Icons.cloud_outlined;
      case RunTargetPref.phone:
        return Icons.smartphone_outlined;
    }
  }
}

/* v2 (2026-10-11): 9-24 ~ 10-10 面板里只有「我的电脑 / 云端」两档, 存着的 desktop 多半不是「锁死电脑」的意思
 * 而是当时唯一能点的那个 —— 换新键, 老值里只认 cloud, 其余回到「自动」(电脑在线用电脑, 不在线上云端)。 */
const _kPref = 'neox_run_target_pref_v2';
const _kPrefV1 = 'neox_run_target_pref';

String? _readPref(SharedPreferences p) =>
    p.getString(_kPref) ?? (p.getString(_kPrefV1) == 'cloud' ? 'cloud' : null);

class RunTargetPrefController extends StateNotifier<RunTargetPref> {
  RunTargetPrefController(this._prefs)
    : super(_decode(_readPref(_prefs)));
  final SharedPreferences _prefs;

  void set(RunTargetPref t) {
    state = t;
    _prefs.setString(_kPref, t.name);
  }

  static RunTargetPref _decode(String? raw) {
    switch (raw) {
      case 'desktop':
        return RunTargetPref.desktop;
      case 'cloud':
        /* 云端下架 (2026-09-18) 后, 老用户存着的 'cloud' 必须落回 auto.
         * 否则那一档在面板里已经不渲染了, 他却停在上面 —— 看不到自己选的是什么,
         * 也没有任何办法切走 (面板里没有可点的当前项)。判据见 core/feature_flags.dart。 */
        return kCloudAgentEnabled ? RunTargetPref.cloud : RunTargetPref.auto;
      case 'phone':
        return RunTargetPref.phone;
      case 'auto':
        return RunTargetPref.auto;
      default:
        /* 没选过 = 本机 (2026-10-11 用户: 手机本地就能干是最大优势, 工作给它一块工作区跟 PC 一样干活)。
         * 编码不受影响: stage_input._effectivePref 把编码的「本机」当「电脑」。 */
        return RunTargetPref.phone;
    }
  }
}

final runTargetPrefProvider =
    StateNotifierProvider<RunTargetPrefController, RunTargetPref>(
      (ref) => RunTargetPrefController(ref.watch(sharedPreferencesProvider)),
    );

/* ───────────────────────────────────────────────────────────────
 * 首选电脑 (2026-08-04)
 *
 * 用户实录: "我已配对的, 我都不能切换" —— 配了多台电脑, 设置里看得到, 但
 * 路由永远取 _rankDesktops(...).first, 用户没有任何发言权; 顶栏和运行位置
 * 又都只写"我的电脑"不写是哪台, 于是连到错的那台也看不出来 (真实后果:
 * 消息发去了一台没在干活的 Windows, 用户以为 app 坏了)。
 *
 * 这里存一个用户显式选择的 deviceId。routing 的口径:
 *   有首选 且 该机当前可连  → 用它 (用户说了算)
 *   有首选 但 连不上        → 落回排序第一 (别让人卡死), 由 UI 提示已临时改用哪台
 *   没首选                  → 维持原排序行为
 * ─────────────────────────────────────────────────────────────── */
const _kPreferredDesktop = 'neox_preferred_desktop_device_id';

class PreferredDesktopController extends StateNotifier<String?> {
  PreferredDesktopController(this._prefs)
    : super(_norm(_prefs.getString(_kPreferredDesktop)));
  final SharedPreferences _prefs;

  static String? _norm(String? v) =>
      (v != null && v.trim().isNotEmpty) ? v.trim() : null;

  /// null = 清除首选, 回到自动排序.
  void set(String? deviceId) {
    final v = _norm(deviceId);
    state = v;
    if (v == null) {
      _prefs.remove(_kPreferredDesktop);
    } else {
      _prefs.setString(_kPreferredDesktop, v);
    }
  }
}

final preferredDesktopProvider =
    StateNotifierProvider<PreferredDesktopController, String?>(
      (ref) => PreferredDesktopController(ref.watch(sharedPreferencesProvider)),
    );

/// deviceId → 人看得懂的机器名. UI 只拿到 activeDesktopDeviceId (一串 id),
/// 要显示"我的电脑 · MacBook"就得有这张表.
final pairedDesktopNamesProvider = StreamProvider<Map<String, String>>((ref) {
  final db = ref.watch(appDatabaseProvider);
  return db.pairedDesktopsDao.watchReachable().map(
    (list) => <String, String>{
      for (final d in list)
        if (isRealPairedDesktop(d))
          d.deviceId: (d.deviceName?.trim().isNotEmpty ?? false)
              ? d.deviceName!.trim()
              : d.deviceId,
    },
  );
});

/// 此刻真正连着的那台电脑的名字 (没连桌面 → null).
final activeDesktopNameProvider = Provider<String?>((ref) {
  final id = ref.watch(wsClientProvider).activeDesktopDeviceId;
  if (id == null || id.isEmpty) return null;
  return ref.watch(pairedDesktopNamesProvider).value?[id];
});
