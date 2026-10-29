package com.mkco.neox.mobile

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * Pilot 来电 (2026-10-01) —— Pilot 的「通话」能力在手机上的系统那一层。
 *
 * 通话样式通知 (Android 12+ CallStyle, 低版本是带接/挂按钮的高优先通知) + 全屏意图:
 * 锁屏时直接亮屏全屏响, 用着别的 App 时是顶部来电横幅; 铃声循环 (FLAG_INSISTENT), 到点自己撤。
 * 接 → 拉起 MainActivity (带 call_id), 挂 → 广播回来; 两者都转给 Dart (`onAction`)。
 */
class PilotCallBridge(activity: Activity, messenger: BinaryMessenger) {
    private val ctx = activity.applicationContext
    private val channel = MethodChannel(messenger, CHANNEL)

    init {
        instance = this
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "showIncoming" -> {
                    showIncoming(
                        ctx,
                        call.argument<String>("callId") ?: "",
                        call.argument<String>("pilotName") ?: "Pilot",
                        call.argument<String>("reason") ?: "",
                        call.argument<Int>("ringSeconds") ?: 25,
                    )
                    result.success(null)
                }
                "cancel" -> { cancel(); result.success(null) }
                "takePending" -> {
                    ready = true
                    result.success(pendingAction?.also { pendingAction = null })
                }
                else -> result.notImplemented()
            }
        }
    }

    fun cancel() {
        ctx.getSystemService(NotificationManager::class.java).cancel(NOTIF_ID)
    }

    /** 接 / 挂 / 点开 —— Flutter 那边起来了就直接转; 冷启动时先记着, Dart 起来后 takePending 取 */
    fun deliver(callId: String, action: String) {
        if (action != "open") cancel()
        /* 推送叫醒的来电带着「哪台电脑打的」: 手机可能正连着另一台, Dart 侧据此先切过去再接 / 挂 */
        val payload = mapOf(
            "callId" to callId, "action" to action, "desktopId" to desktopFor(ctx, callId).orEmpty(),
            /* 云端的 Pilot 打来的: 来电的全部信息都在推送里 (没有电脑补发), 原样交给 Dart */
            "cloud" to cloudFor(ctx, callId).orEmpty(),
        )
        if (ready) channel.invokeMethod("onAction", payload) else pendingAction = payload
    }

    fun dispose() {
        if (instance === this) instance = null
    }

    companion object {
        const val CHANNEL = "neox.pilot/call"
        const val NOTIF_CHANNEL = "pilot_call"
        const val NOTIF_ID = 4242
        const val EXTRA_CALL_ID = "pilot_call_id"
        const val EXTRA_ACTION = "pilot_call_action"
        var instance: PilotCallBridge? = null
        /** Dart 侧来电控制器起来了 (调过 takePending) 才直接转发 */
        var ready = false
        var pendingAction: Map<String, String>? = null
        /** 此刻系统来电在响的是哪通 (推送来的「别响了」只撤这一通) */
        var ringingCallId: String? = null

        private const val PREFS = "neox_pilot_call"

        /** 推送来电: 记下是哪台电脑打的 (进程可能在接 / 挂之前被杀, 所以落 prefs) */
        fun rememberDesktop(ctx: Context, callId: String, desktopId: String) {
            if (desktopId.isEmpty()) return
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().putString(callId, desktopId).apply()
        }

        fun desktopFor(ctx: Context, callId: String): String? =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(callId, null)

        /** 云端 Pilot 的来电: 推送里的那组字段 (JSON) 落 prefs —— 接的时候 App 可能刚被拉起 */
        fun rememberCloud(ctx: Context, callId: String, json: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().putString("cloud:$callId", json).apply()
        }

        fun cloudFor(ctx: Context, callId: String): String? =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("cloud:$callId", null)

        /** 别处接了 / 那边结束了: 撤掉这一通的系统来电 (别的通不动) */
        fun cancelIf(ctx: Context, callId: String) {
            if (callId != ringingCallId) return
            ringingCallId = null
            ctx.getSystemService(NotificationManager::class.java).cancel(NOTIF_ID)
        }

        private fun ensureChannel(nm: NotificationManager) {
            if (Build.VERSION.SDK_INT < 26 || nm.getNotificationChannel(NOTIF_CHANNEL) != null) return
            nm.createNotificationChannel(NotificationChannel(NOTIF_CHANNEL, "Pilot 来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Pilot 打给你时响铃"
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        }

        /** 弹系统来电。App 进程里没有 Flutter 界面时 (被推送叫醒, NeoxPushService) 也能直接调 */
        fun showIncoming(ctx: Context, callId: String, pilotName: String, reason: String, ringSeconds: Int) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            ensureChannel(nm)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val open = PendingIntent.getActivity(ctx, 1, activityIntent(ctx, callId, "open"), flags)
            val answer = PendingIntent.getActivity(ctx, 2, activityIntent(ctx, callId, "accept"), flags)
            val decline = PendingIntent.getBroadcast(ctx, 3,
                Intent(ctx, PilotCallActionReceiver::class.java).putExtra(EXTRA_CALL_ID, callId).putExtra(EXTRA_ACTION, "decline"), flags)

            val builder = Notification.Builder(ctx, NOTIF_CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(pilotName)
                .setContentText(reason.ifBlank { "Pilot 来电" })
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(open, true)
                .setContentIntent(open)
                .setTimeoutAfter(ringSeconds * 1000L + 2000L)
            if (Build.VERSION.SDK_INT >= 31) {
                val caller = Person.Builder().setName(pilotName).setImportant(true).build()
                builder.setStyle(Notification.CallStyle.forIncomingCall(caller, decline, answer))
            } else {
                builder.addAction(Notification.Action.Builder(null, "挂断", decline).build())
                builder.addAction(Notification.Action.Builder(null, "接听", answer).build())
            }
            val n = builder.build()
            n.flags = n.flags or Notification.FLAG_INSISTENT
            nm.notify(NOTIF_ID, n)
            ringingCallId = callId
        }

        private fun activityIntent(ctx: Context, callId: String, action: String) = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setAction("neox.pilot.$action.$callId") /* 每个动作一个 action, PendingIntent 才不会互相顶掉 */
            .putExtra(EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_ACTION, action)
    }
}

/** 通知上的「挂断」 —— 不用拉起界面, 广播回来转给 Dart */
class PilotCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(PilotCallBridge.EXTRA_CALL_ID) ?: return
        val action = intent.getStringExtra(PilotCallBridge.EXTRA_ACTION) ?: return
        val bridge = PilotCallBridge.instance
        if (bridge != null) bridge.deliver(callId, action)
        else context.getSystemService(android.app.NotificationManager::class.java).cancel(PilotCallBridge.NOTIF_ID)
    }
}
