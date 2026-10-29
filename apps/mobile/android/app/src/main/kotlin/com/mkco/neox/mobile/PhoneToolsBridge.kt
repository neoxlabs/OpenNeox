package com.mkco.neox.mobile

import android.Manifest
import android.app.Activity

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * Pilot 在手机上的手脚 (2026-10-01) —— 打电话 / 发短信 / 读短信 / 联系人 / 日历 / 闹钟 / 定位 /
 * 开 App / 深链 / 看通知。Dart 侧每个能力包成一个 agent 工具 (core/local_agent/tools/phone_tools.dart)。
 *
 * 权限按需要: 工具第一次用到哪项才弹哪项 (`ensure`), 不在启动时一口气全要。
 * 拿不到权限不假装做成: 打电话退到拨号盘 (号码填好, 你按), 其余如实回「没有权限」。
 * 所有查询放后台线程 —— 联系人 / 短信库大的机器上主线程读会卡帧。
 */
class PhoneToolsBridge(private val activity: Activity, messenger: BinaryMessenger) {
    private val ctx: Context = activity.applicationContext
    private val io = Executors.newSingleThreadExecutor()
    private val pendingPermissions = mutableMapOf<Int, MethodChannel.Result>()
    private var nextRequestCode = 7100

    init {
        val channel = MethodChannel(messenger, CHANNEL)
        channel.setMethodCallHandler { call, result -> handle(call, result) }
        /* 新通知实时交给 Dart (phone_signals.dart), 由它推给电脑上的 Pilot */
        NeoxNotificationListener.sink = { item ->
            activity.runOnUiThread { runCatching { channel.invokeMethod("notificationPosted", item) } }
        }
        /* Phone Use 操控悬浮层 (ControlOverlay): Dart 叫 show / hide; 用户点「停止」反过来告诉 Dart */
        val control = MethodChannel(messenger, "neox.phone/control")
        control.setMethodCallHandler { call, result ->
            when (call.method) {
                "show" -> { ControlOverlay.show(call.argument<String>("step"), call.argument<String>("label"), call.argument<String>("stop")); result.success(NeoxAccessibilityService.instance != null) }
                "hide" -> { ControlOverlay.hide(call.argument<Boolean>("returnHome") == true); result.success(true) }
                /* 回到 Neox (问用户授权要在 Neox 里弹框; 有悬浮层也一并收起) */
                "front" -> { ControlOverlay.hide(returnHome = true); result.success(true) }
                else -> result.notImplemented()
            }
        }
        ControlOverlay.onStop = {
            activity.runOnUiThread { runCatching { control.invokeMethod("stop", null) } }
        }
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "ensure" -> ensure(call.argument<List<String>>("permissions") ?: emptyList(), result)
            "status" -> result.success(status())
            "dial" -> result.success(dial(call.argument<String>("number") ?: ""))
            "sendSms" -> background(result) { sendSms(call.argument<String>("to") ?: "", call.argument<String>("text") ?: "") }
            "readSms" -> background(result) {
                readSms(call.argument<Int>("limit") ?: 10, call.argument<String>("query"), (call.argument<Number>("sinceMs"))?.toLong())
            }
            "contacts" -> background(result) { contacts(call.argument<String>("query") ?: "", call.argument<Int>("limit") ?: 10) }
            "calendarEvents" -> background(result) {
                calendarEvents((call.argument<Number>("fromMs"))!!.toLong(), (call.argument<Number>("toMs"))!!.toLong())
            }
            "calendarAdd" -> background(result) {
                calendarAdd(
                    call.argument<String>("title") ?: "",
                    (call.argument<Number>("startMs"))!!.toLong(),
                    (call.argument<Number>("endMs"))!!.toLong(),
                    call.argument<String>("location"),
                    call.argument<String>("notes"),
                )
            }
            "setAlarm" -> result.success(setAlarm(call.argument<Int>("hour")!!, call.argument<Int>("minute")!!, call.argument<String>("label")))
            "setTimer" -> result.success(setTimer(call.argument<Int>("seconds")!!, call.argument<String>("label")))
            "location" -> background(result) { location() }
            /* 经纬度 → 一行地址 (系统地理编码, 吃 WGS-84; 语言跟系统)。没网 / 机器不带地理编码服务就是 null */
            "address" -> background(result) {
                val lat = call.argument<Double>("lat") ?: 0.0
                val lng = call.argument<Double>("lng") ?: 0.0
                runCatching {
                    @Suppress("DEPRECATION")
                    android.location.Geocoder(ctx, java.util.Locale.getDefault()).getFromLocation(lat, lng, 1)?.firstOrNull()?.let { a ->
                        a.getAddressLine(0) ?: listOfNotNull(a.adminArea, a.locality, a.subLocality, a.thoroughfare, a.featureName).joinToString("")
                    }
                }.getOrNull()
            }
            "apps" -> background(result) { apps(call.argument<String>("query") ?: "", call.argument<Boolean>("all") == true) }
            "openApp" -> result.success(openApp(call.argument<String>("package") ?: ""))
            "openUri" -> result.success(openUri(call.argument<String>("uri") ?: ""))
            "notifications" -> result.success(notifications(call.argument<Int>("limit") ?: 20))
            "notificationsSince" -> result.success(NeoxNotificationListener.since((call.argument<Number>("sinceMs"))?.toLong() ?: 0L))
            "sensors" -> background(result) { DeviceSense.sensors(ctx) }
            /* 电量 + 网络快照 (pilot:H-07) — 只给 pilot.hello 心跳用, 不进工具表 */
            "power" -> background(result) { DeviceSense.power(ctx) }
            /* 代你操作别的 App (NeoxAccessibilityService) —— 服务没开就如实说, Dart 那边会把设置页打开 */
            "ui" -> {
                val svc = NeoxAccessibilityService.instance
                if (svc == null) { result.success(mapOf("error" to "not_enabled")); return }
                background(result) {
                    val op = call.argument<String>("op")
                    /* 哪些 App 能让 Agent 碰 (Phone Use 设置页): back / home 不受限, 别的看前台 App */
                    if (op !in setOf("back", "home", "recents")) {
                        policyBlock(svc.foregroundPackage(), op ?: "", call.argument<String>("policy"),
                            call.argument<List<String>>("allow").orEmpty(), call.argument<List<String>>("deny").orEmpty())
                            ?.let { return@background it }
                    }
                    when (op) {
                        "snapshot" -> svc.snapshot()
                        "read_text" -> svc.readText(call.argument<Int>("pages") ?: 3, call.argument<String>("direction") != "down")
                        "tap" -> svc.tap(call.argument<Int>("target") ?: 0, call.argument<Boolean>("confirmed") == true)
                        "tap_at" -> svc.tapAt(
                            (call.argument<Number>("x") ?: 0).toFloat(),
                            (call.argument<Number>("y") ?: 0).toFloat(),
                            call.argument<Boolean>("confirmed") == true,
                            call.argument<String>("expect"),
                        )
                        "type" -> svc.type(call.argument<Int>("target"), call.argument<String>("text") ?: "")
                        "scroll" -> svc.scroll(call.argument<String>("direction") != "up", call.argument<Int>("target"))
                        "back", "home", "recents" -> svc.global(call.argument<String>("op")!!)
                        "screenshot" -> svc.screenshot()
                        else -> mapOf("error" to "op 只能是 snapshot / read_text / tap / tap_at / type / scroll / back / home / screenshot")
                    }
                }
            }
            /* 一轮操控结束: 删掉这一轮在 cacheDir 里截的图 (pilot:D-08) */
            "uiRoundEnd" -> result.success(mapOf("deleted" to (NeoxAccessibilityService.instance?.endRoundShots() ?: 0)))
            "openAccessibilitySettings" -> {
                activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                result.success(null)
            }
            /* 对话里文件卡的 PDF 预览: 系统自带的 PdfRenderer 一页页画成 PNG (2026-10-12) */
            "renderPdf" -> background(result) {
                renderPdf(call.argument<String>("path") ?: "", call.argument<Int>("maxPages") ?: 30, call.argument<Int>("width") ?: 1080)
            }
            "takePhoto" -> background(result) { DeviceSense.takePhoto(ctx, call.argument<Boolean>("front") == true) }
            "openNotificationAccess" -> {
                activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                result.success(null)
            }
            /* 设置 → 语言: Android 13+ 有单应用语言页, 更早的去应用详情 (2026-10-14) */
            "openAppLocaleSettings" -> {
                val uri = android.net.Uri.fromParts("package", ctx.packageName, null)
                val intent = if (android.os.Build.VERSION.SDK_INT >= 33) {
                    Intent(Settings.ACTION_APP_LOCALE_SETTINGS, uri)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
                }
                activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun background(result: MethodChannel.Result, work: () -> Any?) {
        io.execute {
            val out = try { work() } catch (e: Throwable) { mapOf("error" to (e.message ?: e.javaClass.simpleName)) }
            activity.runOnUiThread { result.success(out) }
        }
    }

    /**
     * Phone Use 的 App 名单 (2026-10-12)。名单存在 Dart 那边 (设置页改), 每次调用带过来; 这里只按前台包名判。
     *   policy=open (默认): 除了 deny 都能碰;  policy=allowlist: 只有 allow 里的能碰。deny 永远优先。
     * 硬线 (名单改不动): Neox 自己不让点 / 填 —— Agent 不能替用户在 Neox 里点「同意」自己批自己。
     */
    /** 拦下来就回一张单子 (error + blocked); 只是「不在允许名单」的再带 needs_grant + 包名, Dart 去问用户授权一次 */
    private fun policyBlock(pkg: String?, op: String, policy: String?, allow: List<String>, deny: List<String>): Map<String, Any>? {
        val p = pkg ?: return null
        if (p == ctx.packageName && op in setOf("tap", "tap_at", "type", "scroll")) {
            return mapOf("error" to "不能在 Neox 自己的界面里点按 —— 先 open_app 打开要操作的 App", "blocked" to true)
        }
        if (p == ctx.packageName) return null
        val label = runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(p, 0)).toString() }.getOrDefault(p)
        fun hit(list: List<String>) = list.any { it.equals(p, ignoreCase = true) || it.equals(label, ignoreCase = true) }
        if (hit(deny)) return mapOf("error" to "「$label」在 Phone Use 的禁止名单里, 不能操作 (用户可以在 设置 → Phone Use 里改)", "blocked" to true)
        if (policy == "allowlist" && !hit(allow)) {
            return mapOf("error" to "「$label」还没被允许操作", "blocked" to true, "needs_grant" to true, "package" to p, "label" to label)
        }
        return null
    }

