package com.mkco.neox.mobile

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** pilot:D-08 —— 任务结束删掉本轮截图; 启动清扫删掉上一轮残留 */
class ShotRoundTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("pilot-round").toFile()
        ShotRound.clear()
    }

    @After
    fun tearDown() {
        ShotRound.clear()
        dir.deleteRecursively()
    }

    private fun shot(name: String): File = File(dir, name).apply { writeBytes(ByteArray(16)) }

    @Test
    fun `任务结束 — 本轮记下的截图全删, 清单清空`() {
        val a = shot("pilot-screen-1.jpg")
        val b = shot("pilot-screen-2.jpg")
        ShotRound.record(a.absolutePath)
        ShotRound.record(b.absolutePath)

        assertEquals(2, ShotRound.end(dir, "pilot-screen-"))
        assertFalse(a.exists())
        assertFalse(b.exists())
        assertTrue(ShotRound.tracked().isEmpty())
    }

    @Test
    fun `不是本轮记的文件不动 (别的轮的、不是截图的)`() {
        val mine = shot("pilot-screen-1.jpg")
        val other = shot("pilot-screen-9.jpg")
        val voice = File(dir, "voice.m4a").apply { writeBytes(ByteArray(4)) }
        ShotRound.record(mine.absolutePath)

        assertEquals(1, ShotRound.end(dir, "pilot-screen-"))
        assertFalse(mine.exists())
        assertTrue(other.exists())
        assertTrue(voice.exists())
    }

    @Test
    fun `同一条路径记两次只删一次, 已经删掉的按 0 算`() {
        val a = shot("pilot-screen-1.jpg")
        ShotRound.record(a.absolutePath)
        ShotRound.record(a.absolutePath)
        a.delete()

        assertEquals(0, ShotRound.end(dir, "pilot-screen-"))
    }

    @Test
    fun `启动清扫 — 上次进程留下的截图全删, 别的前缀不碰`() {
        val old1 = shot("pilot-screen-1.jpg")
        val old2 = shot("pilot-screen-2.jpg")
        val keep = File(dir, "neox-photo-1.jpg").apply { writeBytes(ByteArray(4)) }

        assertEquals(2, ScreenshotCache.sweepAll(dir, "pilot-screen-"))
        assertFalse(old1.exists())
        assertFalse(old2.exists())
        assertTrue(keep.exists())
    }
}
