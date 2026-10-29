package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「让 Pilot 一直在线」的厂商地图 (2026-10-18)。只测纯映射: 不碰 Android 组件,
 * 因此这里能覆盖的是「厂商认没认对 / 每项有没有候选组件和手动路径」。
 */
class PilotKeepAlivePlanTest {

    @Test
    fun vendorOf_recognizesMajorChineseRoms() {
        assertEquals(PilotKeepAlivePlan.XIAOMI, PilotKeepAlivePlan.vendorOf("Xiaomi", "Redmi"))
        assertEquals(PilotKeepAlivePlan.XIAOMI, PilotKeepAlivePlan.vendorOf("Xiaomi", "POCO"))
        assertEquals(PilotKeepAlivePlan.HUAWEI, PilotKeepAlivePlan.vendorOf("HUAWEI", "HONOR"))
        assertEquals(PilotKeepAlivePlan.HUAWEI, PilotKeepAlivePlan.vendorOf("HONOR", "HONOR"))
        assertEquals(PilotKeepAlivePlan.OPPO, PilotKeepAlivePlan.vendorOf("OPPO", "OPPO"))
        assertEquals(PilotKeepAlivePlan.OPPO, PilotKeepAlivePlan.vendorOf("OnePlus", "OnePlus"))
        assertEquals(PilotKeepAlivePlan.OPPO, PilotKeepAlivePlan.vendorOf("realme", "realme"))
        assertEquals(PilotKeepAlivePlan.VIVO, PilotKeepAlivePlan.vendorOf("vivo", "vivo"))
        assertEquals(PilotKeepAlivePlan.VIVO, PilotKeepAlivePlan.vendorOf("iQOO", "vivo"))
        assertEquals(PilotKeepAlivePlan.SAMSUNG, PilotKeepAlivePlan.vendorOf("samsung", "samsung"))
        assertEquals(PilotKeepAlivePlan.STOCK, PilotKeepAlivePlan.vendorOf("Google", "google"))
        assertEquals(PilotKeepAlivePlan.STOCK, PilotKeepAlivePlan.vendorOf(null, null))
    }

    @Test
    fun items_miuiHasTwoExtraSwitches() {
        assertEquals(
            listOf("accessibility", "notifications", "battery", "autostart", "background_popup", "lockscreen"),
            PilotKeepAlivePlan.items(PilotKeepAlivePlan.XIAOMI),
        )
        assertEquals(
            listOf("accessibility", "notifications", "battery", "autostart"),
            PilotKeepAlivePlan.items(PilotKeepAlivePlan.HUAWEI),
        )
        assertEquals(
            listOf("accessibility", "notifications", "battery", "autostart"),
            PilotKeepAlivePlan.items(PilotKeepAlivePlan.STOCK),
        )
    }

    @Test
    fun detectable_onlyEvidenceBasedItems() {
        assertTrue(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.A11Y))
        assertTrue(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.NOTIF))
        assertTrue(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.BATTERY))
        assertFalse(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.AUTOSTART))
        assertFalse(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.BACKGROUND_POPUP))
        assertFalse(PilotKeepAlivePlan.detectable(PilotKeepAlivePlan.LOCKSCREEN))
    }

    @Test
    fun everyVendorAndItem_hasManualPath() {
        for (vendor in listOf(
            PilotKeepAlivePlan.XIAOMI, PilotKeepAlivePlan.HUAWEI, PilotKeepAlivePlan.OPPO,
            PilotKeepAlivePlan.VIVO, PilotKeepAlivePlan.SAMSUNG, PilotKeepAlivePlan.STOCK,
        )) {
            for (item in PilotKeepAlivePlan.items(vendor)) {
                assertTrue("$vendor/$item 缺手动路径", PilotKeepAlivePlan.manual(vendor, item).isNotBlank())
            }
        }
    }

    @Test
    fun vendorHandles_haveCandidateComponents() {
        for (vendor in listOf(
            PilotKeepAlivePlan.XIAOMI, PilotKeepAlivePlan.HUAWEI, PilotKeepAlivePlan.OPPO,
            PilotKeepAlivePlan.VIVO, PilotKeepAlivePlan.SAMSUNG,
        )) {
            val comps = PilotKeepAlivePlan.components(vendor, PilotKeepAlivePlan.AUTOSTART) +
                PilotKeepAlivePlan.components(vendor, PilotKeepAlivePlan.BATTERY)
            assertTrue("$vendor 没给任何厂商组件", comps.isNotEmpty())
            comps.forEach { (pkg, cls) ->
                assertTrue(pkg.contains('.'))
                assertTrue(cls.contains('.'))
            }
        }
        /* 原生系统没有厂商页, 只靠标准 action */
        assertTrue(PilotKeepAlivePlan.components(PilotKeepAlivePlan.STOCK, PilotKeepAlivePlan.AUTOSTART).isEmpty())
    }
}
