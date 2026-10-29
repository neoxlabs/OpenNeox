package com.mkco.neox.mobile

import java.math.BigDecimal

/**
 * 点前记金额、点后对比 (pilot:S-02)
 *
 * PayGuard 只看「按钮上的字」——「确认支付」「提交订单」这类按钮字里没有金额，
 * 用户同意的是确认页上的 ¥32，点下去页面却可能变成 ¥320（改价、加购、默认勾选），
 * 按钮字一直没变，闸就拦不住。
 *
 * 所以这里从整屏控件文字里读出「这一单要付多少」，在两个时刻各读一次：
 *   · 用户点头前（被拦下时）记一次 —— 这是用户同意的数；
 *   · 点下去之后再读一次 —— 变了就告诉模型停下，让用户重新拍板。
 *
 * 取数规则（宁可漏读，不乱读）：
 *   1. 带「合计 / 总计 / 应付 / 实付 / 待支付 / 小计 / 优惠后…」的行，取标签后第一个金额；
 *   2. 没有这类行，取全屏最大金额，但跳过「余额 / 红包 / 积分 / 优惠 / 原价 / 起送」这类行
 *      （它们是屏幕上最大的那个数，却不是要付的钱）；
 *   3. 都没有 → null，不比对（不拿猜测当依据）。
 *
 * 只认「变大」：变便宜不用拦。判定写成纯函数（不碰 Android API），由 JVM 单测逐条钉住。
 */
object PayAmountWatch {

    /* 金额数字：1,299.00 / 32 / 9.99 */
    private const val NUM = """\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"""

    /* ¥32 / ￥1,299.00 / $9.99 */
    private val SYMBOL = Regex("""[¥￥$]\s*($NUM)""")
    /* 32元 / 1,299 元 */
    private val YUAN = Regex("""($NUM)\s*元""")
    /* RMB 50 / CNY 32.5 */
    private val CODE = Regex("""\b(?:RMB|CNY|USD)\s*($NUM)""", RegexOption.IGNORE_CASE)

    /* 「这一单多少钱」的行标签 */
    private val TOTAL_LABEL = Regex(
        """合计|总计|应付|实付|待支付|支付金额|订单金额|需支付|优惠后|实付款|总价|小计|共\s*\d""",
    )

    /* 有金额但不是要付的钱的行：余额 / 红包 / 优惠 / 原价 / 起送价… */
    private val NOT_PAYABLE = Regex(
        """余额|红包|积分|优惠|立减|折扣|原价|参考价|起送|可用|剩余|券|减""",
        RegexOption.IGNORE_CASE,
    )

    /** 点下去之后金额反而变大 */
    data class Escalation(val before: BigDecimal, val after: BigDecimal) {
        val beforeText: String get() = money(before)
        val afterText: String get() = money(after)
        val message: String get() = "点之前的金额是 ¥$beforeText, 点完变成 ¥$afterText"
    }

    /** 整屏控件文字 → 这一单要付的金额；读不出来给 null */
    fun payable(screen: String?): BigDecimal? {
        if (screen.isNullOrBlank()) return null
        val text = normalize(screen)
        var labelled: BigDecimal? = null
        var biggest: BigDecimal? = null
        for (line in text.split('\n')) {
            labelledAmount(line)?.let { labelled = max(labelled, it) }
            if (!NOT_PAYABLE.containsMatchIn(line)) {
                for (a in amountsIn(line)) biggest = max(biggest, a)
            }
        }
        return labelled ?: biggest
    }

    /** 只在「点完更贵」时返回变化；任何一边读不到金额都不报（不拿猜测当依据） */
    fun escalated(before: BigDecimal?, after: BigDecimal?): Escalation? {
        if (before == null || after == null) return null
        return if (after.compareTo(before) > 0) Escalation(before, after) else null
    }

    /** 行里最后一个合计类标签后面的第一个金额（「原价 ¥100 合计 ¥80」取 80） */
    private fun labelledAmount(line: String): BigDecimal? {
        val m = TOTAL_LABEL.findAll(line).lastOrNull() ?: return null
        return amountsIn(line.substring(m.range.last + 1)).firstOrNull()
    }

    private fun amountsIn(text: String): List<BigDecimal> {
        val out = mutableListOf<BigDecimal>()
        for (m in SYMBOL.findAll(text)) out += toAmount(m.groupValues[1])
        for (m in YUAN.findAll(text)) out += toAmount(m.groupValues[1])
        for (m in CODE.findAll(text)) out += toAmount(m.groupValues[1])
        return out
    }

    private fun toAmount(raw: String): BigDecimal = BigDecimal(raw.replace(",", ""))

    private fun max(a: BigDecimal?, b: BigDecimal): BigDecimal = if (a == null || b > a) b else a

    private fun money(v: BigDecimal): String = v.stripTrailingZeros().toPlainString()

    /** 全角数字 / 全角货币符 → 半角, 去零宽字符 */
    private fun normalize(s: String): String {
        val sb = StringBuilder(s.length)
        for (c in s) {
            when {
                c in '\uFF10'..'\uFF19' -> sb.append('0' + (c - '\uFF10'))
                c == '\uFFE5' || c == '\uFF04' -> sb.append('¥')
                c == '\u00A0' || c == '\u200B' || c == '\uFEFF' -> sb.append(' ')
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }
}
