package com.mkco.neox.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.LocationManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 情境层 (2026-10-11, 设计见 docs/NEOX_PILOT_ASSISTANT_DESIGN_2026_10_11.md §4): 手机看见物理世界。
 *
 *   车     跟「你的车」(蓝牙地址) 连上 = driving, 断开 = parked: 记下停车位置; 3 小时内有雨就问车窗
 *   家/公司 系统接近提醒 (addProximityAlert: 围栏由系统管, 不轮询) 进出 = home / outside / work;
 *          挂在「出门」「到公司」上的提醒 (Dart 从 trigger 同步过来) 当场弹
 *   一整天  每天 17:00 看一眼 (AlarmManager): 今天一直在家、天气好 → 叫出门走走
 *
 * 状态变化攒在 SharedPreferences (neox_ctx) 的事件队列里, App 开着时 Dart 取走写进个人记录 (context.state)。
 * 只留状态段, 不留轨迹点; 每条反射一天最多一次, 23:00~8:00 不响。App 被杀了也照样工作 (清单里的 receiver)。
 */
object ContextSense {
    private const val PREFS = "neox_ctx"
    const val ACTION_GEOFENCE = "com.mkco.neox.mobile.CTX_GEOFENCE"
    const val ACTION_DAILY = "com.mkco.neox.mobile.CTX_DAILY"
    const val ACTION_DEBUG = "com.mkco.neox.mobile.CTX_DEBUG"
    private const val CHANNEL_ID = "pilot_context"
    private val io = Executors.newSingleThreadExecutor()

    /** App 开着时实时把事件交给 Dart */
    @Volatile var sink: ((Map<String, Any?>) -> Unit)? = null

