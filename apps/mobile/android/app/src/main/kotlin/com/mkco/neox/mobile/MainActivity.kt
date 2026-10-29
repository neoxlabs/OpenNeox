package com.mkco.neox.mobile

import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * MainActivity — Neox mobile 入口 Activity.
 *
 * Phase 5 商业化安全:
 *   - SECURE 模式 (FLAG_SECURE): 屏蔽截屏 + Recents 任务里的缩略图.
 *     默认 cold-start 就 ON, Dart 侧根据当前页可以 set/clear.
 *   - 实现走 MethodChannel `neox.security/screen`. Flutter 端调 set/clear, 这里转 Window flag.
 *
 * 注: FLAG_SECURE 是窗口级 flag, 一次 set 一直生效, 直到 clear 或 Activity destroy.
 *     不影响 OS 内截图 (root / debug bridge), 只防一般用户和系统级 Recents 预览泄露.
 */
private const val SECURITY_CHANNEL = "neox.security/screen"
private const val INTEGRITY_CHANNEL = "neox.security/integrity"
private const val MULTICAST_LOCK_TAG = "neox:mdns"
/* App 内更新 — 下载在 Dart 侧做, 这里只负责授权判定与拉起系统安装器 (见 ApkInstaller) */
private const val UPDATE_CHANNEL = "neox.update/apk"
/* 任务在跑时切后台的保活前台服务 (见 KeepAliveService) */
private const val KEEPALIVE_CHANNEL = "neox.sync/keepalive"

/* FlutterFragmentActivity 是 local_auth 显示生物识别 prompt dialog 必需的 — 用普通
 *  FlutterActivity 时 BiometricPrompt fragment 无法 attach, prompt 不弹.  */
class MainActivity : FlutterFragmentActivity() {
    private var multicastLock: WifiManager.MulticastLock? = null
    private var liteRt: LiteRtLmBridge? = null
    private var phoneTools: PhoneToolsBridge? = null
    private var linuxEnv: LinuxEnv? = null
    private var pilotCall: PilotCallBridge? = null
    private var pilotVoice: PilotVoiceBridge? = null
    private var push: NeoxPushService.Bridge? = null

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        phoneTools?.onPermissionsResult(requestCode, permissions)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        acquireMulticastLock()
        handlePilotCallIntent(intent)
        handleOpenIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePilotCallIntent(intent)
        handleOpenIntent(intent)
    }

    /** 点推送通知进来的: 交给 Dart 打开消息页 */
    private fun handleOpenIntent(intent: Intent?) {
        val target = intent?.getStringExtra(NeoxPushService.EXTRA_OPEN) ?: return
        if (target != "inbox" && target != "pilot_today") return
        val item = intent.getStringExtra(NeoxPushService.EXTRA_OPEN_ITEM)
        intent.removeExtra(NeoxPushService.EXTRA_OPEN)
        intent.removeExtra(NeoxPushService.EXTRA_OPEN_ITEM)
        NeoxPushService.requestOpenInbox(applicationContext, target, item)
    }

    /** Pilot 来电的全屏 / 接听意图: 锁屏上直接亮屏显示, 动作转给 Dart */
    private fun handlePilotCallIntent(intent: Intent?) {
        val callId = intent?.getStringExtra(PilotCallBridge.EXTRA_CALL_ID) ?: return
        val action = intent.getStringExtra(PilotCallBridge.EXTRA_ACTION) ?: "open"
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        intent.removeExtra(PilotCallBridge.EXTRA_CALL_ID) /* 旋转 / 重建时别再触发一次 */
        val bridge = PilotCallBridge.instance
        if (bridge != null) bridge.deliver(callId, action)
        else PilotCallBridge.pendingAction = mapOf("callId" to callId, "action" to action)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SECURITY_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "setSecure" -> {
                        runOnUiThread {
                            window.setFlags(
                                WindowManager.LayoutParams.FLAG_SECURE,
                                WindowManager.LayoutParams.FLAG_SECURE
                            )
                        }
                        result.success(null)
                    }
                    "clearSecure" -> {
                        runOnUiThread {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        }
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        /* 完整性检测 — Dart 侧启动后异步拉一次, 见 core/security/integrity_guard.dart.
         * 放子线程: root 探测要读 /proc/mounts + exec getprop, 主线程跑会拖慢首帧. */
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, INTEGRITY_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "collect" -> {
                        Thread {
                            val report = try {
                                IntegrityChecker.collect(applicationContext)
                            } catch (_: Throwable) {
                                emptyMap<String, Any>()
                            }
                            runOnUiThread { result.success(report) }
                        }.start()
                    }
                    else -> result.notImplemented()
                }
            }

        /* App 内更新 (R2 自建分发, 不走商店) — 三个方法对应安装前必须过的三道关:
         * 未知来源授权 → 送用户去授权页 → 拿 FileProvider URI 拉起安装器。 */
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, UPDATE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "canInstall" -> result.success(ApkInstaller.canInstall(applicationContext))
                    "openInstallPermissionSettings" -> {
                        ApkInstaller.openInstallPermissionSettings(this)
                        result.success(null)
                    }
                    "install" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrEmpty()) {
                            result.error("bad_args", "path required", null)
                        } else {
                            /* 返回 null = 已拉起; 字符串 = 拉不起来的原因, Dart 侧原样提示 */
                            result.success(ApkInstaller.install(this, path))
                        }
                    }
                    else -> result.notImplemented()
                }
            }

        liteRt = LiteRtLmBridge(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
        phoneTools = PhoneToolsBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        /* 设置 → 让 Pilot 一直在线: 检测系统权限 + 按厂商跳对应设置页 */
        PilotKeepAliveBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        linuxEnv = LinuxEnv(this, flutterEngine.dartExecutor.binaryMessenger)
        pilotCall = PilotCallBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        pilotVoice = PilotVoiceBridge(this, flutterEngine.dartExecutor.binaryMessenger)
        push = NeoxPushService.Bridge(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
        ContextSense.attach(applicationContext, flutterEngine.dartExecutor.binaryMessenger)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, KEEPALIVE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> result.success(
                        KeepAliveService.start(applicationContext, call.argument<String>("title")),
                    )
                    "stop" -> {
                        KeepAliveService.stop(applicationContext)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onDestroy() {
        KeepAliveService.stop(applicationContext)
        liteRt?.dispose()
        pilotCall?.dispose()
        pilotVoice?.stop()
        push?.dispose()
        PilotCallBridge.ready = false
        releaseMulticastLock()
        super.onDestroy()
    }

    private fun acquireMulticastLock() {
        try {
            val current = multicastLock
            if (current?.isHeld == true) return
            val wifiManager = applicationContext
                .getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
            multicastLock = wifiManager.createMulticastLock(MULTICAST_LOCK_TAG).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Throwable) {
            multicastLock = null
        }
    }

    private fun releaseMulticastLock() {
        try {
            multicastLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (_: Throwable) {
        } finally {
            multicastLock = null
        }
    }

    /*
     * onCreate 不再全局 set FLAG_SECURE — 用户要能截屏分享 AI 对话.
     * Dart 端在敏感页 (LoginPage/RegisterPage/ForgotPasswordPage) initState set,
     * dispose 时 clear, 实现"只锁登录类页面"的细粒度策略.
     */
}
