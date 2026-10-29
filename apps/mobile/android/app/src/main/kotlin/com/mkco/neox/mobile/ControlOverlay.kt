package com.mkco.neox.mobile

import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.SweepGradient
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.LinearInterpolator
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Phone Use 操控中的全局悬浮层 (2026-10-12)。
 *
 * 用户: 「跳转到 QQ 对话的第三方软件时, 你要有一个全局的悬浮层, 类似于 AI 在掌控的科技感。然后要有按钮,
 * 提示 AI 正在操控中, 用户可以点击按钮解除操控… 跳的地方软件就回不来了, 回不到 Neox」。
 *
 *   · 四周一圈流动的光边 (不拦触摸, Agent 的点按照样穿过去)
 *   · 顶部一颗胶囊: 呼吸的光点 + 「Neox 正在操控 · 在读聊天」+「停止」
 *   · 点「停止」: 中断 Agent (回调给 Dart) 并回到 Neox
 *   · Agent 这一轮跑完: Dart 叫 hide(returnHome=true), 收起并回到 Neox
 *
 * 窗口类型用 TYPE_ACCESSIBILITY_OVERLAY —— 无障碍服务自带的悬浮层, 不用另外申请「显示在其他应用上层」。
 * 所以必须挂在 NeoxAccessibilityService 的 context 上; 服务没开就没有悬浮层 (那时也操控不了别的 App)。
 */
object ControlOverlay {
    private val main = Handler(Looper.getMainLooper())
    private var border: View? = null
    private var pill: LinearLayout? = null
    private var label: TextView? = null
    private var animators = mutableListOf<ValueAnimator>()
    /** 窗口挂在哪个服务实例上 —— 服务重连后旧实例的窗口要先拿掉 */
    private var owner: Context? = null

    /** 用户点了「停止」—— PhoneToolsBridge 接上, 转给 Dart 去取消这一轮 */
    @Volatile var onStop: (() -> Unit)? = null

    /** 「停止」按钮上的字 —— Dart 按界面语言给 (英文界面是 Stop) */
    private var stopText: String = "停止"
    private var stopView: TextView? = null

    /** [text] = Dart 按界面语言拼好的整句; 老调用方只给 [step] 时退回中文 */
    fun show(step: String?, text: String? = null, stop: String? = null) = main.post {
        val svc = NeoxAccessibilityService.instance ?: return@post
        /* pilot:D-12 操控期前台服务: 跳进别的 App 以后 Neox 是后台进程, 国产 ROM 会清掉;
         * 挂上这个之后进程落在「前台服务」档, 操控不会停在一半 */
        PhoneControlService.start(svc)
        if (!stop.isNullOrBlank()) stopText = stop
        /* 系统把窗口拿掉了 (无障碍服务重连 / 厂商省电清理) → 重新挂, 保证操控全程都看得见 */
        if (border != null && (owner !== svc || border?.isAttachedToWindow != true)) detach(owner)
        if (border == null) { attach(svc); owner = svc }
        stopView?.text = stopText
        label?.text = text?.takeIf { it.isNotBlank() }
            ?: if (step.isNullOrBlank()) "Neox 正在操控" else "Neox 正在操控 · $step"
    }

    fun hide(returnHome: Boolean) = main.post {
        val svc = NeoxAccessibilityService.instance
        val ctx = owner ?: svc
        detach(ctx)
        owner = null
        /* 操控结束: 撤掉前台服务, 回到普通后台进程 (空闲时不常驻、不耗电) */
        if (ctx != null) PhoneControlService.stop(ctx)
        if (returnHome && svc != null) bringNeoxToFront(svc)
    }

    val showing: Boolean get() = border != null

