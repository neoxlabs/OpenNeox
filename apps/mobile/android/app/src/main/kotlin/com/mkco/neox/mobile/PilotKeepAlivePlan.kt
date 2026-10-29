package com.mkco.neox.mobile

/**
 * 「让 Pilot 一直在线」的厂商地图 (2026-10-18)。
 *
 * 国产 ROM 的省电 / 自启动开关散在各自的系统管理器里, AOSP 的标准设置页上根本没有,
 * 所以跳转只能按厂商硬编码 —— 每个条目给一组候选组件, 从新到旧挨个试, 都试不通
 * 由 [PilotKeepAliveBridge] 回落到应用详情页, 同时页面上显示这里的手动路径。
 *
 * 这个文件**不引用 android.***, 只做字符串映射, 方便跑 JVM 单测 (PilotKeepAlivePlanTest)。
 * 组件对不上 ROM 版本是常态 (小米/华为都改过好几次包名), 所以宁可多列几条候选。
 */
object PilotKeepAlivePlan {

    const val A11Y = "accessibility"
    const val NOTIF = "notifications"
    const val BATTERY = "battery"
    const val AUTOSTART = "autostart"
    const val BACKGROUND_POPUP = "background_popup"
    const val LOCKSCREEN = "lockscreen"

    const val XIAOMI = "xiaomi"
    const val HUAWEI = "huawei"
    const val OPPO = "oppo"
    const val VIVO = "vivo"
    const val SAMSUNG = "samsung"
    const val STOCK = "stock"

    /** Build.MANUFACTURER / Build.BRAND (小写) → 厂商。认不出的按原生处理 */
    fun vendorOf(manufacturer: String?, brand: String?): String {
        val m = (manufacturer ?: "").lowercase()
        val b = (brand ?: "").lowercase()
        return when {
            listOf("xiaomi", "redmi", "poco").any { m.contains(it) || b.contains(it) } -> XIAOMI
            listOf("huawei", "honor", "hihonor").any { m.contains(it) || b.contains(it) } -> HUAWEI
            listOf("oppo", "oneplus", "realme", "oplus").any { m.contains(it) || b.contains(it) } -> OPPO
            listOf("vivo", "iqoo").any { m.contains(it) || b.contains(it) } -> VIVO
            listOf("samsung").any { m.contains(it) || b.contains(it) } -> SAMSUNG
            else -> STOCK
        }
    }

    /** 这页对该厂商要列哪几项。后台弹出 / 锁屏显示是 MIUI 独有的两道开关, 别家没有就不显示 */
    fun items(vendor: String): List<String> = when (vendor) {
        XIAOMI -> listOf(A11Y, NOTIF, BATTERY, AUTOSTART, BACKGROUND_POPUP, LOCKSCREEN)
        else -> listOf(A11Y, NOTIF, BATTERY, AUTOSTART)
    }

    /** 真能检测的只有这三项; 自启动 / 后台弹出 / 锁屏显示 系统没有查询接口 */
    fun detectable(item: String): Boolean = item == A11Y || item == NOTIF || item == BATTERY

    /** 该项对应的系统设置 action (标准入口); 厂商页单独在 [components] */
    fun action(item: String): String? = when (item) {
        A11Y -> "android.settings.ACCESSIBILITY_SETTINGS"
        NOTIF -> "android.settings.NOTIFICATION_LISTENER_SETTINGS"
        BATTERY -> "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"
        else -> null
    }

