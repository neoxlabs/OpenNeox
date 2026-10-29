/// providers_page.dart — BYOK「我的模型 Key」管理页.
///
/// 零账号核心入口 — 跟桌面 onboarding「接入模型」步同一心智:
///   选厂商 → 贴 Key → 探活 (顺带拉厂商模型列表) → 勾模型 → 完成.
///
/// 结构:
///   - 空态: 说明卡 + 厂商 preset 网格
///   - 列表态: provider 卡 (名称/协议/模型数/开关) + 添加按钮
///   - 添加/编辑: 全屏 bottom sheet, 三步 (Key → 探活 → 选模型)
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/byok/byok_models.dart';
import '../../core/byok/byok_service.dart';
import '../../core/byok/byok_store.dart';
import '../../core/errors/friendly_error.dart';
import '../../core/network/ws_client_provider.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';
import '../../shared/widgets/neox_card.dart';
import '../../shared/widgets/neox_scaffold.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ProvidersPage extends ConsumerWidget {
  const ProvidersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final providers = ref.watch(byokStoreProvider);
    final ws = ref.watch(wsClientProvider);
    final canImportDesktop =
        ws.transport == WsTransport.lan &&
        ws.connection == WsConnectionState.connected;

    return NeoxScaffold(
      title: tr('云端 Key'),
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              NeoxSpace.xl,
              NeoxSpace.xs,
              NeoxSpace.xl,
              NeoxSpace.sm,
            ),
            child: _ImportFromDesktopCard(
              enabled: canImportDesktop,
              onImport: () => _importFromDesktop(context, ref),
            ),
          ),
        ),
        if (providers.isEmpty)
          const SliverToBoxAdapter(child: _EmptyHero())
        else ...[
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.xl,
                NeoxSpace.xs,
                NeoxSpace.xl,
                NeoxSpace.sm,
              ),
              child: Column(
                children: [
                  for (final p in providers) _ProviderCard(provider: p),
                ],
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: NeoxSpace.xl,
                vertical: NeoxSpace.sm,
              ),
              child: OutlinedButton.icon(
                onPressed: () => showAddProviderSheet(context),
                icon: const Icon(Icons.add, size: 18),
                label: Text(tr('添加厂商')),
              ),
            ),
          ),
        ],
        const SliverToBoxAdapter(child: SizedBox(height: NeoxSpace.xl)),
      ],
    );
  }
}

Future<void> _importFromDesktop(BuildContext context, WidgetRef ref) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(tr('从电脑导入 Provider')),
      content: Text(
        tr('将把已配对电脑上的 API Key 同步到本机安全区。'
        '仅在同 Wi-Fi 直连时可用，不会经过云端。'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text(tr('取消')),
        ),
        FilledButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          child: Text(tr('导入')),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;

  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const Center(
      child: Card(
        child: Padding(
          padding: EdgeInsets.all(NeoxSpace.lg),
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
        ),
      ),
    ),
  );

  try {
    final exported = await ref
        .read(wsClientProvider.notifier)
        .exportDesktopProviders();
    final result = await ref
        .read(byokStoreProvider.notifier)
        .upsertFromDesktop(exported.providers);
    if (!context.mounted) return;
    Navigator.of(context, rootNavigator: true).pop(); // dismiss progress
    final skipped = exported.skippedCount;
    final msg = result.added == 0 && result.updated == 0
        ? (skipped > 0
              ? tr('电脑上没有可导入的 chat Provider（已跳过 $skipped 项）')
              : tr('电脑上没有可导入的 Provider'))
        : tr('已导入 ${result.added} 个，更新 ${result.updated} 个'
              '${skipped > 0 ? '（跳过 $skipped）' : ''}');
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  } catch (e) {
    if (!context.mounted) return;
    Navigator.of(context, rootNavigator: true).pop();
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(friendlyError(e))));
  }
}

class _ImportFromDesktopCard extends StatelessWidget {
  const _ImportFromDesktopCard({required this.enabled, required this.onImport});

