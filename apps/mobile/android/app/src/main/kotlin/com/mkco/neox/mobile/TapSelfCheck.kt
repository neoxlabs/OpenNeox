package com.mkco.neox.mobile

/**
 * 坐标点击的自检 (pilot:D-07, 2026-10-18) —— App 改版后不会点错按钮。
 *
 * 坐标来自截图。App 一改版, 同样的 (x, y) 就落到别的控件上了 (以前看不出来, 还会说「点了」)。
 * 两道自检:
 *   · 点之前: 模型说它要点的是「下单」, 就用坐标底下那个控件的文字对一遍; 对不上不点, 并说明现在是什么。
 *   · 点之后: 前台 App 从 A 变成 B 了就说清楚 (可能点错 / 跳走了), 别按原计划继续。
 *
 * 纯字符串逻辑 (控件文字 / 包名 / 标题由调用方给), 便于 JVM 单测。标题变化不判失败:
 * 同一个 App 里跳页标题一定会变, 那不是点错。
 */
object TapSelfCheck {

    /** 比对用的归一化: 去掉空白、转小写 (「立即 下单」和「立即下单」算一样) */
    fun normalize(s: String): String = s.replace(WHITESPACE, "").lowercase()

    /**
     * 点之前对一遍。返回 null = 可以对; 否则是给模型的拒绝理由。
     *
     * @param expect 模型以为坐标上是什么 (可空; 给了才检查)
     * @param actualLabel 坐标底下那个控件读到的文字
     * @param pkg 前台包名
     * @param title 前台窗口标题 (可空)
     */
    fun preCheck(expect: String?, actualLabel: String, pkg: String, title: String?): String? {
        val want = normalize(expect.orEmpty())
        if (want.isEmpty()) return null
        val at = normalize(actualLabel)
        val where = buildString {
            append(if (pkg.isEmpty()) "当前界面" else pkg)
            if (!title.isNullOrBlank()) append(" / 「$title」")
        }
        if (at.isEmpty()) {
            return "坐标上读不到文字 (可能改版成图片 / 自绘界面了), 你以为是「${expect!!.trim()}」。没点。" +
                "先 screenshot 看清这一屏 ($where), 再决定点哪里 —— 别凭旧截图的坐标点。"
        }
        val hit = at.contains(want) || want.contains(at)
        if (hit) return null
        return "坐标上现在是「${actualLabel.trim()}」, 不是你说的「${expect!!.trim()}」($where)。" +
            "界面多半改版了, 没点。先 screenshot 重看, 按新的位置 / 编号再点。"
    }

    /**
     * 点完之后的自检。返回 null = 还在原来那个 App; 否则是给模型的一句提醒。
     *
     * @param expectedPkg 模型声明的目标包名 (可空; 目标本来就是别的 App 时用)
     */
    fun afterTap(
        beforePkg: String,
        beforeTitle: String?,
        afterPkg: String,
        afterTitle: String?,
        expectedPkg: String? = null,
    ): String? {
        if (afterPkg.isEmpty() || beforePkg.isEmpty() || afterPkg == beforePkg) return null
        if (!expectedPkg.isNullOrBlank() && afterPkg == expectedPkg) return null
        val from = buildString {
            append(beforePkg)
            if (!beforeTitle.isNullOrBlank()) append(" / 「$beforeTitle」")
        }
        val to = buildString {
            append(afterPkg)
            if (!afterTitle.isNullOrBlank()) append(" / 「$afterTitle」")
        }
        return "点了之后前台从「$from」变成了「$to」—— 不是原来那个 App 了。" +
            "可能点错了, 也可能是按钮触发了跳转: 先 snapshot 看清现在在哪, 别按原计划继续点。"
    }

    private val WHITESPACE = Regex("\\s+")
}
