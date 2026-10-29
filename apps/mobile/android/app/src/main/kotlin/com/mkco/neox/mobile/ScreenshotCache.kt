package com.mkco.neox.mobile

import java.io.File

/**
 * 无障碍截图的磁盘清理 (2026-10-17)
 *
 * [NeoxAccessibilityService.screenshot] 每截一张就往 cacheDir 写一个 `pilot-screen-<毫秒>.jpg`,
 * 以前从不删 —— 回一次微信翻十屏就是十张, 长期用下来 cacheDir 能吃掉几百兆, 系统清缓存前一直在。
 *
 * 清理挂在每次截图之后, 删掉 30 分钟前的旧图, 但两条兜底:
 *   · 正在被这一轮引用的那张 (刚写出来, 或调用方显式传进 keep) 一定保留;
 *   · 最近 [KEEP_RECENT] 张一定保留 —— 模型前一两步拿到的 path 可能还在用,
 *     删了它就得重截一张, 白花一次来回。
 *
 * 写成纯函数 (只碰 java.io.File) 是为了能被 JVM 单测钉住。
 */
object ScreenshotCache {

    /** 旧到可以删的年龄: 30 分钟 */
    const val MAX_AGE_MS = 30 * 60 * 1000L

    /** 无论多旧都保留最近这么多张 (一张约 100–300KB) */
    const val KEEP_RECENT = 10

    /**
     * @param dir 截图目录 (通常 cacheDir)
     * @param prefix 只清这个名字开头的文件, 别的 (语音、rootfs、照片) 不碰
     * @param keep 调用方明确要保留的绝对路径 (刚写出来的那张)
     * @return 删掉的文件数
     */
    fun prune(
        dir: File,
        prefix: String,
        keep: Set<String> = emptySet(),
        now: Long = System.currentTimeMillis(),
        maxAgeMs: Long = MAX_AGE_MS,
        keepRecent: Int = KEEP_RECENT,
    ): Int {
        if (!dir.isDirectory) return 0
        val files = dir.listFiles()?.filter { it.isFile && it.name.startsWith(prefix) } ?: return 0
        if (files.isEmpty()) return 0

        val protected = HashSet<String>(keep.size + keepRecent)
        for (path in keep) protected += File(path).name
        files.sortedByDescending { it.lastModified() }.take(keepRecent).forEach { protected += it.name }

        var removed = 0
        for (f in files) {
            if (f.name in protected) continue
            /* 时间在未来的 (时钟被调过) 也按「新」处理, 不动它 */
            if (now - f.lastModified() < maxAgeMs) continue
            if (f.delete()) removed++
        }
        return removed
    }

    /**
     * 服务启动清扫 (pilot:D-08): 上一次进程留下的截图一张不留。
     *
     * 服务刚起来时不可能还有「这一轮正在用的图」—— 上一轮已经随进程结束, 模型那边也换了会话。
     * 所以这里不做年龄 / 张数兜底。
     */
    fun sweepAll(dir: File, prefix: String): Int {
        if (!dir.isDirectory) return 0
        val files = dir.listFiles()?.filter { it.isFile && it.name.startsWith(prefix) } ?: return 0
        var removed = 0
        for (f in files) if (f.delete()) removed++
        return removed
    }

    /** 按路径删 (任务结束删本轮, pilot:D-08)。只删这个前缀、确实存在的文件 */
    fun deleteFiles(dir: File, paths: Collection<String>, prefix: String): Int {
        var removed = 0
        val dirPath = runCatching { dir.canonicalPath }.getOrElse { dir.absolutePath }
        for (path in paths) {
            val f = File(path)
            if (!f.name.startsWith(prefix)) continue
            if (runCatching { f.parentFile?.canonicalPath }.getOrNull() != dirPath) continue
            if (runCatching { f.isFile && f.delete() }.getOrDefault(false)) removed++
        }
        return removed
    }
}