  final bool enabled;
  final VoidCallback onImport;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return NeoxCard(
      child: Row(
        children: [
          Opacity(
            opacity: enabled ? 1 : 0.5,
            child: Image.asset(NeoxClay.of('i-laptop'), width: 32, height: 32),
          ),
          const SizedBox(width: NeoxSpace.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  tr('从电脑导入'),
                  style: theme.textTheme.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  enabled ? tr('同步电脑上的 Key') : tr('需同 Wi-Fi'),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: NeoxSpace.sm),
          FilledButton.tonal(
            onPressed: enabled ? onImport : null,
            child: Text(tr('导入')),
          ),
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  空态 — 说明 + preset 网格
// ════════════════════════════════════════════════════════════════
class _EmptyHero extends StatelessWidget {
  const _EmptyHero();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.xl,
        NeoxSpace.xs,
        NeoxSpace.xl,
        NeoxSpace.md,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          /* 这里原来是「用自己的 API Key」headlineSmall 二级大标题 + 三行说明。
           * 页面标题已经是「我的模型 Key」, 再来一个同义的二级标题纯属重复;
           * 说明缩成一行 —— 第一次来的人需要知道"Key 存在本机", 之后每次来它都是噪音。 */
          Text(
            tr('Key 只存在本机，直连厂商计费。'),
            style: theme.textTheme.bodyMedium?.copyWith(
              color: scheme.onSurfaceVariant,
              height: 1.5,
            ),
          ),
          const SizedBox(height: NeoxSpace.lg),
          _PresetGrid(
            onPick: (preset) => showAddProviderSheet(context, preset: preset),
          ),
        ],
      ),
    );
  }
}

class _PresetGrid extends StatelessWidget {
  const _PresetGrid({required this.onPick});
  final void Function(ByokPreset) onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Wrap(
      spacing: NeoxSpace.sm,
      runSpacing: NeoxSpace.sm,
      children: [
        for (final p in kByokPresets)
          /* 填充药丸, 不再是"白底 + 一圈描边".
           * 描边款跟 composer 里那排 chip 是两套语言 —— 而它们是同一种东西
           * (一颗能点的药丸)。app 里能点的东西一律坐在 chipFill 上。 */
          Material(
            color: scheme.chipFill,
            borderRadius: NeoxRadius.pillR,
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => onPick(p),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: NeoxSpace.md + 2,
                  vertical: NeoxSpace.sm + 2,
                ),
                child: Text(
                  p.name,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: scheme.onSurface,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  Provider 卡
// ════════════════════════════════════════════════════════════════
class _ProviderCard extends ConsumerWidget {
  const _ProviderCard({required this.provider});
  final ByokProviderConfig provider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final protocolLabel = switch (provider.protocol) {
      ByokProtocol.anthropic => 'Anthropic',
      ByokProtocol.gemini => 'Gemini',
      ByokProtocol.openaiCompat => tr('OpenAI 兼容'),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoxSpace.sm + 2),
      child: NeoxCard(
        padding: const EdgeInsets.all(NeoxSpace.lg),
        onTap: () => showAddProviderSheet(context, editing: provider),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    provider.name,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    tr('$protocolLabel · ${provider.models.length} 个模型 · '
                    'Key ${maskKey(provider.apiKey)}'),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            SettingsSwitch(
              value: provider.enabled,
              onChanged: (v) => ref
                  .read(byokStoreProvider.notifier)
                  .update(provider.copyWith(enabled: v)),
            ),
          ],
        ),
      ),
    );
  }
}

String maskKey(String key) {
  if (key.length <= 8) return '••••';
  return '${key.substring(0, 4)}…${key.substring(key.length - 4)}';
}

// ════════════════════════════════════════════════════════════════
//  添加 / 编辑 sheet
// ════════════════════════════════════════════════════════════════
Future<void> showAddProviderSheet(
  BuildContext context, {
  ByokPreset? preset,
  ByokProviderConfig? editing,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: _ProviderForm(preset: preset, editing: editing),
    ),
  );
}

class _ProviderForm extends ConsumerStatefulWidget {
  const _ProviderForm({this.preset, this.editing});
  final ByokPreset? preset;
  final ByokProviderConfig? editing;

  @override
  ConsumerState<_ProviderForm> createState() => _ProviderFormState();
}

class _ProviderFormState extends ConsumerState<_ProviderForm> {
  late ByokPreset _preset;
  late final TextEditingController _name;
  late final TextEditingController _baseUrl;
  late final TextEditingController _apiKey;
  late final TextEditingController _manualModel;

  bool _probing = false;
  String? _probeError;

  /// 探活拿回的厂商模型列表 (可空).
  List<String> _probedModels = const [];

  /// 已勾选模型.
  late final Set<String> _selected;

  /// 模型过滤词 (OpenRouter 探活返回 300+ 个, 全平铺手机滚不完).
  String _modelFilter = '';
  static const int _kMaxModelChips = 30;

  bool get _isEditing => widget.editing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.editing;
    _preset =
        widget.preset ??
        (e == null
            ? kByokPresets.first
            : kByokPresets.firstWhere(
                (p) => p.protocol == e.protocol && p.baseUrl == e.baseUrl,
                orElse: () => kByokPresets.last /* custom */,
              ));
    _name = TextEditingController(text: e?.name ?? _preset.name);
    _baseUrl = TextEditingController(text: e?.baseUrl ?? _preset.baseUrl);
    _apiKey = TextEditingController(text: e?.apiKey ?? '');
    _manualModel = TextEditingController();
    _selected = {...?e?.models};
    if (e == null && _preset.defaultModel.isNotEmpty) {
      _selected.add(_preset.defaultModel);
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _baseUrl.dispose();
    _apiKey.dispose();
    _manualModel.dispose();
    super.dispose();
  }

