part of 'pilot_records_page.dart';

/// pilot_rooms.dart — 我的世界里新加的房间 (家 / 人 / 工作学习 / 我)、房间地图、各房间的明细底板 (2026-10-11)。
///
/// 数都是服务端 summarizeRooms 算好的 (_room(id)), 这里只画; 一个房间最多四个泡泡 —— 多了就乱。
extension _Rooms on _PilotRecordsPageState {
  // ───────── 家: 账单 / 车 ─────────

  Widget _homeRoom(ThemeData theme) {
    final home = _room('home');
    final bills = [for (final b in (home['bills'] as List? ?? const [])) Map<String, dynamic>.from(b as Map)];
    final vehicles = [for (final v in (home['vehicles'] as List? ?? const [])) Map<String, dynamic>.from(v as Map)];
    final unpaid = bills.where((b) => b['paid'] == false).toList();
    final monthBills = (home['monthBills'] as num?)?.toDouble() ?? 0;
    /* 账单按金额取前两张挂在小屋边上; 车挂在小摩托上 */
    final topBills = ([...bills]..sort((a, b) => ((b['amount'] as num?) ?? 0).compareTo((a['amount'] as num?) ?? 0))).take(2).toList();
    const billSpots = [Offset(0.16, 0.50), Offset(0.56, 0.42)];
    final car = vehicles.isEmpty ? null : vehicles.first;
    final carItems = car == null ? const [] : (car['items'] as List? ?? const []);
    final carNext = carItems.isEmpty ? null : Map<String, dynamic>.from(carItems.first as Map);
    return _stage(
      art: _worldArt('life'),
      world: 2,
      artAspect: 900 / 731,
      headline: _bigNumber(
        theme,
        _yuan(monthBills),
        sub: bills.isEmpty ? tr('本月账单') : unpaid.isEmpty ? tr('本月账单 · 都交了') : tr('本月账单 · ${unpaid.length} 张没交'),
        onTap: bills.isEmpty ? null : _openBills,
      ),
      floats: [
        for (final (i, b) in topBills.indexed)
          _Float(billSpots[i], _Orb(
            letter: '${b['label'] ?? '账单'}'.substring(0, 1),
            value: '${_yuan(((b['amount'] as num?) ?? 0).toDouble())}${b['paid'] == false ? ' · 未交' : ''}',
            onTap: _openBills,
          )),
        if (car != null)
          _Float(const Offset(0.84, 0.56), _Orb(
            clay: 'i-route',
            value: carNext == null ? '${car['name']}' : '${car['name']} · ${carNext['what']}${carNext['days']}天',
            onTap: () => _openVehicle(car),
          )),
        if (bills.isEmpty)
          _Float(const Offset(0.20, 0.50), _Orb(clay: 'i-receipt', value: '记账单', ghost: true, onTap: () => _say(tr('截图或转发账单短信给我，水电燃气物业我都认得')))),
      ],
    );
  }

  /// 日期 yyyy-mm-dd 取「03月08日」(英文「03/08」)
  String _monthDay(Object? v) {
    final md = '$v'.substring(5);
    return isEnglishUi ? md.replaceFirst('-', '/') : '${md.replaceFirst('-', '月')}日';
  }

  String _unpaidText(Object? due) => due == null ? tr('没交') : tr('没交，${_monthDay(due)}前');

  Future<void> _openBills() async {
    final bills = [for (final b in (_room('home')['bills'] as List? ?? const [])) Map<String, dynamic>.from(b as Map)];
    await _listSheet(
      title: tr('账单'),
      rows: [
        for (final b in bills)
          (
            clay: 'i-receipt',
            title: '${b['label']} · ${b['period'] ?? ''}',
            sub: b['paid'] == false ? _unpaidText(b['due']) : tr('已交'),
            trailing: _yuan(((b['amount'] as num?) ?? 0).toDouble()),
          ),
      ],
      actions: [
        (label: tr('问问为啥这么贵'), run: () => _askPilot(tr('看看我家这几个月的水电燃气账单，哪项不正常、为什么、怎么省，说短一点。'), shown: tr('账单哪项不正常'))),
      ],
    );
  }

