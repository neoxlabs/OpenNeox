/// tool_image_seen_card.dart — 工具截图回灌给模型的那条「user」消息, 渲染成它看了哪几张图 (2026-10-12)。
///
/// 内核 (packages/kernel imageToolResult.ts buildImageAttachmentMessage) 把工具返回的截图包成一条
/// user 消息塞回上下文: 「[系统注入] 以下 N 张图片是工具 X 的返回内容, 不是用户的新消息: …」。
/// 那是给模型的协议, 不是用户说的话 —— 桌面渲染成「看到的图」, 手机原来当用户气泡, 白底大框里一句
/// 「[系统注入] …undefined×undefined」+ 转圈 (用户实拍)。这里跟桌面对齐: 靠左, 一行小字 + 图。
///
/// 2026-10-12 第二修 (用户: 「图片手机端不显示不渲染啊」): 桌面发给手机前会把图片块瘦身成一行
/// markdown `![](neox-image://<sha>.<ext>)` 混在文本里 (mobilePayloadSlim.ts), 而这里原来把这行
/// **当说明文字原样印出来**。现在把引用抽出来交给 NeoxRemoteImage 渲染, 标签里不再留那串 markdown
/// —— 抽取器 (neoxImageNamesIn) 和加载器 (NeoxRemoteImage) 本来就在, 只是这张卡没用。
library;

import 'package:flutter/material.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'remote_image.dart';
import 'user_attachments.dart';

final RegExp _head = RegExp(r'^\s*\[系统注入\]\s*以下\s*(\d+)\s*张图片是工具\s*(\S+?)\s*的返回内容[^:：]*[:：]?');

/// markdown 图 `![](neox-image://…)` 或裸引用 —— 从说明文字里剥掉, 换行渲染成真图.
final RegExp _reNeoxImageRef = RegExp(
  r'!?\[[^\]]*\]\(\s*neox-image://[^)\s]*\s*\)|neox-image://\S+',
);

/// 计划推进提醒 (core updatePlan.ts getActionFramePrompt) —— 每轮塞给模型的「[计划 · 已完成 1/5] 当前步骤…」,
/// 不是用户说的话; 进度手机上已经有「计划 N/M」条, 这一条不显示 (2026-10-12 真机: 被当成用户气泡)。
bool isPlanNudge(String text) {
  final t = text.trimLeft();
  return t.startsWith('[计划 · 已完成') || t.startsWith('[Plan · ');
}

/// 是不是工具截图回灌; 是就返回 (张数, 工具名, 每张的说明, 图片引用名)
({int count, String tool, List<String> labels, List<String> images})? parseToolImageInjection(String text) {
  final m = _head.firstMatch(text);
  if (m == null) return null;
  final rest = text.substring(m.end);
  return (
    count: int.tryParse(m[1]!) ?? 1,
    tool: m[2]!,
    labels: rest
        .split(RegExp(r'\n+'))
        .map(_cleanLabel)
        .where((l) => l.isNotEmpty)
        .toList(),
    images: neoxImageNamesIn(rest),
  );
}

/// 说明文字清洗: 剥掉图片引用, 顺手去掉拼不出来的尺寸占位.
String _cleanLabel(String l) => l
    .replaceAll(_reNeoxImageRef, '')
    /* 拿不到尺寸时会拼出 undefined×undefined —— 不往脸上摆 */
    .replaceAll(RegExp(r',?\s*undefined\s*[×x]\s*undefined'), '')
    .replaceAll(RegExp(r'\(\s*surface\s+default\s*\)'), '')
    .trim();

class ToolImageSeenCard extends StatelessWidget {
  const ToolImageSeenCard({
    super.key,
    required this.count,
    required this.labels,
    required this.attachments,
    this.images = const [],
  });

  final int count;
  final List<String> labels;
  final List<LocalAttachmentRef> attachments;

  /// 混在文本里的 `neox-image://` 引用 —— 单独渲染成图 (见文件头注释)
  final List<String> images;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    /* 图已经摆在下面时只写「看了 N 张图」: 文件名 / 大小 / image/jpeg, resized 是给模型的说明,
     * 对人是废话, 还折两行占地方 (2026-10-22 用户实拍)。拿不到图时才用说明顶一下, 也只给一行 */
    final caption = labels.isEmpty || images.isNotEmpty || attachments.isNotEmpty
        ? tr('看了 $count 张图')
        : tr('看了 $count 张图 · ${labels.join('；')}');
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, NeoxSpace.xs, NeoxIndent.gutter, NeoxSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.image_outlined, size: 15, color: mute),
            const SizedBox(width: 6),
            Expanded(
              child: Text(caption, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: mute)),
            ),
          ]),
          /* 图就摆在「看了 N 张图」下面 —— 这一行的全部意义就是"它看了什么",
           * 不给图等于只说了个数。尺寸规则跟 NeoxImageStrip 一致 (单图给大)。 */
          if (images.isNotEmpty) ...[
            const SizedBox(height: NeoxSpace.xs),
            Wrap(
              spacing: NeoxSpace.xs,
              runSpacing: NeoxSpace.xs,
              children: [
                for (final n in images)
                  NeoxRemoteImage(
                    name: n,
                    maxWidth: images.length == 1 ? 260 : 150,
                    maxHeight: images.length == 1 ? 320 : 150,
                  ),
              ],
            ),
          ],
          if (attachments.isNotEmpty) ...[
            const SizedBox(height: NeoxSpace.xs),
            UserAttachments(items: attachments, alignStart: true),
          ],
        ],
      ),
    );
  }
}
