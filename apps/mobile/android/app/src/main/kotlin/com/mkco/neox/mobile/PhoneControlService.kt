package com.mkco.neox.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 操控期前台服务 (pilot:D-12, 2026-10-18)。
 *
 * Phone Use 在别的 App 里点点按按时, Neox 自己是后台的 —— 小米 / 华为 / OPPO 这类 ROM 会把
 * 后台进程收掉, 无障碍服务一断, 操控就停在半路。操控期间挂一个前台服务, 进程落到「前台服务」
 * 这一档, 不会被省电策略当成空闲进程清掉; 状态栏也看得见「Neox 正在操控手机」。
 *
 * 与 [KeepAliveService] 分开: 那个是「跟电脑同步任务」的常驻, 切回前台会被 ws_client 停掉;
 * 操控有自己明确的开始 (第一次 phone_ui) 和结束 (悬浮层收起 / 用户点停止)。
 *
 * 系统不允许从后台启动前台服务时 (Android 12+ 的启动限制), 这里静默失败: 操控照旧,
 * 只是少了这层保护 —— 下次在 Neox 里先打开一个 App 再操控, 通常就能起来。
 */
class PhoneControlService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        ensureChannel(this)
        val open = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("Neox 正在操控手机")
            .setContentText("正在替你操作 · 回到 Neox 可以随时停")
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Throwable) {
            /* 系统不让起: 操控继续, 只是没有这层保活 */
            running = false
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "neox_control"
        private const val NOTIFICATION_ID = 7302

        /** 已经在跑 —— 操控每走一步都会叫一次 start, 别反复重建通知 */
        @Volatile
        private var running = false

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "操控中", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Agent 在别的 App 里替你操作时显示"
                    setShowBadge(false)
                },
            )
        }

        fun start(ctx: Context) {
            if (running) return
            try {
                val i = Intent(ctx, PhoneControlService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
                running = true
            } catch (_: Throwable) {
                running = false
            }
        }

        fun stop(ctx: Context) {
            running = false
            try {
                ctx.stopService(Intent(ctx, PhoneControlService::class.java))
            } catch (_: Throwable) {
            }
        }
    }
}
