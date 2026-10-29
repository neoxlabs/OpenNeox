package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigDecimal

/**
 * 点前记金额、点后对比 (pilot:S-02)
 *
 * 左边这组钉「读得对」—— 读错一个数，用户同意的金额就记错了；
 * 右边这组钉「不乱拦」—— 余额、优惠券、原价这些不是要付的钱，读成付款额会天天误拦。
 */
class PayAmountWatchTest {

    private fun amount(screen: String): BigDecimal? = PayAmountWatch.payable(screen)

    private fun assertAmount(expected: String, screen: String) {
        val got = amount(screen)
        assertNotNull("「$screen」应该读出一个金额", got)
        /* 按数值比 (32 与 32.00 是同一个价, BigDecimal.equals 会因 scale 不同判不等) */
        assertEquals("「$screen」读错了", 0, BigDecimal(expected).compareTo(got))
    }

    @Test
    fun `合计类标签优先于屏幕上更大的数`() {
        assertAmount("32", "合计 ¥32.00")
        assertAmount("80", "原价 ¥100 合计 ¥80")
        assertAmount("32", "合计 ¥32 优惠 ¥5")
        assertAmount("1299.00", "总计: ￥1,299.00")
        assertAmount("45.5", "应付 45.5 元")
    }

    @Test
    fun `没有合计行时取最大金额`() {
        assertAmount("32", "¥32")
        assertAmount("32", "32元")
        assertAmount("9.99", "$9.99")
        assertAmount("50", "RMB 50")
        assertAmount("32", "￥３２")
        assertAmount("20", "小份 ¥12\n大份 ¥20")
    }

    @Test
    fun `余额优惠原价这类不是要付的钱`() {
        assertNull(amount("余额 ¥1000.00"))
        assertNull(amount("¥10 优惠券"))
        assertNull(amount("满100元减10"))
        assertNull(amount("¥42 起送"))
        assertNull(amount(""))
        assertNull(amount("屏幕上没有价格"))
    }

    @Test
    fun `余额再大也不盖过合计`() {
        assertAmount("32", "合计 ¥32.00\n余额 ¥1000.00")
        assertAmount("32", "余额 ¥1000.00\n合计 ¥32.00\n红包 ¥5")
    }

    @Test
    fun `点完金额变大才报`() {
        val up = PayAmountWatch.escalated(BigDecimal("32"), BigDecimal("320"))
        assertNotNull(up)
        assertEquals("32", up!!.beforeText)
        assertEquals("320", up.afterText)
        assertEquals("点之前的金额是 ¥32, 点完变成 ¥320", up.message)

        /* 只是小数点写法不同 / 变便宜 / 缺一边 —— 都不报 */
        assertNull(PayAmountWatch.escalated(BigDecimal("32"), BigDecimal("32.00")))
        assertNull(PayAmountWatch.escalated(BigDecimal("32"), BigDecimal("29")))
        assertNull(PayAmountWatch.escalated(null, BigDecimal("320")))
        assertNull(PayAmountWatch.escalated(BigDecimal("32"), null))
    }

    @Test
    fun `真实页面片段 32 变 320`() {
        val before = "[12] 文字 「商品总价」\n[13] 文字 「合计 ¥32.00」\n[14] 按钮 「确认支付」"
        val after = "[9] 文字 「订单金额」\n[10] 文字 「合计 ¥320.00」\n[11] 按钮 「确认支付」"
        val change = PayAmountWatch.escalated(PayAmountWatch.payable(before), PayAmountWatch.payable(after))
        assertNotNull(change)
        assertEquals("32", change!!.beforeText)
        assertEquals("320", change.afterText)
    }
}
