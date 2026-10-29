/// payment_parser.dart — 支付宝 / 微信支付 / 银行短信 的到账、扣款提醒 → 一笔收支 (2026-10-11)。
///
/// 只在手机上识别 (正则, 不叫模型): 通知原文不出手机, 进记录的只有金额 / 商户 / 分类。
/// 宁可漏, 不可错: 聊天里的「我花了 35」、验证码、还款提醒、营销都不算 —— 记错一笔比漏一笔更让人不信它。
library;

/// 衣食住行 + 其它 —— 「我的记录」生活那一页按这个分
enum LifeDim { clothes, food, home, travel, other }

class ParsedPayment {
  const ParsedPayment({required this.amount, required this.income, required this.via, required this.category, this.merchant});
  final double amount;
  final bool income;
  /// 支付宝 / 微信 / 某某银行
  final String via;
  /// 吃饭 / 交通 / 居家 / 衣着 / 购物 / 其它 —— 跟手动记账的分类同一套
  final String category;
  final String? merchant;

  Map<String, Object?> toRecord(DateTime at) => {
        'type': income ? 'finance.income' : 'finance.expense',
        'value': amount,
        'occurred_at': at.millisecondsSinceEpoch,
        'source': 'device:phone:auto',
        'tags': const ['auto'],
        'data': {
          'currency': 'CNY',
          'category': category,
          'via': via,
          if (merchant != null) 'merchant': merchant,
        },
      };
}

LifeDim dimOf(String? category) => switch (category) {
      '吃饭' => LifeDim.food,
      '交通' => LifeDim.travel,
      '居家' => LifeDim.home,
      '衣着' => LifeDim.clothes,
      _ => LifeDim.other,
    };

/// 一笔花销落在衣食住行哪一格: 分类不是那几个标准词时 (Pilot 写的「咖啡」「打车」), 拿分类 + 商户 + 标题再猜一次
LifeDim dimOfExpense(Map<String, dynamic> data, String title) {
  final cat = data['category'] is String ? data['category'] as String : null;
  final d = dimOf(cat);
  if (d != LifeDim.other || cat == '购物' || cat == '其它') return d;
  return dimOf(guessCategory('${cat ?? ''} ${data['merchant'] ?? ''} ${data['note'] ?? ''} $title'));
}

const _alipay = 'com.eg.android.AlipayGphone';
const _wechat = 'com.tencent.mm';

/* 这些字眼出现就不是一笔真实发生的收支 */
final _noise = RegExp(r'验证码|校验码|动态码|动态密码|还款|应还|账单已出|账单日|最低还|额度|优惠券|领取|积分|活动|立减金|红包封面|待支付|未支付|支付失败|已退回|即将|预授权|签约|余额宝|零钱通|理财|基金|收益');
final _out = RegExp(r'消费|支出|支付|付款|扣款|扣费|取现|转出|转账给|已付');
final _in = RegExp(r'收款|收入|存入|入账|转入|到账|退款|工资|代发');
final _bankTag = RegExp(r'【([^】]{2,12}(?:银行|信用卡|银联))】|^([^\s]{2,10}银行)');
final _cardTail = RegExp(r'尾号\s*\d{3,4}|\*\d{4}');
/* 「余额 1,234.00 元」「可用额度 …」先抹掉, 不然会被当成金额 */
final _balance = RegExp(r'(?:可用)?(?:余额|额度)[为是:：]?\s*(?:人民币|RMB|CNY)?\s*[¥￥]?\s*[0-9][0-9,]*(?:\.\d+)?\s*元?');
final _amount = RegExp(r'(?:人民币|RMB|CNY|[¥￥])\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*元');
final _merchantPats = [
  RegExp(r'在\s*([^，。,;；\s]{2,20}?)\s*(?:消费|支付|付款|刷卡)'),
  RegExp(r'(?:商户|收款方|对方|商家)(?:名称)?[:：]\s*([^，。,;；\s]{2,20})'),
  RegExp(r'向\s*([^，。,;；\s]{2,20}?)\s*(?:付款|支付|转账)'),
  RegExp(r'([^，。,;；\s]{2,20}?)\s*(?:扣款|扣费)'),
];

