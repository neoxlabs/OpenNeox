package com.mkco.neox.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 密码页的三条规矩 (pilot:D-09)
 *
 * 验收口径: isPassword 页面截图返回拒绝。左边这组是必须拒绝/打码的, 右边是不能误伤的
 * (普通输入框、隐藏的密码框) —— 误伤会让正常页面也截不了图。
 */
class PasswordScreenPolicyTest {

    private fun pwd(editable: Boolean = true, visible: Boolean = true) =
        PasswordScreenPolicy.Control(editable = editable, password = true, visible = visible)

    private fun plain(editable: Boolean = true, visible: Boolean = true) =
        PasswordScreenPolicy.Control(editable = editable, password = false, visible = visible)

    @Test
    fun `有可见密码框就是密码页`() {
        assertTrue(PasswordScreenPolicy.isPasswordScreen(listOf(plain(), pwd())))
    }

    @Test
    fun `普通输入框不算密码页`() {
        assertFalse(PasswordScreenPolicy.isPasswordScreen(listOf(plain(), plain())))
        assertFalse(PasswordScreenPolicy.isPasswordScreen(emptyList()))
    }

    @Test
    fun `藏起来的密码框不挡截图`() {
        assertFalse(PasswordScreenPolicy.isPasswordScreen(listOf(pwd(visible = false))))
    }

    @Test
    fun `截图的拒绝回执说清为什么和接下来谁做`() {
        val r = PasswordScreenPolicy.refusal()
        assertEquals(true, r["blocked"])
        assertEquals(true, r["needs_user"])
        assertTrue((r["error"] as String).contains("密码"))
        assertTrue((r["error"] as String).contains("不截屏"))
    }

    @Test
    fun `密码框打码, 普通控件不打码`() {
        assertTrue(PasswordScreenPolicy.mask(pwd()))
        assertFalse(PasswordScreenPolicy.mask(plain()))
    }

    @Test
    fun `打码那一行只留序号和输入框, 不带任何内容`() {
        val line = PasswordScreenPolicy.maskedLine(3, "输入框")
        assertTrue(line.startsWith("[3] 输入框"))
        assertTrue(line.contains("已隐藏"))
        assertFalse(line.contains("123456"))
    }

    @Test
    fun `密码框不代填, 普通输入框照常填`() {
        assertFalse(PasswordScreenPolicy.allowTyping(pwd()))
        assertTrue(PasswordScreenPolicy.allowTyping(plain()))
    }
}
