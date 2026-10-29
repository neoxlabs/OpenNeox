/// render_shot.dart — 离线渲染台: 把真组件渲成 PNG, 不用真机.
///
/// 【为什么要有】
/// 2026-09-18 用户要求 "界面美观 一定要严格! 用户第一 1 像素都不能差"。
/// 而在此之前改 UI 全靠读代码想象效果 —— 结果就是一轮轮"还是不好看"。
/// 桌面端早有离线渲染台 (renderer/__harness__), 手机端一直没有。
///
/// 这里用 flutter_test 的真实渲染管线 + `--update-goldens` 落盘:
/// 拿到的是**真组件、真主题、真字体**的位图, 跟真机差别只在系统字体回退。
/// 所以"改之前先看一眼"和"改完对比"都成立, 不用等打包装机。
///
/// 【用法】
///   flutter test --update-goldens test/harness/<某个>_shot_test.dart
///   产物: test/harness/shots/<名字>.png
///
/// 不进 CI: 这些图是**给人看的**, 不是断言。做成 golden 断言会变成
/// "改一点像素就红" 的维护负担, 而我们要的是"能看见"。所以 shots/ 进 .gitignore。
library;

import 'dart:io' show File, Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// 常用机型尺寸 (逻辑像素) —— 窄屏是最容易出事的那一档.
class ShotSize {
  /// 用户那台 X200 PRO mini 一类的窄屏
  static const Size phoneNarrow = Size(360, 780);

  /// 主流 6.1-6.7 寸
  static const Size phone = Size(390, 844);

  /// 只截一块组件时用
  static const Size strip = Size(390, 420);
}

/// 渲染一个页面/组件并落盘成 PNG.
///
/// [name]  产物文件名 (不含扩展名)
/// [child] 被渲染的东西 —— 直接传真 widget, 不要传简化版仿制品
/// [dark]  深色主题
/// [theme] 主题构造器 (由调用方传, 避免这个文件依赖 app 的主题实现细节)
Future<void> shoot(
  WidgetTester tester, {
  required String name,
  required Widget child,
  required ThemeData theme,
  Size size = ShotSize.phone,
  bool settleAnimations = true,
  /// 落到哪个目录 (相对测试文件); 默认 shots/ (不进仓)
  String dir = 'shots',
  /// false = 只把页面画出来, 不落盘 (还要接着操作再截的时候用)
  bool capture = true,
  /// provider 覆盖 —— 页面依赖远端数据时用它造态 (免费/付费/耗尽…各造一张看)
  List<Override> overrides = const [],
}) async {
  tester.view.physicalSize = size * 3; // 3x 取图, 细节看得清
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme,
        home: child,
      ),
    ),
  );

  /* 图片必须在 runAsync 里等解码 —— 否则 Image.asset 在截图那一帧还没解出来,
   * 图的位置是**空的**。这一条不补的话, 拿到的图会让人以为"插画没生效",
   * 从而去改根本没问题的代码 (2026-09-18 第一版渲染台就踩了这个)。 */
  await tester.runAsync(() async {
    for (final e in tester.widgetList<Image>(find.byType(Image))) {
      await precacheImage(e.image, tester.element(find.byType(MaterialApp)));
    }
  });
  await tester.pump();

  /* 入场动画要跑完再截, 否则截到的是半透明的中间帧.
   * pumpAndSettle 在有常驻循环动画时会超时, 所以给个兜底: 超时就按固定时长推进。 */
  if (settleAnimations) {
    try {
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
    } on FlutterError {
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }
  }

  if (!capture) return;
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('$dir/$name.png'),
  );

}