  Future<void> _openVehicle(Map<String, dynamic> car) async {
    final items = [for (final x in (car['items'] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
    await _listSheet(
      title: '${car['name']}${car['model'] != null ? ' · ${car['model']}' : ''}',
      rows: [
        for (final x in items)
          (clay: 'i-calendar', title: '${x['what']}', sub: '${x['due']}', trailing: (x['days'] as num) < 0 ? tr('过期了') : tr('${x['days']} 天')),
      ],
      actions: [
        if (items.isNotEmpty)
          (label: tr('帮我办${items.first['what']}'), run: () => _askPilot(tr('我的车 ${car['name']} ${items.first['what']} ${items.first['due']} 到期。告诉我现在该做什么（比价 / 预约 / 材料），能替我办的直接办，再定个提醒。'), shown: tr('办${items.first['what']}'))),
      ],
    );
  }

  // ───────── 足迹: 此刻在哪 (情境层) ─────────

  /// 足迹房间正中下方一颗: 设好了说「在家 · 3 小时」「车停了 2 小时」「在外地 · 杭州」, 没设好说「让它认得家」
  _Float _senseFloat({Offset at = const Offset(0.5, 0.80)}) {
    final s = ref.watch(contextSenseProvider);
    String value;
    if (!s.setUp) {
      value = tr('让它认得家和车');
    } else if (s.away) {
      value = tr('在外地 · ${s.city}');
    } else if (s.state == 'parked' && s.parkedTime != null) {
      value = tr('车停了 ${_ago(s.parkedTime!)}');
    } else if (s.state != null && s.since != null) {
      value = '${tr(ctxStateZh[s.state] ?? s.state!)} · ${_ago(s.since!)}';
    } else {
      value = tr('等它看见你');
    }
    return _Float(at, _Orb(clay: s.state == 'home' ? 'i-house' : 'i-route', value: value, ghost: !s.setUp, onTap: _openSense));
  }

  /// 一句此刻: 「在家 13 分钟」「车停了 2 小时」「在外地 杭州」; 还没设好返回 null
  String? _senseLine() {
    final s = ref.watch(contextSenseProvider);
    if (!s.setUp) return null;
    if (s.away) return tr('在外地 ${s.city}');
    if (s.state == 'parked' && s.parkedTime != null) return tr('车停了 ${_ago(s.parkedTime!)}');
    if (s.state != null && s.since != null) return '${tr(ctxStateZh[s.state] ?? s.state!)} ${_ago(s.since!)}';
    return null;
  }

  String _ago(DateTime t) {
    final m = DateTime.now().difference(t).inMinutes;
    if (m < 60) return tr('${m < 1 ? 1 : m} 分钟');
    if (m < 60 * 24) return tr('${m ~/ 60} 小时');
    return tr('${m ~/ (60 * 24)} 天');
  }

  Future<void> _openSense() async {
    final s = ref.read(contextSenseProvider);
    await _listSheet(
      title: tr('它看着的'),
      rows: [
        (clay: 'i-house', title: tr('家'), sub: s.home ? tr('到家、出门它都知道；出门提醒在这时候弹') : tr('站在家里点「这里是家」'), trailing: s.home ? tr('已设') : null),
        (clay: 'i-laptop', title: tr('公司'), sub: s.work ? tr('到公司的提醒在这时候弹') : tr('在公司时点「这里是公司」'), trailing: s.work ? tr('已设') : null),
        (
          clay: 'i-route',
          title: s.car == null ? tr('你的车') : tr('车 · ${s.car}'),
          sub: s.car == null ? tr('选车上的蓝牙：下车时记住停在哪，要下雨就问你车窗关没关') : tr('连上算开车，断开算停车'),
          trailing: s.car == null ? null : tr('已设'),
        ),
        (clay: 'i-bulb', title: tr('一整天在家'), sub: tr('下午 5 点还没出过门、天气又好，叫你下楼走走'), trailing: null),
      ],
      actions: [
        if (s.car == null) (label: tr('选你的车'), run: _pickCar) else (label: tr('换辆车'), run: _pickCar),
        (label: tr('这里是公司'), run: () => _markHere('work')),
        (label: tr('这里是家'), run: () => _markHere('home')),
      ],
    );
  }

  /// 第一次设地点: 先说清楚为什么要「始终允许」, 再跳系统页 (直接跳过去用户不知道该选哪个)
  Future<void> _markHere(String which) async {
    if (!ref.read(contextSenseProvider).bgLocation) {
      final go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(tr('接下来选「始终允许」')),
          content: Text(tr('这样你出门、到家、到公司时，App 没打开它也知道，该提醒的当场提醒。只记「在家 / 在公司 / 在外面」这几段，不记轨迹。')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('先不用'))),
            TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('好'))),
          ],
        ),
      );
      if (go != true) return;
    }
    final r = await ref.read(contextSenseProvider.notifier).markHere(which);
    _say(r == null ? tr('没拿到位置，开一下定位') : tr('记住了，这是$r'));
  }

  Future<void> _pickCar() async {
    final n = ref.read(contextSenseProvider.notifier);
    final ds = await n.bondedDevices();
    if (!mounted) return;
    if (ds.isEmpty) {
      _say(tr('没看到配对过的蓝牙。先让手机连一次车上的蓝牙，或者给一下「附近设备」权限'));
      return;
    }
    await _listSheet(
      title: tr('哪个是你的车'),
      rows: [
        for (final d in ds.take(6)) (clay: 'i-route', title: d.name, sub: d.car ? tr('看着像车载') : null, trailing: null),
      ],
      actions: [
        for (final d in ds.take(3).toList().reversed)
          (label: d.name, run: () async { await n.setCar(d.address, d.name); _say(tr('记住了，${d.name} 是你的车')); }),
      ],
    );
  }

  // ───────── 人: 生日 / 多久没联系 ─────────

  Widget _peopleRoom(ThemeData theme) {
    final list = [for (final p in (_room('people')['list'] as List? ?? const [])) Map<String, dynamic>.from(p as Map)];
    final next = list.where((p) => p['birthdayInDays'] != null && (p['birthdayInDays'] as num) <= 30).firstOrNull;
    const spots = [Offset(0.18, 0.40), Offset(0.82, 0.38), Offset(0.20, 0.62), Offset(0.82, 0.60)];
    String tag(Map<String, dynamic> p) {
      final b = p['birthdayInDays'] as num?;
      if (b != null && b <= 14) return b == 0 ? '今天生日' : '$b天后生日';
      final last = p['lastContactDays'] as num?;
      if (last != null && last >= 14) return '$last天没联系';
      return '${p['relation'] ?? ''}';
    }

    return _stage(
      art: _worldArt('people'),
      world: 3,
      artAspect: 900 / 690,
      headline: _bigNumber(
        theme,
        '${list.length}',
        sub: next == null ? tr('个你在乎的人') : tr('个你在乎的人 · ${next['name']}生日还有 ${next['birthdayInDays']} 天'),
      ),
      floats: [
        for (final (i, p) in list.take(4).indexed)
          _Float(spots[i], _Orb(
            clay: 'i-person',
            value: tag(p).isEmpty ? '${p['name']}' : '${p['name']} · ${tag(p)}',
            onTap: () => _openPerson(p),
          )),
        if (list.isEmpty)
          _Float(spots[0], _Orb(clay: 'i-person', value: '说说身边的人', ghost: true, onTap: () => _say(tr('跟我说「我妈生日 3 月 8 号，喜欢越剧」，我就记住了')))),
      ],
    );
  }

  Future<void> _openPerson(Map<String, dynamic> p) async {
    final name = '${p['name']}';
    await _listSheet(
      title: name,
      rows: [
        if (p['relation'] != null) (clay: 'i-person', title: tr('关系'), sub: null, trailing: '${p['relation']}'),
        if (p['birthday'] != null)
          (clay: 'i-calendar', title: tr('生日'), sub: p['birthdayInDays'] == null ? null : tr('还有 ${p['birthdayInDays']} 天'), trailing: '${p['birthday']}'.replaceFirst('-', '月') + tr('日')),
        if (p['likes'] != null) (clay: 'i-heart', title: tr('喜欢'), sub: '${p['likes']}', trailing: null),
        if (p['lastContactDays'] != null) (clay: 'i-chat', title: tr('上次联系'), sub: null, trailing: tr('${p['lastContactDays']} 天前')),
      ],
      actions: [
        (label: tr('今晚 8 点提醒我联系'), run: () => _runAction({'kind': 'remind', 'at': '20:00', 'title': tr('给$name打个电话')})),
        (label: tr('送点什么'), run: () => _askPilot(tr('结合你记得的$name的喜好，给我三个送礼或一起做的事的建议，附大概价钱，说短一点。'), shown: tr('给$name送点什么'))),
      ],
    );
  }

  // ───────── 工作学习: 交给它做 ─────────

  Widget _workRoom(ThemeData theme) {
    final work = _room('work');
    final made = [for (final d in (work['deliverables'] as List? ?? const [])) Map<String, dynamic>.from(d as Map)];
    final job = work['job'] as String?;
    return _stage(
      art: _worldArt('work'),
      world: 4,
      artAspect: 900 / 818,
      headline: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(job ?? tr('交给它做'), style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        Text(made.isEmpty ? tr('PPT、文档、小工具，说一句就做') : tr('它替你做过 ${made.length} 份东西'),
            style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      ]),
      floats: [
        for (final (i, d) in made.take(2).indexed)
          _Float(i == 0 ? const Offset(0.18, 0.40) : const Offset(0.82, 0.40), _Orb(
            clay: 'i-doc',
            value: '${d['title']}',
            onTap: () => _say('${d['title']} · ${'${d['day']}'.substring(5).replaceFirst('-', '月')}日'),
          )),
        _Float(const Offset(0.5, 0.30), _Orb(clay: 'i-laptop', value: '交给它做', ghost: true, onTap: _openTask)),
      ],
    );
  }

  /// 交给它做: 几个常用的一点就发, 也能自己写
  Future<void> _openTask() async {
    const presets = ['做个周会 PPT', '写这周的周报', '帮我改一份 Word', '做个投票小工具', '整理会议纪要'];
    final t = await _sheet<String>((c) => _TaskSheet(presets: presets));
    if (t != null && t.trim().isNotEmpty) {
      await _askPilot(tr('${t.trim()}。做好了把文件或链接发给我；需要我补充的先问我一句。'), shown: t.trim());
    }
  }

  // ───────── 我: 关于你 / 知识库 / 关注点 ─────────

  static const _meKeyNames = {
    'me.job': '职业', 'me.likes.food': '口味', 'me.style.writing': '写作风格', 'me.birthday': '生日',
    'me.city': '常住', 'me.goal': '目标', 'me.trait': '性格',
  };

  Widget _meRoom(ThemeData theme) {
    final me = _room('me');
    final facts = [for (final f in (me['facts'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];
    final knowledge = me['knowledge'] as List? ?? const [];
    final focus = [for (final f in (me['focus'] as List? ?? const [])) '$f'];
    const focusNames = {'money': '省钱', 'body': '睡眠体重', 'social': '家人朋友', 'habit': '习惯', 'mood': '心情', 'place': '出去走走'};
    return _stage(
      art: _worldArt('me'),
      world: 7,
      artAspect: 900 / 805,
      headline: _bigNumber(
        theme,
        '${facts.length}',
        sub: focus.isEmpty ? tr('件关于你的事') : tr('件关于你的事 · 先盯 ${focus.map((f) => focusNames[f] ?? f).join('、')}'),
        onTap: _openMe,
      ),
      floats: [
        for (final (i, f) in facts.take(2).indexed)
          _Float(i == 0 ? const Offset(0.18, 0.40) : const Offset(0.82, 0.38), _Orb(
            clay: 'i-info',
            /* 泡泡里只放值 (「产品经理」「火锅和日料」), 是什么在明细里看 */
            value: '${f['value']}'.length > 10 ? '${'${f['value']}'.substring(0, 10)}…' : '${f['value']}',
            onTap: _openMe,
          )),
        _Float(const Offset(0.22, 0.62), _Orb(clay: 'i-book', value: '知识库 ${knowledge.length}', onTap: _openKnowledge)),
        _Float(const Offset(0.80, 0.60), _Orb(clay: 'i-sliders', value: '关注点', ghost: focus.isEmpty, onTap: _pickFocus)),
      ],
    );
  }

  Future<void> _openMe() async {
    final facts = [for (final f in (_room('me')['facts'] as List? ?? const [])) Map<String, dynamic>.from(f as Map)];
    await _listSheet(
      title: tr('关于你'),
      rows: [
        for (final f in facts) (clay: 'i-info', title: _meKeyNames['${f['key']}'] ?? '${f['key']}'.replaceFirst('me.', ''), sub: '${f['value']}', trailing: null),
      ],
      actions: [
        (label: tr('它还该知道什么'), run: () => _askPilot(tr('按你现在对我的了解，还缺哪几件最该知道的事（工作、口味、作息、目标…）？一次问我一件。'), shown: tr('还该知道什么'))),
      ],
    );
  }

  Future<void> _openKnowledge() async {
    final items = [for (final k in (_room('me')['knowledge'] as List? ?? const [])) Map<String, dynamic>.from(k as Map)];
    const kindName = {'link': '收藏', 'note': '笔记', 'doc': '文档', 'deliverable': '它做的', 'quote': '摘抄'};
    await _listSheet(
      title: tr('知识库'),
      rows: [
        for (final k in items)
          (clay: k['kind'] == 'deliverable' ? 'i-laptop' : 'i-doc', title: '${k['title']}', sub: kindName['${k['kind']}'] ?? '', trailing: '${k['day']}'.substring(5).replaceFirst('-', '/')),
      ],
      actions: [
        (label: tr('存一条'), run: () => _quick('note')),
      ],
    );
  }

  // ───────── 钱: 资产 ─────────

  Future<void> _openAssets() async {
    final money = _room('money');
    final accounts = [for (final a in (money['accounts'] as List? ?? const [])) Map<String, dynamic>.from(a as Map)];
    final subs = [for (final s in (money['subscriptions'] as List? ?? const [])) Map<String, dynamic>.from(s as Map)];
    const kindName = {'cash': '现金', 'deposit': '存款', 'fund': '基金', 'stock': '股票', 'property': '房产', 'vehicle': '车', 'debt': '负债', 'credit': '信用卡', 'other': '其它'};
    final delta = (money['netWorthDelta30'] as num?)?.toDouble();
    final netWorth = _yuan(((money['netWorth'] as num?) ?? 0).toDouble());
    final deltaSign = delta == null ? '' : (delta >= 0 ? '+' : '−');
    final deltaText = delta == null ? '' : tr(' · 一个月$deltaSign${_yuan(delta.abs())}');
    await _listSheet(
      title: '${tr('净资产 $netWorth')}$deltaText',
      rows: [
        for (final a in accounts)
          (clay: (a['value'] as num) < 0 ? 'i-receipt' : 'i-coins', title: '${a['name']}', sub: kindName['${a['kind']}'] ?? '', trailing: (a['value'] as num) < 0 ? '−${_yuan(-(a['value'] as num).toDouble())}' : _yuan((a['value'] as num).toDouble())),
        for (final s in subs) (clay: 'i-calendar', title: tr('每月 · ${s['name']}'), sub: tr('下次 ${_monthDay(s['nextDay'])}'), trailing: _yuan((s['amount'] as num).toDouble())),
      ],
      actions: [
        (label: tr('帮我理理财'), run: () => _askPilot(tr('按我各个账户的余额、房贷和每月收支，给我一个现实的理财安排：应急金留多少、多出来的放哪、房贷要不要提前还。说短一点，不确定的说明风险。'), shown: tr('帮我理财'))),
      ],
    );
  }

  // ───────── 我的世界: 八个房间的地图 ─────────

  Future<void> _openMap() async {
    final picked = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _WorldMap(current: _world, flags: {for (var i = 0; i < _rooms.length; i++) i: _questFor(i)?.tone}),
    );
    if (picked != null && picked != _world) {
      unawaited(_pager.animateToPage(picked, duration: const Duration(milliseconds: 480), curve: Curves.easeOutCubic));
    }
  }

  /// 通用的明细底板: 一列 (图标 · 标题 / 小字 · 右边的数) + 底部几个能办的事
  Future<void> _listSheet({
    required String title,
    required List<({String clay, String title, String? sub, String? trailing})> rows,
    List<({String label, Future<void> Function() run})> actions = const [],
  }) async {
    final run = await showModalBottomSheet<Future<void> Function()>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _ListSheet(title: title, rows: rows, actions: actions),
    );
    if (run != null) await run();
  }
}

