package com.mkco.neox.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * ApkInstaller — App 内更新的安装环节 (Android).
 *
 * 为什么自己写而不是引第三方 ota 插件:
 *   这一步要动的东西就三件 —— 未知来源授权状态、FileProvider 授 URI、拉起系统
 *   安装器。加一个插件依赖反而多一层黑盒, 出问题时看不见。
 *
 * 三个坑, 缺一个都装不上:
 *
 *   1. Android 8 (O) 起「未知来源」是**按应用**授权的, 不再是全局开关。
 *      没授权时直接发安装 Intent 会静默什么都不发生 —— 用户看到的是"点了没反应"。
 *      必须先 canRequestPackageInstalls() 判, false 就把他送到那个应用的授权页。
 *
 *   2. Android 7 (N) 起给别的进程传 file:// 会抛 FileUriExposedException。
 *      必须走 FileProvider 换成 content:// 并带 FLAG_GRANT_READ_URI_PERMISSION,
 *      否则安装器读不到那个文件。
 *
 *   3. 签名必须跟已装的那个包一致, 否则系统报 INSTALL_FAILED_UPDATE_INCOMPATIBLE。
 *      debug 包装 release APK 必然失败 —— 这不是 bug, 是 Android 的安全模型。
 *      调试时要么两边都用 release 签名, 要么先卸载。
 */
object ApkInstaller {

    /** 这个应用有没有被授予「安装未知应用」权限. Android 8 以下恒 true. */
    fun canInstall(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return context.packageManager.canRequestPackageInstalls()
    }

    /**
     * 打开本应用的「安装未知应用」授权页.
     *
     * 用 package: uri 直达本应用那一项 —— 不带的话会落到一个全是应用的列表页,
     * 用户得自己在里面找 Neox, 多数人找不到就放弃了。
     */
    fun openInstallPermissionSettings(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}"),
        )
        try {
            activity.startActivity(intent)
        } catch (_: Throwable) {
            /* 个别定制 ROM 没有这个 Action — 退回应用详情页, 至少能手动找到开关 */
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:${activity.packageName}"),
                    )
                )
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * 拉起系统安装器.
     *
     * 返回 null = 已拉起; 非 null = 拉不起来的原因 (给 Dart 侧原样提示用户).
     */
    fun install(activity: Activity, apkPath: String): String? {
        val file = File(apkPath)
        if (!file.exists() || file.length() <= 0) {
            return "安装包不存在或为空，请重新下载"
        }
        return try {
            val uri: Uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            null
        } catch (e: Throwable) {
            "拉起安装器失败: ${e.message ?: e.javaClass.simpleName}"
        }
    }
}
