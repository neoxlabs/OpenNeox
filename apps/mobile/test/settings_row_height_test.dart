/// settings_row_height_test.dart — 设置行的高度必须齐.
///
/// 2026-09-18 用户: 「应用锁的高度和其他不一样 是因为开关的高度过大 撑高!!!」
///
/// SettingsRow 的两档高度是 `minHeight`(最小值), 不是固定值 —— 所以 trailing
/// 放什么进去都可能把整行顶高。Material 的 Switch 默认带 48×48 点按盒, 一顶
/// 就比旁边的行高十几像素。这里**量**出来, 不靠看。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/features/settings/settings_ui.dart';

Future<double> _rowHeight(WidgetTester t, Widget row) async {
  await t.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Column(children: [SizedBox(width: 390, child: row)]),
      ),
    ),
  );
  return t.getSize(find.byType(SettingsRow)).height;
}

void main() {
  testWidgets('带开关的行跟带 chevron 的行一样高', (t) async {
    final plain = await _rowHeight(
      t,
      const SettingsRow(
        leading: Icons.palette_outlined,
        title: '外观',
        showChevron: true,
      ),
    );
    final withSwitch = await _rowHeight(
      t,
      SettingsRow(
        leading: Icons.fingerprint,
        title: '应用锁',
        trailing: SettingsSwitch(value: true, onChanged: (_) {}),
      ),
    );

    expect(
      withSwitch,
      plain,
      reason: '开关那一行凸出来就是这个 bug; 差一个像素都算不齐',
    );
  });

  testWidgets('带副标题 + 开关 = 带副标题的那一档, 不再被顶高', (t) async {
    final sub = await _rowHeight(
      t,
      const SettingsRow(
        leading: Icons.palette_outlined,
        title: '外观',
        subtitle: '跟随系统',
        showChevron: true,
      ),
    );
    final subSwitch = await _rowHeight(
      t,
      SettingsRow(
        leading: Icons.swap_horiz,
        title: '自动保持连接',
        subtitle: '离开 Wi-Fi 转远程',
        trailing: SettingsSwitch(value: false, onChanged: (_) {}),
      ),
    );

    expect(subSwitch, sub);
  });

  testWidgets('裸 Switch 确实会顶高 —— 证明这道闸不是空的', (t) async {
    final withOurs = await _rowHeight(
      t,
      SettingsRow(
        title: '应用锁',
        trailing: SettingsSwitch(value: true, onChanged: (_) {}),
      ),
    );
    final withRaw = await _rowHeight(
      t,
      SettingsRow(
        title: '应用锁',
        trailing: Switch(value: true, onChanged: (_) {}),
      ),
    );

    /* 这一条是给后来人看的: 直接写 Switch 就会回到那个 bug。
     * (如果哪天 Material 自己改了默认点按盒, 这条会红 —— 那时候
     *  SettingsSwitch 可能就不必要了, 是个值得知道的信号。) */
    expect(
      withRaw,
      greaterThan(withOurs),
      reason: '裸 Switch 不再顶高的话, SettingsSwitch 的存在理由要重新评估',
    );
  });
}