class _ListSheet extends StatelessWidget {
  const _ListSheet({required this.title, required this.rows, required this.actions});
  final String title;
  final List<({String clay, String title, String? sub, String? trailing})> rows;
  final List<({String label, Future<void> Function() run})> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.8),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.lg),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: NeoxSpace.sm),
            Flexible(
              child: ListView(shrinkWrap: true, children: [
                if (rows.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: NeoxSpace.xl),
                    child: Text(tr('还没有'), textAlign: TextAlign.center, style: theme.textTheme.bodyMedium?.copyWith(color: mute)),
                  ),
                for (final r in rows)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 9),
                    child: Row(children: [
                      Image.asset(NeoxClay.of(r.clay), width: 28, height: 28, filterQuality: FilterQuality.medium),
                      const SizedBox(width: NeoxSpace.md),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                          if (r.sub != null && r.sub!.isNotEmpty)
                            Text(r.sub!, maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: mute)),
                        ]),
                      ),
                      if (r.trailing != null) ...[
                        const SizedBox(width: NeoxSpace.sm),
                        Text(r.trailing!, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
                      ],
                    ]),
                  ),
              ]),
            ),
            if (actions.isNotEmpty) ...[
              const SizedBox(height: NeoxSpace.md),
              Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: [
                for (final (i, a) in actions.indexed)
                  i == actions.length - 1
                      ? _Pill(label: a.label, onTap: () => Navigator.pop(context, a.run))
                      : OutlinedButton(onPressed: () => Navigator.pop(context, a.run), child: Text(a.label)),
              ]),
            ],
          ]),
        ),
      ),
    );
  }
}

