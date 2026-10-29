/// pilot_receipt.dart — 回执卡: 一句话 + 数字 + 下一步 (pilot:U-05).
///
/// 用户看完回执要能马上回答三个问题: 办成了没有 / 关键数字是多少 / 接下来我做什么。
/// 原来账本里的一行事件原样居中显示, 只有一句话; 金额、时间、次数埋在句子里, 也没有下一步。
/// 这里把一句话拆成三块 —— 数字尽量从原句里取 (取不到就用发生时间, 也是一个能对得上的数),
/// 下一步按事情类型给一句实话。措辞不套模板, 只在最后兜一句「有变化我再说」。
library;

import 'package:flutter/material.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../shared/clay/clay.dart';

/// 一件办完的小事, 拆成用户看得懂的三块
class PilotReceipt {
  const PilotReceipt({required this.summary, required this.fact, required this.next});

  /// 一句话: 办了什么
  final String summary;

  /// 一个数字: 时间 / 金额 / 件数 —— 用户能对得上的那个
  final String fact;

  /// 下一步: 接下来会怎样, 或者用户该做什么
  final String next;

  factory PilotReceipt.fromEvent(String text, {DateTime? at}) {
    final clean = _clean(text);
    return PilotReceipt(
      summary: _summary(clean),
      fact: _fact(clean) ?? _clock(at ?? DateTime.now()),
      next: _next(clean),
    );
  }

  static final _lead = RegExp(r'^[\s✅✓☑⚠️❗•·\-—]+');
  static final _time = RegExp(r'\d{1,2}[:：]\d{2}');
  static final _money = RegExp(r'[¥￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|块)');
  static final _percent = RegExp(r'\d[\d,]*(?:\.\d+)?\s*%');
  static final _count = RegExp(r'\d[\d,]*(?:\.\d+)?\s*(?:分钟|小时|天|个|件|条|项|次|号|点|公里|km|公斤|kg|步|分|秒)');
  static final _bare = RegExp(r'\d[\d,]*(?:\.\d+)?');

  static String _clean(String text) => text.trim().replaceFirst(_lead, '').trim();

  /// 第一句就说清楚办了什么; 太长才截断
  static String _summary(String clean) {
    if (clean.isEmpty) return '';
    final head = clean.split('\n').firstWhere((l) => l.trim().isNotEmpty, orElse: () => clean).trim();
    final stop = head.indexOf(RegExp(r'[。！？!?]'));
    final sentence = (stop > 0 ? head.substring(0, stop) : head).trim();
    return sentence.length <= 60 ? sentence : '${sentence.substring(0, 59)}…';
  }

  /// 句子里最像「用户会核对的那个数」的一段: 时刻 > 金额 > 百分比 > 带单位的数 > 光秃秃的数
  static String? _fact(String clean) {
    for (final re in [_time, _money, _percent, _count, _bare]) {
      final m = re.firstMatch(clean);
      if (m != null) return m[0]!.trim();
    }
    return null;
  }

  static String _clock(DateTime at) =>
      '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';

  /// 这一步之后会发生什么 —— 按事情类型, 不按固定模板套
  static String _next(String clean) {
    const rules = <(String, String)>[
      ('没办成', '我晚点再试一次'),
      ('失败', '我晚点再试一次'),
      ('提醒', '到点我会提醒你'),
      ('闹钟', '到点我会提醒你'),
      ('日历', '到点我会提醒你'),
      ('短信', '对方回了我告诉你'),
      ('iMessage', '对方回了我告诉你'),
      ('已发送', '对方回了我告诉你'),
      ('发给', '对方回了我告诉你'),
      ('做好', '点开就能用'),
      ('生成', '点开就能用'),
      ('记下', '要改直接跟我说'),
      ('记好', '要改直接跟我说'),
      ('存好', '要改直接跟我说'),
      ('打卡', '要改直接跟我说'),
    ];
    for (final (word, next) in rules) {
      if (clean.contains(word)) return next;
    }
    return '有变化我再说';
  }
}

/// 回执卡 (平): 绿勾 + 一句话, 下面一行「数字 · 下一步」
class PilotReceiptCard extends StatelessWidget {
  const PilotReceiptCard({super.key, required this.receipt});
  final PilotReceipt receipt;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
      padding: const EdgeInsets.fromLTRB(8, 6, 12, 6),
      decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(14)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Container(
              width: 15,
              height: 15,
              decoration: BoxDecoration(color: c.green, shape: BoxShape.circle),
              child: const Icon(Icons.check_rounded, size: 11, color: Colors.white),
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(tr(receipt.summary), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.ink, height: 1.35)),
                const SizedBox(height: 2),
                Text.rich(
                  TextSpan(children: [
                    TextSpan(text: tr(receipt.fact), style: TextStyle(fontWeight: FontWeight.w600, color: c.grey)),
                    TextSpan(text: ' · ${tr(receipt.next)}', style: TextStyle(color: c.grey)),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, height: 1.3),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
