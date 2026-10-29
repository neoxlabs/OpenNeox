package com.mkco.neox.mobile

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.google.ai.edge.litertlm.Content
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.Executors

/**
 * 本机大模型第二引擎: Google LiteRT-LM (2026-09-30 用户: 「LiteRT-LM 搞起, 自动适配, NPU 和 GPU 都要」)。
 *
 * llama.cpp 在天玑 (Mali / Immortalis GPU) 上走不了加速, 只能 CPU; LiteRT-LM 的 GPU 走 OpenCL
 * (ML Drift), Mali 和 Adreno 都能用; NPU 走厂商调度库 (联发科 APU / 高通 HTP), 模型要按芯片预编译。
 *
 * 为什么自己写桥而不用 pub 上的 flutter_litert_lm: 那个锁在 litertlm 0.10 (Mali 上 engine_create 会崩的那版),
 * 全局只有一个流、不能中途停、拿不到实测速度。这里直接对 0.17:
 *   · load: 按要求的后端建引擎; auto = GPU → CPU, 失败带原因往下退, 返回实际用上的那个; NPU 模型只走 NPU
 *   · generate: 每轮新建 Conversation (历史作为 initialMessages), 流式回调逐段推给 Dart, 结束时附实测
 *     预填充 / 生成速度 (BenchmarkInfo)
 *   · stop: cancelProcess 真停
 * 所有重活在单线程执行器上跑 (引擎不是线程安全的), 回调切回主线程发给 Flutter。
 */
class LiteRtLmBridge(private val context: Context, messenger: BinaryMessenger) {

    private val method = MethodChannel(messenger, "neox.llm/litert")
    private val stream = EventChannel(messenger, "neox.llm/litert/stream")
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var sink: EventChannel.EventSink? = null

    private var engine: Engine? = null
    private var enginePath: String? = null
    private var engineBackend: String? = null
    private var conversation: Conversation? = null

