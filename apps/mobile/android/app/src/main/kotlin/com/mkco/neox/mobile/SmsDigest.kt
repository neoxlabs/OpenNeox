package com.mkco.neox.mobile

/**
 * 短信原文不出手机 (pilot:D-10, 2026-10-18)
 *
 * 以前 read_sms 把整条正文原样交给 Dart、再交给云端模型 —— 验证码确实能拿到, 但别人的私聊、
 * 银行余额、快递地址、营销短信也跟着上了云。pilot 方案 D-10 的口径是「只回码与来源」:
 * 发件方 / 时间 / 验证码 / 金额, 其余一个字都不出这台手机。
 *
 * 所以提取放在原生侧 (PhoneToolsBridge.readSms) 做, 正文连 MethodChannel 都不过;
 * 这里写成纯函数, 用 JVM 单测把「什么算验证码 / 什么算金额 / 什么都不是」钉死。
 */
object SmsDigest {

    /** 一行摘要: from / at 一定有, code 与 amount 没提取到就是 null, 正文不带 */
    fun digest(from: String, body: String, at: Long): Map<String, Any?> {
        val code = verificationCode(body)
        val amount = amount(body)
        val kind = when {
            code != null -> "code"
            amount != null -> "amount"
            else -> "other"
        }
        return mapOf(
            "from" to from,
            "at" to at,
            "code" to code,
            "amount" to amount,
            "kind" to kind,
        )
    }

    /* 验证码: 关键词在前 (「验证码是 123456」「verification code: 482913」)… */
    private val CODE_AFTER_KEYWORD = Regex(
        """(?:验证码|校验码|动态码|确认码|激活码|verification\s*code|security\s*code|\bOTP\b|\bcode\b)[^0-9]{0,12}([0-9]{4,8})""",
        RegexOption.IGNORE_CASE,
    )

    /* …或者数字在前 (「123456 是您的验证码」, 少见但确实有) */
    private val CODE_BEFORE_KEYWORD = Regex(
        """([0-9]{4,8})[^0-9]{0,8}(?:是您的验证码|为您的验证码|是本次验证码|动态验证码)""",
        RegexOption.IGNORE_CASE,
    )

    private val AMOUNT_PATTERNS = listOf(
        Regex("""(?:¥|￥|RMB|CNY)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE),
        Regex("""(?:人民币)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"""),
        Regex("""([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*元"""),
    )

    /** 验证码; 认不出就是 null (宁可回「没有」也不猜一串数字) */
    fun verificationCode(body: String): String? {
        for (re in listOf(CODE_AFTER_KEYWORD, CODE_BEFORE_KEYWORD)) {
            for (m in re.findAll(body)) {
                val group = m.groups[1] ?: continue
                if (looksLikeNonCode(body, group.range.first, group.range.last + 1)) continue
                return group.value
            }
        }
        return null
    }

    /** 金额 (带货币标识才算, 裸数字一律不当钱); 认不出就是 null */
    fun amount(body: String): String? {
        for (re in AMOUNT_PATTERNS) {
            val m = re.find(body) ?: continue
            val value = m.groups[1]?.value?.trim().orEmpty()
            if (value.isNotEmpty()) return "¥$value"
        }
        return null
    }

    /**
     * 排除「尾号 1234」「订单 12345678」这类被误当成验证码的数字:
     * 看数字前 6 个字符里有没有「尾号 / 手机号 / 卡号」, 以及数字后面紧跟着「元 / .0」这种金额形态。
     */
    private fun looksLikeNonCode(body: String, start: Int, end: Int): Boolean {
        val before = body.substring(maxOf(0, start - 6), start)
        if (before.contains("尾号") || before.contains("手机号") || before.contains("卡号")) return true
        val after = body.substring(end, minOf(body.length, end + 3))
        if (after.startsWith("元")) return true
        /* 「268.00」这种金额形态: 点后面必须紧跟数字; 句末的句号 (「190283.」) 不算 */
        if (after.length >= 2 && after[0] == '.' && after[1].isDigit()) return true
        return false
    }
}
