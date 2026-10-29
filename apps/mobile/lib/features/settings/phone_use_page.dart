/// 设置 → Phone Use (2026-10-12): Agent 在手机上替你看 / 点别的 App。
///
/// 一页三块: 要开的两个系统权限 (无障碍 = 读屏和点按, 通知使用权 = 实时收消息) · 能碰哪些 App · 硬规矩。
/// 名单存 PhoneUsePolicy, 判定在原生 (PhoneToolsBridge.policyBlock)。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/i18n/tr.dart';
import '../../core/local_agent/phone_use_policy.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';

const _ch = MethodChannel('neox.phone/tools');

class PhoneUsePage extends StatefulWidget {
  const PhoneUsePage({super.key});

  @override
  State<PhoneUsePage> createState() => _PhoneUsePageState();
}

class _PhoneUsePageState extends State<PhoneUsePage> with WidgetsBindingObserver {
  PhoneUsePolicy? _p;
  Map<String, String> _names = {}; // 包名 → App 名 (装了的)
  bool _a11y = false;
  bool _notif = false;

  static const _m = EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /* 从系统设置开完权限回来, 状态跟着刷新 */
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _refreshStatus();
  }

  Future<void> _load() async {
    final p = await PhoneUsePolicy.load();
    final apps = await _ch.invokeMethod<List>('apps', {'query': '', 'all': true}).catchError((_) => null) ?? const [];
    if (!mounted) return;
    setState(() {
      _p = p;
      _names = {for (final a in apps) if (a is Map) '${a['package']}': '${a['name']}'};
    });
    await _refreshStatus();
  }

  Future<void> _refreshStatus() async {
    final st = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    if (!mounted || st == null) return;
    setState(() {
      _a11y = st['accessibility'] == true;
      _notif = st['notifications'] == true;
    });
  }

  Future<void> _save(PhoneUsePolicy p) async {
    setState(() => _p = p);
    await p.save();
  }

  String _name(String pkg) => _names[pkg] ?? pkg;

  /* pilot:D-11 批量管理: 一次勾几个, 一起移出。允许名单里装了的/没装的都列出来
   * (没装的那几个在列表页看不见, 只能在这里清掉) */
  Future<void> _batchRemove({required bool deny}) async {
    final p = _p;
    if (p == null) return;
    final list = deny ? p.deny : p.allow;
    if (list.isEmpty) return;
    final picked = await showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _BatchPicker(
        title: deny ? tr('移出禁止名单') : tr('移出允许名单'),
        names: _names,
        packages: list,
      ),
    );
    if (picked == null || picked.isEmpty) return;
    await _save(p.withoutPackages(picked));
  }

  Future<void> _addApp({required bool deny}) async {
    final p = _p;
    if (p == null) return;
    final taken = {...p.allow, ...p.deny};
    final pick = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AppPicker(names: _names, exclude: taken),
    );
    if (pick == null) return;
    await _save(deny ? p.copyWith(deny: [...p.deny, pick]) : p.copyWith(allow: [...p.allow, pick]));
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    final scheme = Theme.of(context).colorScheme;
    return SettingsFrame(
      title: 'Phone Use',
      subtitle: tr('让 Agent 替你看、替你点手机上的 App'),
      body: p == null
          ? const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
          : ListView(
              padding: const EdgeInsets.only(top: NeoxSpace.md, bottom: 40),
              children: [
                SettingsGroup(
                  title: tr('权限'),
                  margin: _m,
                  children: [
                    SettingsRow(
                      clay: 'i-phone',
                      title: tr('无障碍 (读屏和点按)'),
                      subtitle: _a11y ? tr('已开启') : tr('没开: Agent 读不了微信 / QQ, 也点不了别的 App'),
                      trailing: _a11y ? Icon(Icons.check_circle, color: scheme.primary, size: 20) : null,
                      showChevron: !_a11y,
                      onTap: () => _ch.invokeMethod('openAccessibilitySettings'),
                    ),
                    SettingsRow(
                      clay: 'i-mail',
                      title: tr('通知使用权 (实时收消息)'),
                      subtitle: _notif ? tr('已开启') : tr('没开: 新消息来了 Agent 不知道'),
                      trailing: _notif ? Icon(Icons.check_circle, color: scheme.primary, size: 20) : null,
                      showChevron: !_notif,
                      onTap: () => _ch.invokeMethod('openNotificationAccess'),
                    ),
                  ],
                ),
                SettingsGroup(
                  title: tr('能碰哪些 App'),
                  margin: _m,
                  children: [
                    SettingsRow(
                      title: tr('除了禁止名单, 都可以'),
                      trailing: p.mode == 'open' ? Icon(Icons.check, color: scheme.primary, size: 20) : null,
                      onTap: () => _save(p.copyWith(mode: 'open')),
                    ),
                    SettingsRow(
                      title: tr('只许下面名单里的'),
                      trailing: p.mode == 'allowlist' ? Icon(Icons.check, color: scheme.primary, size: 20) : null,
                      onTap: () => _save(p.copyWith(mode: 'allowlist')),
                    ),
                  ],
                ),
                if (p.mode == 'allowlist')
                  SettingsGroup(
                    title: tr('允许名单'),
                    margin: _m,
                    children: [
                      for (final pkg in p.allow)
                        if (_names.containsKey(pkg))
                          SettingsRow(
                            title: _name(pkg),
                            trailing: IconButton(
                              icon: const Icon(Icons.remove_circle_outline, size: 20),
                              tooltip: tr('移出'),
                              onPressed: () => _save(p.copyWith(allow: [...p.allow]..remove(pkg))),
                            ),
                          ),
                      SettingsRow(leading: Icons.add, title: tr('添加 App'), onTap: () => _addApp(deny: false)),
                      if (p.allow.length > 1)
                        SettingsRow(
                          leading: Icons.checklist,
                          title: tr('批量移除…'),
                          subtitle: tr('一次勾几个 App 移出名单'),
                          onTap: () => _batchRemove(deny: false),
                        ),
                    ],
                  ),
                SettingsGroup(
                  title: tr('禁止名单'),
                  margin: _m,
                  children: [
                    for (final pkg in p.deny)
                      SettingsRow(
                        title: _name(pkg),
                        trailing: IconButton(
                          icon: const Icon(Icons.remove_circle_outline, size: 20),
                          tooltip: tr('移出'),
                          onPressed: () => _save(p.copyWith(deny: [...p.deny]..remove(pkg))),
                        ),
                      ),
                    SettingsRow(leading: Icons.add, title: tr('添加 App'), onTap: () => _addApp(deny: true)),
                    if (p.deny.length > 1)
                      SettingsRow(
                        leading: Icons.checklist,
                        title: tr('批量移除…'),
                        subtitle: tr('一次勾几个 App 从禁止名单移出'),
                        onTap: () => _batchRemove(deny: true),
                      ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl + 4),
                  child: Text(
                    tr('不管名单怎么设, 这几条一直有效: 在微信 / QQ / 短信 / 钉钉 / 飞书里发消息、任何 App 里付钱, 都要你确认才会点; Agent 不能操作 Neox 自己。读到的内容会作为这次对话的一部分发给你选的模型, Neox 不另外留存。'),
                    style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurfaceVariant),
                  ),
                ),
              ],
            ),
    );
  }
}