    /** 厂商页候选: 包名 to 类名, 按 ROM 新旧排序 */
    fun components(vendor: String, item: String): List<Pair<String, String>> = when (vendor) {
        XIAOMI -> when (item) {
            AUTOSTART -> listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            )
            BACKGROUND_POPUP, LOCKSCREEN -> listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.permissions.PermissionsEditorActivity",
                "com.miui.securitycenter" to "com.miui.permcenter.permissions.AppPermissionsEditorActivity",
            )
            BATTERY -> listOf(
                "com.miui.powerkeeper" to "com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
            )
            else -> emptyList()
        }
        HUAWEI -> when (item) {
            AUTOSTART -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
                "com.hihonor.systemmanager" to "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.hihonor.systemmanager" to "com.hihonor.systemmanager.optimize.process.ProtectActivity",
            )
            BATTERY -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.power.ui.HwPowerManagerActivity",
                "com.hihonor.systemmanager" to "com.hihonor.systemmanager.power.ui.HwPowerManagerActivity",
            )
            else -> emptyList()
        }
        OPPO -> when (item) {
            AUTOSTART -> listOf(
                "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
                "com.oplus.safecenter" to "com.oplus.safecenter.permission.startup.StartupAppListActivity",
                "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            )
            BATTERY -> listOf(
                "com.coloros.oppoguardelf" to "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
            )
            else -> emptyList()
        }
        VIVO -> when (item) {
            AUTOSTART -> listOf(
                "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
                "com.vivo.abe" to "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity",
            )
            BATTERY -> listOf(
                "com.vivo.abe" to "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity",
            )
            else -> emptyList()
        }
        SAMSUNG -> when (item) {
            BATTERY -> listOf(
                "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity",
                "com.samsung.android.sm" to "com.samsung.android.sm.ui.battery.BatteryActivity",
            )
            else -> emptyList()
        }
        else -> emptyList()
    }

    /** 跳不到时页面上显示的手动路径 (一句) */
    fun manual(vendor: String, item: String): String = when (vendor) {
        XIAOMI -> when (item) {
            A11Y -> "设置 → 更多设置 → 无障碍 → 已下载的应用 → Neox Pilot"
            NOTIF -> "设置 → 应用设置 → 应用管理 → Neox → 通知使用权（读取通知）"
            BATTERY -> "设置 → 省电与电池 → 应用智能省电 → Neox 选「不限制」"
            AUTOSTART -> "设置 → 应用设置 → 应用管理 → Neox → 自启动"
            BACKGROUND_POPUP -> "设置 → 应用设置 → 应用管理 → Neox → 权限管理 → 后台弹出界面"
            LOCKSCREEN -> "设置 → 应用设置 → 应用管理 → Neox → 权限管理 → 锁屏显示"
            else -> ""
        }
        HUAWEI -> when (item) {
            A11Y -> "设置 → 辅助功能 → 无障碍 → 已下载的应用 → Neox Pilot"
            NOTIF -> "设置 → 通知和状态栏 → 通知使用权 → Neox"
            BATTERY -> "设置 → 电池 → 更多电池设置 → 允许后台活动"
            AUTOSTART -> "设置 → 应用 → 应用启动管理 → Neox 关掉「自动管理」，三项都允许"
            else -> ""
        }
        OPPO -> when (item) {
            A11Y -> "设置 → 系统设置 → 无障碍 → 已下载的应用 → Neox Pilot"
            NOTIF -> "设置 → 通知与状态栏 → 通知使用权 → Neox"
            BATTERY -> "设置 → 电池 → 更多 → 应用耗电管理 → Neox：允许后台活动"
            AUTOSTART -> "设置 → 应用 → 自启动管理 → 打开 Neox"
            else -> ""
        }
        VIVO -> when (item) {
            A11Y -> "设置 → 快捷与辅助 → 无障碍 → 已下载的应用 → Neox Pilot"
            NOTIF -> "设置 → 通知与状态栏 → 通知使用权 → Neox"
            BATTERY -> "设置 → 电池 → 后台耗电管理 → Neox：允许后台高耗电"
            AUTOSTART -> "设置 → 应用与权限 → 权限管理 → 自启动 → Neox"
            else -> ""
        }
        SAMSUNG -> when (item) {
            A11Y -> "设置 → 辅助功能 → 已安装的应用 → Neox Pilot"
            NOTIF -> "设置 → 通知 → 高级设置 → 通知使用权 → Neox"
            BATTERY -> "设置 → 电池和设备维护 → 电池 → 后台使用限制，把 Neox 移出休眠应用"
            AUTOSTART -> "设置 → 电池和设备维护 → 电池 → 后台使用限制"
            else -> ""
        }
        else -> when (item) {
            A11Y -> "设置 → 无障碍 → 已下载的应用 → Neox Pilot"
            NOTIF -> "设置 → 通知 → 通知使用权 → Neox"
            BATTERY -> "设置 → 电池 → 电池优化 → Neox 选「不优化」"
            AUTOSTART -> "设置 → 应用 → Neox → 应用的电池使用情况 → 不受限制"
            else -> ""
        }
    }
}
