/// current_project_provider.dart — 「我现在在哪个项目里干活」.
///
/// **为什么需要** (2026-09-18 用户原话)
/// 「就是选择项目后 就应该是这个项目 新建会话等 现在我进入项目还是没 UI 显示
///  当前在什么项目下..完全懵逼」
///
/// 选项目这个动作原来是**一次性**的: 挑完 → 在那个工作区里起一条会话 → 结束。
/// 之后界面上没有任何地方说"你在 neox-webbench 里", 再按「+」开新会话又回到
/// 没有项目的状态。于是"选项目"像是一次跳转, 不像一个上下文。
///
/// 这里把它变成**有状态的上下文**:
///   · 选过之后首页那颗药丸显示项目名 (不再是"选电脑上的项目");
///   · 之后在首页开的新会话默认落在这个项目里;
///   · 会话里顶栏显示这条会话自己的项目名 (那是会话建好时定死的, 不跟这里联动)。
///
/// 存在偏好里而不是内存: 冷启动回来还在同一个项目里, 才叫"上下文"。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../shared/theme/theme_mode_provider.dart'
    show sharedPreferencesProvider;

class CurrentProject {
  const CurrentProject({
    required this.path,
    required this.name,
    this.desktopDeviceId,
  });

  final String path;
  final String name;

  /// 项目在哪台电脑上 (2026-09-22)。路径只在那台电脑上有意义 —— 换了电脑还拿着
  /// 这个路径去建会话, 要么建不出来, 要么落到另一台的同名目录。连上的不是这台时
  /// 项目会被清掉 (见 connection_guard.dart)。老数据没有这个字段 = 不知道, 不清。
  final String? desktopDeviceId;

  /// 显示用: 名字为空就退到路径最后一段 (总比空白好).
  String get label {
    final n = name.trim();
    if (n.isNotEmpty) return n;
    final seg = path.split('/').where((s) => s.isNotEmpty);
    return seg.isEmpty ? path : seg.last;
  }
}

const _kPath = 'neox_current_project_path';
const _kName = 'neox_current_project_name';
const _kDesktop = 'neox_current_project_desktop';

class CurrentProjectController extends StateNotifier<CurrentProject?> {
  CurrentProjectController(this._prefs) : super(_load(_prefs));

  final SharedPreferences _prefs;

  static CurrentProject? _load(SharedPreferences p) {
    final path = p.getString(_kPath)?.trim();
    if (path == null || path.isEmpty) return null;
    final desktop = p.getString(_kDesktop)?.trim();
    return CurrentProject(
      path: path,
      name: p.getString(_kName)?.trim() ?? '',
      desktopDeviceId: (desktop == null || desktop.isEmpty) ? null : desktop,
    );
  }

  void set(CurrentProject? project) {
    state = project;
    if (project == null) {
      _prefs.remove(_kPath);
      _prefs.remove(_kName);
      _prefs.remove(_kDesktop);
    } else {
      _prefs.setString(_kPath, project.path);
      _prefs.setString(_kName, project.name);
      final d = project.desktopDeviceId;
      if (d == null || d.isEmpty) {
        _prefs.remove(_kDesktop);
      } else {
        _prefs.setString(_kDesktop, d);
      }
    }
  }

  void clear() => set(null);
}

final currentProjectProvider =
    StateNotifierProvider<CurrentProjectController, CurrentProject?>(
      (ref) => CurrentProjectController(ref.watch(sharedPreferencesProvider)),
    );