    /* 工程没开 BuildConfig 生成, 看包自己的 debuggable 标记 */
    fun debuggable(ctx: Context) = (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ───────── 状态 ─────────

    fun setState(ctx: Context, state: String, place: String? = null, lat: Double? = null, lng: Double? = null) {
        val p = prefs(ctx)
        if (p.getString("state", null) == state && place == p.getString("place", null)) return
        val now = System.currentTimeMillis()
        val ev = JSONObject().put("state", state).put("at", now).put("place", place ?: JSONObject.NULL)
            .put("lat", lat ?: JSONObject.NULL).put("lng", lng ?: JSONObject.NULL)
        val q = runCatching { JSONArray(p.getString("events", "[]")) }.getOrDefault(JSONArray())
        q.put(ev)
        /* 只留最近 200 条 (App 很久没开也不会无限长) */
        val trimmed = JSONArray()
        for (i in maxOf(0, q.length() - 200) until q.length()) trimmed.put(q.get(i))
        p.edit().putString("state", state).putLong("since", now).putString("place", place)
            .putString("events", trimmed.toString()).apply()
        sink?.invoke(mapOf("state" to state, "at" to now, "place" to place, "lat" to lat, "lng" to lng))
    }

    fun drainEvents(ctx: Context): List<Map<String, Any?>> {
        val p = prefs(ctx)
        val q = runCatching { JSONArray(p.getString("events", "[]")) }.getOrDefault(JSONArray())
        p.edit().putString("events", "[]").apply()
        return (0 until q.length()).map { i ->
            val o = q.getJSONObject(i)
            mapOf(
                "state" to o.getString("state"), "at" to o.getLong("at"),
                "place" to (if (o.isNull("place")) null else o.getString("place")),
                "lat" to (if (o.isNull("lat")) null else o.getDouble("lat")),
                "lng" to (if (o.isNull("lng")) null else o.getDouble("lng")),
            )
        }
    }

    // ───────── 反射 ─────────

    /** 一条反射一天最多一次; 23:00~8:00 不响 */
    private fun mayFire(ctx: Context, key: String): Boolean {
        val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val p = prefs(ctx)
        val noQuiet = debuggable(ctx) && p.getBoolean("debug_noquiet", false)
        if (!noQuiet && (h >= 23 || h < 8)) return false
        val today = Calendar.getInstance().get(Calendar.DAY_OF_YEAR)
        if (p.getInt("fired_$key", -1) == today) return false
        p.edit().putInt("fired_$key", today).apply()
        return true
    }

    fun notify(ctx: Context, id: Int, title: String, body: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Pilot 留个心", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "下车遇上要下雨、出门带东西、在家待了一整天这类提醒"
            })
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm.notify(id, NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).build())
    }

    /** 下车: 记位置; 3 小时内下雨概率 ≥ 50% 就问车窗 */
    fun onParked(ctx: Context, done: () -> Unit) {
        val loc = lastLocation(ctx)
        setState(ctx, "parked", prefs(ctx).getString("car_name", null), loc?.first, loc?.second)
        if (loc != null) prefs(ctx).edit().putString("parked_at", "${loc.first},${loc.second}").putLong("parked_time", System.currentTimeMillis()).apply()
        if (loc == null) { done(); return }
        io.execute {
            try {
                val rain = rainSoon(loc.first, loc.second)
                if (rain != null && mayFire(ctx, "parked_rain")) {
                    notify(ctx, 7301, "刚下车，${rain.first} 点后可能有雨", "下雨概率 ${rain.second}%。车窗、天窗关好了吗？停车位置已经记下了。")
                }
            } finally { done() }
        }
    }

    /** 接下来 3 小时第一个下雨概率 ≥ 50% 的钟点 → (几点, 概率); 没有就 null */
    private fun rainSoon(lat: Double, lng: Double): Pair<Int, Int>? = runCatching {
        val url = URL(String.format(Locale.US,
            "https://api.open-meteo.com/v1/forecast?latitude=%.3f&longitude=%.3f&hourly=precipitation_probability&forecast_hours=3&timezone=auto", lat, lng))
        val c = (url.openConnection() as HttpURLConnection).apply { connectTimeout = 6000; readTimeout = 6000 }
        val j = JSONObject(c.inputStream.bufferedReader().readText())
        val h = j.getJSONObject("hourly")
        val times = h.getJSONArray("time")
        val probs = h.getJSONArray("precipitation_probability")
        (0 until probs.length()).firstOrNull { probs.optInt(it, 0) >= 50 }?.let {
            times.getString(it).substring(11, 13).toInt() to probs.getInt(it)
        }
    }.getOrNull()

    /** 今天天气好不好 (12~30 度、不下雨) → 好就 (温度) */
    private fun niceWeather(lat: Double, lng: Double): Int? = runCatching {
        val url = URL(String.format(Locale.US,
            "https://api.open-meteo.com/v1/forecast?latitude=%.3f&longitude=%.3f&current=temperature_2m,precipitation&timezone=auto", lat, lng))
        val c = (url.openConnection() as HttpURLConnection).apply { connectTimeout = 6000; readTimeout = 6000 }
        val cur = JSONObject(c.inputStream.bufferedReader().readText()).getJSONObject("current")
        val t = cur.getDouble("temperature_2m")
        if (cur.optDouble("precipitation", 0.0) > 0.1 || t < 12 || t > 30) null else t.toInt()
    }.getOrNull()

    /** 进出家 / 公司 */
    fun onGeofence(ctx: Context, name: String, entering: Boolean) {
        val p = prefs(ctx)
        when {
            name == "home" && entering -> setState(ctx, "home", "家")
            name == "home" && !entering -> {
                setState(ctx, "outside")
                val texts = p.getString("leave_home", "")!!.split('\n').filter { it.isNotBlank() }
                if (texts.isNotEmpty() && mayFire(ctx, "leave_home")) notify(ctx, 7302, "出门了", texts.joinToString("；") + "？")
            }
            name == "work" && entering -> {
                setState(ctx, "work", "公司")
                val texts = p.getString("arrive_work", "")!!.split('\n').filter { it.isNotBlank() }
                if (texts.isNotEmpty() && mayFire(ctx, "arrive_work")) notify(ctx, 7303, "到公司了", texts.joinToString("；"))
            }
            name == "work" && !entering -> setState(ctx, "outside")
        }
    }

    /** 17:00: 今天一直在家 (从早上 9 点前到现在没出去过) + 天气好 → 叫出门 */
    fun onDaily(ctx: Context, done: () -> Unit) {
        scheduleDaily(ctx)
        val p = prefs(ctx)
        val startOfDay9 = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, 9); set(Calendar.MINUTE, 0) }.timeInMillis
        val stayed = p.getString("state", null) == "home" && p.getLong("since", Long.MAX_VALUE) < startOfDay9
        val home = p.getString("home", null)?.split(',')?.mapNotNull { it.toDoubleOrNull() }
        if (!stayed || home == null || home.size < 2) { done(); return }
        io.execute {
            try {
                val t = niceWeather(home[0], home[1])
                if (t != null && mayFire(ctx, "stay_home")) {
                    notify(ctx, 7304, "今天还没出门", "外面 $t 度，不下雨。下楼走二十分钟？")
                }
            } finally { done() }
        }
    }

    // ───────── 注册 (Dart 设置完 / 开机后) ─────────

    @SuppressLint("MissingPermission")
    fun registerGeofences(ctx: Context) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        for ((i, name) in listOf("home", "work").withIndex()) {
            val pi = PendingIntent.getBroadcast(ctx, 7400 + i,
                Intent(ctx, ContextReceiver::class.java).setAction(ACTION_GEOFENCE).putExtra("name", name),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            runCatching { lm.removeProximityAlert(pi) }
            val v = prefs(ctx).getString(name, null)?.split(',')?.mapNotNull { it.toDoubleOrNull() } ?: continue
            if (v.size < 2) continue
            runCatching { lm.addProximityAlert(v[0], v[1], 150f, -1, pi) }
        }
    }

    fun scheduleDaily(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(ctx, 7410, Intent(ctx, ContextReceiver::class.java).setAction(ACTION_DAILY),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val at = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 17); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0)
            if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_YEAR, 1)
        }.timeInMillis
        /* 差几分钟无所谓, 不要精确闹钟权限 */
        am.setWindow(AlarmManager.RTC_WAKEUP, at, 15 * 60_000L, pi)
    }

    @SuppressLint("MissingPermission")
    private fun lastLocation(ctx: Context): Pair<Double, Double>? {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val fixes = lm.getProviders(true).mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        /* 10 分钟内的挑最准的 (基站定位常常更新但偏好几公里); 都旧了再取最新 */
        val nowNs = android.os.SystemClock.elapsedRealtimeNanos()
        val recent = fixes.filter { nowNs - it.elapsedRealtimeNanos < 10 * 60 * 1_000_000_000L }
        return (recent.minByOrNull { it.accuracy } ?: fixes.maxByOrNull { it.elapsedRealtimeNanos })?.let { it.latitude to it.longitude }
    }

    @SuppressLint("MissingPermission")
    fun bondedDevices(ctx: Context): List<Map<String, Any?>> {
        if (Build.VERSION.SDK_INT >= 31 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return emptyList()
        val adapter: BluetoothAdapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return emptyList()
        return runCatching {
            adapter.bondedDevices.map {
                val cls = it.bluetoothClass?.deviceClass ?: 0
                mapOf("name" to (it.name ?: it.address), "address" to it.address,
                    /* 车载音响 / 免提: 列表里排前面 */
                    "car" to (cls == android.bluetooth.BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO || cls == android.bluetooth.BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE))
            }
        }.getOrDefault(emptyList())
    }

    fun city(ctx: Context, lat: Double, lng: Double): String? = runCatching {
        @Suppress("DEPRECATION")
        Geocoder(ctx, Locale.CHINA).getFromLocation(lat, lng, 1)?.firstOrNull()?.let { it.locality ?: it.adminArea }
    }.getOrNull()

    // ───────── Dart 通道 neox.phone/context ─────────

    fun attach(ctx: Context, messenger: BinaryMessenger) {
        val ch = MethodChannel(messenger, "neox.phone/context")
        sink = { ev -> android.os.Handler(ctx.mainLooper).post { runCatching { ch.invokeMethod("event", ev) } } }
        ch.setMethodCallHandler { call: MethodCall, result: MethodChannel.Result ->
            val p = prefs(ctx)
            when (call.method) {
                "status" -> result.success(mapOf(
                    "state" to p.getString("state", null), "since" to p.getLong("since", 0), "place" to p.getString("place", null),
                    "home" to p.getString("home", null), "work" to p.getString("work", null),
                    "car" to p.getString("car_name", null), "parkedAt" to p.getString("parked_at", null), "parkedTime" to p.getLong("parked_time", 0),
                    "bgLocation" to (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED),
                ))
                "setPlace" -> {
                    val name = call.argument<String>("name")!!
                    val lat = call.argument<Double>("lat"); val lng = call.argument<Double>("lng")
                    p.edit().putString(name, if (lat == null || lng == null) null else "$lat,$lng").apply()
                    registerGeofences(ctx)
                    /* 设家的那一刻人就在家 */
                    if (name == "home" && lat != null) setState(ctx, "home", "家", lat, lng)
                    result.success(null)
                }
                "setCar" -> {
                    p.edit().putString("car_bt", call.argument<String>("address")).putString("car_name", call.argument<String>("name")).apply()
                    result.success(null)
                }
                "setPlaceTexts" -> {
                    p.edit().putString("leave_home", call.argument<String>("leaveHome") ?: "")
                        .putString("arrive_work", call.argument<String>("arriveWork") ?: "").apply()
                    result.success(null)
                }
                "bondedDevices" -> io.execute { val d = bondedDevices(ctx); android.os.Handler(ctx.mainLooper).post { result.success(d) } }
                "city" -> {
                    val lat = call.argument<Double>("lat")!!; val lng = call.argument<Double>("lng")!!
                    io.execute { val c = city(ctx, lat, lng); android.os.Handler(ctx.mainLooper).post { result.success(c) } }
                }
                "setState" -> { setState(ctx, call.argument<String>("state")!!, call.argument<String>("place")); result.success(null) }
                "drain" -> result.success(drainEvents(ctx))
                "start" -> { registerGeofences(ctx); scheduleDaily(ctx); result.success(null) }
                else -> result.notImplemented()
            }
        }
        /* 调试: adb shell am broadcast -a com.mkco.neox.mobile.CTX_DEBUG --es event car_off  (只在 debug 包里, 只在 App 开着时) */
        if (debuggable(ctx)) {
            val f = IntentFilter(ACTION_DEBUG)
            val r = ContextReceiver()
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(r, f)
        }
    }
}

