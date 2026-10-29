package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/** pilot:D-06 —— 等待看「可见变化 + 网络 idle」, 不再固定多等 3.5 秒 */
class SettleWaitTest {

    private val t0 = 10_000L

    @Test
    fun `界面变了并且网络安静 → 200ms 内就收尾`() {
        val w = SettleWait(startMs = t0, before = "a")
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0, "a", 100))
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 100, "b", 100))
        /* 变了之后还没稳够 200ms */
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 250, "b", 100))
        /* 稳定 200ms 且网络 150ms 没动 */
        assertEquals(SettleWait.Done.CHANGED, w.observe(t0 + 330, "b", 100))
    }

    @Test
    fun `界面变了但网络还在忙 → 最多再等 networkGrace 就收尾`() {
        val w = SettleWait(startMs = t0, before = "a")
        w.observe(t0, "a", 100)
        w.observe(t0 + 50, "b", 200)
        /* 流量一直在涨 */
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 300, "b", 900))
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 700, "b", 1500))
        /* 变了 700ms 后网络仍忙: 不再无限等 */
        assertEquals(SettleWait.Done.CHANGED, w.observe(t0 + 760, "b", 2000))
    }

    @Test
    fun `点了没反应 + 网络安静 → 400ms 就如实说没变, 不等到 3_5 秒`() {
        val w = SettleWait(startMs = t0, before = "a")
        w.observe(t0, "a", 100)
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 300, "a", 100))
        assertEquals(SettleWait.Done.UNCHANGED, w.observe(t0 + 450, "a", 100))
    }

    @Test
    fun `画面一直在变 → 到 maxWait 收尾, 不会无限等`() {
        val w = SettleWait(startMs = t0, before = "a")
        w.observe(t0, "a", 100)
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 1000, "b", 1000))
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 2000, "c", 2000))
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 3400, "d", 3400))
        /* 3400ms 时最后一次变化, 还没稳够 200ms; 到 maxWait 直接收尾 */
        assertEquals(SettleWait.Done.CHANGED, w.observe(t0 + 3500, "e", 3500))
    }

    @Test
    fun `点了没反应 + 网络忙 → 超过 minWait+noChangeGrace 后按没变收尾`() {
        val w = SettleWait(startMs = t0, before = "a")
        w.observe(t0, "a", 100)
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0 + 600, "a", 900))
        /* 1300ms = minWait(400) + noChangeGrace(900): 网络再忙也不再硬等 */
        assertEquals(SettleWait.Done.UNCHANGED, w.observe(t0 + 1400, "a", 1400))
    }

    @Test
    fun `第一次采样只立基线, 不会把初始流量当成变化`() {
        val w = SettleWait(startMs = t0, before = "a")
        assertEquals(SettleWait.Done.CONTINUE, w.observe(t0, "a", 5_000))
        /* 流量没再动, 过了最短观察期后算 idle */
        assertEquals(SettleWait.Done.UNCHANGED, w.observe(t0 + 450, "a", 5_000))
    }
}
