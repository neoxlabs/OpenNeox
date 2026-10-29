package com.mkco.neox.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Pilot 的「眼睛和皮肤」(2026-10-01) —— 手机上的传感器和相机, 交给 agent 感知你所处的环境。
 *
 *   sensors()   环境温度 / 湿度 / 光照 / 气压 / 距离 / 是否在动 + 电池 (电量、充电、电池温度)。
 *               大多数手机没有温湿度传感器 —— 没有就列进 missing, 不拿电池温度冒充气温。
 *   takePhoto() 静默拍一张 (不弹相机界面), 压到长边 1280 存 cache, 回路径; Dart 侧再转给电脑上的 Pilot 看。
 *               安卓 9 起后台不能开相机: App 不在前台时如实报错。
 *
 * 都在调用方的后台线程里跑 (PhoneToolsBridge.background), 这里可以阻塞等结果。
 */
object DeviceSense {
    private val WANTED = listOf(
        Sensor.TYPE_AMBIENT_TEMPERATURE to "temperature_c",
        Sensor.TYPE_RELATIVE_HUMIDITY to "humidity_pct",
        Sensor.TYPE_LIGHT to "light_lux",
        Sensor.TYPE_PRESSURE to "pressure_hpa",
        Sensor.TYPE_PROXIMITY to "proximity_cm",
        Sensor.TYPE_ACCELEROMETER to "motion",
    )

