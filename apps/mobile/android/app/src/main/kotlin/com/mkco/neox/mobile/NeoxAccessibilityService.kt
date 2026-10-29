package com.mkco.neox.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.TrafficStats
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File
import java.io.FileOutputStream
import java.math.BigDecimal
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Pilot 替你在手机上点 (2026-10-01, NEOX_PILOT_JARVIS P3) —— 点外卖、叫车、查订单这类「得在别的 App 里操作」的事。
 *
 * 跟电脑上的 computer_snapshot 同一个套路, 模型最好用:
 *   snapshot    当前屏幕上能看能点的控件, 编号列出来 (哪个 App、标题、[3] 按钮「下单」…)
 *   tap n       点第 n 个 (不能点的往上找能点的父级; 实在不行按坐标点)
 *   type n 文本 往第 n 个输入框里填
 *   scroll      上 / 下滑
 *   back / home
 *   screenshot  截一张给模型看 (界面是图片、控件没文字时)
 * 每个动作做完等界面稳一下, 直接回新的 snapshot —— 省一来一回。
 *
 * 付钱的那一下有闸 (PayGuard): 要点的控件文字像「立即充值 / 呼叫快车 / 转账 / 去结算 / 确认支付」,
 * 或者干脆就是价格「¥32」, 没带 confirmed 就不点, 回一句让 Pilot 先 report_to_user(blocked) 问你 ——
 * 这道闸是代码, 不靠模型自觉。
 * 按钮字里没有金额时, 闸还会记下用户点头那一刻页面上的金额 (PayAmountWatch), 点下去之前比一遍、
 * 点完再比一遍: 32 变成 320 就停下让用户重新拍板, 不按旧的同意继续 (pilot:S-02)。
 *
 * 用户在 设置 → 无障碍 里打开才会运行; 平时只在被调用时读屏幕, 不记录、不上传任何界面内容。
 */
class NeoxAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
        /* 启动清扫 (pilot:D-08): 上一次进程留下的截图随上一轮一起作废, 一张不留 */
        runCatching { ScreenshotCache.sweepAll(cacheDir, SHOT_PREFIX) }
        ShotRound.clear()
    }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }
    /* 只记最后一次界面变化的时刻 (点完等屏幕定下来用), 不读内容 */
    @Volatile private var lastChangeAt = 0L
    override fun onAccessibilityEvent(event: AccessibilityEvent?) { lastChangeAt = SystemClock.uptimeMillis() }
    override fun onInterrupt() {}

    private var lastNodes: List<AccessibilityNodeInfo> = emptyList()
    private var lastElements: String? = null
    /** 最近一次点下去的付款按钮 (字, 时刻) */
    private var lastPay: Pair<String, Long>? = null
    /** 动钱被拦下时的页面金额 (pilot:S-02): 用户同意的是这个数, 批准后再点要比一遍 */
    private var pendingPay: Triple<String, BigDecimal?, Long>? = null

    // ───────────────────────── 读屏 ─────────────────────────

    fun snapshot(): Map<String, Any?> {
        /* 系统会缓存控件树; 网页 (Chrome / App 里的 WebView) 改了内容, 缓存不一定跟着失效 ——
         * 实测点完「立即购买」页面已经是「下单成功」, 读回来还是购买页, 模型以为没点上又点一次 = 第二单。
         * 所以每次读屏先清缓存, 遍历时每个节点也 refresh 一下 (已经不在的节点 refresh 返回 false, 跳过) */
        if (Build.VERSION.SDK_INT >= 34) runCatching { clearCache() }
        val root = rootInActiveWindow ?: return mapOf("error" to "读不到当前界面 (锁屏中, 或系统界面不让读)")
        val nodes = mutableListOf<AccessibilityNodeInfo>()
        val lines = mutableListOf<String>()
        walk(root, nodes, lines, 0)
        lastNodes = nodes
        lastElements = lines.joinToString("\n")
        val pkg = root.packageName?.toString() ?: ""
        val app = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        /* 密码页 (pilot:D-09): 密码框已经打码, 再告诉模型这一屏不该截图、不该代填 */
        val passwordScreen = PasswordScreenPolicy.isPasswordScreen(
            nodes.map { PasswordScreenPolicy.Control(editable = it.isEditable, password = it.isPassword) },
        )
        val base = mapOf<String, Any?>(
            "app" to app,
            "package" to pkg,
            /* 窗口标题 (pilot:D-07 自检用): 同一个 App 里换了页, 标题会变 */
            "title" to windowTitle(root),
            "elements" to lines.joinToString("\n"),
            "count" to nodes.size,
            "hint" to if (nodes.isEmpty()) "这个界面读不出控件 (多半是游戏 / 视频 / 自绘界面), 用 screenshot 看图, 再按坐标点" else null,
        )
        return if (passwordScreen) base + mapOf("password_screen" to true) else base
    }

    private fun walk(n: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>, lines: MutableList<String>, depth: Int) {
        if (depth > 40 || out.size >= MAX_ELEMENTS) return
        if (!n.refresh() || !n.isVisibleToUser) return
        /* 密码框不回传 (pilot:D-09): 用户可能已经输了一半 —— 原文和描述都不读, 只留「这里有个输入框」 */
        val masked = PasswordScreenPolicy.mask(
            PasswordScreenPolicy.Control(editable = n.isEditable, password = n.isPassword),
        )
        val text = if (masked) "" else n.text?.toString()?.trim().orEmpty()
        val desc = if (masked) "" else n.contentDescription?.toString()?.trim().orEmpty()
        val interactive = n.isClickable || n.isEditable || n.isScrollable || n.isCheckable || n.isLongClickable
        val label = when {
            text.isNotEmpty() && desc.isNotEmpty() && desc != text -> "$text ($desc)"
            text.isNotEmpty() -> text
            else -> desc
        }
        if (interactive || label.isNotEmpty() || masked) {
            out += n
            val kind = when {
                n.isEditable -> "输入框"
                n.isCheckable -> if (n.isChecked) "开关[开]" else "开关[关]"
                n.isScrollable -> "可滑动区域"
                n.isClickable -> "按钮"
                else -> "文字"
            }
            if (masked) {
                lines += PasswordScreenPolicy.maskedLine(out.size, kind)
            } else {
                val shown = if (label.length > 60) label.take(60) + "…" else label
                lines += "[${out.size}] $kind${if (shown.isNotEmpty()) " 「$shown」" else ""}${if (n.isEditable && n.isFocused) " (正在输入)" else ""}"
            }
        }
        for (i in 0 until n.childCount) {
            val c = n.getChild(i) ?: continue
            walk(c, out, lines, depth + 1)
        }
    }

    // ───────────────────────── 动作 ─────────────────────────

    private fun node(index: Int): AccessibilityNodeInfo? = lastNodes.getOrNull(index - 1)

    private fun labelOf(n: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        n.text?.let { parts += it.toString() }
        n.contentDescription?.let { parts += it.toString() }
        /* 按钮字常在子节点上 (「¥32 去支付」是一个 FrameLayout 包着两个 TextView) */
        for (i in 0 until minOf(n.childCount, 6)) n.getChild(i)?.text?.let { parts += it.toString() }
        return parts.joinToString(" ")
    }

    fun tap(index: Int, confirmed: Boolean): Map<String, Any?> {
        val n = node(index) ?: return mapOf("error" to "没有第 $index 个控件, 先 snapshot 看看现在屏幕上有什么")
        val label = labelOf(n)
        val isPay = PayGuard.isMoneyAction(label)
        val now = SystemClock.uptimeMillis()
        /* 点前记金额 (pilot:S-02): 读当前实屏, 不拿上一次快照充数 (页面可能自己刷新了) */
        val liveText = if (isPay) currentText() else null
        /* 聊天 App 里「发送」: 读随便读, 以用户名义发出去的每一条都要用户点头 (2026-10-12) */
        val pkg = n.packageName?.toString().orEmpty()
        if (!confirmed && pkg in IM_APPS && SEND.matches(label.trim())) {
            return mapOf("error" to "这是在「${pkg.substringAfterLast('.')}」里以用户的名义发消息。先 report_to_user(status=blocked) 把发给谁、发什么说清楚让用户确认; 同意后再带 confirmed=true 点发送。", "blocked" to true)
        }
        if (!confirmed && isPay) {
            /* 点前记金额 (pilot:S-02): 记下用户此刻看到的数, 用户同意的就是它 */
            val agreed = PayAmountWatch.payable(liveText)
            pendingPay = Triple(label, agreed, now)
            val howMuch = if (agreed == null) "" else "这单现在是 ¥${agreed.stripTrailingZeros().toPlainString()}, "
            return mapOf(
                "error" to "「$label」是付钱的那一步。${howMuch}先 report_to_user(status=blocked) 把要付多少、买的是什么说清楚让用户拍板; 用户同意后再带 confirmed=true 点。",
                "blocked" to true,
                "amount" to agreed?.stripTrailingZeros()?.toPlainString(),
            )
        }
        if (confirmed && isPay) {
            /* 用户点头到真点下去之间页面可能被改价: 金额变了就不按原批准执行 */
            val agreed = pendingPay?.takeIf { it.first == label && now - it.third < PAY_APPROVAL_MS }?.second
            PayAmountWatch.escalated(agreed, PayAmountWatch.payable(liveText))?.let { change ->
                return mapOf("error" to "${change.message} —— 不是用户同意的数。先 report_to_user(status=blocked) 把新金额告诉用户重新拍板; 用户重新同意前不要再点。", "blocked" to true)
            }
        }
        /* 用户同意的是「一单」: 两分钟内再点同一个付款按钮, 多半是没看清已经付了 —— 拦下, 先截图看结果 */
        lastPay?.let { (l, at) ->
            if (isPay && l == label && now - at < 120_000) {
                return mapOf("error" to "${(now - at) / 1000} 秒前刚点过「$label」, 很可能已经付了。先 screenshot 看清结果; 真没成, report_to_user(status=blocked) 告诉用户, 别再点。", "blocked" to true)
            }
        }
        val beforeAmount = PayAmountWatch.payable(liveText)
        var target: AccessibilityNodeInfo? = n
        while (target != null && !target.isClickable) target = target.parent
        val ok = target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true || gestureTap(center(n))
        if (!ok) return mapOf("error" to "点不动「$label」")
        if (isPay) {
            lastPay = label to now
            pendingPay = null
        }
        val snap = settleAndSnapshot("点了「${label.take(30)}」")
        if (isPay) {
            /* 点后对比 (pilot:S-02): 按钮字没变, 但页面上的金额可能变了 —— 停下, 让用户重新拍板 */
            PayAmountWatch.escalated(beforeAmount, PayAmountWatch.payable(snap["elements"] as? String))?.let { change ->
                return snap + mapOf(
                    "warning" to "${change.message} —— 金额变了, 先停下: report_to_user(status=blocked) 把变化告诉用户, 别再点付款 / 继续下单。",
                    "blocked" to true,
                    "amount_before" to change.beforeText,
                    "amount_after" to change.afterText,
                )
            }
        }
        return snap
    }

    fun tapAt(x: Float, y: Float, confirmed: Boolean = false, expect: String? = null): Map<String, Any?> {
        val root = rootInActiveWindow
        val beforePkg = root?.packageName?.toString().orEmpty()
        val beforeTitle = windowTitle(root)
        val hit = nodeAt(root, x.toInt(), y.toInt())
        val label = if (hit != null) labelOf(hit).trim() else ""
        val isPay = hit != null && PayGuard.isMoneyAction(label)
        val now = SystemClock.uptimeMillis()
        /* 点前记金额 (pilot:S-02): 读当前实屏 */
        val liveText = if (isPay) currentText() else null
        /* 按坐标点也过同一道闸: 看坐标底下是什么控件 (不然截图找到「发送」/「付款」按坐标一点就绕过去了) */
        if (!confirmed && hit != null) {
            val pkg = hit.packageName?.toString().orEmpty()
            if (pkg in IM_APPS && SEND.matches(label)) {
                return mapOf("error" to "坐标 ($x, $y) 上是「$label」—— 发消息 / 付钱要用户确认: 先 report_to_user(status=blocked) 说清楚, 同意后带 confirmed=true 再点。", "blocked" to true)
            }
            if (isPay) {
                /* 点前记金额 (pilot:S-02): 用户同意的就是这个数 */
                val agreed = PayAmountWatch.payable(liveText)
                pendingPay = Triple(label, agreed, now)
                val howMuch = if (agreed == null) "" else "这单现在是 ¥${agreed.stripTrailingZeros().toPlainString()}, "
                return mapOf(
                    "error" to "坐标 ($x, $y) 上是「$label」—— 发消息 / 付钱要用户确认。${howMuch}先 report_to_user(status=blocked) 说清楚, 同意后带 confirmed=true 再点。",
                    "blocked" to true,
                    "amount" to agreed?.stripTrailingZeros()?.toPlainString(),
                )
            }
        }
        if (confirmed && isPay) {
            /* 用户点头到真点下去之间页面可能被改价: 金额变了就不按原批准执行 */
            val agreed = pendingPay?.takeIf { it.first == label && now - it.third < PAY_APPROVAL_MS }?.second
            PayAmountWatch.escalated(agreed, PayAmountWatch.payable(liveText))?.let { change ->
                return mapOf("error" to "${change.message} —— 不是用户同意的数。先 report_to_user(status=blocked) 把新金额告诉用户重新拍板; 用户重新同意前不要再点。", "blocked" to true)
            }
        }
        /* 点之前自检 (pilot:D-07): 坐标上的控件还是不是模型以为的那个 —— App 改版就拒点 */
        TapSelfCheck.preCheck(expect, label, beforePkg, beforeTitle)?.let { return mapOf("error" to it) }
        val beforeAmount = PayAmountWatch.payable(liveText)
        if (!gestureTap(x to y)) return mapOf("error" to "这个位置点不了")
        if (isPay) {
            lastPay = label to now
            pendingPay = null
        }
        val snap = settleAndSnapshot("点了坐标 ($x, $y)")
        /* 点完之后自检: 前台 App 换人了 (点错 / 跳走) 就说明白, 别让模型按原计划继续 */
        val afterPkg = snap["package"]?.toString().orEmpty()
        val afterTitle = snap["title"]?.toString()
        /* 点后对比 (pilot:S-02): 按钮字没变, 金额变了就停下 */
        val amountWarn = PayAmountWatch.escalated(beforeAmount, PayAmountWatch.payable(snap["elements"] as? String))?.let {
            "${it.message} —— 金额变了, 先停下: report_to_user(status=blocked) 把变化告诉用户, 别再点付款 / 继续下单。"
        }
        val warning = listOfNotNull(TapSelfCheck.afterTap(beforePkg, beforeTitle, afterPkg, afterTitle), amountWarn)
            .joinToString(" ")
            .ifEmpty { null }
        return if (warning == null) snap else snap + ("warning" to warning) + (if (amountWarn != null) mapOf("blocked" to true) else emptyMap())
    }

    /** 坐标底下最深的那个可见控件 (往上找第一个可点的, 那才是按钮本身) */
    private fun nodeAt(root: AccessibilityNodeInfo?, x: Int, y: Int): AccessibilityNodeInfo? {
        root ?: return null
        var deepest: AccessibilityNodeInfo? = null
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (depth > 50 || !n.isVisibleToUser) return
            val r = Rect(); n.getBoundsInScreen(r)
            if (!r.contains(x, y)) return
            deepest = n
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        var t = deepest
        while (t != null && !t.isClickable) t = t.parent
        return t ?: deepest
    }

    /**
     * 当前屏幕上所有文字 —— 只给动钱闸读金额用 (pilot:S-02)。
     * 不动 lastNodes / lastElements: 点按编号仍然指向模型刚才看到的那一屏。
     */
    private fun currentText(): String? {
        val root = rootInActiveWindow ?: return lastElements
        val lines = mutableListOf<String>()
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (depth > 40 || lines.size >= 400) return
            if (!n.isVisibleToUser || n.isPassword) return
            n.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += it }
            n.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() && it.length <= 60 }?.let { lines += it }
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        return if (lines.isEmpty()) lastElements else lines.joinToString("\n")
    }

    fun type(index: Int?, text: String): Map<String, Any?> {
        val n = index?.let { node(it) } ?: findFocusedEditable(rootInActiveWindow)
            ?: return mapOf("error" to "没找到输入框: 先 tap 输入框, 或给出它的编号")
        if (!n.isEditable) return mapOf("error" to "第 $index 个不是输入框")
        /* 密码框不代填 (pilot:D-09 同一道边界): 密码由用户自己敲 */
        if (!PasswordScreenPolicy.allowTyping(PasswordScreenPolicy.Control(editable = n.isEditable, password = n.isPassword))) {
            return PasswordScreenPolicy.refusal() + mapOf("error" to "这是密码框: 不代填。把页面停在要输密码的地方, 让用户自己输入。")
        }
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        val ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        return if (ok) settleAndSnapshot("填了「${text.take(30)}」") else mapOf("error" to "这个输入框不让填")
    }

    fun scroll(down: Boolean, index: Int?): Map<String, Any?> {
        val n = index?.let { node(it) } ?: lastNodes.firstOrNull { it.isScrollable }
        val ok = n?.performAction(if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) == true
            || swipe(down)
        return if (ok) settleAndSnapshot(if (down) "往下滑了" else "往上滑了") else mapOf("error" to "滑不动 (到头了?)")
    }

    fun global(action: String): Map<String, Any?> {
        val code = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            else -> return mapOf("error" to "不认识的动作 $action")
        }
        return if (performGlobalAction(code)) settleAndSnapshot(action) else mapOf("error" to "$action 没成功")
    }

    fun screenshot(): Map<String, Any?> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return mapOf("error" to "安卓 11 以下不能截屏, 用 snapshot 读控件")
        /* 密码页不截屏 (pilot:D-09): 整屏图会把用户已经输了一半的密码 / 键盘痕迹一起送上去 */
        if (PasswordScreenPolicy.isPasswordScreen(passwordControls(rootInActiveWindow))) {
            return PasswordScreenPolicy.refusal()
        }
        val got = AtomicReference<Bitmap?>(null)
        val err = AtomicReference<String?>(null)
        val latch = CountDownLatch(1)
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                got.set(Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false))
                result.hardwareBuffer.close()
                latch.countDown()
            }
            override fun onFailure(errorCode: Int) { err.set("截屏失败 ($errorCode)"); latch.countDown() }
        })
        latch.await(5, TimeUnit.SECONDS)
        err.get()?.let { return mapOf("error" to it) }
        var bmp = got.get() ?: return mapOf("error" to "截屏没回来")
        val scale = 1280f / maxOf(bmp.width, bmp.height)
        if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
        val file = File(cacheDir, "$SHOT_PREFIX${System.currentTimeMillis()}.jpg")
        FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        /* 记进本轮 (pilot:D-08): 任务一结束就删, 不留半小时 */
        ShotRound.record(file.absolutePath)
        /* 兜底: 清掉 30 分钟前的旧图, 刚写的这张和最近十张不动 ——
         * 异常 / 崩溃没走到「任务结束」时, 也不会越攒越多 */
        runCatching { ScreenshotCache.prune(cacheDir, SHOT_PREFIX, keep = setOf(file.name)) }
        /* 坐标换算: 模型按截图上的像素给 tap_at, 这里告诉它比例 */
        return mapOf("path" to file.absolutePath, "width" to bmp.width, "height" to bmp.height, "scale" to scale.coerceAtMost(1f))
    }

    // ───────────────────────── 整段读屏 (Phone Use, 2026-10-12) ─────────────────────────
    //
    // 用户: 「AI agent 能直接跑到微信、QQ 拿截图读取信息…这样用户才能更充分的融入生活」。
    // snapshot 只给一屏、而且是「控件列表」(给点按用的); 读聊天要的是一段对话: 往上翻几屏,
    // 每屏把文字按从上到下收起来, 按气泡在左 / 右分出「对方 / 我」, 居中的短字是时间 / 系统提示。
    // 相邻两屏有重叠, 拼的时候去掉重叠段。不针对某个 App 写死控件 id —— 微信 / QQ / 钉钉 / 短信都是左右气泡。

    fun readText(pages: Int, up: Boolean): Map<String, Any?> {
        if (Build.VERSION.SDK_INT >= 34) runCatching { clearCache() }
        val root = rootInActiveWindow ?: return mapOf("error" to "读不到当前界面 (锁屏中, 或系统界面不让读)")
        val pkg = root.packageName?.toString() ?: ""
        val app = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        val n = pages.coerceIn(1, 15)
        val shots = mutableListOf<List<String>>()
        var prevSig: String? = null
        for (i in 0 until n) {
            if (i > 0 && !pageTurn(up)) break
            val lines = pageLines()
            val sig = lines.joinToString("\n")
            if (sig == prevSig) break // 到头了 (翻不动 / 内容没变)
            shots += lines
            prevSig = sig
        }
        /* 往上翻: 后读到的是更早的, 倒过来拼成时间顺序 */
        val ordered = if (up) shots.reversed() else shots
        var merged = emptyList<String>()
        for (p in ordered) merged = mergeOverlap(merged, p)
        var text = merged.joinToString("\n")
        val cut = text.length > MAX_READ_CHARS
        if (cut) text = "…(更早的省略)\n" + text.takeLast(MAX_READ_CHARS)
        lastNodes = emptyList(); lastElements = null // 翻过页了, 旧编号作废
        return mapOf("app" to app, "package" to pkg, "pages" to shots.size, "text" to text, "truncated" to cut)
    }

    /** 一屏的文字, 从上到下; 每行带位置标记: 「对方」靠左、「我」靠右、「·」居中 (时间 / 系统提示) */
    private fun pageLines(): List<String> {
        if (Build.VERSION.SDK_INT >= 34) runCatching { clearCache() }
        val root = rootInActiveWindow ?: return emptyList()
        val w = resources.displayMetrics.widthPixels.toFloat()
        val h = resources.displayMetrics.heightPixels.toFloat()
        val items = mutableListOf<Triple<Rect, String, Boolean>>() // 位置, 字, 是不是头像 / 图片描述
        fun walk(x: AccessibilityNodeInfo, depth: Int) {
            if (depth > 50 || items.size > 400) return
            if (!x.refresh() || !x.isVisibleToUser) return
            val t = x.text?.toString()?.trim().orEmpty()
            val d = x.contentDescription?.toString()?.trim().orEmpty()
            val r = Rect(); x.getBoundsInScreen(r)
            /* 密码框一个字都不收 (pilot:D-09): 读聊天不该把密码读出来 */
            if (!x.isEditable && !x.isPassword && r.height() > 0) {
                if (t.isNotEmpty()) items += Triple(r, t, false)
                /* 没字但有描述的: 头像 (「张三头像」, 群聊里靠它知道是谁说的)、图片 / 语音 / 表情 */
                else if (d.isNotEmpty() && d.length <= 40 && x.childCount == 0) items += Triple(r, d, true)
            }
            for (i in 0 until x.childCount) x.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        /* 顶栏 (标题 / 返回) 和底部输入栏不算对话内容: 只取中间 8% ~ 90% 高度 */
        val body = items.filter { it.first.centerY() > h * 0.08 && it.first.centerY() < h * 0.9 }
            .sortedWith(compareBy({ it.first.top }, { it.first.left }))
        val out = mutableListOf<String>()
        for ((r, t, isDesc) in body) {
            val side = when {
                r.left > w * 0.3 && r.right > w * 0.8 -> "我"
                r.left < w * 0.25 -> "对方"
                else -> "·"
            }
            val line = if (isDesc) "$side: [$t]" else "$side: $t"
            if (out.lastOrNull() != line) out += line
        }
        return out
    }

    /** 翻一屏: 优先让列表自己滚 (不碰屏幕上的东西), 不行再滑; 等到内容变了再回 */
    private fun pageTurn(up: Boolean): Boolean {
        val before = pageLines().joinToString("\n")
        val list = biggestScrollable(rootInActiveWindow)
        val ok = list?.performAction(if (up) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) == true
            || swipe(!up)
        if (!ok) return false
        val deadline = SystemClock.uptimeMillis() + 2500
        Thread.sleep(350)
        while (SystemClock.uptimeMillis() < deadline) {
            if (pageLines().joinToString("\n") != before) { Thread.sleep(250); return true }
            Thread.sleep(200)
        }
        return false
    }

    private fun biggestScrollable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        root ?: return null
        var best: AccessibilityNodeInfo? = null
        var bestArea = 0
        fun walk(x: AccessibilityNodeInfo, depth: Int) {
            if (depth > 40) return
            if (x.isScrollable && x.isVisibleToUser) {
                val r = Rect(); x.getBoundsInScreen(r)
                val a = r.width() * r.height()
                if (a > bestArea) { best = x; bestArea = a }
            }
            for (i in 0 until x.childCount) x.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        return best
    }

    /** older 在前、newer 在后, 去掉 newer 开头跟 older 结尾重叠的那段 */
    private fun mergeOverlap(older: List<String>, newer: List<String>): List<String> {
        val max = minOf(older.size, newer.size)
        for (m in max downTo 1) {
            if (older.subList(older.size - m, older.size) == newer.subList(0, m)) return older + newer.subList(m, newer.size)
        }
        return older + newer
    }

    // ───────────────────────── 底层 ─────────────────────────

    private fun center(n: AccessibilityNodeInfo): Pair<Float, Float> {
        val r = Rect(); n.getBoundsInScreen(r)
        return r.exactCenterX() to r.exactCenterY()
    }

    private fun gesture(path: Path, ms: Long): Boolean {
        val done = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        val sent = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { ok.set(true); done.countDown() }
            override fun onCancelled(d: GestureDescription?) { done.countDown() }
        }, null)
        if (!sent) return false
        done.await(3, TimeUnit.SECONDS)
        return ok.get()
    }

    private fun gestureTap(p: Pair<Float, Float>): Boolean = gesture(Path().apply { moveTo(p.first, p.second) }, 60)

    private fun swipe(down: Boolean): Boolean {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val (y1, y2) = if (down) dm.heightPixels * 0.75f to dm.heightPixels * 0.3f else dm.heightPixels * 0.3f to dm.heightPixels * 0.75f
        return gesture(Path().apply { moveTo(x, y1); lineTo(x, y2) }, 300)
    }

    private fun findFocusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? =
        root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }

    /** 动作之后界面要动一会儿 (跳页 / 加载), 等它稳了再读 (pilot:D-06: 可见变化 + 网络 idle) */
    private fun settleAndSnapshot(did: String): Map<String, Any?> {
        /* 固定等一会儿再读会读到旧屏: 网页 (Chrome) 的控件树比画面晚一两秒才更新, 点完「立即购买」画面已是
         * 「下单成功」, 读回来还是购买页 —— 模型以为没点上, 又点一次 = 第二单。
         * 所以拿上一次读到的屏幕作对照, 等到「控件文本变了 + 静止 200ms + 网络 150ms 没动」才回;
         * 点了没反应就别硬等 3.5 秒, 早早如实说「屏幕没变」。判断规则在 SettleWait (有单测)。 */
        val wait = SettleWait(SystemClock.uptimeMillis(), lastElements)
        var snap = snapshot()
        var done = wait.observe(SystemClock.uptimeMillis(), snap["elements"] as? String, trafficBytes())
        while (done == SettleWait.Done.CONTINUE) {
            Thread.sleep(POLL_MS)
            snap = snapshot()
            done = wait.observe(SystemClock.uptimeMillis(), snap["elements"] as? String, trafficBytes())
        }
        if (done == SettleWait.Done.CHANGED) return snap + ("did" to did)
        return snap + ("did" to did) + ("hint" to "屏幕看起来没变化: 可能还在加载, 也可能没点上。先 screenshot 看清楚再决定, 别直接重复。")
    }

    /** 全机收发字节数 —— 用来判断网络 idle (pilot:D-06); 取不到就返回稳定的 -1, 当作一直 idle */
    private fun trafficBytes(): Long {
        val rx = TrafficStats.getTotalRxBytes()
        val tx = TrafficStats.getTotalTxBytes()
        if (rx < 0 || tx < 0) return -1L
        return rx + tx
    }

    /** 前台窗口标题 (pilot:D-07), 读不到给 null */
    private fun windowTitle(root: AccessibilityNodeInfo?): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return null
        return runCatching { root?.window?.title?.toString()?.takeIf { it.isNotBlank() } }.getOrNull()
    }

    /** 任务结束: 删掉本轮截的图 (pilot:D-08) */
    fun endRoundShots(): Int = ShotRound.end(cacheDir, SHOT_PREFIX)

    /** 当前屏幕上看得见的密码框 —— 只收集判定要的事实, 一个字都不读 (pilot:D-09) */
    private fun passwordControls(root: AccessibilityNodeInfo?): List<PasswordScreenPolicy.Control> {
        root ?: return emptyList()
        val out = mutableListOf<PasswordScreenPolicy.Control>()
        fun collect(n: AccessibilityNodeInfo, depth: Int) {
            if (depth > 40 || out.isNotEmpty()) return
            if (!n.isVisibleToUser) return
            if (n.isPassword) {
                out += PasswordScreenPolicy.Control(editable = n.isEditable, password = true)
                return
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { collect(it, depth + 1) }
        }
        collect(root, 0)
        return out
    }

    /** 当前前台 App 的包名 (策略检查用) */
    fun foregroundPackage(): String? = rootInActiveWindow?.packageName?.toString()

    companion object {
        @Volatile var instance: NeoxAccessibilityService? = null
        private const val MAX_ELEMENTS = 150
        private const val MAX_READ_CHARS = 20000
        /* 截图的文件名前缀 (清理只认这个) */
        const val SHOT_PREFIX = "pilot-screen-"
        /* 动作后读屏的轮询间隔 (pilot:D-06) */
        private const val POLL_MS = 120L
        /* 用户点头后多久内还认这次同意 (pilot:S-02 金额比对 / S-03 令牌同口径: 10 分钟) */
        private const val PAY_APPROVAL_MS = 10 * 60 * 1000L
        /* 以用户名义发消息的 App: 微信 / QQ / TIM / 企业微信 / 钉钉 / 飞书 / 短信 */
        val IM_APPS = setOf(
            "com.tencent.mm", "com.tencent.mobileqq", "com.tencent.tim", "com.tencent.wework",
            "com.alibaba.android.rimet", "com.ss.android.lark",
            "com.google.android.apps.messaging", "com.android.mms", "com.samsung.android.messaging",
        )
        /* 短信 App 的发送键是图标, 读到的是描述「Send SMS」「发送短信」 */
        private val SEND = Regex("^(发送|发 送|发送短信|发送信息|Send|Send SMS|Send message|Send MMS)$", RegexOption.IGNORE_CASE)
        /* 动钱的判定在 PayGuard (词根 + 金额两条判据, 有单测): 充值 / 转账 / 结算 / 下单 / 叫车 / 打车 /
         * 支付 / 付款 / 购买 / 续费 / 开通会员 / 提现, 以及按钮字本身就是价格「¥32」 */
    }
}
