/// 其它主要页面的截图 —— 全面检查用.
///   flutter test --update-goldens test/harness/pages_shot_test.dart
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';
import 'package:neox_app/core/startup/changelog.dart';
import 'package:neox_app/features/settings/update_page.dart';
import 'package:neox_app/shared/theme/app_theme.dart';

import 'render_shot.dart';

void main() {
  late SharedPreferences prefs;

  setUpAll(() async {
    stubNativePlugins();
    await loadAppFonts();
    /* main.dart 里是 override 进去的 —— 渲染台必须做同一件事,
     * 否则设置页第一个读偏好的组件就抛 UnimplementedError, 整页渲不出来。 */
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  /* 设置页 / 连接页仍进不来 —— 真因是 **drift**, 不是业务定时器。
   * 详细原因和试过的办法写在 render_shot.dart 末尾 (我先怀疑 membershipProvider 的
   * 60s 轮询, 覆盖掉之后照样红, 读 stack 才发现是 drift 的缓存清理 timer)。
   * 能渲的: 引导页、会员页 (Free/Pro/深色三态)、timeline、更新页。 */
  final pages = <String, dynamic>{
    'update': const UpdatePage(),
  };

  for (final e in pages.entries) {
    for (final dark in [false, true]) {
      testWidgets('${e.key} · ${dark ? "深色" : "浅色"}', (t) async {
        await shoot(t,
          name: '${e.key}-${dark ? "dark" : "light"}',
          child: e.value,
          theme: dark ? AppTheme.dark : AppTheme.light,
          size: ShotSize.phoneNarrow,
          /* 设置页有常驻轮询/动画, pumpAndSettle 会一直等不到静止然后超时。
           * 这几页要的是"现在长什么样", 不需要等动画收尾。 */
          settleAnimations: false,
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
            /* 更新日志走网络 —— 渲染台里喂真实形状的假数据 (双语字段带
             * <!--zh--> 标记, 跟服务端一模一样), 否则只能截到"读不到"那一态 */
            changelogProvider.overrideWith((ref) async => [
              ChangelogEntry.fromJson(const {
                'id': 'cl-v3-4-0-android',
                'version': '3.4.0',
                'title': 'Neox 3.4.0 — History loads<!--zh-->Neox 3.4.0 — 历史能加载、能选项目、跟上高刷',
                'bodyMd': 'en<!--zh-->3.3.9 → 3.4.0。\n\n修复:\n1. 打开旧会话显示「还没有消息」, 看不到历史。\n2. 应用锁那一行比旁边的行高。\n\n改动:\n1. 开新会话能选电脑上的项目。\n2. Android 跟上屏幕的最高刷新率 (90/120Hz)。',
                'publishedAt': '2026-09-18T06:20:00.000Z',
              }, zh: true)!,
              ChangelogEntry.fromJson(const {
                'id': 'cl-v3-3-9',
                'version': '3.3.9',
                'title': 'x<!--zh-->Neox 3.3.9 — 手机端排版与更新修复',
                'bodyMd': 'x<!--zh-->3.3.8 → 3.3.9。\n\n修复:\n1. 更新下载报「An async operation is currently pending」。',
                'publishedAt': '2026-09-18T02:00:00.000Z',
              }, zh: true)!,
            ]),
          ]);
      });
    }
  }
}