/// 字体: flutter_test 默认用 Ahem (方块占位字), 截出来全是黑块.
///
/// 加载真字体才看得出排版。app 的字体在 assets/fonts/ 下, 用 FontLoader 注册进来。
///
/// [neoxRounded] 是否额外注册 NeoxRounded (正文 / UI 的真实族名) —— 默认关,
/// 因为注册它会改变所有截图测试的像素 (golden 断言会红)。只有需要看正文效果的
/// 那一份截图测试显式打开 (见 pilot_im_shot_test.dart)。
Future<void> loadAppFonts({bool neoxRounded = false}) async {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> load(String family, List<String> paths) async {
    final loader = FontLoader(family);
    for (final p in paths) {
      loader.addFont(
        Future.value(
          ByteData.sublistView(await File(p).readAsBytes()),
        ),
      );
    }
    await loader.load();
  }

  /* Inter 里**必须**跟一份中文字体 —— 真机上中文是靠系统回退 (PingFang / Noto Sans CJK)
   * 渲出来的, 而测试环境没有系统字体, 未命中的字形一律变成豆腐块 □。
   * 不补这一条, 截出来的图上所有 sans 中文都是方块, 排版根本看不出对错
   * (2026-09-18 第一版渲染台就是这样, 差点让我以为"跳过"两个字有 bug)。
   *
   * 用衬线体当 sans 的回退在观感上不精确 (真机是黑体), 但**字宽和行高对得上**,
   * 判"会不会换行 / 挤不挤 / 层级清不清"足够了。仓里没有打包中文黑体。 */
  await load('Inter', [
    'assets/fonts/InterVariable.ttf',
    'assets/fonts/NotoSerifSC-Regular.otf',
  ]);
  /* Material 图标字体 —— 不加载的话所有 Icon 都是豆腐块 □, 页面上有多少图标就有多少方块,
   * 完全看不出图标选得对不对、大小合不合适 (2026-09-18 会员页第一版截图就是满屏方块)。
   * 字体在 Flutter SDK 里, 路径由 flutter 命令的位置推出来。 */
  /* 等宽字体 —— 行内代码/工具参数用的是 NeoxMono (主族名 'monospace')。
   * 测试环境没有系统等宽字体, 不注册的话所有行内代码渲成**蓝色方块**,
   * 完全看不出代码片段在句子里长什么样 (2026-09-18 timeline 第一版截图就是满屏蓝块)。
   * 仓里没打包等宽字体, 用 Inter 顶上 —— 字宽不是真等宽, 但至少能读出排版和对比。 */
  await load('monospace', ['assets/fonts/InterVariable.ttf']);
  await load('Menlo', ['assets/fonts/InterVariable.ttf']);

  final iconFont = _findMaterialIconFont();
  if (iconFont != null) await load('MaterialIcons', [iconFont]);

  /* 正文用 NotoSerifSC, 但仓里这份是子集: 数字 (7:40 / 12°C / 1 条) 没有字形, 截出来是方块。
   * 把 Inter 也挂到同一个族名里当回退, 至少数字能看 (中文字形仍走 Noto)。 */
  /* 正文 / UI 真正的族名是 NeoxRounded (app_theme 的 _kFontSans) —— 之前只注册了 NotoSerifSC,
   * 中文落到系统回退、拉丁和数字没有字形, 截出来是一排黑方块 (7:40 / 12°C / 1 条 全是)。
   * 中英同一字体, 注册它一个就够。
   * 注意: 这会改变所有截图测试的像素, 所以只在 [neoxRounded] 打开时注册。 */
  if (neoxRounded) {
    await load('NeoxRounded', [
      'assets/fonts/ResourceHanRoundedCN-Regular.otf',
      'assets/fonts/ResourceHanRoundedCN-Medium.otf',
      'assets/fonts/ResourceHanRoundedCN-Bold.otf',
    ]);
  }
  await load('NotoSerifSC', [
    'assets/fonts/NotoSerifSC-Regular.otf',
    'assets/fonts/NotoSerifSC-SemiBold.otf',
  ]);
}

/// 找 Flutter SDK 里的 Material 图标字体.
///
/// 从 dart 可执行文件往上找 `bin/cache/artifacts/material_fonts/` —— 不写死路径,
/// 换 Flutter 版本 / 换机器都能用。找不到就返回 null (图标退回豆腐块, 但不让测试挂)。
String? _findMaterialIconFont() {
  var dir = File(Platform.resolvedExecutable).parent;
  for (var i = 0; i < 6; i++) {
    final f = File('${dir.path}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    if (f.existsSync()) return f.path;
    final g = File('${dir.path}/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    if (g.existsSync()) return g.path;
    dir = dir.parent;
  }
  return null;
}

/// 原生插件桩 —— 渲染台里没有真插件, 页面一调就抛 MissingPluginException.
///
/// 不桩掉的话 settings / connection 这类页面**根本渲不出来** (2026-09-18 实测:
/// connectivity_plus 和 flutter_secure_storage 各抛一次, 测试直接失败),
/// 于是"检查所有页面"就只能靠真机一页页翻。
///
/// 这里只回最小可用值 —— 目的是让页面渲出来, 不是模拟真实行为。
void stubNativePlugins() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  void stub(String channel, Object? Function(MethodCall call) handler) {
    messenger.setMockMethodCallHandler(MethodChannel(channel), (call) async {
      return handler(call);
    });
  }

  /* 网络状态: 当成有 wifi */
  stub('dev.fluttercommunity.plus/connectivity', (c) => <String>['wifi']);
  stub('dev.fluttercommunity.plus/connectivity_status', (c) => <String>['wifi']);
  /* 安全存储: 空库 */
  stub('plugins.it_nomads.com/flutter_secure_storage', (c) =>
      c.method == 'readAll' ? <String, String>{} : null);
  /* 其余常见插件: 返回空, 页面自己有兜底 */
  stub('plugins.flutter.io/path_provider', (c) => '/tmp/neox-harness');
  stub('dev.fluttercommunity.plus/package_info', (c) => <String, String>{
        'appName': 'Neox',
        'packageName': 'com.mkco.neox',
        'version': '3.3.8',
        'buildNumber': '15',
      });
  stub('plugins.flutter.io/shared_preferences', (c) =>
      c.method == 'getAll' ? <String, Object>{} : true);
}
