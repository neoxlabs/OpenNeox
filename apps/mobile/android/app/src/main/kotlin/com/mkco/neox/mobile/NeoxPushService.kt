package com.mkco.neox.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * FCM 推送 (2026-10-02) —— App 被系统杀了 / 锁屏几小时后, 中继连接早断了; 电脑上 (以后是云端值班)
 * 的 Pilot 要找你, 只能靠推送把这台手机叫起来。
 *
 * 服务器只发 data 消息 (neox_kind + 一句话), 这里决定怎么响:
 *   call  → 跟连着时一模一样的系统来电 (PilotCallBridge.showIncoming): 锁屏全屏、接/挂按钮。
 *           点开 App 后连回电脑, 电脑把还在响的那通补发过来, Dart 侧按你点的接/挂处理。
 *   alert → 高优先通知, 点开进 App
 *   wake  → 什么都不显示 (以后给"有活要手机办"用)
 * 走原生不走 Dart: 被推送拉起时没有 Flutter 引擎, 来电要立刻响, 不能等引擎冷启动。
 *
 * 没有 Firebase 配置 (开源版, 见 app/firebase.properties) 时 FirebaseApp 没初始化, 令牌返回 null, 整块不生效。
 */
class NeoxPushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val title = d["title"].orEmpty()
        val body = d["body"].orEmpty()
        Log.i(TAG, "push ${d["neox_kind"]} sent_at=${d["sent_at"]}")
        /* 收到的每条都记进消息页 (2026-10-10 用户: 「推送后没有消息显示页面, 我就很懵」) —— 通知栏划掉就没了,
         * App 里得有个地方能回看。wake 是静默的不记。 */
        if (d["neox_kind"] == "alert" || d["neox_kind"] == "call") {
            recordInbox(applicationContext, d["neox_kind"].orEmpty(), title.ifBlank { "Pilot" }, body, d)
        }
        when (d["neox_kind"]) {
            "call" -> {
                val callId = d["call_id"].orEmpty()
                if (callId.isEmpty()) return
                /* 推送路上耗掉的时间要从响铃里扣掉: 电脑那边响满就按没接处理了 */
                val ring = d["ring_seconds"]?.toIntOrNull() ?: 25
                val sentAt = d["sent_at"]?.toLongOrNull() ?: System.currentTimeMillis()
                val left = ring - ((System.currentTimeMillis() - sentAt) / 1000).toInt()
                if (left < 3) return
                if (d["pilot_id"].isNullOrEmpty()) {
                    PilotCallBridge.rememberDesktop(applicationContext, callId, d["desktop_id"].orEmpty())
                } else {
                    /* 云端的 Pilot 打来的 (2026-10-03): 没有电脑补发, 来电信息全在这条推送里 */
                    PilotCallBridge.rememberCloud(applicationContext, callId, org.json.JSONObject(d as Map<*, *>).toString())
                }
                PilotCallBridge.showIncoming(applicationContext, callId, title.ifBlank { "Pilot" }, body, left)
                /* App 界面正开着 (连着别的电脑 / 没连上): 系统来电只进通知栏 —— vivo 等默认不给「悬浮通知」,
                 * 你看不见 (2026-10-02 真机)。直接交给 App: 切到打来的电脑, 那台补发这通, App 里弹来电页 */
                PilotCallBridge.instance?.let { b -> Handler(Looper.getMainLooper()).post { b.deliver(callId, "open") } }
            }
            /* 触发引擎的到点提醒 / 晨间简报 / 成品做好了 / 专员交了汇报: 点开是 Pilot「今天」页; 其余进消息页 */
            /* 2026-10-11: Pilot 发的一律落「今天」页, 顶上摆着点的那一条 + 能直接办的按钮 (提醒、汇报原来进消息页, 只能再读一遍推送) */
            "alert" -> showAlert(applicationContext, title.ifBlank { "Pilot" }, body,
                if (d["neox_action"].orEmpty().startsWith("pilot_")) "pilot_today" else "inbox", d)
            /* wake 不显示; 带 call_end = 这通在别的手机上接了 / 已经结束, 这台别再响 */
            "wake" -> if (d["neox_action"] == "call_end") PilotCallBridge.cancelIf(applicationContext, d["call_id"].orEmpty())
            else -> {}
        }
    }

    override fun onNewToken(token: String) {
        /* 令牌轮换: 记下, App 下次起来 (或正开着) 时 Dart 侧重新登记到服务器 */
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
        /* 这个回调在 FCM 的工作线程上, Flutter 通道只能在主线程调 (直接调会崩) */
        val b = bridge ?: return
        Handler(Looper.getMainLooper()).post { b.channel.invokeMethod("onToken", token) }
    }

    private fun showAlert(ctx: Context, title: String, body: String, open: String = "inbox", data: Map<String, String> = emptyMap()) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ALERT_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, "Pilot 找你", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "电脑或云端上的 Pilot 有要紧的事"
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        }
        val notifId = (System.currentTimeMillis() / 1000 % 100000).toInt() + 5000
        /* 点开要落到「这一条」上 (2026-10-11 用户: 推送点进去啥也没有) —— 这条的内容跟着意图走。
         * 请求码一条一个: 原来固定 7/8 + UPDATE_CURRENT, 后到的通知会把前面几条的意图盖掉 */
        val item = org.json.JSONObject()
            .put("title", title).put("body", body)
            .put("data", org.json.JSONObject(data as Map<*, *>)).toString()
        val pi = PendingIntent.getActivity(ctx, notifId,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_OPEN, open)
                .putExtra(EXTRA_OPEN_ITEM, item),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(ctx, ALERT_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        nm.notify(notifId, n)
    }

    /** Dart 侧: getToken 拿令牌去登记; onToken 收轮换 */
    class Bridge(private val ctx: Context, messenger: BinaryMessenger) {
        val channel = MethodChannel(messenger, CHANNEL)

        init {
            bridge = this
            channel.setMethodCallHandler { call, result ->
                when (call.method) {
                    "getToken" -> {
                        if (FirebaseApp.getApps(ctx).isEmpty()) { result.success(null); return@setMethodCallHandler }
                        FirebaseMessaging.getInstance().token
                            .addOnSuccessListener { t ->
                                ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_TOKEN, t).apply()
                                result.success(t)
                            }
                            .addOnFailureListener { e ->
                                Log.w(TAG, "getToken failed: ${e.message}")
                                /* 拿不到新的就给上次存的 (没网 / Google 服务抽风) */
                                result.success(ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TOKEN, null))
                            }
                    }
                    /* 取走原生攒下的推送 (App 没开时收到的) + 是不是点通知进来的; 取完清空 */
                    "drainInbox" -> {
                        val prefs = ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
                        val out = org.json.JSONObject()
                            .put("items", org.json.JSONArray(prefs.getString(KEY_INBOX, "[]")))
                            .put("open", prefs.getBoolean(KEY_OPEN_INBOX, false))
                            .put("target", prefs.getString(KEY_OPEN_TARGET, "inbox"))
                            .put("item", prefs.getString(KEY_OPEN_ITEM, null)?.let { try { org.json.JSONObject(it) } catch (_: Exception) { null } })
                        prefs.edit().remove(KEY_INBOX).remove(KEY_OPEN_INBOX).remove(KEY_OPEN_TARGET).remove(KEY_OPEN_ITEM).apply()
                        result.success(out.toString())
                    }
                    else -> result.notImplemented()
                }
            }
        }

        /** 有新消息 / 点了通知: App 开着就叫 Dart 马上来取 */
        fun poke() {
            Handler(Looper.getMainLooper()).post { channel.invokeMethod("onInbox", null) }
        }

        fun dispose() {
            if (bridge === this) bridge = null
        }
    }

    companion object {
        /** 推送记一条到待取队列 (最多攒 200 条), App 开着就叫它来取 */
        fun recordInbox(ctx: Context, kind: String, title: String, body: String, data: Map<String, String>) {
            val prefs = ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            val arr = try { org.json.JSONArray(prefs.getString(KEY_INBOX, "[]")) } catch (_: Exception) { org.json.JSONArray() }
            arr.put(org.json.JSONObject()
                .put("kind", kind).put("title", title).put("body", body)
                .put("ts", System.currentTimeMillis())
                .put("data", org.json.JSONObject(data as Map<*, *>)))
            while (arr.length() > 200) arr.remove(0)
            prefs.edit().putString(KEY_INBOX, arr.toString()).apply()
            bridge?.poke()
        }

        /** 点了推送通知进 App: 记下要打开消息页 */
        /** [target]: inbox = 消息页 / pilot_today = Pilot「今天」页 */
        fun requestOpenInbox(ctx: Context, target: String = "inbox", item: String? = null) {
            ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_OPEN_INBOX, true).putString(KEY_OPEN_TARGET, target)
                .putString(KEY_OPEN_ITEM, item).apply()
            bridge?.poke()
        }

        const val EXTRA_OPEN = "neox_open"
        const val EXTRA_OPEN_ITEM = "neox_open_item"
        const val KEY_OPEN_ITEM = "open_item"
        const val KEY_INBOX = "inbox_queue"
        const val KEY_OPEN_INBOX = "open_inbox"
        const val KEY_OPEN_TARGET = "open_target"
        const val TAG = "NeoxPush"
        const val CHANNEL = "neox.push"
        const val ALERT_CHANNEL = "pilot_push_alerts"
        const val PREFS = "neox_push"
        const val KEY_TOKEN = "fcm_token"
        var bridge: Bridge? = null
    }
}
