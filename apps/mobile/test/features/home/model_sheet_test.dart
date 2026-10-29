/// model_sheet_test.dart — 模型面板 (用户路径: 点输入框上的模型签 → 选一个).
///
/// 这里钉的是「用户看到什么、点完发生什么」:
///   - 订阅 / 按量 / 自己的 Key / 本机模型 分组的名字和顺序
///   - 当前模型只有一个勾; 点一行把真实模型 id 交回去 (按量要去掉前缀)
///   - 搜索能筛、能清、没命中要说清楚
///   - 思考档: 选完跟着模型走, 不能换了模型就回到「关」
///   - 一个模型都没有时说原因, 并给登录 / 重试的路
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/execution/inference_params_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/local_agent/model_gateway_client.dart' show GatewayModel;
import 'package:neox_app/core/local_llm/device_profile.dart' show DeviceTier;
import 'package:neox_app/core/local_llm/local_model_catalog.dart';
import 'package:neox_app/features/home/widgets/model_sheet_body.dart';
import 'package:neox_app/shared/clay/clay.dart';
import 'package:neox_app/shared/theme/theme_mode_provider.dart';

const _sub = [
  (id: 'deepseek-v4', name: 'DeepSeek V4', isByok: false, payg: false, relativeCost: 0.4),
  (id: 'claude-opus', name: 'Claude Opus', isByok: false, payg: false, relativeCost: 2.5),
];

const _payg = [
  (id: '${GatewayModel.paygPrefix}gpt-5', name: 'GPT-5', isByok: false, payg: true, relativeCost: 1.0),
];

const _byok = [
  (id: 'byok/gemini', name: 'Gemini', isByok: true, payg: false, relativeCost: null),
];