    // ───────────────────────── 权限 ─────────────────────────

    private fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    /* 系统同一时间只认一个授权请求, 第二个会被吞掉、回调永远不来 (实测: 连着点两个工具, 后一个卡死)。
     * 所以排队: 前一个回来了再发下一个。 */
    private val permissionQueue = ArrayDeque<Pair<List<String>, MethodChannel.Result>>()

    private fun ensure(perms: List<String>, result: MethodChannel.Result) {
        if (perms.all(::granted)) { result.success(perms.associateWith { true }); return }
        permissionQueue.addLast(perms to result)
        if (pendingPermissions.isEmpty()) requestNext()
    }

    private fun requestNext() {
        while (permissionQueue.isNotEmpty()) {
            val (perms, result) = permissionQueue.removeFirst()
            val missing = perms.filterNot(::granted)
            if (missing.isEmpty()) { result.success(perms.associateWith { true }); continue }
            val code = nextRequestCode++
            pendingPermissions[code] = result
            ActivityCompat.requestPermissions(activity, missing.toTypedArray(), code)
            return
        }
    }

    /** MainActivity.onRequestPermissionsResult 转进来 */
    fun onPermissionsResult(requestCode: Int, permissions: Array<out String>) {
        val result = pendingPermissions.remove(requestCode) ?: return
        result.success(permissions.associateWith { granted(it) })
        requestNext()
    }

