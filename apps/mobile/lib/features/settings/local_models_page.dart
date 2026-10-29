/// 我的模型 → 本地部署: 这台手机能跑什么 + 搜索 / 下载 (可暂停、断点续传) / 删除 / 用它聊天。
///
/// 顶部先报这台机器的底子 (芯片 / 内存 / 剩余空间 / 推理方式), 然后是搜索框和目录。
/// 搜索框先筛本地目录; 目录里没有就「在线搜索」HuggingFace 上的 GGUF (走 hf-mirror, 国内能直连),
/// 挑一个文件加进来, 下载时仍先试 ModelScope。
/// 每个模型按这台机器标「推荐」或「可能较慢」—— 不拦着下, 但下之前心里有数。
library;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/local_llm/device_profile.dart';
import '../../core/local_llm/litert_engine.dart';
import '../../core/local_llm/local_llm_engine.dart';
import '../../core/local_llm/local_model_catalog.dart';
import '../../core/models/model_store.dart';
import '../../core/startup/setup_readiness.dart';
import '../../shared/theme/neox_tokens.dart';
import '../home/state/selected_model_provider.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

final _deviceProfileProvider = FutureProvider<DeviceProfile>((ref) => detectDeviceProfile());
final _backendPrefProvider = FutureProvider<LlmBackendPref>((ref) => loadBackendPref());
final _runStatsProvider = FutureProvider.family<LlmRunStats?, String>((ref, id) => loadRunStats(id));

class LocalModelsPage extends ConsumerStatefulWidget {
  const LocalModelsPage({super.key});
  @override
  ConsumerState<LocalModelsPage> createState() => _LocalModelsPageState();
}

class _LocalModelsPageState extends ConsumerState<LocalModelsPage> {
  final _search = TextEditingController();
  String _q = '';

  @override
  void initState() {
    super.initState();
    _refreshAll();
  }

