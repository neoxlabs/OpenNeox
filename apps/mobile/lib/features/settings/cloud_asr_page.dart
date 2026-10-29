/// 设置 → 语音 → 识别服务 (二级页): 选服务商、填 Key、测一下、保存。
///
/// 表单是「标签 + 无边框输入」的一行式 (每行 48 高), 不用 Material 的浮动标签大框 ——
/// 2026-09-29 用户: 「组件不要大只尤其输入框, 好用才是重点」。
/// 服务商各存一份, 切过去自动带出上次填的, 没填过就是预设的地址和默认模型。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/voice/cloud_asr.dart';
import '../../core/voice/voice_settings.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class CloudAsrPage extends ConsumerStatefulWidget {
  const CloudAsrPage({super.key});
  @override
  ConsumerState<CloudAsrPage> createState() => _CloudAsrPageState();
}

class _CloudAsrPageState extends ConsumerState<CloudAsrPage> {
  final _key = TextEditingController();
  final _model = TextEditingController();
  final _base = TextEditingController();
  String _provider = '';
  CloudAsrProtocol _protocol = CloudAsrProtocol.transcriptions;
  bool _showKey = false;
  bool _testing = false;
  bool _saving = false;
  /* 测试结果: null = 没测; ok=true 显示耗时, ok=false 显示原因 */
  ({bool ok, String text})? _result;

  @override
  void initState() {
    super.initState();
    final ctl = ref.read(voiceSettingsProvider.notifier);
    ctl.ready.then((_) {
      if (!mounted) return;
      _select(ref.read(voiceSettingsProvider).cloud.provider);
    });
  }

  @override
  void dispose() {
    _key.dispose();
    _model.dispose();
    _base.dispose();
    super.dispose();
  }

  void _select(String provider) {
    final c = ref.read(voiceSettingsProvider).configFor(provider);
    setState(() {
      _provider = provider;
      _key.text = c.apiKey;
      _model.text = c.model;
      _base.text = c.baseUrl;
      _protocol = c.protocol;
      _result = null;
    });
  }

  CloudAsrConfig get _draft => CloudAsrConfig(
        provider: _provider,
        baseUrl: _base.text.trim(),
        apiKey: _key.text.trim(),
        model: _model.text.trim(),
        protocol: _protocol,
      );

  String? get _missing {
    final d = _draft;
    if (d.apiKey.isEmpty) return tr('先填 API Key');
    if (d.model.isEmpty) return tr('先填模型');
    if (d.baseUrl.isEmpty) return tr('先填接口地址');
    return null;
  }