    private fun status(): Map<String, Any> = mapOf(
        "call" to granted(Manifest.permission.CALL_PHONE),
        "sms" to granted(Manifest.permission.SEND_SMS),
        "readSms" to granted(Manifest.permission.READ_SMS),
        "contacts" to granted(Manifest.permission.READ_CONTACTS),
        "calendar" to (granted(Manifest.permission.READ_CALENDAR) && granted(Manifest.permission.WRITE_CALENDAR)),
        "location" to (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)),
        "notifications" to notificationAccess(),
        "accessibility" to (NeoxAccessibilityService.instance != null),
    )

    // ───────────────────────── 电话 / 短信 ─────────────────────────

    /** 有权限直接拨出; 没有就打开拨号盘把号码填好 —— 两种都如实回报 */
    private fun dial(number: String): Map<String, Any> {
        val clean = number.trim()
        if (clean.isEmpty()) return mapOf("error" to "number required")
        val uri = Uri.parse("tel:" + Uri.encode(clean))
        val direct = granted(Manifest.permission.CALL_PHONE)
        val intent = Intent(if (direct) Intent.ACTION_CALL else Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            activity.startActivity(intent)
            mapOf("placed" to direct, "dialer" to !direct)
        } catch (e: Throwable) {
            mapOf("error" to (e.message ?: "cannot dial"))
        }
    }

    private fun sendSms(to: String, text: String): Map<String, Any> {
        if (!granted(Manifest.permission.SEND_SMS)) return mapOf("error" to "no SEND_SMS permission")
        if (to.isBlank() || text.isBlank()) return mapOf("error" to "to and text required")
        @Suppress("DEPRECATION")
        val sms = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else SmsManager.getDefault()
        val parts = sms.divideMessage(text)
        sms.sendMultipartTextMessage(to.trim(), null, parts, null, null)
        return mapOf("sent" to true, "parts" to parts.size)
    }

    private fun readSms(limit: Int, query: String?, sinceMs: Long?): Any {
        if (!granted(Manifest.permission.READ_SMS)) return mapOf("error" to "no READ_SMS permission")
        val sel = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (sinceMs != null) { sel += "${Telephony.Sms.DATE} >= ?"; args += sinceMs.toString() }
        if (!query.isNullOrBlank()) { sel += "(${Telephony.Sms.BODY} LIKE ? OR ${Telephony.Sms.ADDRESS} LIKE ?)"; args += "%$query%"; args += "%$query%" }
        val out = mutableListOf<Map<String, Any?>>()
        ctx.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            sel.joinToString(" AND ").ifEmpty { null },
            args.toTypedArray().ifEmpty { null },
            "${Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (c.moveToNext() && out.size < limit.coerceIn(1, 50)) {
                /* 只提验证码与金额 (pilot:D-10): 正文不出这台手机 —— 别人的私聊 / 余额 / 地址
                 * 不该因为「要个验证码」跟着上云。提取在原生侧做, 正文连 MethodChannel 都不过。 */
                out += SmsDigest.digest(
                    from = c.getString(0).orEmpty(),
                    body = c.getString(1).orEmpty(),
                    at = c.getLong(2),
                )
            }
        }
        return out
    }

    // ───────────────────────── 联系人 / 日历 ─────────────────────────

    private fun contacts(query: String, limit: Int): Any {
        if (!granted(Manifest.permission.READ_CONTACTS)) return mapOf("error" to "no READ_CONTACTS permission")
        val out = linkedMapOf<String, MutableMap<String, Any>>()
        val q = query.trim()
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            if (q.isEmpty()) null else "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? OR ${ContactsContract.CommonDataKinds.Phone.NUMBER} LIKE ?",
            if (q.isEmpty()) null else arrayOf("%$q%", "%$q%"),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        )?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(0) ?: continue
                val num = c.getString(1) ?: continue
                val entry = out.getOrPut(name) { mutableMapOf("name" to name, "numbers" to mutableListOf<String>()) }
                @Suppress("UNCHECKED_CAST")
                val nums = entry["numbers"] as MutableList<String>
                if (num !in nums) nums += num
                if (out.size > limit.coerceIn(1, 50)) break
            }
        }
        return out.values.take(limit.coerceIn(1, 50))
    }

    private fun calendarEvents(fromMs: Long, toMs: Long): Any {
        if (!granted(Manifest.permission.READ_CALENDAR)) return mapOf("error" to "no READ_CALENDAR permission")
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            android.content.ContentUris.appendId(it, fromMs)
            android.content.ContentUris.appendId(it, toMs)
        }.build()
        val out = mutableListOf<Map<String, Any?>>()
        ctx.contentResolver.query(
            uri,
            arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
                CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.ALL_DAY),
            null, null, "${CalendarContract.Instances.BEGIN} ASC",
        )?.use { c ->
            while (c.moveToNext() && out.size < 100) {
                out += mapOf("title" to c.getString(0), "start" to c.getLong(1), "end" to c.getLong(2),
                    "location" to c.getString(3), "allDay" to (c.getInt(4) == 1))
            }
        }
        return out
    }

    private fun calendarAdd(title: String, startMs: Long, endMs: Long, location: String?, notes: String?): Any {
        if (!granted(Manifest.permission.WRITE_CALENDAR)) return mapOf("error" to "no WRITE_CALENDAR permission")
        if (title.isBlank()) return mapOf("error" to "title required")
        /* 写进第一个能写的日历 —— 优先主账号的 (IS_PRIMARY), 跟系统日历 App 新建事件默认落的那个一致 */
        var calId: Long? = null
        ctx.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY),
            "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}",
            null, "${CalendarContract.Calendars.IS_PRIMARY} DESC",
        )?.use { c -> if (c.moveToFirst()) calId = c.getLong(0) }
        val id = calId ?: createLocalCalendar()
            ?: return mapOf("error" to "no writable calendar on this phone (add an account in the Calendar app)")
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, id)
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.DTSTART, startMs)
            put(CalendarContract.Events.DTEND, endMs)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
            if (!location.isNullOrBlank()) put(CalendarContract.Events.EVENT_LOCATION, location)
            if (!notes.isNullOrBlank()) put(CalendarContract.Events.DESCRIPTION, notes)
        }
        val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?: return mapOf("error" to "insert failed")
        return mapOf("added" to true, "eventId" to uri.lastPathSegment)
    }

    /** 手机上一个能写的日历都没有 (没登任何账号, 国内机器常见): 建一个只在本机的「Neox」日历,
     *  系统日历 App 里看得到。用 sync adapter 身份建, 这是本地日历唯一的建法。 */
    private fun createLocalCalendar(): Long? = runCatching {
        val uri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, "Neox")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            .build()
        val values = ContentValues().apply {
            put(CalendarContract.Calendars.ACCOUNT_NAME, "Neox")
            put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            put(CalendarContract.Calendars.NAME, "Neox")
            put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, "Neox")
            put(CalendarContract.Calendars.CALENDAR_COLOR, 0xFF4F7BF7.toInt())
            put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER)
            put(CalendarContract.Calendars.OWNER_ACCOUNT, "Neox")
            put(CalendarContract.Calendars.VISIBLE, 1)
            put(CalendarContract.Calendars.SYNC_EVENTS, 1)
            put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, TimeZone.getDefault().id)
        }
        ctx.contentResolver.insert(uri, values)?.lastPathSegment?.toLong()
    }.getOrNull()

    // ───────────────────────── 闹钟 / 计时 ─────────────────────────

    /** 系统闹钟 App 里真建一个 —— 我们被杀了照样响 */
    private fun setAlarm(hour: Int, minute: Int, label: String?): Map<String, Any> = launch(
        Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .apply { if (!label.isNullOrBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label) },
    )

    private fun setTimer(seconds: Int, label: String?): Map<String, Any> = launch(
        Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .apply { if (!label.isNullOrBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, label) },
    )

    private fun launch(intent: Intent): Map<String, Any> = try {
        activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        mapOf("ok" to true)
    } catch (e: Throwable) {
        mapOf("error" to (e.message ?: "no app can handle this"))
    }

    // ───────────────────────── 定位 ─────────────────────────

    @Suppress("MissingPermission")
    private fun location(): Any {
        val fine = granted(Manifest.permission.ACCESS_FINE_LOCATION)
        if (!fine && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) return mapOf("error" to "no location permission")
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = lm.getProviders(true)
        if (Build.VERSION.SDK_INT >= 30) {
            /* 几个来源一起问, 谁先给就用谁: 室内 GPS 半天没信号, 没装谷歌服务的国产机 fused 不出数,
             * 只押一个来源两种情况都会白等 (模拟器上的坐标也只进 gps) */
            val candidates = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                .filter { it in providers && (fine || it != LocationManager.GPS_PROVIDER) }
            if (candidates.isNotEmpty()) {
                val latch = java.util.concurrent.CountDownLatch(1)
                val fresh = java.util.concurrent.atomic.AtomicReference<Location?>(null)
                val cancels = candidates.map { android.os.CancellationSignal() }
                candidates.forEachIndexed { i, p ->
                    lm.getCurrentLocation(p, cancels[i], ctx.mainExecutor) { loc ->
                        if (loc != null && fresh.compareAndSet(null, loc)) latch.countDown()
                    }
                }
                latch.await(15, java.util.concurrent.TimeUnit.SECONDS)
                cancels.forEach { runCatching { it.cancel() } }
                fresh.get()?.let { return locMap(it, fresh = true) }
            }
        }
        /* 拿不到新的就给最近一次已知的, 并标出是多久前的 */
        val last = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
            ?: return mapOf("error" to "location unavailable (is location turned on?)")
        return locMap(last, fresh = false)
    }

    private fun locMap(l: Location, fresh: Boolean) = mapOf(
        "lat" to l.latitude, "lng" to l.longitude, "accuracyM" to l.accuracy.toDouble(), "at" to l.time, "fresh" to fresh,
    )

    // ───────────────────────── App / 深链 ─────────────────────────

    private fun renderPdf(path: String, maxPages: Int, width: Int): Map<String, Any?> {
        val f = java.io.File(path)
        if (!f.isFile) return mapOf("error" to "文件不存在")
        val outDir = java.io.File(ctx.cacheDir, "pdf-preview/${f.name.hashCode()}-${f.lastModified()}").apply { mkdirs() }
        android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
            android.graphics.pdf.PdfRenderer(fd).use { r ->
                val pages = mutableListOf<String>()
                for (i in 0 until minOf(r.pageCount, maxPages)) {
                    val out = java.io.File(outDir, "p$i.png")
                    if (!out.exists()) {
                        r.openPage(i).use { p ->
                            val h = (width.toFloat() * p.height / p.width).toInt().coerceAtLeast(1)
                            val bmp = android.graphics.Bitmap.createBitmap(width, h, android.graphics.Bitmap.Config.ARGB_8888)
                            bmp.eraseColor(android.graphics.Color.WHITE)
                            p.render(bmp, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            java.io.FileOutputStream(out).use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                            bmp.recycle()
                        }
                    }
                    pages += out.absolutePath
                }
                return mapOf("pages" to pages, "total" to r.pageCount)
            }
        }
    }

    private fun apps(query: String, all: Boolean = false): Any {
        val pm = ctx.packageManager
        val q = query.trim().lowercase()
        return pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { mapOf("name" to it.loadLabel(pm).toString(), "package" to it.activityInfo.packageName) }
            .filter { q.isEmpty() || (it["name"] as String).lowercase().contains(q) || (it["package"] as String).lowercase().contains(q) }
            .distinctBy { it["package"] }
            .sortedBy { it["name"] as String }
            /* 给模型的只要前 60 个 (省 token); Phone Use 设置页挑 App 要全量 */
            .let { if (all) it else it.take(60) }
    }

    private fun openApp(pkg: String): Map<String, Any> {
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg.trim()) ?: return mapOf("error" to "app not installed: $pkg")
        return launch(intent)
    }

    /** 深链 / 地图 / 网页: geo:、https:、weixin:// 之类, 交给系统挑能打开的 App */
    private fun openUri(uri: String): Map<String, Any> {
        if (uri.isBlank()) return mapOf("error" to "uri required")
        if (uri.startsWith("tel:", ignoreCase = true)) return mapOf("error" to "use phone_call for tel: links")
        return launch(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
    }

    // ───────────────────────── 通知 ─────────────────────────

    private fun notificationAccess(): Boolean = PilotKeepAliveBridge.notificationAccessOn(ctx)

    private fun notifications(limit: Int): Any {
        if (!notificationAccess()) return mapOf("error" to "notification access not granted")
        return NeoxNotificationListener.recent(limit.coerceIn(1, 50))
    }

    companion object {
        const val CHANNEL = "neox.phone/tools"
    }
}
