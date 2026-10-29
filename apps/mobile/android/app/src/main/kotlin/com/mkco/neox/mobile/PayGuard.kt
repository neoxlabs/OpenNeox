package com.mkco.neox.mobile

/**
 * 动钱的闸 (Pilot 硬闸, 2026-10-17)
 *
 * 原来只认「支付 / 付款 / 提交订单 / 确认下单 / 立即购买 / 免密 / 确认付款 / Pay / Place order / Buy now」
 * 这几个固定词。结果: 充值页的「立即充值 / 确认充值」、打车页的「呼叫快车 / 打车 / 叫车」、
 * 账单页的「转账 / 去结算 / 立即下单」、把金额直接当按钮字的「付款 ¥32」全都拦不住 ——
 * 模型点下去就真扣钱。改成两条判据, 任一条成立就算动钱:
 *
 *   1. 词根: 支付 / 付款 / 充值 / 提现 / 转账 / 结算 / 下单 / 购买 / 续费 / 免密 / 开通会员 /
 *      叫车 / 打车 / 呼叫 (不含「呼叫客服」) 等, 并收掉拼写变体 (全文见 [VERB])。
 *   2. 金额: 按钮字里带 ¥100 / 100元 / $9.99 这类价格 (不少 App 的付款键就叫「¥32」)。
 *
 * 同时防误拦 —— 「支付宝」是 App 名, 「查看订单 / 订单详情 / 付款方式 / 充值中心 / 优惠券」
 * 这类只读入口点下去不动钱, 不能拦 (拦了模型每步都要用户点头, 用不下去)。
 *
 * 判定写成纯函数 (不碰 Android API), 是为了能被 JVM 单测逐条钉住;
 * 闸本身仍在原生层 [NeoxAccessibilityService], 不靠模型自觉。
 */
object PayGuard {

    /* 金额: ¥100 / ￥1,299.00 / 100 元 / $9.99 / RMB 50 */
    private val AMOUNT = Regex(
        """[¥￥$]\s*\d|\d+(?:[.,]\d{3})*(?:\.\d{1,2})?\s*元|\b(?:RMB|CNY|USD)\s*\d""",
        RegexOption.IGNORE_CASE,
    )

    /*
     * 花钱 / 下单的动词词根。每个词后面带「只读例外」的负向断言:
     *   支付宝       App 名, 不是付款键
     *   支付方式 / 设置 / 管理 / 密码 / 安全   设置类入口
     *   付款方式 / 付款码 / 付款说明         只读入口 / 收款码
     *   充值中心 / 充值记录 / 充值说明       只是进页面, 真正的付款键叫「立即充值」
     */
    private val VERB = Regex(
        listOf(
            "支付(?!宝|方式|设置|管理|密码|安全|帮助|说明|服务|账单|记录)",
            "付款(?!方式|码|说明|备注|帮助|设置|记录)",
            "充值(?!中心|记录|说明|优惠|客服|方式|账单)",
            "提现",
            "转账",
            /* 「去结算」只是进确认页 (还能改地址、看价), 不拦 —— 拦的是确认页上真扣钱的那一下;
             * 带金额的「结算 ¥32」由金额判据拦 */
            "确认结算",
            "下单",
            "购买(?!记录|须知|说明)",
            "续费",
            "免密",
            "(?:开通|订购|订阅)(?:会员|VIP|vip|Plus|PLUS|plus|年卡|月卡|季卡|超级会员|亲情卡|自动扣款)",
            "(?:叫车|打车)",
            "(?:立即|马上|确认|一键|呼叫)用车",
            "呼叫(?!客服|电话|中心|帮助)",
            "提交订单",
            "确认订单",
            "生成订单",
            /* 英文 App: Pay / Checkout / Place order / Buy now / Purchase / Subscribe / Top up */
            "\\bpay\\b",
            "\\bcheckout\\b",
            "\\bplace\\s*order\\b",
            "\\bbuy\\s*now\\b",
            "\\bpurchase\\b",
            "\\btop\\s*up\\b",
            "\\brecharge\\b",
            "\\bconfirm\\s+(?:order|payment|purchase|pay)\\b",
        ).joinToString("|"),
        RegexOption.IGNORE_CASE,
    )

    /*
     * 只用来压低「金额」判据的误伤: 一行字里有价格、但它是看 / 领 / 说明类内容, 不算付款键。
     * 例: 「查看订单 ¥42」「¥10 优惠券」「满100元减10」「¥42 起送」。
     * 注意它只作用于金额判据 —— 词根命中照拦, 所以「余额支付」照样拦 (词根 支付)。
     */
    private val READ_ONLY = Regex(
        """支付宝|查看|详情|记录|明细|历史|优惠|券|红包|积分|余额|账单|客服|帮助|说明|规则|协议|起送|配送|运费|价格|原价|参考价|服务费|立减|满减|折扣|补贴|减""",
        RegexOption.IGNORE_CASE,
    )

    /** 这段控件文字点下去会不会扣钱 / 下单 */
    fun isMoneyAction(label: String): Boolean {
        val s = normalize(label)
        if (s.isEmpty()) return false
        if (VERB.containsMatchIn(s)) return true
        /* 「去 结 算」这类被插了空格的按钮字 */
        val compact = s.filterNot { it.isWhitespace() }
        if (compact != s && VERB.containsMatchIn(compact)) return true
        return AMOUNT.containsMatchIn(s) && !READ_ONLY.containsMatchIn(s)
    }

    /** 全角数字 / 全角货币符 → 半角, 去掉零宽字符 */
    private fun normalize(label: String): String {
        val sb = StringBuilder(label.length)
        for (c in label) {
            when {
                c in '\uFF10'..'\uFF19' -> sb.append('0' + (c - '\uFF10'))
                c == '\uFFE5' || c == '\uFF04' -> sb.append('¥')
                c == '\u00A0' || c == '\u200B' || c == '\uFEFF' -> sb.append(' ')
                else -> sb.append(c)
            }
        }
        return sb.toString().trim()
    }
}