/** 系统 (蓝牙 / 围栏 / 闹钟 / 开机) 和调试广播都进这里; App 没开也会被叫起来 */
class ContextReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val p = ContextSense.prefs(ctx)
        when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED, BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                @Suppress("DEPRECATION")
                val dev = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
                if (dev.address != p.getString("car_bt", null)) return
                if (intent.action == BluetoothDevice.ACTION_ACL_CONNECTED) ContextSense.setState(ctx, "driving", p.getString("car_name", null))
                else { val pr = goAsync(); ContextSense.onParked(ctx) { pr.finish() } }
            }
            ContextSense.ACTION_GEOFENCE -> ContextSense.onGeofence(ctx, intent.getStringExtra("name") ?: return,
                intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false))
            ContextSense.ACTION_DAILY -> { val pr = goAsync(); ContextSense.onDaily(ctx) { pr.finish() } }
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> { ContextSense.registerGeofences(ctx); ContextSense.scheduleDaily(ctx) }
            ContextSense.ACTION_DEBUG -> if (ContextSense.debuggable(ctx)) when (intent.getStringExtra("event")) {
                "car_on" -> ContextSense.setState(ctx, "driving", p.getString("car_name", null))
                "car_off" -> { val pr = goAsync(); ContextSense.onParked(ctx) { pr.finish() } }
                "home_in" -> ContextSense.onGeofence(ctx, "home", true)
                "home_out" -> ContextSense.onGeofence(ctx, "home", false)
                "work_in" -> ContextSense.onGeofence(ctx, "work", true)
                "daily" -> { val pr = goAsync(); ContextSense.onDaily(ctx) { pr.finish() } }
                /* 模拟器时钟改不了: 调试时无视 23:00~8:00 */
                "noquiet" -> p.edit().putBoolean("debug_noquiet", true).apply()
                "unfire" -> { val e = p.edit(); p.all.keys.filter { it.startsWith("fired_") }.forEach { e.remove(it) }; e.apply() }
            }
        }
    }
}