    init {
        stream.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events }
            override fun onCancel(arguments: Any?) { sink = null }
        })
        method.setMethodCallHandler { call, result ->
            when (call.method) {
                "probe" -> result.success(probe())
                "load" -> worker.execute {
                    val r = load(
                        call.argument<String>("path")!!,
                        call.argument<String>("backend") ?: "auto",
                        call.argument<Int>("maxTokens"),
                    )
                    main.post { result.success(r) }
                }
                "generate" -> {
                    @Suppress("UNCHECKED_CAST")
                    val msgs = call.argument<List<Map<String, String>>>("messages") ?: emptyList()
                    val system = call.argument<String>("system")
                    val temperature = call.argument<Double>("temperature") ?: 0.7
                    val thinking = call.argument<Boolean>("thinking") ?: false
                    result.success(null)
                    worker.execute { generate(msgs, system, temperature, thinking) }
                }
                "stop" -> {
                    try { conversation?.cancelProcess() } catch (_: Throwable) {}
                    result.success(null)
                }
                "unload" -> worker.execute {
                    unload()
                    main.post { result.success(null) }
                }
                else -> result.notImplemented()
            }
        }
    }

    /** 这台机器有什么: SoC 型号, OpenCL 在不在, NPU 调度库带没带 */
    private fun probe(): Map<String, Any?> {
        val libDir = context.applicationInfo.nativeLibraryDir
        val openclCandidates = listOf(
            "/vendor/lib64/libOpenCL.so", "/system/vendor/lib64/libOpenCL.so",
            "/vendor/lib64/egl/libGLES_mali.so", "/system/lib64/libOpenCL.so",
        )
        return mapOf(
            "soc" to (if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else Build.HARDWARE),
            "socManufacturer" to (if (Build.VERSION.SDK_INT >= 31) Build.SOC_MANUFACTURER else ""),
            "opencl" to openclCandidates.any { File(it).exists() },
            "npuMediatek" to File(libDir, "libLiteRtDispatch_MediaTek.so").exists(),
            "npuQualcomm" to File(libDir, "libLiteRtDispatch_Qualcomm.so").exists(),
        )
    }

    private fun backendOf(name: String): Backend = when (name) {
        "gpu" -> Backend.GPU()
        "npu" -> Backend.NPU(context.applicationInfo.nativeLibraryDir)
        else -> Backend.CPU(4, null)
    }

    private fun load(path: String, requested: String, maxTokens: Int?): Map<String, Any?> {
        if (engine != null && enginePath == path && (requested == "auto" || requested == engineBackend)) {
            return mapOf("ok" to true, "backend" to engineBackend, "initSec" to 0.0, "cached" to true)
        }
        unload()
        /* NPU 模型是按芯片预编译的, 别的后端跑不了, 所以 NPU 不参与退级; auto 只在通用模型上用 */
        val order = when (requested) {
            "auto" -> listOf("gpu", "cpu")
            "npu" -> listOf("npu")
            "gpu" -> listOf("gpu")
            else -> listOf("cpu")
        }
        val errors = mutableListOf<String>()
        for (b in order) {
            val t0 = System.nanoTime()
            var e: Engine? = null
            try {
                e = Engine(
                    EngineConfig(
                        modelPath = path,
                        backend = backendOf(b),
                        maxNumTokens = maxTokens,
                        cacheDir = context.cacheDir.absolutePath,
                    )
                )
                e.initialize()
                engine = e
                enginePath = path
                engineBackend = b
                return mapOf(
                    "ok" to true,
                    "backend" to b,
                    "initSec" to (System.nanoTime() - t0) / 1e9,
                    "fallbacks" to errors,
                )
            } catch (t: Throwable) {
                try { e?.close() } catch (_: Throwable) {}
                errors.add("$b: ${t.message ?: t.javaClass.simpleName}")
            }
        }
        return mapOf("ok" to false, "errors" to errors)
    }

    private fun generate(msgs: List<Map<String, String>>, system: String?, temperature: Double, thinking: Boolean) {
        val e = engine
        if (e == null) {
            emit(mapOf("t" to "err", "msg" to "engine not loaded"))
            return
        }
        try {
            conversation?.close()
        } catch (_: Throwable) {}
        conversation = null
        val history = msgs.dropLast(1).map {
            if (it["role"] == "assistant") Message.model(it["content"] ?: "") else Message.user(it["content"] ?: "")
        }
        val last = msgs.lastOrNull()?.get("content") ?: ""
        val conv: Conversation
        try {
            var cfg = ConversationConfig(
                initialMessages = history,
                /* NPU 上采样参数不生效 (硬件只做贪心), 传了也无害 */
                samplerConfig = SamplerConfig(40, 0.95, temperature, 0),
                automaticToolCalling = false,
                thinkingConfig = ThinkingConfig(thinking),
            )
            if (!system.isNullOrBlank()) cfg = cfg.copy(systemInstruction = Contents.of(system))
            conv = e.createConversation(cfg)
        } catch (t: Throwable) {
            emit(mapOf("t" to "err", "msg" to (t.message ?: "createConversation failed")))
            return
        }
        conversation = conv
        conv.sendMessageAsync(Message.user(last), object : MessageCallback {
            override fun onMessage(message: Message) {
                val text = message.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
                if (text.isNotEmpty()) emit(mapOf("t" to "tok", "s" to text))
            }

            override fun onDone() {
                /* 实测速度: getBenchmarkInfo 是实验 API, Kotlin 侧不可见 —— 反射取, 取不到就不报速度 */
                fun num(o: Any?, getter: String): Any? = try {
                    o?.javaClass?.getMethod(getter)?.invoke(o)
                } catch (_: Throwable) { null }
                val info = try { conv.javaClass.getMethod("getBenchmarkInfo").invoke(conv) } catch (_: Throwable) { null }
                emit(
                    mapOf(
                        "t" to "done",
                        "backend" to engineBackend,
                        "ttft" to num(info, "getTimeToFirstTokenInSecond"),
                        "prefillTps" to num(info, "getLastPrefillTokensPerSecond"),
                        "decodeTps" to num(info, "getLastDecodeTokensPerSecond"),
                        "decodeTokens" to num(info, "getLastDecodeTokenCount"),
                    )
                )
            }

            override fun onError(throwable: Throwable) {
                emit(mapOf("t" to "err", "msg" to (throwable.message ?: throwable.javaClass.simpleName)))
            }
        })
    }

    private fun unload() {
        try { conversation?.close() } catch (_: Throwable) {}
        conversation = null
        try { engine?.close() } catch (_: Throwable) {}
        engine = null
        enginePath = null
        engineBackend = null
    }

    private fun emit(m: Map<String, Any?>) {
        main.post { sink?.success(m) }
    }

    fun dispose() {
        worker.execute { unload() }
    }
}
