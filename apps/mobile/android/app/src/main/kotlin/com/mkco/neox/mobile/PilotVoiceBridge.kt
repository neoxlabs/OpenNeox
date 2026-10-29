package com.mkco.neox.mobile

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Pilot 的声音 (2026-10-01): 播 Pilot 说的话。
 * 这里只播 —— 合成在 Dart 那边按设置拿 (订阅 / 自己的阿里云 Key / 本地模型, core/voice/pilot_voice.dart)。
 * play() 播完才返回, 通话循环据此接着听。
 */
class PilotVoiceBridge(context: Context, messenger: BinaryMessenger) {
    private val ctx = context.applicationContext
    private var player: MediaPlayer? = null
    private var pending: MethodChannel.Result? = null

    init {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "play" -> play(
                    call.argument<ByteArray>("audio"),
                    call.argument<String>("format") ?: "mp3",
                    call.argument<Boolean>("media") ?: false,
                    result,
                )
                "stop" -> { stop(); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }

    /**
     * [media] = 走媒体音量、外放 (Chat 的语音对话)。不带 = 通话用途 (Pilot 打电话的感觉):
     * VOICE_COMMUNICATION 在不少机型上走听筒 / 通话音量, 手机拿在手上基本听不见 ——
     * 2026-10-05 语音对话「TTS 不出声音」之一。
     */
    private fun play(audio: ByteArray?, format: String, media: Boolean, result: MethodChannel.Result) {
        stop()
        if (audio == null || audio.isEmpty()) { result.success(false); return }
        val file = File(ctx.cacheDir, "pilot-voice.${format.ifBlank { "mp3" }}")
        runCatching { file.writeBytes(audio) }.onFailure { result.success(false); return }
        pending = result
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(AudioAttributes.Builder()
                .setUsage(if (media) AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            mp.setDataSource(file.absolutePath)
            mp.setOnCompletionListener { finish(mp, true) }
            mp.setOnErrorListener { _, _, _ -> finish(mp, false); true }
            /* 准备期间点了停 / 换了一句: 这个播放器已经作废, 不能再 start (否则上一句的声音会冒出来) */
            mp.setOnPreparedListener { if (player === mp) it.start() }
            mp.prepareAsync()
        } catch (e: Throwable) {
            finish(mp, false)
        }
    }

    /** [mp] 是发事件的那个播放器: 已经被换掉 / 停掉的旧播放器不许动现在这个 (pilot:U-20) */
    private fun finish(mp: MediaPlayer?, ok: Boolean) {
        if (mp != null && player !== mp) {
            runCatching { mp.release() }
            return
        }
        runCatching { player?.release() }
        player = null
        pending?.let { pending = null; it.success(ok) }
    }

    fun stop() {
        val mp = player
        /* 还在 prepareAsync 时 stop() 会抛 IllegalStateException; 后面的 release 一样立刻没声 */
        runCatching { mp?.stop() }
        finish(mp, false)
    }

    companion object {
        const val CHANNEL = "neox.pilot/voice"
    }
}
