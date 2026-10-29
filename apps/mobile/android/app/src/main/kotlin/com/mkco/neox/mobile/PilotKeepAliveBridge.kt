package com.mkco.neox.mobile

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * 「让 Pilot 一直在线」的原生侧 (2026-10-18)。
 *
 * 三件事:
 *   1. 真检测 —— 无障碍是否在已启用列表里、通知使用权是否给了、电池优化是否已忽略;
 *   2. 逐项跳转 —— 先试标准 action, 再试 PilotKeepAlivePlan 里的厂商组件, 都不行回落应用详情页;
 *   3. 把厂商告诉 Dart (`xiaomi` / `huawei` / …), 页面据此显示对应的手动路径。
 *
 * 自启动 / 后台弹出 / 锁屏显示 系统没有查询接口, status 里不给值, 页面标「请确认已开」。
 */
class PilotKeepAliveBridge(private val activity: Activity, messenger: BinaryMessenger) {
    private val ctx: Context = activity.applicationContext

    init {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "status" -> result.success(status())
                "open" -> result.success(open(call.argument<String>("item") ?: ""))
                else -> result.notImplemented()
            }
        }
    }

    private fun status(): Map<String, Any?> = mapOf(
        "vendor" to vendorOf(),
        "manufacturer" to (Build.MANUFACTURER ?: ""),
        "brand" to (Build.BRAND ?: ""),
        "accessibility" to accessibilityOn(ctx),
        "notifications" to notificationAccessOn(ctx),
        "battery" to batteryUnrestricted(ctx),
        "items" to PilotKeepAlivePlan.items(vendorOf()),
    )

    /** 一条设置页都没找到也要有出路: 最后一定打开应用详情页, 由页面告诉用户手动去哪 */
    private fun open(item: String): Map<String, Any> {
        val vendor = vendorOf()
        fun fire(intent: Intent): Boolean = try {
            activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Throwable) {
            false
        }

        when (item) {
            PilotKeepAlivePlan.A11Y ->
                if (fire(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))) return opened(item, vendor, "system")
            PilotKeepAlivePlan.NOTIF ->
                if (fire(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))) return opened(item, vendor, "system")
            PilotKeepAlivePlan.BATTERY -> {
                /* 已忽略时再请求一次只会闪一下就回, 直接给「电池优化」列表 */
                if (!batteryUnrestricted(ctx) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val direct = Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + ctx.packageName),
                    )
                    if (fire(direct)) return opened(item, vendor, "system")
                }
                if (fire(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) {
                    return opened(item, vendor, "system")
                }
            }
            else -> Unit
        }

        /* 厂商页: 同一个开关各家包名/类名都不一样, 挨个试 */
        val label = try {
            ctx.packageManager.getApplicationLabel(ctx.applicationInfo).toString()
        } catch (_: Throwable) {
            "Neox"
        }
        for ((pkg, cls) in PilotKeepAlivePlan.components(vendor, item)) {
            val vendorIntent = Intent().setComponent(ComponentName(pkg, cls)).apply {
                /* 小米权限编辑页 / 省电页靠这两个 extra 直接定位到本应用 */
                putExtra("extra_pkgname", ctx.packageName)
                putExtra("package_name", ctx.packageName)
                putExtra("package_label", label)
            }
            if (fire(vendorIntent)) return opened(item, vendor, "vendor")
        }

        fire(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)),
        )
        return opened(item, vendor, "appDetails")
    }

    private fun opened(item: String, vendor: String, where: String) = mapOf(
        "opened" to where,
        "item" to item,
        "vendor" to vendor,
    )

    private fun vendorOf() = PilotKeepAlivePlan.vendorOf(Build.MANUFACTURER, Build.BRAND)

    companion object {
        const val CHANNEL = "neox.phone/keepalive"

        /** 通知使用权: 系统设置里「已启用的监听器」列表里有没有 Neox 的 */
        fun notificationAccessOn(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(ctx, NeoxNotificationListener::class.java).flattenToString()
            return flat.split(":").any { it == me }
        }

        /** 无障碍: 以「已启用服务」列表为准 (服务刚开还没绑上时 instance 仍是 null) */
        fun accessibilityOn(ctx: Context): Boolean {
            if (NeoxAccessibilityService.instance != null) return true
            val flat = Settings.Secure.getString(
                ctx.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            val me = ComponentName(ctx, NeoxAccessibilityService::class.java).flattenToString()
            return flat.split(":").any { it.equals(me, ignoreCase = true) }
        }

        /** 电池优化已忽略 = 系统不会在 Doze 里掐它 */
        fun batteryUnrestricted(ctx: Context): Boolean = try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            Build.VERSION.SDK_INT < Build.VERSION_CODES.M || pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } catch (_: Throwable) {
            false
        }
    }
}
