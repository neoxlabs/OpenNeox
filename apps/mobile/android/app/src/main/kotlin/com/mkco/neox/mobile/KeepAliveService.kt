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
 * 电脑上有任务在跑时切到后台 → 挂这个前台服务, 让系统别冻结 App 进程 (2026-09-30 用户:
 * 「切出去回来立马又要重连, 并没有保持连接, 效率损失很大」)。
 *
 * 安卓 11+ 会在 App 进后台约 10 秒后冻结进程: 心跳停了, 电脑那头 60 秒收不到回应就断开,
 * 回来只能重连、再补历史。有前台服务的进程不算"缓存进程", 不会被冻结, 连接一直在。
 *
 * 只在"有任务在跑 + 切走"时挂 (Dart 侧判), 回到前台立刻撤 —— 空闲时不常驻、不耗电。
 * 类型用 dataSync: 语义就是"跟另一台设备同步数据"。
 */
class KeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel(this)
        val open = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Neox 正在跟电脑同步任务"
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle(title)
            .setContentText("回到 Neox 可以接着看进度")
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
            /* 系统不让起 (后台启动限制 / 权限被关): 退化成原来的行为, 回来重连 */
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "neox_keepalive"
        private const val NOTIFICATION_ID = 7301
        const val EXTRA_TITLE = "title"

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "任务同步", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "电脑上的任务在跑时, 让手机保持连接"
                    setShowBadge(false)
                },
            )
        }

        fun start(ctx: Context, title: String?): Boolean = try {
            val i = Intent(ctx, KeepAliveService::class.java)
            if (title != null) i.putExtra(EXTRA_TITLE, title)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            true
        } catch (_: Throwable) {
            false
        }

        fun stop(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, KeepAliveService::class.java))
            } catch (_: Throwable) {
            }
        }
    }
}