/// 交给它做: 常用的几个一点就发, 也能自己写
class _TaskSheet extends StatefulWidget {
  const _TaskSheet({required this.presets});
  final List<String> presets;
  @override
  State<_TaskSheet> createState() => _TaskSheetState();
}

class _TaskSheetState extends State<_TaskSheet> {
  String _text = '';
  @override
  Widget build(BuildContext context) => _SheetFrame(
        title: tr('交给它做'),
        doneLabel: tr('交给它'),
        canDone: _text.trim().isNotEmpty,
        onDone: () => Navigator.pop(context, _text),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Wrap(spacing: 8, runSpacing: 6, children: [
            for (final p in widget.presets)
              ActionChip(label: Text(tr(p)), visualDensity: VisualDensity.compact, onPressed: () => Navigator.pop(context, p)),
          ]),
          const SizedBox(height: NeoxSpace.md),
          TextField(
            minLines: 1,
            maxLines: 4,
            onChanged: (v) => setState(() => _text = v),
            decoration: _bare(hint: tr('或者自己说: 把这份合同里的日期都改成下周…')),
          ),
        ]),
      );
}

/// 我的世界: 八个房间排成小岛 (两列), 每格是那个房间的陶土场景; 有要留神的事挂一面小旗
class _WorldMap extends StatelessWidget {
  const _WorldMap({required this.current, required this.flags});
  final int current;
  final Map<int, String?> flags;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 0, NeoxSpace.lg, NeoxSpace.lg),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(tr('我的世界'), style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: NeoxSpace.md),
          GridView.count(
            crossAxisCount: 4,
            shrinkWrap: true,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 0.78,
            physics: const NeverScrollableScrollPhysics(),
            children: [
              for (final (i, (_, clay, label, art)) in _rooms.indexed)
                TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: Duration(milliseconds: 240 + i * 50),
                  curve: Curves.easeOutBack,
                  builder: (c, v, child) => Transform.scale(scale: 0.8 + 0.2 * v, child: Opacity(opacity: v.clamp(0, 1), child: child)),
                  child: GestureDetector(
                    onTap: () { HapticFeedback.selectionClick(); Navigator.pop(context, i); },
                    child: Container(
                      padding: const EdgeInsets.fromLTRB(4, 6, 4, 6),
                      decoration: BoxDecoration(
                        color: i == current ? NeoxBrand.blue.withValues(alpha: 0.06) : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
                        borderRadius: NeoxRadius.cardR,
                        border: Border.all(color: i == current ? NeoxBrand.blue.withValues(alpha: 0.6) : Colors.transparent, width: 1.5),
                      ),
                      child: Stack(clipBehavior: Clip.none, children: [
                        Column(children: [
                          Expanded(child: Image.asset(_worldArt(art), fit: BoxFit.contain, filterQuality: FilterQuality.medium)),
                          const SizedBox(height: 4),
                          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                            Image.asset(NeoxClay.of(clay), width: 16, height: 16, filterQuality: FilterQuality.medium),
                            const SizedBox(width: 3),
                            Flexible(child: Text(tr(label), maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600))),
                          ]),
                        ]),
                        if (flags[i] == 'watch')
                          Positioned(right: 2, top: 0, child: Container(width: 8, height: 8, decoration: BoxDecoration(color: _toneColor('watch'), shape: BoxShape.circle))),
                      ]),
                    ),
                  ),
                ),
            ],
          ),
        ]),
      ),
    );
  }
}
