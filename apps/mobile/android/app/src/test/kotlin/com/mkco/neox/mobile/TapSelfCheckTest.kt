package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** pilot:D-07 —— 坐标点击前对文字、点完看前台 App */
class TapSelfCheckTest {

    private val pkg = "com.sankuai.meituan"
    private val title = "美团"

    @Test
    fun `没声明 expect 不拦`() {
        assertNull(TapSelfCheck.preCheck(null, "立即下单", pkg, title))
        assertNull(TapSelfCheck.preCheck("  ", "立即下单", pkg, title))
    }

    @Test
    fun `坐标上是模型以为的那个按钮 → 放行`() {
        assertNull(TapSelfCheck.preCheck("立即下单", "立即下单", pkg, title))
        /* 空白 / 大小写 / 按钮字里带价格, 也算对得上 */
        assertNull(TapSelfCheck.preCheck("立即 下单", "立即下单 ¥32", pkg, title))
    }

    @Test
    fun `App 改版 — 坐标上是别的按钮 → 拒点并说明现在是什么`() {
        val r = TapSelfCheck.preCheck("立即下单", "去结算", pkg, title)
        assertNotNull(r)
        assertTrue(r!!.contains("去结算"))
        assertTrue(r.contains("没点"))
        assertTrue(r.contains(pkg))
    }

    @Test
    fun `坐标上读不到文字 (改成图片) → 也拒, 让模型重截图`() {
        val r = TapSelfCheck.preCheck("立即下单", "", pkg, title)
        assertNotNull(r)
        assertTrue(r!!.contains("screenshot"))
    }

    @Test
    fun `点完还在原来的 App → 不提醒 (同 App 跳页标题会变, 不算点错)`() {
        assertNull(TapSelfCheck.afterTap(pkg, "美团", pkg, "外卖订单"))
    }

    @Test
    fun `点完跳到别的 App → 说清楚从哪到哪`() {
        val r = TapSelfCheck.afterTap(pkg, "美团", "com.tencent.mm", "微信", null)
        assertNotNull(r)
        assertTrue(r!!.contains("com.tencent.mm"))
        assertTrue(r.contains("微信"))
        assertTrue(r.contains(pkg))
    }

    @Test
    fun `明明要跳去指定的 App → 到了就不算异常`() {
        assertNull(TapSelfCheck.afterTap(pkg, "美团", "com.tencent.mm", "微信", "com.tencent.mm"))
    }

    @Test
    fun `读不到前台包名时不瞎提醒`() {
        assertNull(TapSelfCheck.afterTap(pkg, "美团", "", null, null))
    }
}
