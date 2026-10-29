package com.mkco.neox.mobile

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Debug
import java.io.File
import java.security.MessageDigest

/**
 * IntegrityChecker — 运行环境完整性检测 (root / 重打包 / 调试器 / 模拟器 / 注入框架).
 *
 * 定位: **提高逆向门槛, 不是绝对防线**. 任何客户端检测在 root + Frida 面前都能被 patch 掉;
 * 它的价值是把"随手改个 APK 重签名发出去"和"挂 Frida 抓 token"从 5 分钟变成几小时,
 * 并且给服务端一个可上报的信号 (风控侧才是真正的执法点).
 *
 * 为什么放 native 不放 Dart:
 *   Dart AOT 里这段逻辑同样能被 patch, 但 Kotlin 侧多一层 (要先脱 R8 混淆再改 smali),
 *   且 su/prop/文件系统这些探测在 JVM 侧写起来更直接.
 *
 * 设计原则:
 *   - 每项检测独立返回, 不做"一票否决" — 由 Dart 侧策略层决定怎么处置 (提示 / 降级 / 上报).
 *   - 全部 catch 兜住: 检测本身绝不能让 App 起不来.
 *   - 不做主动对抗 (不 kill 进程 / 不删数据) — 误杀真实用户的代价远大于收益.
 */
object IntegrityChecker {

    fun collect(context: Context): Map<String, Any> = mapOf(
        "rooted" to isRooted(),
        "rootSignals" to rootSignals(),
        "debuggerAttached" to isDebuggerAttached(),
        "debuggable" to isDebuggable(context),
        "emulator" to isEmulator(),
        "injectionFramework" to hasInjectionFramework(),
        "signatureSha256" to signatureSha256(context),
        "installer" to installerPackage(context),
    )

    /* ── root ───────────────────────────────────────────────────────────── */

    /** su 二进制常见落点 — Magisk 之后大多不落这些路径, 所以只作为信号之一. */
    private val SU_PATHS = arrayOf(
        "/sbin/su", "/system/bin/su", "/system/xbin/su", "/system/sbin/su",
        "/vendor/bin/su", "/su/bin/su", "/data/local/su",
        "/data/local/xbin/su", "/data/local/bin/su",
    )

    /** Magisk / SuperSU / 常见管理器的痕迹. */
    private val ROOT_APP_PATHS = arrayOf(
        "/sbin/.magisk", "/cache/.disable_magisk", "/dev/.magisk.unblock",
        "/system/app/Superuser.apk", "/system/app/SuperSU",
        "/data/adb/magisk", "/data/adb/ksu", "/data/adb/ap",
    )

    fun rootSignals(): List<String> {
        val hits = mutableListOf<String>()
        try {
            if (SU_PATHS.any { File(it).exists() }) hits.add("su_binary")
            if (ROOT_APP_PATHS.any { File(it).exists() }) hits.add("root_manager")
            /* 工程版/userdebug 固件: 正式机是 release-keys */
            if (Build.TAGS?.contains("test-keys") == true) hits.add("test_keys")
            /* ro.debuggable=1 意味着整机可 run-as 任意应用 */
            if (systemProp("ro.debuggable") == "1") hits.add("ro_debuggable")
            if (systemProp("ro.secure") == "0") hits.add("ro_insecure")
            /* 系统分区可写 = 已被改过 */
            if (isSystemPartitionWritable()) hits.add("system_rw")
            /* which su 能跑通 */
            if (canExecSu()) hits.add("su_exec")
        } catch (_: Throwable) {
        }
        return hits
    }

    fun isRooted(): Boolean = rootSignals().isNotEmpty()

    private fun isSystemPartitionWritable(): Boolean = try {
        /* /system 正常挂 ro; 挂成 rw 说明被 remount 过 */
        File("/proc/mounts").readLines().any { line ->
            val parts = line.split(" ")
            parts.size > 3 &&
                (parts[1] == "/system" || parts[1] == "/") &&
                parts[3].split(",").contains("rw")
        }
    } catch (_: Throwable) {
        false
    }