/// 打开面板并等第一帧; 返回的 picked 会在选完后有值.
Future<String? Function()> _open(
  WidgetTester tester, {
  List<ModelEntry> entries = const [],
  List<LocalLlm> installedLocal = const [],
  String? currentId,
  bool phoneContext = true,
  bool useDesktopList = false,
  bool imageOnly = false,
  String? fetchError,
  bool hasAccounts = false,
  String thinkId = '',
  bool showThinking = false,
  bool thinkToggleable = true,
  VoidCallback? onRetry,
  List<Override> extra = const [],
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  String? picked;
  tester.view.physicalSize = const Size(1200, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs), ...extra],
      child: MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  picked = await showClaySheet<String>(
                    ctx,
                    builder: (_) => ModelSheetBody(
                      entries: entries,
                      installedLocal: installedLocal,
                      currentId: currentId,
                      phoneContext: phoneContext,
                      useDesktopList: useDesktopList,
                      imageOnly: imageOnly,
                      fetchError: fetchError,
                      hasAccounts: hasAccounts,
                      thinkId: thinkId,
                      showThinking: showThinking,
                      thinkToggleable: thinkToggleable,
                      rowName: (id, name) => name,
                      rowProvider: (id, name) => id.startsWith('byok/') ? 'Google' : null,
                      onRetry: onRetry ?? () {},
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return () => picked;
}

LocalLlm _local(String id, String name, {String params = '1.7B'}) => LocalLlm(
      id: id,
      name: name,
      params: params,
      repo: 'org/$id',
      file: '$id.gguf',
      size: 1 << 30,
      sha256: List.filled(64, '0').join(),
      template: 'chatml',
      minTier: DeviceTier.mid,
      minRamGb: 6,
    );

void main() {
  testWidgets('普通面板: 标题是「模型」, 三组按订阅 / 按量 / 自己的 Key 分组', (t) async {
    await _open(t, entries: [..._sub, ..._payg, ..._byok]);

    expect(find.text(tr('模型')), findsOneWidget);
    expect(find.text(tr('订阅 · 用套餐额度')), findsOneWidget);
    expect(find.text(tr('按量 · 从余额扣费')), findsOneWidget);
    expect(find.text(tr('自己的 Key')), findsOneWidget);
    /* 分组顺序: 订阅在按量上面, 按量在自己的 Key 上面 */
    final subY = t.getTopLeft(find.text(tr('订阅 · 用套餐额度'))).dy;
    final paygY = t.getTopLeft(find.text(tr('按量 · 从余额扣费'))).dy;
    final byokY = t.getTopLeft(find.text(tr('自己的 Key'))).dy;
    expect(subY, lessThan(paygY));
    expect(paygY, lessThan(byokY));
  });

  testWidgets('图像模式: 标题是「图像模型」, 不出现本机模型和「管理模型」', (t) async {
    await _open(t, entries: _sub, imageOnly: true);

    expect(find.text(tr('图像模型')), findsOneWidget);
    expect(find.text(tr('模型')), findsNothing);
    expect(find.text(tr('管理模型')), findsNothing);
    /* 图像列表里不该推荐「用自己的 API Key」 */
    expect(find.text(tr('用自己的 API Key')), findsNothing);
  });

  testWidgets('当前模型只打一个勾; 点另一个把它的 id 交回去', (t) async {
    final picked = await _open(t, entries: _sub, currentId: 'deepseek-v4');

    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    await t.tap(find.text('Claude Opus'));
    await t.pumpAndSettle();
    expect(picked(), 'claude-opus');
  });

  testWidgets('按量模型交回的 id 带记账前缀 (调用方原样存)', (t) async {
    final picked = await _open(t, entries: _payg);
    await t.tap(find.text('GPT-5'));
    await t.pumpAndSettle();
    /* 前缀是「从余额扣费」这条路的标识; 剥掉的话下次打开面板就不认得它了 */
    expect(picked(), '${GatewayModel.paygPrefix}gpt-5');
  });

  testWidgets('用途: 便宜的说日常干活, 贵的说更强, 按量另带「按用量计费」', (t) async {
    await _open(t, entries: _sub);

    expect(find.text(tr('日常干活，快')), findsOneWidget);
    expect(find.text(tr('更强，适合复杂任务')), findsOneWidget);
    expect(find.textContaining(tr('按用量计费')), findsNothing);
  });

  testWidgets('自己的 Key 行显示直连哪家厂商', (t) async {
    await _open(t, entries: _byok);
    expect(find.text(tr('直连 · Google')), findsOneWidget);
  });

  testWidgets('搜索: 输入关键字只留匹配的模型; 清掉后全部回来', (t) async {
    await _open(t, entries: _sub);

    await t.tap(find.byTooltip(tr('搜索模型')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'claude');
    await t.pumpAndSettle();

    expect(find.text('Claude Opus'), findsOneWidget);
    expect(find.text('DeepSeek V4'), findsNothing);

    /* 再点一次放大镜 = 关闭搜索并清空 */
    await t.tap(find.byTooltip(tr('搜索模型')));
    await t.pumpAndSettle();
    expect(find.text('DeepSeek V4'), findsOneWidget);
  });

  testWidgets('搜索没命中: 说出没匹配「什么」, 不给一个空面板', (t) async {
    await _open(t, entries: _sub);

    await t.tap(find.byTooltip(tr('搜索模型')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), '不存在的模型');
    await t.pumpAndSettle();

    expect(find.textContaining('没有匹配「不存在的模型」'), findsOneWidget);
  });

  testWidgets('搜索时隐藏思考档 (占用屏幕、且正在找东西)', (t) async {
    await _open(t, entries: _sub, thinkId: 'deepseek-v4', showThinking: true);

    /* 不搜时在 */
    expect(find.text(tr('思考')), findsOneWidget);
    await t.tap(find.byTooltip(tr('搜索模型')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'claude');
    await t.pumpAndSettle();
    expect(find.text(tr('思考')), findsNothing);
  });

  testWidgets('思考档: 四个档位都画出来, 选中当前档', (t) async {
    await _open(t, entries: _sub, thinkId: 'deepseek-v4', showThinking: true);

    for (final label in ['关', '低', '中', '高']) {
      expect(find.text(label), findsOneWidget, reason: '缺档位 $label');
    }
    expect(find.text(tr('想得越多越准，也越慢')), findsOneWidget);
  });

  testWidgets('模型永远会思考时, 说明选「关」也没用', (t) async {
    await _open(
      t,
      entries: _sub,
      thinkId: 'deepseek-v4',
      showThinking: true,
      thinkToggleable: false,
    );
    expect(find.text(tr('这个模型一直会思考，选「关」也无效')), findsOneWidget);
  });

  testWidgets('调好思考档再换模型: 档位跟到新模型上 (不能回到关)', (t) async {
    await _open(t, entries: _sub, currentId: 'deepseek-v4', thinkId: 'deepseek-v4', showThinking: true);

    await t.tap(find.text('高'));
    await t.pumpAndSettle();
    await t.tap(find.text('Claude Opus'));
    await t.pumpAndSettle();

    final container = ProviderScope.containerOf(
      t.element(find.byType(MaterialApp)),
      listen: false,
    );
    expect(
      container.read(chatThinkingProvider.notifier).level('claude-opus'),
      ThinkLevel.high,
      reason: '用户刚调好的档不能因为换了个模型就悄悄丢掉',
    );
  });

  testWidgets('拉取失败且一个模型都没有: 显示原话, 点一下真的重新拉', (t) async {
    var retried = 0;
    await _open(
      t,
      entries: const [],
      fetchError: '网络不通',
      onRetry: () => retried++,
    );
    expect(find.text('网络不通'), findsOneWidget);
    expect(find.text(tr('点一下重新拉取')), findsOneWidget);

    await t.tap(find.text('网络不通'));
    await t.pumpAndSettle();
    expect(retried, 1);
  });

  testWidgets('有账号但没模型: 给「登录使用订阅模型」', (t) async {
    final picked = await _open(t, entries: const [], hasAccounts: true);
    expect(find.text(tr('登录使用订阅模型')), findsOneWidget);

    await t.tap(find.text(tr('登录使用订阅模型')));
    await t.pumpAndSettle();
    expect(picked(), ModelSheetBody.loginSentinel);
  });

  testWidgets('没填过 Key: 给「用自己的 API Key」, 交回加 Key 的哨兵', (t) async {
    final picked = await _open(t, entries: _sub);
    expect(find.text(tr('用自己的 API Key')), findsOneWidget);

    await t.tap(find.text(tr('用自己的 API Key')));
    await t.pumpAndSettle();
    expect(picked(), ModelSheetBody.addKeySentinel);
  });

  testWidgets('电脑给的列表: 不劝用户加 Key, 也不给「管理模型」以外的入口', (t) async {
    await _open(t, entries: _sub, useDesktopList: true);
    expect(find.text(tr('用自己的 API Key')), findsNothing);
    expect(find.textContaining(tr('管理模型')), findsOneWidget);
  });

  testWidgets('点「管理模型」交回管理哨兵', (t) async {
    final picked = await _open(t, entries: _sub);
    await t.tap(find.text(tr('管理模型') + ' ›'));
    await t.pumpAndSettle();
    expect(picked(), ModelSheetBody.manageSentinel);
  });

  testWidgets('本机模型: 安卓上可点, 非手机上下文里是淡的且点不动', (t) async {
    /* 测试宿主平台默认是 android —— kLocalLlmSupported 为 true */
    await _open(
      t,
      entries: _sub,
      installedLocal: [_local('qwen-1.7b', 'Qwen 1.7B')],
      phoneContext: true,
    );
    expect(find.text(tr('本机模型')), findsOneWidget);
    expect(find.text(tr('不联网，在手机上跑')), findsOneWidget);
  });

  testWidgets('本机模型在电脑会话里: 说明「只在对话里用」', (t) async {
    await _open(
      t,
      entries: _sub,
      installedLocal: [_local('qwen-1.7b', 'Qwen 1.7B')],
      phoneContext: false,
    );
    if (kLocalLlmSupported) {
      expect(find.text(tr('只在「对话」里用')), findsOneWidget);
    }
  });
}