  Future<void> _refreshAll() async {
    await loadCustomLocalLlms();
    final store = ref.read(modelStoreProvider.notifier);
    for (final m in kLocalLlms) {
      await store.refresh(m.pack);
    }
    for (final m in kRetiredLocalLlms) {
      await LocalLlmEngine.instance.unloadIf(m.id);
      await store.delete(m.pack);
    }
    ref.invalidate(_runStatsProvider);
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _openOnlineSearch() async {
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _OnlineSearchSheet(initialQuery: _q),
    );
    if (added == true) await _refreshAll();
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(_deviceProfileProvider);
    final theme = Theme.of(context);
    final needle = _q.trim().toLowerCase();
    final p = profile.valueOrNull;
    final pref = ref.watch(_backendPrefProvider).valueOrNull ?? LlmBackendPref.auto;
    /* 这台机器用不了的不列: 别的芯片的 NPU 版 / 没 OpenCL 时的 GPU 版 (配置还没读出来时 NPU 版先不列) */
    final list = kLocalLlms
        .where((m) => p == null ? !m.isNpu : m.availableOn(p))
        .where((m) =>
            needle.isEmpty ||
            m.name.toLowerCase().contains(needle) ||
            m.repo.toLowerCase().contains(needle) ||
            m.params.toLowerCase().contains(needle))
        .toList();
    Future<void> setPref(LlmBackendPref v) async {
      await saveBackendPref(v);
      ref.invalidate(_backendPrefProvider);
    }

    Widget prefRow(LlmBackendPref v, IconData icon, String title, String sub) => SettingsRow(
          leading: icon,
          title: title,
          subtitle: sub,
          trailing: pref == v ? Icon(Icons.check, color: theme.colorScheme.primary, size: 20) : null,
          onTap: () => setPref(v),
        );
    return SettingsFrame(
      title: tr('本地部署'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: NeoxSpace.xl),
        children: [
          profile.when(
            data: (p) => _DeviceCard(profile: p),
            loading: () => const Padding(
              padding: EdgeInsets.all(NeoxSpace.xl),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (e, _) => SettingsSurface(child: Text(tr('读不到这台手机的配置：$e'))),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.sm, NeoxSpace.xl, 0),
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                hintText: tr('搜索模型，比如 qwen、gemma、coder'),
                prefixIcon: const Icon(Icons.search, size: 20),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onChanged: (v) => setState(() => _q = v),
              onSubmitted: (_) {
                if (list.isEmpty) _openOnlineSearch();
              },
            ),
          ),
          SettingsGroup(
            title: tr('模型'),
            children: [
              for (final m in list) _LocalModelRow(model: m, profile: profile.valueOrNull, onRemoved: _refreshAll),
              if (list.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(NeoxSpace.lg),
                  child: Text(tr('目录里没有「${_q.trim()}」'), style: theme.textTheme.bodyMedium),
                ),
              SettingsRow(
                leading: Icons.travel_explore,
                title: needle.isEmpty ? tr('在线搜索更多模型') : tr('在线搜索「${_q.trim()}」'),
                showChevron: true,
                onTap: _openOnlineSearch,
              ),
            ],
          ),
          if (p != null && p.gpu)
            SettingsGroup(
              title: tr('推理加速'),
              children: [
                prefRow(LlmBackendPref.auto, Icons.auto_awesome_outlined, tr('自动（推荐）'), tr('GPU 优先，起不来用 CPU')),
                prefRow(LlmBackendPref.gpu, Icons.bolt_outlined, 'GPU', tr('只用 GPU')),
                prefRow(LlmBackendPref.cpu, Icons.memory_outlined, 'CPU', tr('最稳，较慢')),
              ],
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.xs, NeoxSpace.xl, 0),
            child: Text(
              tr('来自 ModelScope / HuggingFace，下载后不联网也能聊。只能聊天，不能用工具。'),
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({required this.profile});
  final DeviceProfile profile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final rec = recommendedLocalLlm(profile);
    final tierLabel = switch (profile.tier) {
      DeviceTier.flagship => tr('旗舰'),
      DeviceTier.mid => tr('中高端'),
      DeviceTier.entry => tr('入门'),
    };
    Widget stat(String label, String value) => Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(value, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text(label, style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
            ],
          ),
        );
    return SettingsSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.memory, color: scheme.primary),
              const SizedBox(width: NeoxSpace.sm),
              Expanded(
                child: Text(
                  profile.socName,
                  style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              SettingsTag(label: tierLabel, color: scheme.primary),
            ],
          ),
          const SizedBox(height: NeoxSpace.md),
          Row(
            children: [
              stat(tr('内存'), '${profile.ramGb.toStringAsFixed(profile.ramGb < 10 ? 1 : 0)} GB'),
              stat(tr('剩余空间'), formatBytes(profile.freeDiskBytes)),
              stat(tr('加速'), profile.accelSummary),
            ],
          ),
          const SizedBox(height: NeoxSpace.md),
          Text(
            !profile.canRunLocalLlm
                ? tr('这台手机跑不了本地模型（需要 64 位、4GB 以上内存）')
                : rec == null
                    ? tr('这台手机只适合最小的模型')
                    : tr('推荐 ${rec.name}'),
            style: theme.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _LocalModelRow extends ConsumerWidget {
  const _LocalModelRow({required this.model, required this.profile, required this.onRemoved});
  final LocalLlm model;
  final DeviceProfile? profile;
  final Future<void> Function() onRemoved;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final st = ref.watch(modelStatusProvider(model.pack));
    final store = ref.read(modelStoreProvider.notifier);
    final chatModel = ref.watch(chatModelProvider);
    final inUse = chatModel == model.modelId;
    final p = profile;
    final isRec = p != null && recommendedLocalLlm(p)?.id == model.id;
    final tooBig = p != null && !model.fits(p);
    final remaining = model.size - st.received;
    final noSpace = p != null && !st.installed && p.freeDiskBytes > 0 && p.freeDiskBytes < remaining + (500 << 20);

    Future<void> use({bool explicit = true}) async {
      ref.read(chatModelProvider.notifier).set(model.modelId, explicitLocal: explicit);
      ref.invalidate(selectedModelProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('对话默认用 ${model.name}'))));
      }
    }