    /**
     * 电量 + 网络 — 给云端 `<device-state>` 用的轻量快照 (pilot:H-07)。
     * 跟 sensors() 分开: 心跳每 90s 一次, 不能每次都去等传感器 (要 1.5s)。
     * 读不到就少给字段, 不报假数 (模拟器 / 权限异常)。
     */
    fun power(ctx: Context): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>()
        try {
            val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            if (battery != null) {
                val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
                if (level >= 0 && scale > 0) out["battery_pct"] = level * 100 / scale
                val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                if (status >= 0) {
                    out["charging"] = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL
                }
            }
        } catch (_: Exception) { /* 拿不到电量就不报 */ }
        out["network"] = networkType(ctx)
        return out
    }

    private fun networkType(ctx: Context): String = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            when {
                caps == null -> "offline"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "online"
            }
        } else "unknown"
    } catch (_: Exception) { "unknown" }

    fun sensors(ctx: Context): Map<String, Any?> {
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val out = linkedMapOf<String, Any?>()
        val missing = mutableListOf<String>()
        val thread = HandlerThread("neox-sense").apply { start() }
        try {
            val handler = Handler(thread.looper)
            for ((type, key) in WANTED) {
                val sensor = sm.getDefaultSensor(type)
                if (sensor == null) { missing += key; continue }
                val value = readOnce(sm, sensor, handler) ?: continue
                /* 有的机器 (模拟器、部分国产机) 注册了传感器却回哨兵值: 温度 -2147483648、湿度 0。当没有, 别报一个假数 */
                val v0 = value[0]
                val bogus = v0.isNaN() || when (type) {
                    Sensor.TYPE_AMBIENT_TEMPERATURE -> v0 < -60f || v0 > 80f
                    Sensor.TYPE_RELATIVE_HUMIDITY -> v0 <= 0f || v0 > 100f
                    Sensor.TYPE_PRESSURE -> v0 < 300f || v0 > 1100f
                    else -> false
                }
                if (bogus) { missing += key; continue }
                out[key] = when (type) {
                    Sensor.TYPE_ACCELEROMETER -> {
                        /* 重力之外的加速度大 = 在动 (走路 / 车上); 一次采样只给个粗判断 */
                        val g = Math.sqrt((value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).toDouble())
                        if (Math.abs(g - SensorManager.GRAVITY_EARTH) > 1.2) "moving" else "still"
                    }
                    Sensor.TYPE_PROXIMITY -> if (value[0] < sensor.maximumRange) "near (${value[0]}cm, 可能在口袋里或贴着脸)" else "far"
                    else -> Math.round(value[0] * 10) / 10.0
                }
            }
        } finally {
            thread.quitSafely()
        }
        val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (battery != null) {
            val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val temp = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            out["battery_pct"] = if (level >= 0 && scale > 0) level * 100 / scale else null
            out["charging"] = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            if (temp != Int.MIN_VALUE) out["battery_temp_c"] = temp / 10.0
        }
        out["missing"] = missing
        return out
    }

    private fun readOnce(sm: SensorManager, sensor: Sensor, handler: Handler): FloatArray? {
        val got = AtomicReference<FloatArray?>(null)
        val latch = CountDownLatch(1)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                if (got.compareAndSet(null, e.values.clone())) latch.countDown()
            }
            override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {}
        }
        sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, handler)
        /* 光照 / 距离只在变化时上报, 静止的屋子里可能一直不来 —— 等 1.5s 就算了 */
        latch.await(1500, TimeUnit.MILLISECONDS)
        sm.unregisterListener(listener)
        return got.get()
    }

    // ───────────────────────── 相机 ─────────────────────────

    @SuppressLint("MissingPermission") // 调用前 Dart 侧已 ensure CAMERA
    fun takePhoto(ctx: Context, front: Boolean): Map<String, Any?> {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val want = if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == want }
            ?: cm.cameraIdList.firstOrNull()
            ?: return mapOf("error" to "这台手机没有相机")
        val chars = cm.getCameraCharacteristics(id)
        val sizes = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.JPEG)
            ?: return mapOf("error" to "相机不支持拍 JPEG")
        /* 取不超过 1920 宽的最大一档: 够看清, 传给电脑也不大 */
        val size = sizes.filter { it.width <= 1920 }.maxByOrNull { it.width * it.height } ?: sizes.minBy { it.width * it.height }

        val thread = HandlerThread("neox-cam").apply { start() }
        val handler = Handler(thread.looper)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        val jpeg = AtomicReference<ByteArray?>(null)
        val error = AtomicReference<String?>(null)
        val done = CountDownLatch(1)
        var device: CameraDevice? = null
        try {
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(cam: CameraDevice) {
                    device = cam
                    @Suppress("DEPRECATION")
                    cam.createCaptureSession(listOf(reader.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            /* 先连着出几帧让自动曝光 / 对焦收敛, 直接拍第一帧常常一片黑 */
                            val preview = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                addTarget(reader.surface)
                                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                            }.build()
                            var frames = 0
                            reader.setOnImageAvailableListener({ r ->
                                val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                                frames++
                                if (frames >= 8 && jpeg.get() == null) {
                                    val buf = img.planes[0].buffer
                                    jpeg.set(ByteArray(buf.remaining()).also { buf.get(it) })
                                    img.close()
                                    try { session.stopRepeating() } catch (_: Throwable) {}
                                    done.countDown()
                                } else {
                                    img.close()
                                }
                            }, handler)
                            session.setRepeatingRequest(preview, null, handler)
                        }
                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            error.set("相机配置失败"); done.countDown()
                        }
                    }, handler)
                }
                override fun onDisconnected(cam: CameraDevice) { cam.close(); error.compareAndSet(null, "相机被别的 App 占用了"); done.countDown() }
                override fun onError(cam: CameraDevice, code: Int) {
                    cam.close()
                    /* ERROR_CAMERA_DISABLED(3) 多半是 App 在后台: 安卓 9 起后台不许开相机 */
                    error.compareAndSet(null, if (code == 3) "相机被系统禁用 (App 在后台时不能拍, 让用户把 Neox 打开)" else "相机出错 ($code)")
                    done.countDown()
                }
            }, handler)
            if (!done.await(8, TimeUnit.SECONDS)) error.compareAndSet(null, "相机 8 秒没出图")
        } catch (e: Throwable) {
            error.compareAndSet(null, e.message ?: e.javaClass.simpleName)
        } finally {
            try { device?.close() } catch (_: Throwable) {}
            reader.close()
            thread.quitSafely()
        }
        error.get()?.let { return mapOf("error" to it) }
        val raw = jpeg.get() ?: return mapOf("error" to "没拍到")

        /* 转正 (传感器方向) + 缩到长边 1280 */
        val rotation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        var bmp = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: return mapOf("error" to "照片解不开")
        val scale = 1280f / maxOf(bmp.width, bmp.height)
        val m = Matrix().apply {
            if (scale < 1f) postScale(scale, scale)
            postRotate(rotation.toFloat())
            if (front) postScale(-1f, 1f)
        }
        bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        val file = File(ctx.cacheDir, "pilot-photo-${System.currentTimeMillis()}.jpg")
        FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.JPEG, 82, it) }
        return mapOf("path" to file.absolutePath, "width" to bmp.width, "height" to bmp.height)
    }
}