const _cats = <String, List<String>>{
  '吃饭': ['餐', '饭', '面馆', '食', '美团', '饿了么', '肯德基', 'KFC', '麦当劳', '星巴克', '瑞幸', '奶茶', '咖啡', '外卖', '超市', '便利', '盒马', '生鲜', '水果', '喜茶', '蜜雪', '烧烤', '火锅', '烘焙', '面包', '茶饮', '饮料', '零食', '7-Eleven', '全家', '罗森', 'coffee', 'lunch', 'dinner', 'breakfast', 'food', 'meal'],
  '交通': ['滴滴', '地铁', '公交', '出行', '加油', '石化', '石油', '高德', '打车', '出租', '铁路', '火车', '高铁', '12306', '航空', '机票', '停车', 'ETC', '高速', '哈啰', '单车', '曹操', '花小猪', '充电', 'taxi', 'uber', 'bus', 'metro', 'subway', 'train', 'flight', 'gas'],
  '居家': ['房租', '物业', '水费', '电费', '燃气', '宽带', '电网', '自来水', '酒店', '民宿', '住宿', '家居', '宜家', '话费', '移动', '联通', '电信', 'rent', 'hotel'],
  '衣着': ['服饰', '服装', '衣服', '优衣库', 'UNIQLO', 'ZARA', '鞋', '耐克', 'Nike', 'NIKE', '阿迪', 'adidas', 'H&M', '李宁', '安踏', '洗衣', '理发', '美发', 'clothes', 'shoes'],
  '购物': ['淘宝', '天猫', '京东', '拼多多', '抖音', '唯品会', '得物', '商城', '旗舰店', '专卖'],
};

String guessCategory(String text) {
  final low = text.toLowerCase();
  for (final e in _cats.entries) {
    for (final k in e.value) {
      if (low.contains(k.toLowerCase())) return e.key;
    }
  }
  return '其它';
}

double? _firstAmount(String s) {
  for (final m in _amount.allMatches(s)) {
    final raw = (m.group(1) ?? m.group(2) ?? '').replaceAll(',', '');
    final v = double.tryParse(raw);
    /* 「10月11日」这类不会带元/¥; 0 元和天价当成识别错 */
    if (v != null && v > 0 && v < 1000000) return v;
  }
  return null;
}

String? _merchant(String s) {
  for (final p in _merchantPats) {
    final m = p.firstMatch(s);
    final v = m?.group(1)?.trim();
    if (v != null && v.isNotEmpty && !RegExp(r'^[0-9.,¥￥]+$').hasMatch(v) && !v.contains('尾号')) return v;
  }
  return null;
}

/// 一条通知 (或一条短信: [pkg] 传 'sms', [title] 传发件方) → 一笔收支; 不像就 null。
ParsedPayment? parsePayment({required String pkg, required String title, required String text}) {
  final whole = '$title $text'.trim();
  if (whole.isEmpty || _noise.hasMatch(whole)) return null;

  String via;
  if (pkg == _alipay) {
    via = '支付宝';
  } else if (pkg == _wechat) {
    /* 微信只认支付消息; 聊天里有人说「转你 35 元」不算 */
    if (!RegExp(r'^(微信支付|微信收款助手|微信转账)').hasMatch(title) && !text.startsWith('微信支付')) return null;
    via = '微信';
  } else {
    /* 短信 / 银行 App: 要么带【某某银行】, 要么带卡号尾号, 否则不认 */
    final bank = _bankTag.firstMatch(whole);
    if (bank == null && !_cardTail.hasMatch(whole)) return null;
    via = (bank?.group(1) ?? bank?.group(2) ?? '银行卡').replaceAll('信用卡', '');
  }

  final body = whole.replaceAll(_balance, ' ');
  final isOut = _out.hasMatch(body);
  final isIn = _in.hasMatch(body);
  if (!isOut && !isIn) return null;
  /* 「收款方: xx」里的「收款」是在说对方; 两样都有时看哪个先出现 */
  final income = isIn && (!isOut || body.indexOf(_in) < body.indexOf(_out)) && !body.contains('收款方');
  final amount = _firstAmount(body);
  if (amount == null) return null;
  final merchant = _merchant(body);
  return ParsedPayment(
    amount: amount,
    income: income,
    via: via,
    merchant: merchant,
    category: income ? '收入' : guessCategory(merchant ?? body),
  );
}
