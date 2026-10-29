/// image_studio_page.dart — 手机图片工作台.
///
/// 对齐桌面心智: 独立入口 + 复用 Timeline + StageInput, 预挂「创建图片」直连出图.
/// 不依赖桌面 imageDirect IPC / kind=image 桌面会话.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_page_hero.dart';
import '../home/state/current_session_provider.dart';
import '../home/widgets/stage_input.dart';
import '../timeline/widgets/timeline_message_list.dart';
import 'image_gallery.dart';
import 'state/image_studio_providers.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ImageStudioPage extends ConsumerStatefulWidget {
  const ImageStudioPage({super.key});

  @override
  ConsumerState<ImageStudioPage> createState() => _ImageStudioPageState();
}

class _ImageStudioPageState extends ConsumerState<ImageStudioPage> with WidgetsBindingObserver {
  String? _prevChatSession;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    /* 记住进页前的聊天会话, 离开时还原 — 避免图片页污染主会话. */
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _prevChatSession = ref.read(currentSessionProvider);
      final imgSid = ref.read(imageStudioSessionProvider);
      if (imgSid != null) {
        ref.read(currentSessionProvider.notifier).set(imgSid);
      } else {
        ref.read(currentSessionProvider.notifier).set(null);
      }
      _resumePending(imgSid);
    });
  }

  /* 回到前台: 后台期间出好的图接着取回来 (进程没死时 ImageStudioSender 自己也在等, 这里会跳过它) */
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      _resumePending(ref.read(currentSessionProvider));
    }
  }

  void _resumePending(String? sessionId) {
    if (sessionId == null) return;
    ref.read(imageStudioSenderProvider).resumePending(sessionId).catchError((Object e) {
      debugPrint('[image-studio] resume failed: $e');
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    /* 不能在 dispose 里用 ref — 用 addPostFrame 也不安全.
     * 还原放在 PopScope.onPopInvokedWithResult. */
    super.dispose();
  }

  void _restoreChatSession() {
    final imgSid = ref.read(currentSessionProvider);
    if (imgSid != null) {
      ref.read(imageStudioSessionProvider.notifier).set(imgSid);
    }
    ref.read(currentSessionProvider.notifier).set(_prevChatSession);
  }

  /// 我画过的 —— 之前一张都找不回来.
  ///
  /// 走查发现: newCanvas() 只是把 imageStudioSessionProvider 换成新 id, 旧画布
  /// 就此失联 —— 它是 kind='image' 的会话, 既不在这个页面里露出, 又混在聊天
  /// 抽屉的「最近」里 (那边根本没按 kind 过滤)。用户画完一张再点「+」, 上一张
  /// 就等于丢了。
  Future<void> _openGallery() async {
    final picked = await showImageGallery(context, ref);
    if (picked == null || !mounted) return;
    ref.read(imageStudioSessionProvider.notifier).set(picked);
    ref.read(currentSessionProvider.notifier).set(picked);
    _resumePending(picked);
  }

  void _newCanvas() {
    ref.read(imageStudioSessionProvider.notifier).newCanvas();
    ref.read(currentSessionProvider.notifier).set(null);
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final sessionId = ref.watch(currentSessionProvider);

    return PopScope(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _restoreChatSession();
      },
      child: Scaffold(
        backgroundColor: c.canvas,
        body: SafeArea(
          child: Column(
            children: [
              /* 顶栏按 v5 稿: 居中标题, 右边「我画过的」+「新建」。返回仍是 pop, 还原交给 PopScope
               * (见下), 这里不再手动还原一次 —— 原来那样会把聊天会话记成图片页会话。 */
              ClayTopBar(
                title: tr('图片'),
                center: true,
                onBack: () => Navigator.of(context).maybePop(),
                actions: [
                  ClayRoundButton(
                    icon: Icons.grid_view_rounded,
                    flat: true,
                    size: 44,
                    tooltip: tr('我画过的'),
                    onTap: _openGallery,
                  ),
                  /* 已经是空白画布时不画「+」(点了没反应), 跟首页顶栏同一规则 */
                  if (sessionId != null)
                    ClayRoundButton(
                      icon: Icons.add_rounded,
                      flat: true,
                      size: 44,
                      tooltip: tr('新建图片'),
                      onTap: _newCanvas,
                    ),
                ],
              ),
              Expanded(
                child: sessionId == null
                    ? _ImageEmptyState(onOpenGallery: _openGallery)
                    : TimelineMessageList(
                        sessionId: sessionId,
                        emptyChild: _ImageEmptyState(onOpenGallery: _openGallery),
                      ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoxSpace.lg,
                  NeoxSpace.sm,
                  NeoxSpace.lg,
                  NeoxSpace.sm,
                ),
                child: StageInput(imageMode: true),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ImageEmptyState extends StatelessWidget {
  const _ImageEmptyState({required this.onOpenGallery});

  /// 「我画过的」入口 (同顶栏那颗按钮, 同一个画廊)
  final VoidCallback onOpenGallery;

  @override
  Widget build(BuildContext context) {
    /* 2026-10-12 用户: 「这个页面没美化」—— 图片页是抽屉里正儿八经的一个去处,
     * 却还停在最早那版"中间一张等距插画 + 两行字", 跟旁边三个已经换上陶土页头的
     * 页面不像一个产品。现在同一套页头 (同一张图、同一个位置)。
     * 2026-10-14 v5 稿: 页底下面是「我画过的」分组, 一行进画廊。 */
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        NeoxClayBanner(
          asset: 'bg-image',
          title: tr('生成图片'),
          /* 短句: 长了会伸到右边陶土相框的头上 (见 NeoxClayBanner 的说明) */
          subtitle: tr('描述画面，或选图来改'),
        ),
        ClaySectionLabel(tr('我画过的')),
        ClayGroup(
          children: [
            ClayRow(
              icon: Icons.grid_view_rounded,
              title: tr('看看之前画过的图'),
              subtitle: tr('出过的图都在这里, 点开接着改'),
              onTap: onOpenGallery,
            ),
          ],
        ),
      ],
    );
  }
}
