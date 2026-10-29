package com.mkco.neox.mobile

/**
 * 动作之后的等待策略 (pilot:D-06, 2026-10-18) —— 不再固定多等 3.5 秒。
 *
 * 以前: 点完先睡 400ms, 再每 250ms 读一次屏, 直到控件文本变了 (最长 3.5s), 变了再睡 300ms。
 * 现在看两样东西, 谁先满足谁收尾:
 *   · 可见变化: 控件文本变了, 并且之后 [stableMs] 没再变 —— 画面已经画完;
 *   · 网络 idle: 全机流量计数 [idleMs] 没动 —— 在等的那次请求已经回来。
 *
 * 收尾条件:
 *   变过 → 稳定 且 (网络 idle, 或变了之后网络又忙满 [networkGraceMs]);
 *   没变 → 至少等 [minWaitMs], 且 (网络 idle, 或已经到 [minWaitMs] + [noChangeGraceMs]) ——
 *          点了没反应就早点如实说, 别硬等 3.5 秒;
 *   到了 [maxWaitMs] 还没收尾 → 也收尾 (变过当变化, 没变过当没变)。
 *
 * 只做判断, 不碰 Android API (时间与流量都由调用方采样), 所以能被 JVM 单测钉住。
 */
class SettleWait(
    private val startMs: Long,
    before: String?,
    private val maxWaitMs: Long = MAX_WAIT_MS,
    private val minWaitMs: Long = MIN_WAIT_MS,
    private val stableMs: Long = STABLE_MS,
    private val idleMs: Long = IDLE_MS,
    private val networkGraceMs: Long = NETWORK_GRACE_MS,
    private val noChangeGraceMs: Long = NO_CHANGE_GRACE_MS,
) {
    enum class Done { CONTINUE, CHANGED, UNCHANGED }

    private var lastSignature: String? = before
    private var lastChangeAt = startMs
    private var lastTraffic = -1L
    private var lastTrafficAt = startMs
    private var everChanged = false

    /** 还要不要继续等: [signature] 是这一屏的控件文本, [trafficBytes] 是全机收发字节数 */
    fun observe(now: Long, signature: String?, trafficBytes: Long): Done {
        if (lastTraffic < 0) {
            /* 第一次采样只立基线, 用来算「多久没动」 */
            lastTraffic = trafficBytes
        } else if (trafficBytes != lastTraffic) {
            lastTraffic = trafficBytes
            lastTrafficAt = now
        }
        if (signature != lastSignature) {
            lastSignature = signature
            lastChangeAt = now
            everChanged = true
        }

        val waited = now - startMs
        val stable = now - lastChangeAt >= stableMs
        val networkIdle = now - lastTrafficAt >= idleMs

        if (everChanged) {
            if (stable && (networkIdle || now - lastChangeAt >= networkGraceMs)) return Done.CHANGED
            if (waited >= maxWaitMs) return Done.CHANGED
        } else {
            val early = waited >= minWaitMs && (networkIdle || waited >= minWaitMs + noChangeGraceMs)
            if (early) return Done.UNCHANGED
            if (waited >= maxWaitMs) return Done.UNCHANGED
        }
        return Done.CONTINUE
    }

    companion object {
        /** 最多等这么久 (慢页面 / 强网下加载) */
        const val MAX_WAIT_MS = 3500L
        /** 点了没变化也先看这么久, 再判断「没反应」(不短于以前固定等的 400ms) */
        const val MIN_WAIT_MS = 400L
        /** 控件文本连续静止这么久才算画完 */
        const val STABLE_MS = 200L
        /** 流量计数静止这么久算网络 idle */
        const val IDLE_MS = 150L
        /** 画面在连续变 (视频 / 直播) 时, 变完之后最多再等网络这么久 */
        const val NETWORK_GRACE_MS = 700L
        /** 点了没变化, 网络又一直忙: 再多等这么久就如实说没反应 */
        const val NO_CHANGE_GRACE_MS = 900L
    }
}