    private fun canExecSu(): Boolean = try {
        val p = Runtime.getRuntime().exec(arrayOf("which", "su"))
        val out = p.inputStream.bufferedReader().readText().trim()
        p.destroy()
        out.isNotEmpty()
    } catch (_: Throwable) {
        false
    }

    private fun systemProp(key: String): String? = try {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", key))
        val v = p.inputStream.bufferedReader().readText().trim()
        p.destroy()
        v.ifEmpty { null }
    } catch (_: Throwable) {
        null
    }

    /* ── 调试器 / 可调试 ─────────────────────────────────────────────────── */

    /** JDWP 调试器当前是否挂着 — 动态调试的直接信号. */
    fun isDebuggerAttached(): Boolean =
        try { Debug.isDebuggerConnected() } catch (_: Throwable) { false }

    /**
     * APK 自身是否带 debuggable flag.
     * 注意: 这在自家 debug 构建上恒为 true — Dart 侧策略必须结合 kReleaseMode 判断,
     * 否则开发期天天弹警告.
     */
    fun isDebuggable(context: Context): Boolean = try {
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    } catch (_: Throwable) {
        false
    }

    /* ── 模拟器 ─────────────────────────────────────────────────────────── */

    fun isEmulator(): Boolean = try {
        (Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("google_sdk") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for x86") ||
            Build.MANUFACTURER.contains("Genymotion") ||
            Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic") ||
            Build.PRODUCT == "google_sdk" ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu"))
    } catch (_: Throwable) {
        false
    }

    /* ── 注入框架 (Frida / Xposed) ───────────────────────────────────────── */

    /**
     * 只做**低成本静态探测**: 已加载的 so 名 + frida 默认落点.
     * 不扫端口 — frida-server 端口可改, 扫了也白扫还慢.
     */
    fun hasInjectionFramework(): Boolean = try {
        val maps = File("/proc/self/maps")
        val suspicious = listOf(
            "frida", "gum-js-loop", "gmain", "libxposed", "XposedBridge", "libriru", "zygisk",
        )
        val hit = maps.takeIf { it.canRead() }
            ?.bufferedReader()
            ?.useLines { lines -> lines.any { l -> suspicious.any { l.contains(it, true) } } }
            ?: false
        hit || listOf("/data/local/tmp/frida-server", "/data/local/tmp/re.frida.server")
            .any { File(it).exists() }
    } catch (_: Throwable) {
        false
    }

    /* ── 重打包检测 (最有价值的一项) ──────────────────────────────────────── */

    /**
     * 当前 APK 签名证书的 SHA-256.
     *
     * 这是**唯一能真正识别"被改过再重签名"的手段**: 攻击者拿不到你的私钥, 重签名后
     * 这个值必然变。Dart 侧拿它跟编译期常量比对; 不一致 = 这不是我们发的包。
     */
    fun signatureSha256(context: Context): String = try {
        val pm = context.packageManager
        val pkg = context.packageName
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
            val signing = info.signingInfo
            when {
                signing == null -> emptyArray()
                signing.hasMultipleSigners() -> signing.apkContentsSigners
                else -> signing.signingCertificateHistory
            }
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures ?: emptyArray()
        }
        val first = signatures.firstOrNull() ?: return ""
        MessageDigest.getInstance("SHA-256")
            .digest(first.toByteArray())
            .joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
        ""
    }

    /** 安装来源 — 侧载 (null/adb) vs 应用商店. 只做信号, 不做拦截 (国内多渠道分发). */
    fun installerPackage(context: Context): String = try {
        val pm = context.packageManager
        val pkg = context.packageName
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            pm.getInstallSourceInfo(pkg).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(pkg)
        }
        name ?: ""
    } catch (_: Throwable) {
        ""
    }
}