    Future<void> download({bool resume = false}) async {
      if (tooBig && !resume) {
        final go = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            content: Text(tr('${model.name} 对这台手机偏大，能跑但可能很慢、发烫。还要下载吗？')),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
              TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('下载'))),
            ],
          ),
        );
        if (go != true) return;
      }
      /* 动辄 1~5GB, 没连 Wi-Fi 时先问一句 */
      final net = await Connectivity().checkConnectivity();
      final onWifi = net.contains(ConnectivityResult.wifi) || net.contains(ConnectivityResult.ethernet);
      if (!onWifi && context.mounted) {
        final go = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            content: Text(tr('现在没连 Wi-Fi，下载 ${model.name} 要用 ${formatBytes(remaining)} 流量。继续吗？')),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
              TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('用流量下载'))),
            ],
          ),
        );
        if (go != true) return;
      }
      await store.download(model.pack);
      /* 下完、对话**没有别的模型可用**时 (没登录也没填 Key), 直接设成对话默认 —— 下完就能聊。
       * 以前条件是「没选过 || 没账号没 Key」: 订阅用户没手动选过模型时前半句就成立, 下个本机模型
       * 对话默认就被换成它 —— 270M 的小模型答两句就挂, 用户以为整个产品不能用 (2026-10-05 真机)。 */
      if (ref.read(modelStatusProvider(model.pack)).installed) {
        final r = ref.read(setupReadinessProvider);
        final chosen = ref.read(chatModelProvider);
        if (!r.hasAccount && !r.hasOwnKey && localLlmForModelId(chosen) == null) {
          await use(explicit: false);
        }
      }
    }

    Future<void> remove() async {
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          content: Text(
            model.custom && !st.installed
                ? tr('从列表移除 ${model.name}？')
                : tr('删除 ${model.name}？释放 ${formatBytes(st.installed ? model.size : st.received)}'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
            TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('删除'))),
          ],
        ),
      );
      if (ok != true) return;
      await LocalLlmEngine.instance.unloadIf(model.id);
      await store.delete(model.pack);
      if (inUse) {
        ref.read(chatModelProvider.notifier).set('');
        ref.invalidate(selectedModelProvider);
      }
      if (model.custom) {
        await removeCustomLocalLlm(model.id);
        await onRemoved();
      }
    }

    final deleteBtn = IconButton(icon: const Icon(Icons.delete_outline), tooltip: tr('删除'), onPressed: remove);
    /* 跑过就显示实测 (实际后端 + 生成速度), 没跑过显示它走什么加速 */
    final stats = ref.watch(_runStatsProvider(model.id)).valueOrNull;
    final speed = stats?.label ?? model.accelLabel;
    String sub;
    Widget trailing;
    switch (st.phase) {
      case ModelPhase.installed:
        sub = '${formatBytes(model.size)} · $speed · ${tr(model.blurb.isEmpty ? model.repo : model.blurb)}';
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            inUse
                ? SettingsTag(label: tr('对话在用'), color: scheme.primary)
                : TextButton(onPressed: use, child: Text(tr('用它聊天'))),
            deleteBtn,
          ],
        );
      case ModelPhase.downloading:
        final total = st.total > 0 ? st.total : model.size;
        sub = '${formatBytes(st.received)} / ${formatBytes(total)}';
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5, value: st.progress == 0 ? null : st.progress),
            ),
            IconButton(icon: const Icon(Icons.pause), tooltip: tr('暂停'), onPressed: () => store.pause(model.pack)),
          ],
        );
      case ModelPhase.paused:
        sub = tr('已暂停 · ${formatBytes(st.received)} / ${formatBytes(model.size)}');
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton(onPressed: noSpace ? null : () => download(resume: true), child: Text(tr('继续'))),
            deleteBtn,
          ],
        );
      case ModelPhase.failed:
        sub = st.error ?? tr('下载失败');
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton(onPressed: () => download(resume: true), child: Text(tr('重试'))),
            if (st.received > 0 || model.custom) deleteBtn,
          ],
        );
      case ModelPhase.notInstalled:
        sub = '${formatBytes(model.size)} · ${model.accelLabel} · ${tr(model.blurb.isEmpty ? model.repo : model.blurb)}';
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton(onPressed: noSpace ? null : download, child: Text(noSpace ? tr('空间不够') : tr('下载'))),
            if (model.custom) deleteBtn,
          ],
        );
    }

    return SettingsRow(
      leading: model.custom ? Icons.cloud_download_outlined : Icons.smart_toy_outlined,
      title: model.name,
      subtitle: sub,
      tag: isRec ? tr('推荐') : (tooBig ? tr('可能较慢') : null),
      tagColor: isRec ? scheme.primary : scheme.error,
      trailing: DefaultTextStyle.merge(style: theme.textTheme.labelLarge, child: trailing),
    );
  }
}

/* ── 在线搜索 (HuggingFace GGUF, 经 hf-mirror) ─────────────────────────── */

const String _kHfApi = 'https://hf-mirror.com/api';

class _HfRepo {
  const _HfRepo(this.id, this.downloads);
  final String id;
  final int downloads;
}

class _HfFile {
  const _HfFile(this.path, this.size, this.sha256);
  final String path;
  final int size;
  final String? sha256;
}

class _OnlineSearchSheet extends StatefulWidget {
  const _OnlineSearchSheet({required this.initialQuery});
  final String initialQuery;
  @override
  State<_OnlineSearchSheet> createState() => _OnlineSearchSheetState();
}

