package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 短信只回码与来源 (pilot:D-10)
 *
 * 验收口径: 读 10 条短信, 只返回验证码与金额字段。下面第一条测试直接拿 10 条真实形态的
 * 短信跑一遍, 断言每一行都只有 from / at / code / amount / kind 五个字段 —— 正文一个字都
 * 不能出现在结果里。剩下的是逐类判据 (验证码 / 金额 / 误判)。
 */
class SmsDigestTest {

    private val now = 1_760_000_000_000L

    private val inbox = listOf(
        "【某某银行】验证码 123456，5 分钟内有效，请勿泄露。",
        "您尾号1234的储蓄卡10月17日消费人民币268.00元，余额1,234.56元。",
        "明天下午三点老地方见，别迟到。",
        "【某宝】482913 是您的验证码，切勿告诉他人。",
        "支付成功 ¥32.00，感谢使用。",
        "Your verification code is 190283. Do not share it.",
        "【快递】您的包裹已到小区驿站，取件码 8-2-1234。",
        "验证码已发送至尾号1234的手机，验证码 654321",
        "订单 12345678 已发货，物流单号 SF1234567890。",
        "【营销】限时特惠，满100元减10元，回复TD退订。",
    )

    private fun digest(body: String) = SmsDigest.digest("1069", body, now)

    @Test
    fun `读 10 条短信只有发件方 时间 验证码 金额`() {
        val allowed = setOf("from", "at", "code", "amount", "kind")
        val rows = inbox.map { digest(it) }

        assertEquals(10, rows.size)
        for (row in rows) {
            assertTrue("多了字段: ${row.keys}", allowed.containsAll(row.keys))
            assertEquals("1069", row["from"])
            assertEquals(now, row["at"])
        }
        /* 正文里的私密内容一个字都不许出现在结果里 */
        val flat = rows.joinToString("\n") { it.toString() }
        for (body in inbox) {
            assertTrue("正文泄漏: $body", !flat.contains(body))
        }
        assertTrue(!flat.contains("老地方见"))
        assertTrue(!flat.contains("取件码"))
    }

    @Test
    fun `中文验证码 关键词在前或数字在前都认`() {
        assertEquals("123456", SmsDigest.verificationCode("【某某银行】验证码 123456，5 分钟内有效"))
        assertEquals("482913", SmsDigest.verificationCode("【某宝】482913 是您的验证码，切勿告诉他人。"))
        assertEquals("8888", SmsDigest.verificationCode("校验码：8888"))
    }

    @Test
    fun `英文验证码`() {
        assertEquals("190283", SmsDigest.verificationCode("Your verification code is 190283. Do not share it."))
        assertEquals("4321", SmsDigest.verificationCode("OTP: 4321"))
    }

    @Test
    fun `尾号里的数字不当验证码`() {
        assertEquals("654321", SmsDigest.verificationCode("验证码已发送至尾号1234的手机，验证码 654321"))
    }

    @Test
    fun `普通短信没有验证码`() {
        assertNull(SmsDigest.verificationCode("明天下午三点老地方见，别迟到。"))
        assertNull(SmsDigest.verificationCode("订单 12345678 已发货，物流单号 SF1234567890。"))
    }

    @Test
    fun `金额 人民币 元 符号三种写法都认`() {
        assertEquals("¥268.00", SmsDigest.amount("您尾号1234的储蓄卡10月17日消费人民币268.00元"))
        assertEquals("¥32.00", SmsDigest.amount("支付成功 ¥32.00，感谢使用"))
        assertEquals("¥100", SmsDigest.amount("满100元减10元"))
        assertEquals("¥1299.00", SmsDigest.amount("CNY 1299.00 paid"))
    }

    @Test
    fun `裸数字不当金额`() {
        assertNull(SmsDigest.amount("订单 12345678 已发货"))
        assertNull(SmsDigest.amount("验证码 123456"))
    }

    @Test
    fun `kind 标出这行是哪一类`() {
        assertEquals("code", digest("【某某银行】验证码 123456")["kind"])
        assertEquals("amount", digest("支付成功 ¥32.00")["kind"])
        assertEquals("other", digest("明天下午三点老地方见")["kind"])
    }

    @Test
    fun `一条短信可以同时有码和金额, 两个都留`() {
        val row = digest("验证码 123456，本次消费 268.00 元")
        assertEquals("123456", row["code"])
        assertEquals("¥268.00", row["amount"])
    }
}
