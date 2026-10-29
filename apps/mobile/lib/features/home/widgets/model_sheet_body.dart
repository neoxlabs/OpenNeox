/// model_sheet_body.dart — 模型选择面板的样子 (陶土稿 v5「模型」弹层).
///
/// 数据 (拉哪份列表、当前是谁、选完写到哪) 还在 stage_input.dart 的 openModelSheet 里;
/// 这里只管长相:
///   模型 ··········· 🔍
///   [ 关 · 低 · 中 · 高 ]   想得越多越准，也越慢
///   订阅      DeepSeek V4 / 日常干活，快 ✓
///   按量 / 自己的 Key / 本机模型
///   管理模型 ›
/// 不写价格和倍率 (稿上规则), 选中只一个墨色细勾。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/execution/inference_params_provider.dart';
import '../../../core/local_llm/local_model_catalog.dart';
import '../../../core/local_agent/model_gateway_client.dart' show GatewayModel;
import '../../../shared/clay/clay.dart';
import '../../../shared/widgets/provider_brand_icon.dart';
import 'package:neox_app/core/i18n/tr.dart';

typedef ModelEntry = ({String id, String name, bool isByok, bool payg, double? relativeCost});

class ModelSheetBody extends ConsumerStatefulWidget {
  const ModelSheetBody({
    super.key,
    required this.entries,
    required this.installedLocal,
    required this.currentId,
    required this.phoneContext,
    required this.useDesktopList,
    required this.imageOnly,
    required this.fetchError,
    required this.hasAccounts,
    required this.thinkId,
    required this.showThinking,
    required this.thinkToggleable,
    required this.rowName,
    required this.rowProvider,
    required this.onRetry,
  });

  final List<ModelEntry> entries;
  final List<LocalLlm> installedLocal;
  final String? currentId;
  final bool phoneContext;
  final bool useDesktopList;
  final bool imageOnly;
  final String? fetchError;
  final bool hasAccounts;

  /// 思考跟着哪个模型记 (空 = 没有)
  final String thinkId;

  /// 这条会在手机上跑 (思考只对手机上的对话生效; 电脑会话的思考由电脑管)
  final bool showThinking;
  final bool thinkToggleable;
  final String Function(String id, String name) rowName;
  final String? Function(String id, String name) rowProvider;
  final VoidCallback onRetry;

  static const addKeySentinel = '__add_byok_key__';
  static const loginSentinel = '__login__';
  static const localModelsSentinel = '__local_models__';
  static const manageSentinel = '__manage_models__';

  @override
  ConsumerState<ModelSheetBody> createState() => _ModelSheetBodyState();
}

class _ModelSheetBodyState extends ConsumerState<ModelSheetBody> {
  bool _searching = false;
  String _q = '';

