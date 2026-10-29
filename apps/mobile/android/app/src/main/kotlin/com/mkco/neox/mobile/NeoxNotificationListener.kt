package com.mkco.neox.mobile

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * 看通知 (2026-10-01): 用户在系统设置里给了「通知使用权」后, 系统把每条新通知送到这里。
 * 只在内存里留最近 100 条 —— 「微信刚才谁找我」够用, 不落盘、不上传。
 * 自己 (Neox) 的通知、持续性的 (下载进度 / 音乐播放) 不收。
 */
class NeoxNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_ONGOING_EVENT != 0) return
        val extras = n.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (title.isBlank() && text.isBlank()) return
        val app = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
        }.getOrDefault(sbn.packageName)
        val item = mapOf(
            "key" to sbn.key, "app" to app, "package" to sbn.packageName, "title" to title, "text" to text,
            "at" to sbn.postTime, "category" to (n.category ?: ""),
        )
        synchronized(buffer) {
            /* 同一条会话通知会被 App 反复更新 (key 相同) —— 只留最新那次 */
            buffer.removeAll { it["key"] == sbn.key }
            buffer.addFirst(item)
            while (buffer.size > MAX) buffer.removeLast()
        }
        /* App 开着 (Flutter 引擎在) 就立刻交给 Dart 推给电脑上的 Pilot; 不在的话下次连上时 Dart 自己按时间补拉 */
        sink?.invoke(item - "key")
    }

    companion object {
        private const val MAX = 100
        private val buffer = ArrayDeque<Map<String, Any>>()

        /** PhoneToolsBridge 挂上: 新通知 → Dart (`notificationPosted`) */
        @Volatile var sink: ((Map<String, Any>) -> Unit)? = null

        fun since(ms: Long): List<Map<String, Any>> = synchronized(buffer) {
            buffer.filter { (it["at"] as Long) > ms }.map { it - "key" }
        }

        fun recent(limit: Int): List<Map<String, Any>> = synchronized(buffer) {
            buffer.take(limit).map { it - "key" }
        }
    }
}