  Future<void> _test() async {
    final miss = _missing;
    if (miss != null) {
      setState(() => _result = (ok: false, text: miss));
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _testing = true;
      _result = null;
    });
    try {
      final ms = await CloudAsr.test(_draft);
      if (mounted) setState(() => _result = (ok: true, text: tr('连接正常 · $ms ms')));
    } catch (e) {
      final msg = e is StateError ? e.message : '$e';
      if (mounted) setState(() => _result = (ok: false, text: msg));
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _save() async {
    final miss = _missing;
    if (miss != null) {
      setState(() => _result = (ok: false, text: miss));
      return;
    }
    setState(() => _saving = true);
    final ctl = ref.read(voiceSettingsProvider.notifier);
    await ctl.setCloud(_draft);
    await ctl.setEngine(VoiceEngine.cloud);
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('已保存，语音改用云端识别'))));
    Navigator.of(context).maybePop();
  }

  Future<void> _pickModel(CloudAsrPreset p) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final m in p.models)
              ListTile(
                dense: true,
                title: Text(m, style: const TextStyle(fontSize: 15)),
                trailing: m == _model.text.trim()
                    ? Icon(Icons.check, size: 18, color: Theme.of(c).colorScheme.primary)
                    : null,
                onTap: () => Navigator.pop(c, m),
              ),
            const SizedBox(height: NeoxSpace.sm),
          ],
        ),
      ),
    );
    if (picked != null) setState(() => _model.text = picked);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(voiceSettingsProvider);
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (!s.loaded || _provider.isEmpty) {
      return SettingsFrame(title: tr('识别服务'), body: const SizedBox.shrink());
    }
    final preset = cloudAsrPreset(_provider);
    final isCustom = preset.id == kCustomAsrPresetId;
    final muted = TextStyle(fontSize: 13, color: scheme.onSurfaceVariant);
    final iconBtn = IconButton.styleFrom(
      minimumSize: const Size(36, 36),
      padding: EdgeInsets.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );

    return SettingsFrame(
      title: tr('识别服务'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: NeoxSpace.xl),
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        children: [
          SettingsGroup(
            title: tr('服务商'),
            children: [
              for (final p in kCloudAsrPresets)
                _ProviderRow(
                  name: tr(p.name),
                  detail: p.id == kCustomAsrPresetId
                      ? tr('OpenAI 兼容接口')
                      : (s.saved[p.id]?.apiKey.isNotEmpty ?? false)
                          ? tr('已填 Key')
                          : (p.models.isEmpty ? '' : p.models.first),
                  selected: p.id == _provider,
                  inUse: s.engine == VoiceEngine.cloud && s.cloud.provider == p.id && s.cloud.ready,
                  onTap: () => _select(p.id),
                ),
            ],
          ),
          SettingsGroup(
            title: tr('连接'),
            children: [
              _FieldRow(
                label: 'Key',
                child: TextField(
                  controller: _key,
                  obscureText: !_showKey,
                  autocorrect: false,
                  enableSuggestions: false,
                  style: const TextStyle(fontSize: 15),
                  decoration: _bare('sk-…', muted),
                  onChanged: (_) => setState(() => _result = null),
                ),
                trailing: [
                  IconButton(
                    style: iconBtn,
                    iconSize: 18,
                    tooltip: tr('粘贴'),
                    icon: Icon(Icons.content_paste, color: scheme.onSurfaceVariant),
                    onPressed: () async {
                      final d = await Clipboard.getData(Clipboard.kTextPlain);
                      final t = d?.text?.trim() ?? '';
                      if (t.isNotEmpty) setState(() => _key.text = t);
                    },
                  ),
                  IconButton(
                    style: iconBtn,
                    iconSize: 18,
                    icon: Icon(
                      _showKey ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                      color: scheme.onSurfaceVariant,
                    ),
                    onPressed: () => setState(() => _showKey = !_showKey),
                  ),
                ],
              ),
              _FieldRow(
                label: tr('模型'),
                child: TextField(
                  controller: _model,
                  autocorrect: false,
                  style: const TextStyle(fontSize: 15),
                  decoration: _bare('whisper-1', muted),
                ),
                trailing: [
                  if (preset.models.length > 1)
                    IconButton(
                      style: iconBtn,
                      iconSize: 20,
                      icon: Icon(Icons.expand_more, color: scheme.onSurfaceVariant),
                      onPressed: () => _pickModel(preset),
                    ),
                ],
              ),
              _FieldRow(
                label: tr('地址'),
                child: TextField(
                  controller: _base,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  style: TextStyle(fontSize: isCustom ? 15 : 13, color: isCustom ? null : scheme.onSurfaceVariant),
                  decoration: _bare('https://…/v1', muted),
                ),
                trailing: [
                  if (!isCustom && _base.text.trim() != preset.baseUrl)
                    IconButton(
                      style: iconBtn,
                      iconSize: 18,
                      tooltip: tr('恢复默认'),
                      icon: Icon(Icons.restart_alt, color: scheme.onSurfaceVariant),
                      onPressed: () => setState(() => _base.text = preset.baseUrl),
                    ),
                ],
              ),
              if (isCustom)
                _FieldRow(
                  label: tr('接口'),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: SegmentedButton<CloudAsrProtocol>(
                      showSelectedIcon: false,
                      style: SegmentedButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        textStyle: const TextStyle(fontSize: 13),
                      ),
                      segments: [
                        ButtonSegment(value: CloudAsrProtocol.transcriptions, label: Text(tr('转写'))),
                        ButtonSegment(value: CloudAsrProtocol.chatAudio, label: Text(tr('聊天音频'))),
                      ],
                      selected: {_protocol},
                      onSelectionChanged: (v) => setState(() => _protocol = v.first),
                    ),
                  ),
                ),
            ],
          ),
          if (preset.keyUrl != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, 0, NeoxSpace.xl, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  icon: const Icon(Icons.open_in_new, size: 14),
                  label: Text(tr('去${tr(preset.name)}拿 Key'), style: const TextStyle(fontSize: 13)),
                  onPressed: () => launchUrl(Uri.parse(preset.keyUrl!), mode: LaunchMode.externalApplication),
                ),
              ),
            ),
          if (_result != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, NeoxSpace.sm, NeoxSpace.xl, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    _result!.ok ? Icons.check_circle : Icons.error_outline,
                    size: 16,
                    color: _result!.ok ? Colors.green : scheme.error,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _result!.text,
                      style: TextStyle(fontSize: 13, color: _result!.ok ? scheme.onSurface : scheme.error),
                    ),
                  ),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.md, NeoxSpace.xl, 0),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(40)),
                    onPressed: _testing ? null : _test,
                    child: _testing
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(tr('测试')),
                  ),
                ),
                const SizedBox(width: NeoxSpace.sm),
                Expanded(
                  child: FilledButton(
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(40)),
                    onPressed: _saving ? null : _save,
                    child: Text(tr('保存并使用')),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 无边框输入。InputDecoration.collapsed 挡不住主题的 inputDecorationTheme (渲染台实拍: 每个输入
/// 还套着一圈圆角描边), 这里把边框 / 填充全部显式关掉。
InputDecoration _bare(String hint, TextStyle hintStyle) => InputDecoration(
      isCollapsed: true,
      hintText: hint,
      hintStyle: hintStyle,
      filled: false,
      contentPadding: const EdgeInsets.symmetric(vertical: 12),
      border: InputBorder.none,
      enabledBorder: InputBorder.none,
      focusedBorder: InputBorder.none,
      disabledBorder: InputBorder.none,
    );

/// 服务商一行: 名字 + 右侧小字 (默认模型 / 已填 Key) + 选中勾; 在用的那家标「在用」
class _ProviderRow extends StatelessWidget {
  const _ProviderRow({
    required this.name,
    required this.detail,
    required this.selected,
    required this.inUse,
    required this.onTap,
  });
  final String name;
  final String detail;
  final bool selected;
  final bool inUse;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 46,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.lg),
          child: Row(
            children: [
              SizedBox(
                width: 22,
                child: selected ? Icon(Icons.check, size: 18, color: scheme.primary) : null,
              ),
              const SizedBox(width: NeoxSpace.md),
              Text(name, style: TextStyle(fontSize: 15, fontWeight: selected ? FontWeight.w600 : null)),
              if (inUse) ...[
                const SizedBox(width: 8),
                SettingsTag(label: tr('在用'), color: scheme.primary),
              ],
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  detail,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 表单一行: 左边固定宽的标签, 右边无边框输入, 再右边几个小图标按钮
class _FieldRow extends StatelessWidget {
  const _FieldRow({required this.label, required this.child, this.trailing = const []});
  final String label;
  final Widget child;
  final List<Widget> trailing;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Padding(
        padding: const EdgeInsets.only(left: NeoxSpace.lg, right: NeoxSpace.sm),
        child: Row(
          children: [
            SizedBox(
              width: 56,
              child: Text(label, style: TextStyle(fontSize: 14, color: scheme.onSurfaceVariant)),
            ),
            Expanded(child: child),
            ...trailing,
          ],
        ),
      ),
    );
  }
}