/// 批量移除的勾选面板: 勾上要移出的, 一次交回去 (pilot:D-11)
class _BatchPicker extends StatefulWidget {
  const _BatchPicker({required this.title, required this.names, required this.packages});
  final String title;
  final Map<String, String> names;
  final List<String> packages;

  @override
  State<_BatchPicker> createState() => _BatchPickerState();
}

class _BatchPickerState extends State<_BatchPicker> {
  final _picked = <String>{};

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.7,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.sm, NeoxSpace.sm),
            child: Row(
              children: [
                Expanded(child: Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
                TextButton(
                  onPressed: _picked.isEmpty ? null : () => Navigator.of(context).pop(_picked.toList()),
                  child: Text(tr('移出所选') + (_picked.isEmpty ? '' : ' (${_picked.length})')),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: widget.packages.length,
              itemBuilder: (_, i) {
                final pkg = widget.packages[i];
                final on = _picked.contains(pkg);
                return CheckboxListTile(
                  value: on,
                  onChanged: (v) => setState(() => v == true ? _picked.add(pkg) : _picked.remove(pkg)),
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  activeColor: scheme.primary,
                  title: Text(widget.names[pkg] ?? pkg),
                  subtitle: widget.names.containsKey(pkg) ? Text(pkg, style: const TextStyle(fontSize: 11.5)) : null,
                );
              },
            ),
          ),
          SafeArea(
            top: false,
            child: SizedBox(
              width: double.infinity,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.lg, NeoxSpace.md),
                child: FilledButton.tonal(
                  onPressed: _picked.isEmpty ? null : () => Navigator.of(context).pop(_picked.toList()),
                  child: Text(tr('移出所选')),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AppPicker extends StatefulWidget {
  const _AppPicker({required this.names, required this.exclude});
  final Map<String, String> names;
  final Set<String> exclude;

  @override
  State<_AppPicker> createState() => _AppPickerState();
}

class _AppPickerState extends State<_AppPicker> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final rows = widget.names.entries
        .where((e) => !widget.exclude.contains(e.key))
        .where((e) => _q.isEmpty || e.value.toLowerCase().contains(_q) || e.key.toLowerCase().contains(_q))
        .toList()
      ..sort((a, b) => a.value.compareTo(b.value));
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.7,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.lg, NeoxSpace.sm),
            child: TextField(
              autofocus: false,
              decoration: InputDecoration(isDense: true, prefixIcon: const Icon(Icons.search, size: 18), hintText: tr('搜索 App')),
              onChanged: (v) => setState(() => _q = v.trim().toLowerCase()),
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: rows.length,
              itemBuilder: (_, i) => ListTile(
                title: Text(rows[i].value),
                subtitle: Text(rows[i].key, style: const TextStyle(fontSize: 11.5)),
                onTap: () => Navigator.of(context).pop(rows[i].key),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