    private fun attach(ctx: Context) {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY

        /* 1. 光边: 全屏, 不拦触摸 */
        val edge = GlowBorder(ctx)
        wm.addView(edge, WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ))
        border = edge
        animators += ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 3200; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
            addUpdateListener { edge.angle = it.animatedValue as Float; edge.invalidate() }
            start()
        }

        /* 2. 胶囊: 顶部居中, 只有它自己吃触摸 */
        val d = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt() }
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(d(14f), d(8f), d(6f), d(8f))
            background = GradientDrawable().apply {
                cornerRadius = d(22f).toFloat()
                setColor(Color.argb(252, 16, 20, 34))
                setStroke(d(1f), Color.argb(150, 90, 140, 255))
            }
            elevation = d(6f).toFloat()
        }
        /* Neox 圆环 logo, 慢慢转 + 呼吸 (用户: 「那个原点能不能换到我们的 logo」) */
        val mark = android.widget.ImageView(ctx).apply { setImageResource(R.drawable.neox_mark_white) }
        box.addView(mark, LinearLayout.LayoutParams(d(18f), d(18f)).apply { marginEnd = d(8f) })
        animators += ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 2400; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
            addUpdateListener { mark.rotation = it.animatedValue as Float }
            start()
        }
        animators += ValueAnimator.ofFloat(0.55f, 1f).apply {
            duration = 900; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE
            addUpdateListener { mark.alpha = it.animatedValue as Float }
            start()
        }
        val caption = TextView(ctx).apply {
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            maxLines = 1; maxWidth = d(210f)
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        box.addView(caption)
        val stop = TextView(ctx).apply {
            text = stopText
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(d(12f), d(5f), d(12f), d(5f))
            background = GradientDrawable().apply { cornerRadius = d(16f).toFloat(); setColor(Color.argb(255, 47, 107, 255)) }
            setOnClickListener {
                onStop?.invoke()
                hide(returnHome = true)
            }
        }
        box.addView(stop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = d(10f) })
        val statusBar = ctx.resources.getIdentifier("status_bar_height", "dimen", "android").let { if (it > 0) ctx.resources.getDimensionPixelSize(it) else d(24f) }
        wm.addView(box, WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = statusBar + d(6f) })
        pill = box
        label = caption
        stopView = stop
    }

    private fun detach(ctx: Context?) {
        animators.forEach { it.cancel() }
        animators.clear()
        val wm = ctx?.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        listOfNotNull(border, pill).forEach { v -> runCatching { wm?.removeViewImmediate(v) } }
        border = null; pill = null; label = null; stopView = null
    }

    /** 回到 Neox: 从服务里起 MainActivity (已在后台就拉到前面, 不新建) */
    private fun bringNeoxToFront(ctx: Context) {
        runCatching {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP,
            ))
        }
    }

    /** 四周流动的光边: 一圈旋转的扫描渐变描边 + 一层模糊的外发光 */
    private class GlowBorder(ctx: Context) : View(ctx) {
        var angle = 0f
        private val density = ctx.resources.displayMetrics.density
        private val colors = intArrayOf(
            Color.argb(0, 47, 107, 255), Color.argb(230, 47, 107, 255), Color.argb(230, 120, 200, 255),
            Color.argb(210, 150, 110, 255), Color.argb(0, 47, 107, 255), Color.argb(200, 47, 107, 255), Color.argb(0, 47, 107, 255),
        )
        private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 10 * density
            maskFilter = BlurMaskFilter(12 * density, BlurMaskFilter.Blur.NORMAL)
        }
        private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.5f * density }
        private val m = Matrix()
        private val rect = RectF()

        init { setLayerType(LAYER_TYPE_SOFTWARE, null) } // BlurMaskFilter 要软件层

        override fun onDraw(canvas: Canvas) {
            val cx = width / 2f; val cy = height / 2f
            val shader = SweepGradient(cx, cy, colors, null)
            m.setRotate(angle, cx, cy); shader.setLocalMatrix(m)
            glow.shader = shader; line.shader = shader
            val inset = 1.5f * density
            /* 圆角跟着手机屏幕角走个大概 */
            val r = 28 * density
            rect.set(inset, inset, width - inset, height - inset)
            canvas.drawRoundRect(rect, r, r, glow)
            canvas.drawRoundRect(rect, r, r, line)
        }
    }
}
