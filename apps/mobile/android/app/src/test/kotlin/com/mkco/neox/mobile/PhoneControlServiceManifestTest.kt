package com.mkco.neox.mobile

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 操控期前台服务 (pilot:D-12) 的清单守卫。
 *
 * 服务本身要真机才跑得起来, 但「有没有在清单里登记 + 前台服务类型对不对」是能在这里拴住的:
 * Android 14 起 startForeground 必须带上已声明的 foregroundServiceType, 漏了会在运行时就抛,
 * 那时只有操控到一半才发现。所以直接读清单核对。
 */
class PhoneControlServiceManifestTest {

    private fun manifest(): File {
        /* Gradle 单测的工作目录是 app 模块, 两种都认一下 */
        return listOf(File("src/main/AndroidManifest.xml"), File("app/src/main/AndroidManifest.xml")).first { it.isFile }
    }

    @Test
    fun controlServiceDeclaredAsDataSyncForegroundService() {
        val xml = manifest().readText()
        val at = xml.indexOf("PhoneControlService")
        assertTrue("清单里没有 PhoneControlService", at > 0)
        val block = xml.substring(at, minOf(xml.length, at + 400))
        assertTrue("必须是前台服务并声明 dataSync 类型, 否则 Android 14 起 startForeground 会抛", block.contains("foregroundServiceType=\"dataSync\""))
        assertTrue("只给 App 自己用", block.contains("exported=\"false\""))
    }
}
