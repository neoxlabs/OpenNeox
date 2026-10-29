package com.mkco.neox.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 动钱闸的判据 (2026-10-17)
 *
 * 左边这组是「真的会扣钱」的按钮字, 漏一个就等于模型点下去直接把钱付了;
 * 右边这组是「看着像、实际只是入口 / 设置 / 优惠」的字, 拦了会让每一步都要用户点头。
 */
class PayGuardTest {

    private fun blocked(label: String) = assertTrue("「$label」应该被拦下", PayGuard.isMoneyAction(label))
    private fun allowed(label: String) = assertFalse("「$label」不该被拦", PayGuard.isMoneyAction(label))

    @Test
    fun `充值类按钮都拦`() {
        blocked("充值")
        blocked("立即充值")
        blocked("确认充值")
        blocked("立即充值 100 元")
    }

    @Test
    fun `支付与付款类按钮都拦`() {
        blocked("支付")
        blocked("确认支付")
        blocked("付款")
        blocked("确认付款")
        blocked("免密支付")
        blocked("付款 ¥32")
        blocked("支付宝支付")
    }

    @Test
    fun `下单结算购买类按钮都拦`() {
        /* 「去结算」只进确认页, 不拦; 带金额或「确认结算」才拦 */
        allowed("去结算")
        blocked("去结算(¥32)")
        blocked("确认结算")
        allowed("购买记录")
        allowed("Subscribe")
        blocked("立即下单")
        blocked("确认下单")
        blocked("提交订单")
        blocked("购买")
        blocked("立即购买")
        blocked("续费")
        blocked("开通会员")
        blocked("提现")
        blocked("转账")
    }

    @Test
    fun `打车叫车类按钮都拦`() {
        blocked("打车")
        blocked("叫车")
        blocked("呼叫快车")
        blocked("立即用车")
        blocked("确认呼叫")
    }

    @Test
    fun `按钮字本身就是价格也算动钱`() {
        blocked("¥32")
        blocked("￥1299.00")
        blocked("32元")
        blocked("$9.99")
        blocked("￥３２")
    }

    @Test
    fun `英文 App 的付款键也拦`() {
        blocked("Pay")
        blocked("Pay now")
        blocked("Place order")
        blocked("Buy now")
        blocked("Checkout")
        blocked("Confirm payment")
    }

    @Test
    fun `插了空格的按钮字也认`() {
        blocked("确 认 结 算")
        blocked("确 认 支 付")
    }

    @Test
    fun `App 名和只读入口不拦`() {
        allowed("支付宝")
        allowed("支付宝钱包")
        allowed("查看订单")
        allowed("订单详情")
        allowed("我的订单")
        allowed("付款方式")
        allowed("支付方式")
        allowed("支付设置")
        allowed("付款码")
        allowed("充值中心")
        allowed("充值记录")
        allowed("余额")
        allowed("我的钱包")
        allowed("呼叫客服")
        allowed("发送")
        allowed("")
    }

    @Test
    fun `只是看着有数字的只读内容不拦`() {
        allowed("查看订单 ¥42")
        allowed("¥10 优惠券")
        allowed("满100元减10")
        allowed("¥42 起送")
        allowed("余额 ¥120.00")
    }
}
