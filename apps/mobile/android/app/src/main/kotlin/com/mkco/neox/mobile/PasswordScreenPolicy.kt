package com.mkco.neox.mobile

/**
 * 密码页的判定与打码 (pilot:D-09, 2026-10-18)
 *
 * 界面上只要有一个看得见的密码框, 这一屏就是密码页 —— 微信支付密码、银行 App 登录密码、
 * 系统锁屏密码都落在这一类。对这种屏幕定三条规矩:
 *   1. 不截屏: 截图会把整屏 (含用户已经输入一半的密码 / 键盘上的按键痕迹) 写成一张图送上去;
 *   2. 不回传密码框里的字: snapshot 只保留「这里有个输入框」这个结构, 原文一个字都不带;
 *   3. 不代填: 密码由用户自己敲, agent 只负责把页面停在要输密码的地方。
 *
 * 跟 PayGuard 一样写成纯逻辑 (不碰 Android 类), 好让 JVM 单测把每一条钉死;
 * NeoxAccessibilityService 只做「遍历控件树 → 收集 Control → 问这里」。
 */
object PasswordScreenPolicy {

    /** 判定只需要三个事实: 是不是输入框、是不是密码框、用户在不在看得见的地方 */
    data class Control(
        val editable: Boolean,
        val password: Boolean,
        val visible: Boolean = true,
    )

    /** 屏幕上有没有看得见的密码框 (= 这一屏是不是密码页) */
    fun isPasswordScreen(controls: List<Control>): Boolean = controls.any { it.visible && it.password }

    /** 这个控件的文字要不要打码 —— 密码框一律打码, 别的控件不动 */
    fun mask(control: Control): Boolean = control.visible && control.password

    /** 打码后的那一行: 保留序号与「输入框」, 内容一个字符都不带 */
    fun maskedLine(index: Int, kind: String): String = "[$index] $kind 「已隐藏: 密码由用户自己输入」"

    /** 密码框不让 agent 代填 (包括 model 自己编的、记忆里翻出来的) */
    fun allowTyping(control: Control): Boolean = !control.password

    /** 截图被拒时回给模型的单子: 说清为什么、接下来该谁做 */
    fun refusal(): Map<String, Any?> = mapOf(
        "error" to "这一屏有密码框: 不截屏、不读密码、也不代填。密码由用户自己输入; " +
            "你可以先 snapshot 看页面结构, 等用户输完再继续。",
        "blocked" to true,
        "needs_user" to true,
    )
}