class _OnlineSearchSheetState extends State<_OnlineSearchSheet> {
  final _dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 12), receiveTimeout: const Duration(seconds: 20)));
  late final _q = TextEditingController(text: widget.initialQuery);
  List<_HfRepo>? _repos;
  String? _openRepo;
  List<_HfFile>? _files;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    if (_q.text.trim().isNotEmpty) _searchRepos();
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _searchRepos() async {
    final q = _q.text.trim();
    if (q.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _openRepo = null;
      _files = null;
    });
    try {
      final r = await _dio.get<List<dynamic>>('$_kHfApi/models', queryParameters: {
        'search': q,
        'filter': 'gguf',
        'sort': 'downloads',
        'direction': '-1',
        'limit': '30',
      });
      _repos = [
        for (final m in (r.data ?? const []).whereType<Map>())
          _HfRepo(m['id'] as String, (m['downloads'] as num?)?.toInt() ?? 0),
      ];
    } catch (_) {
      _error = tr('搜不到，检查网络后重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openRepoFiles(String repo) async {
    setState(() {
      _busy = true;
      _error = null;
      _openRepo = repo;
      _files = null;
    });
    try {
      final r = await _dio.get<List<dynamic>>('$_kHfApi/models/$repo/tree/main');
      final files = <_HfFile>[
        for (final f in (r.data ?? const []).whereType<Map>())
          if ((f['path'] as String).toLowerCase().endsWith('.gguf') &&
              !(f['path'] as String).toLowerCase().contains('mmproj'))
            _HfFile(
              f['path'] as String,
              (f['size'] as num?)?.toInt() ?? 0,
              (f['lfs'] is Map) ? (f['lfs'] as Map)['oid'] as String? : null,
            ),
      ];
      /* 手机上最合适的放前面: Q4_K_M → 其它 Q4 → 其余按大小 */
      int rank(_HfFile f) {
        final p = f.path.toLowerCase();
        if (p.contains('q4_k_m')) return 0;
        if (p.contains('q4')) return 1;
        return 2;
      }
      files.sort((a, b) => rank(a) != rank(b) ? rank(a) - rank(b) : a.size - b.size);
      _files = files;
      if (files.isEmpty) _error = tr('这个仓库里没有单文件的 GGUF');
    } catch (_) {
      _error = tr('读不到文件列表，检查网络后重试');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _add(String repo, _HfFile f) async {
    final base = f.path.split('/').last.replaceAll(RegExp(r'\.gguf$', caseSensitive: false), '');
    final id = 'hf-${repo.replaceAll('/', '--')}--$base'.toLowerCase().replaceAll(RegExp(r'[^a-z0-9._-]'), '-');
    final req = estimateRequirement(f.size);
    final lower = base.toLowerCase();
    await addCustomLocalLlm(LocalLlm(
      id: id,
      name: base,
      params: RegExp(r'(\d+(\.\d+)?)b', caseSensitive: false).firstMatch(base)?.group(0)?.toUpperCase() ?? '',
      repo: repo,
      file: f.path,
      size: f.size,
      sha256: f.sha256,
      /* 模板: 认得出的给名字, 认不出交给插件按文件名猜 */
      template: lower.contains('gemma')
          ? 'gemma'
          : (lower.contains('qwen') || lower.contains('smollm'))
              ? 'chatml'
              : null,
      minTier: req.tier,
      minRamGb: req.ramGb,
      hybridThinking: lower.contains('qwen3') && !lower.contains('instruct'),
      custom: true,
    ));
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.8,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Row(
                children: [
                  if (_openRepo != null)
                    IconButton(
                      icon: const Icon(Icons.arrow_back),
                      onPressed: () => setState(() {
                        _openRepo = null;
                        _files = null;
                        _error = null;
                      }),
                    ),
                  Expanded(
                    child: _openRepo != null
                        ? Text(_openRepo!, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis)
                        : TextField(
                            controller: _q,
                            autofocus: _q.text.isEmpty,
                            textInputAction: TextInputAction.search,
                            decoration: InputDecoration(
                              isDense: true,
                              hintText: tr('在 HuggingFace 搜 GGUF 模型'),
                              prefixIcon: const Icon(Icons.search, size: 20),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                            ),
                            onSubmitted: (_) => _searchRepos(),
                          ),
                  ),
                ],
              ),
            ),
            if (_busy) const LinearProgressIndicator(minHeight: 2),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(20),
                child: Text(_error!, style: TextStyle(color: scheme.error)),
              ),
            Expanded(
              child: _openRepo == null
                  ? ListView(
                      children: [
                        for (final r in _repos ?? const <_HfRepo>[])
                          ListTile(
                            title: Text(r.id, maxLines: 1, overflow: TextOverflow.ellipsis),
                            subtitle: Text(tr('${_compact(r.downloads)} 次下载')),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _openRepoFiles(r.id),
                          ),
                        if (_repos != null && _repos!.isEmpty && !_busy)
                          Padding(padding: const EdgeInsets.all(20), child: Text(tr('没搜到带 GGUF 的模型'))),
                      ],
                    )
                  : ListView(
                      children: [
                        for (final f in _files ?? const <_HfFile>[])
                          ListTile(
                            title: Text(f.path.split('/').last, maxLines: 2, overflow: TextOverflow.ellipsis),
                            subtitle: Text(formatBytes(f.size)),
                            trailing: FilledButton.tonal(
                              onPressed: () => _add(_openRepo!, f),
                              child: Text(tr('添加')),
                            ),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  static String _compact(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return '$n';
  }
}