  Future<void> _probe() async {
    if (_apiKey.text.trim().isEmpty || _baseUrl.text.trim().isEmpty) {
      setState(() => _probeError = tr('先填 API 地址和 Key'));
      return;
    }
    setState(() {
      _probing = true;
      _probeError = null;
    });
    try {
      final result = await ref
          .read(byokServiceProvider)
          .probe(
            protocol: _preset.protocol,
            baseUrl: _baseUrl.text,
            apiKey: _apiKey.text,
            providerName: _name.text.trim().isEmpty
                ? _preset.name
                : _name.text.trim(),
            extraHeaders: _preset.extraHeaders,
          );
      if (!mounted) return;
      setState(() {
        _probing = false;
        _probedModels = result.models;
        /* 探活成功但没勾模型 → 自动勾 preset 默认或列表第一个 */
        if (_selected.isEmpty) {
          if (_preset.defaultModel.isNotEmpty) {
            _selected.add(_preset.defaultModel);
          } else if (result.models.isNotEmpty) {
            _selected.add(result.models.first);
          }
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _probing = false;
        _probeError = friendlyError(e, fallback: tr('验证失败，请检查地址和 Key'));
      });
    }
  }

  Future<void> _save() async {
    final store = ref.read(byokStoreProvider.notifier);
    final name = _name.text.trim().isEmpty ? _preset.name : _name.text.trim();
    final models = _selected.toList();
    if (models.isEmpty) {
      setState(() => _probeError = tr('至少选一个模型'));
      return;
    }
    if (_isEditing) {
      await store.update(
        widget.editing!.copyWith(
          name: name,
          baseUrl: _baseUrl.text,
          apiKey: _apiKey.text.trim(),
          models: models,
        ),
      );
    } else {
      await store.add(
        name: name,
        protocol: _preset.protocol,
        baseUrl: _baseUrl.text,
        apiKey: _apiKey.text,
        models: models,
        extraHeaders: _preset.extraHeaders,
      );
    }
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('删除这个厂商?')),
        content: Text(tr('「${widget.editing!.name}」的 Key 和模型配置将从手机移除。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('取消')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(tr('删除')),
          ),
        ],
      ),
    );
    if (ok == true && mounted) {
      await ref.read(byokStoreProvider.notifier).remove(widget.editing!.id);
      if (mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    /* 模型可选列表 = 探活结果 ∪ 已勾选 (手动加的也显示).
     * 已勾选永远置顶显示; 其余按过滤词截前 N 个. */
    final filter = _modelFilter.trim().toLowerCase();
    final unselected = _probedModels
        .where((m) => !_selected.contains(m))
        .where((m) => filter.isEmpty || m.toLowerCase().contains(filter))
        .take(_kMaxModelChips)
        .toList();
    final candidates = <String>[..._selected, ...unselected];
    final hiddenCount =
        _probedModels
            .where((m) => !_selected.contains(m))
            .where((m) => filter.isEmpty || m.toLowerCase().contains(filter))
            .length -
        unselected.length;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      maxChildSize: 0.95,
      builder: (context, scrollCtrl) => ListView(
        controller: scrollCtrl,
        padding: const EdgeInsets.fromLTRB(
          NeoxSpace.xl,
          0,
          NeoxSpace.xl,
          NeoxSpace.xl,
        ),
        children: [
          Text(
            _isEditing ? tr('编辑「${widget.editing!.name}」') : tr('接入 ${_preset.name}'),
            style: theme.textTheme.titleLarge,
          ),
          const SizedBox(height: NeoxSpace.md),

          /* 厂商切换 (仅新增时) */
          if (!_isEditing) ...[
            SizedBox(
              height: 36,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: kByokPresets.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final p = kByokPresets[i];
                  final selected = p.presetId == _preset.presetId;
                  return ChoiceChip(
                    label: Text(p.name, style: const TextStyle(fontSize: 13)),
                    selected: selected,
                    onSelected: (_) => setState(() {
                      _preset = p;
                      _name.text = p.name;
                      _baseUrl.text = p.baseUrl;
                      _probedModels = const [];
                      _probeError = null;
                      _selected
                        ..clear()
                        ..addAll([
                          if (p.defaultModel.isNotEmpty) p.defaultModel,
                        ]);
                    }),
                  );
                },
              ),
            ),
            const SizedBox(height: NeoxSpace.md),
          ],

          TextField(
            controller: _baseUrl,
            decoration: InputDecoration(
              labelText: tr('API 地址'),
              hintText: 'https://…',
            ),
            keyboardType: TextInputType.url,
            autocorrect: false,
          ),
          const SizedBox(height: NeoxSpace.md),
          TextField(
            controller: _apiKey,
            decoration: InputDecoration(
              labelText: 'API Key',
              hintText: 'sk-…',
              suffixIcon: _probing
                  ? const Padding(
                      padding: EdgeInsets.all(12),
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : IconButton(
                      icon: const Icon(Icons.wifi_tethering, size: 18),
                      tooltip: tr('验证连通'),
                      onPressed: _probe,
                    ),
            ),
            obscureText: true,
            autocorrect: false,
          ),
          if (_preset.keyUrl != null) ...[
            const SizedBox(height: NeoxSpace.xs),
            Text(
              tr('在厂商控制台创建 Key: ${_preset.keyUrl}'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
          if (_probeError != null) ...[
            const SizedBox(height: NeoxSpace.sm),
            Text(
              _probeError!,
              style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
            ),
          ],
          if (_probedModels.isNotEmpty) ...[
            const SizedBox(height: NeoxSpace.sm),
            Row(
              children: [
                Icon(Icons.check_circle, size: 14, color: scheme.primary),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    /* 诚实文案: 部分厂商 (OpenRouter 等) /models 端点不验 key,
                     * 探活通过 ≠ Key 有效 — 别给用户"绿勾=能聊"的错误暗示 */
                    tr('地址连通 · 返回 ${_probedModels.length} 个模型 · Key 有效性以首次对话为准'),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.primary,
                    ),
                    maxLines: 2,
                  ),
                ),
              ],
            ),
          ],

          const SizedBox(height: NeoxSpace.lg),
          Text(tr('模型'), style: theme.textTheme.titleSmall),
          const SizedBox(height: NeoxSpace.sm),
          /* 探活返回多 (OpenRouter 344 个) 时给搜索框, 不然滚不完 */
          if (_probedModels.length > _kMaxModelChips) ...[
            TextField(
              decoration: InputDecoration(
                labelText: tr('搜索模型'),
                hintText: 'e.g. gpt / claude / gemini',
                prefixIcon: Icon(Icons.search, size: 18),
                isDense: true,
              ),
              autocorrect: false,
              onChanged: (v) => setState(() => _modelFilter = v),
            ),
            const SizedBox(height: NeoxSpace.sm),
          ],
          if (candidates.isEmpty)
            Text(
              _probedModels.isEmpty
                  ? tr('点上方验证按钮自动拉厂商模型列表，或手动输入模型 id。')
                  : tr('没有匹配「$_modelFilter」的模型'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            )
          else ...[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final m in candidates)
                  FilterChip(
                    label: Text(m, style: const TextStyle(fontSize: 13)),
                    selected: _selected.contains(m),
                    onSelected: (v) => setState(() {
                      if (v) {
                        _selected.add(m);
                      } else {
                        _selected.remove(m);
                      }
                    }),
                  ),
              ],
            ),
            if (hiddenCount > 0)
              Padding(
                padding: const EdgeInsets.only(top: NeoxSpace.sm),
                child: Text(
                  tr('还有 $hiddenCount 个 — 用搜索缩小范围'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
          const SizedBox(height: NeoxSpace.sm),
          TextField(
            controller: _manualModel,
            decoration: InputDecoration(
              labelText: tr('手动添加模型 id'),
              hintText: 'e.g. gpt-4o-mini',
              suffixIcon: IconButton(
                icon: const Icon(Icons.add, size: 18),
                onPressed: () {
                  final m = _manualModel.text.trim();
                  if (m.isEmpty) return;
                  setState(() {
                    _selected.add(m);
                    _manualModel.clear();
                  });
                },
              ),
            ),
            autocorrect: false,
          ),

          const SizedBox(height: NeoxSpace.lg),
          TextField(
            controller: _name,
            decoration: InputDecoration(labelText: tr('显示名称')),
          ),
          const SizedBox(height: NeoxSpace.xl),
          FilledButton(
            onPressed: _probing ? null : _save,
            child: Text(_isEditing ? tr('保存') : tr('添加')),
          ),
          if (_isEditing) ...[
            const SizedBox(height: NeoxSpace.sm),
            TextButton(
              onPressed: _delete,
              style: TextButton.styleFrom(foregroundColor: scheme.error),
              child: Text(tr('删除这个厂商')),
            ),
          ],
        ],
      ),
    );
  }
}
