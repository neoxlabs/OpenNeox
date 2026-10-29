package com.mkco.neox.mobile

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 无障碍截图的清理规则 (2026-10-17) */
class ScreenshotCacheTest {

    private lateinit var dir: File
    private val now = System.currentTimeMillis()

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("pilot-shots").toFile()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun shot(name: String, ageMs: Long, bytes: Int = 8): File {
        val f = File(dir, name)
        f.writeBytes(ByteArray(bytes))
        f.setLastModified(now - ageMs)
        return f
    }

    private fun minutes(n: Int) = n * 60_000L

    @Test
    fun `超过 30 分钟的旧截图被删掉, 新的不动`() {
        val old1 = shot("pilot-screen-1.jpg", minutes(40))
        val old2 = shot("pilot-screen-2.jpg", minutes(90))
        val fresh = shot("pilot-screen-3.jpg", 0)

        val removed = ScreenshotCache.prune(dir, "pilot-screen-", now = now, keepRecent = 1)

        assertEquals(2, removed)
        assertFalse(old1.exists())
        assertFalse(old2.exists())
        assertTrue(fresh.exists())
    }

    @Test
    fun `刚写的这张一定保留 —— 模型正在引用它`() {
        val old = shot("pilot-screen-1.jpg", minutes(120))
        val fresh = shot("pilot-screen-2.jpg", minutes(60))

        val removed = ScreenshotCache.prune(
            dir, "pilot-screen-", keep = setOf(fresh.absolutePath), now = now, keepRecent = 0,
        )

        assertEquals(1, removed)
        assertFalse(old.exists())
        assertTrue(fresh.exists())
    }

    @Test
    fun `最近十张不动 —— 上一两步拿到的 path 还在用`() {
        /* 12 张全是 40 分钟前的旧图: 最近 10 张留下, 只有最旧的 2 张被删 */
        val files = (1..12).map { i -> shot("pilot-screen-$i.jpg", minutes(40 + i)) }

        val removed = ScreenshotCache.prune(dir, "pilot-screen-", now = now)

        assertEquals(2, removed)
        /* i 越大越旧: 留下最新的 10 张 (0..9), 删掉最旧的两张 (10、11) */
        assertFalse(files[10].exists())
        assertFalse(files[11].exists())
        for (i in 0..9) assertTrue(files[i].name, files[i].exists())
    }

    @Test
    fun `没超时的图一张不删`() {
        repeat(15) { i -> shot("pilot-screen-$i.jpg", minutes(5)) }

        assertEquals(0, ScreenshotCache.prune(dir, "pilot-screen-", now = now))
        assertEquals(15, dir.listFiles()!!.size)
    }

    @Test
    fun `别的文件不碰`() {
        shot("pilot-screen-1.jpg", minutes(60))
        val voice = shot("pilot-voice.mp3", minutes(600))
        val photo = shot("pilot-photo-1.jpg", minutes(600))

        ScreenshotCache.prune(dir, "pilot-screen-", now = now, keepRecent = 0)

        assertFalse(File(dir, "pilot-screen-1.jpg").exists())
        assertTrue(voice.exists())
        assertTrue(photo.exists())
    }

    @Test
    fun `目录不存在时不报错`() {
        assertEquals(0, ScreenshotCache.prune(File(dir, "nope"), "pilot-screen-", now = now))
    }
}