  /// 一句用途 —— 稿上「日常干活，快」「最强，按用量计费」。
  /// 手里只有相对消耗 (relativeCost, 1 = 基准), 按它说快慢强弱, 不编具体能力。
  String _purpose(ModelEntry m) {
    final c = m.relativeCost;
    final tier = c == null
        ? null
        : c <= 0.6
            ? tr('日常干活，快')
            : c <= 1.6
                ? tr('均衡')
                : tr('更强，适合复杂任务');
    if (m.payg) return [?tier, tr('按用量计费')].join('，');
    if (m.isByok) {
      final p = widget.rowProvider(m.id, m.name);
      return p == null ? tr('直连厂商') : tr('直连 · $p');
    }
    return tier ?? tr('订阅附带');
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final needle = _q.trim().toLowerCase();
    final visible = needle.isEmpty
        ? widget.entries
        : widget.entries
            .where((m) => m.id.toLowerCase().contains(needle) || m.name.toLowerCase().contains(needle))
            .toList(growable: false);
    final sub = visible.where((m) => !m.isByok && !m.payg).toList();
    final payg = visible.where((m) => m.payg).toList();
    final byok = visible.where((m) => m.isByok).toList();
    final local = widget.installedLocal
        .where((m) => needle.isEmpty || m.name.toLowerCase().contains(needle))
        .toList();
    /* 档位存在 controller 里另一张表上; watch 那张开 / 关表只是为了档位一变就重画 */
    ref.watch(chatThinkingProvider);
    final level = ref.read(chatThinkingProvider.notifier).level(widget.thinkId);

    Widget modelRow(ModelEntry m) {
      final realId = m.payg ? m.id.substring(GatewayModel.paygPrefix.length) : m.id;
      return ClayRow(
        /* 厂商原色标打头 (DeepSeek 蓝鲸 / Claude 橙 …), 一眼认出是谁家的 */
        leading: ProviderBrandIcon(id: realId, name: m.name, size: 22),
        title: widget.rowName(realId, m.name),
        subtitle: _purpose(m),
        selected: m.id == widget.currentId,
        chevron: false,
        onTap: () {
          /* 思考档是按模型记的: 面板顶上调好档再点模型, 档要跟到新模型上
           * (2026-10-14 实测: 先选「中」再换 V4.1, V4.1 还是「关」, 整轮没思考) */
          if (widget.showThinking && m.id != widget.thinkId) {
            ref.read(chatThinkingProvider.notifier).setLevel(m.id, level);
          }
          Navigator.pop(context, m.id);
        },
      );
    }

    final rows = <Widget>[
      ClaySheetHeader(
        title: widget.imageOnly ? tr('图像模型') : tr('模型'),
        trailing: ClayRoundButton(
          icon: _searching ? Icons.close_rounded : Icons.search_rounded,
          size: 36,
          tooltip: tr('搜索模型'),
          onTap: () => setState(() {
            _searching = !_searching;
            if (!_searching) _q = '';
          }),
        ),
      ),
      if (_searching)
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
          child: ClayField(
            hint: tr('搜索模型'),
            icon: Icons.search_rounded,
            autofocus: true,
            onChanged: (v) => setState(() => _q = v),
          ),
        ),
      if (widget.showThinking && widget.thinkId.isNotEmpty && needle.isEmpty) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 6),
          child: Row(
            children: [
              Text(tr('思考'), style: TextStyle(fontSize: 13, color: c.grey, fontWeight: FontWeight.w500)),
              const SizedBox(width: 12),
              Expanded(
                child: ClaySegmented<ThinkLevel>(
                  options: [
                    (ThinkLevel.off, tr('关')),
                    (ThinkLevel.low, tr('低')),
                    (ThinkLevel.medium, tr('中')),
                    (ThinkLevel.high, tr('高')),
                  ],
                  value: level,
                  onChanged: (l) => ref.read(chatThinkingProvider.notifier).setLevel(widget.thinkId, l),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
          child: Text(
            widget.thinkToggleable ? tr('想得越多越准，也越慢') : tr('这个模型一直会思考，选「关」也无效'),
            style: TextStyle(fontSize: 12.5, color: c.grey),
          ),
        ),
      ],
      if (needle.isNotEmpty && visible.isEmpty && local.isEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
          child: Text(tr('没有匹配「${_q.trim()}」的模型'), style: TextStyle(fontSize: 14, color: c.grey)),
        ),
      /* 一个都没有: 先说为什么, 再给能点的路 */
      if (sub.isEmpty && byok.isEmpty && payg.isEmpty && !widget.useDesktopList && needle.isEmpty) ...[
        if (widget.fetchError != null)
          ClayRow(
            icon: Icons.error_outline_rounded,
            title: widget.fetchError!,
            subtitle: tr('点一下重新拉取'),
            danger: true,
            onTap: widget.onRetry,
          ),
        if (widget.hasAccounts)
          ClayRow(
            icon: Icons.person_outline_rounded,
            title: tr('登录使用订阅模型'),
            onTap: () => Navigator.pop(context, ModelSheetBody.loginSentinel),
          ),
      ],
      if (sub.isNotEmpty) ...[
        /* 同一个模型可能订阅、按量各出现一次 —— 组名带上「钱从哪扣」, 不然用户分不清点的是哪个 (4.0.2 用户:「有点懵」) */
        ClaySectionLabel(tr('订阅 · 用套餐额度'), padding: const EdgeInsets.fromLTRB(24, 16, 24, 4)),
        ...sub.map(modelRow),
      ],
      if (payg.isNotEmpty) ...[
        ClaySectionLabel(tr('按量 · 从余额扣费'), padding: const EdgeInsets.fromLTRB(24, 16, 24, 4)),
        ...payg.map(modelRow),
      ],
      if (byok.isNotEmpty || (!widget.useDesktopList && needle.isEmpty && !widget.imageOnly)) ...[
        ClaySectionLabel(tr('自己的 Key'), padding: const EdgeInsets.fromLTRB(24, 16, 24, 4)),
        ...byok.map(modelRow),
        if (!widget.useDesktopList && byok.isEmpty)
          ClayRow(
            icon: Icons.vpn_key_outlined,
            title: tr('用自己的 API Key'),
            subtitle: tr('直连厂商，不走订阅额度'),
            onTap: () => Navigator.pop(context, ModelSheetBody.addKeySentinel),
          ),
      ],
      if (!widget.imageOnly && kLocalLlmSupported && local.isNotEmpty) ...[
        ClaySectionLabel(tr('本机模型'), padding: const EdgeInsets.fromLTRB(24, 16, 24, 4)),
        for (final m in local)
          ClayRow(
            title: m.name,
            subtitle: widget.phoneContext ? tr('不联网，在手机上跑') : tr('只在「对话」里用'),
            faded: !widget.phoneContext,
            selected: m.modelId == widget.currentId,
            chevron: false,
            onTap: widget.phoneContext ? () => Navigator.pop(context, m.modelId) : null,
          ),
      ],
      if (!widget.imageOnly)
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => Navigator.pop(context, ModelSheetBody.manageSentinel),
              child: Text('${tr('管理模型')} ›', style: TextStyle(fontSize: 14, color: c.grey)),
            ),
          ),
        ),
      const SizedBox(height: 8),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: rows),
    );
  }
}
