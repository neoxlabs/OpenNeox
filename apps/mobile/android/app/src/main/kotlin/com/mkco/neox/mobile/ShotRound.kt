package com.mkco.neox.mobile

import java.io.File

/**
 * 一轮操控里截的图, 任务结束即删 (pilot:D-08, 2026-10-18).
 *
 * 以前只有「30 分钟前的旧图 + 最近十张」这一条兜底 (ScreenshotCache), 正常用完的一轮图
 * 也要在 cacheDir 里躺半小时。现在:
 *   · 每次截图记一笔 (只记路径, 不读内容);
 *   · 任务结束 (本地一轮跑完 / 电脑借手机办完一件事) 调 [end], 把这一轮记下的全删掉;
 *   · 服务启动时 [ScreenshotCache.sweepAll] 清掉上次进程留下的残图 (那一轮已经不可能还活着)。
 *
 * 只碰 java.io.File, 能被 JVM 单测钉住。
 */
object ShotRound {

    private val files = LinkedHashSet<String>()

    @Synchronized
    fun record(path: String) {
        files += path
    }

    /** 这一轮记下的路径 (测试 / 回执用) */
    @Synchronized
    fun tracked(): List<String> = files.toList()

    @Synchronized
    fun clear() {
        files.clear()
    }

    /**
     * 任务结束: 删掉这一轮记下的截图, 记下的清单也清空。
     * @return 真正删掉的文件数 (可能已经被调用方搬走 / 删掉)
     */
    fun end(dir: File, prefix: String): Int {
        val names = synchronized(this) {
            val snapshot = files.toList()
            files.clear()
            snapshot
        }
        return ScreenshotCache.deleteFiles(dir, names, prefix)
    }
}
