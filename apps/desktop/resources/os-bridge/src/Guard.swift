import Foundation
import AppKit

/*
 * Guard —— Computer Use 的**硬边界**, 在桥这一层拒绝。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 为什么必须落在桥里, 而不是 TS 层
 * ---------------------------------
 * TS 那边的闸 (插件闸 / 审批档位) 管的是"这个工具能不能调"。可一旦调成了, 桥就会照做 ——
 * 而桥能操作的东西比任何工具都大: 它能替用户点任何窗口上的任何按钮。
 * 于是有三类目标, 一旦被点开, 上面所有的闸都等于不存在:
 *
 *   ① **终端** (Terminal / iTerm / Warp …)
 *      往终端里敲字回车 = 执行任意命令。execute_shell 有审批、有沙箱、有风险评估,
 *      而"在终端窗口里打字"绕过全部三样。这是整个 CU 里最大的一个洞。
 *
 *   ② **Neox 自己**
 *      审批卡是 Neox 自己的窗口。能点自己的窗口 = 能点「允许」= 自我授权。
 *      连带的还有设置页 (可以关掉审批档位)、插件页 (可以装东西)。
 *
 *   ③ **系统的授权/密码窗口** (SecurityAgent / 钥匙串 / TCC 弹窗)
 *      那些窗口存在的唯一理由就是"必须由人亲手点"。代点等于把授权体系拆了。
 *
 * 判据用 **bundleId 前缀**, 不用窗口标题 —— 标题是应用自己写的字符串, 想伪装随时能改;
 * bundleId 由签名固定。名字兜底只用于极少数没有 bundleId 的进程。
 *
 * ⚠️ 这份名单是**硬编码的下限**, 不从配置读。将来做"每 App 黑白名单"时, 用户配置只能
 * 在这条线**之上**再收紧, 不能放开它 —— 一个能被配置关掉的安全边界等于没有边界。
 */

/** 终端类: 能在里面打字 = 能执行任意命令 */
private let TERMINAL_BUNDLES: [String] = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp",            // Warp / Warp-Stable 都以这个开头
    "co.zeit.hyper",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "org.tabby",
    "com.termius",
    "com.apple.ScriptEditor",   // 脚本编辑器 = 另一种"执行任意代码"
]

/** Neox 自己 (含各发行版和桥自身): 能点自己的窗口 = 能点审批卡上的「允许」 */
private let SELF_BUNDLES: [String] = [
    "com.mk.neox",              // 前缀匹配, 覆盖 .dev / .work / .lite / .os-bridge
]

/** 系统的授权 / 密码 / 安全窗口: 存在的意义就是必须由人亲手点 */
private let SECURITY_BUNDLES: [String] = [
    "com.apple.SecurityAgent",          // TCC / 授权弹窗
    "com.apple.security",
    "com.apple.keychainaccess",         // 钥匙串访问
    "com.apple.systemuiserver",
    "com.apple.loginwindow",
    "com.apple.CryptoTokenKit",
    "com.apple.UserNotificationCenter", // 老式授权弹窗
]

/** 没有 bundleId 时的名字兜底 (小写比较) */
private let FORBIDDEN_NAMES: [String] = [
    "terminal", "iterm", "iterm2", "warp", "hyper", "kitty", "alacritty", "wezterm",
    "securityagent", "keychain access", "钥匙串访问", "终端",
]

/**
 * 系统设置 (com.apple.systempreferences) —— **整个拒**。
 *
 * 第一版想做得细一点: 只拒"隐私与安全性"那一栏 (辅助功能/屏幕录制/完全磁盘访问都在那儿,
 * 代点「允许」就是自己给自己发权限), 别的面板 (墙纸/声音) 放行。判据用窗口标题。
 *
 * **真机上不成立**: 系统设置切面板时窗口标题不跟着换 —— 从辅助功能切到声音之后,
 * AXTitle 仍然是 "Accessibility"。于是这条判据要么漏放隐私面板 (安全洞), 要么误拦
 * 普通面板并且给出一句驴唇不对马嘴的理由 (实测就是后者)。
 *
 * 一个会误判的安全判据比没有更糟: 它让人以为这一块被守着了。所以整块拒, 理由说清,
 * 并指一条真能走的路 —— 改系统设置用 `execute_shell` + `defaults write`,
 * 那条路有审批、有沙箱, 也留得下审计。
 */
private let SYSTEM_SETTINGS_BUNDLES = ["com.apple.systempreferences", "com.apple.systemsettings"]

enum GuardVerdict {
    case allow
    case deny(code: String, reason: String, hint: String)
}

/** 这个 App 能不能被 Computer Use 操作。 */
func guardApp(_ app: NSRunningApplication?) -> GuardVerdict {
    guard let app else { return .allow }   // 找不到目标由各 op 自己报 app_not_found
    let bundle = (app.bundleIdentifier ?? "")
    let name = (app.localizedName ?? "").lowercased()

    let hasPrefix = { (list: [String]) -> Bool in
        !bundle.isEmpty && list.contains { bundle == $0 || bundle.hasPrefix($0 + ".") || bundle.hasPrefix($0) }
    }

    if hasPrefix(TERMINAL_BUNDLES) || (bundle.isEmpty && FORBIDDEN_NAMES.contains(where: { name.contains($0) })) {
        return .deny(
            code: "app_forbidden_terminal",
            reason: "不允许操作终端类应用 (\(app.localizedName ?? bundle))",
            hint: "往终端窗口里打字等于执行任意命令, 那会绕过 execute_shell 的审批、沙箱和风险评估。"
                + " 要跑命令就用 execute_shell —— 它会按当前审批档位征求用户同意。")
    }
    if hasPrefix(SELF_BUNDLES) {
        return .deny(
            code: "app_forbidden_self",
            reason: "不允许操作 Neox 自己的窗口",
            hint: "审批卡、设置页、插件页都是 Neox 自己的窗口, 代点它们等于自我授权。"
                + " 需要用户确认的事就交回给用户说。")
    }
    if hasPrefix(SECURITY_BUNDLES) || FORBIDDEN_NAMES.contains(where: { name.contains($0) }) {
        return .deny(
            code: "app_forbidden_security",
            reason: "不允许操作系统的授权 / 密码窗口 (\(app.localizedName ?? bundle))",
            hint: "这类窗口必须由用户本人点。请把需要授权这件事告诉用户, 让他自己点。")
    }
    if SYSTEM_SETTINGS_BUNDLES.contains(bundle) {
        return .deny(
            code: "app_forbidden_settings",
            reason: "不允许操作系统设置",
            hint: "辅助功能 / 屏幕录制 / 完全磁盘访问都在系统设置里, 代点「允许」等于自己给自己发权限,"
                + " 而切面板时窗口标题不更新, 没法可靠地只拦那一栏。"
                + " 改系统设置请用 execute_shell + `defaults write` —— 那条路有审批、有沙箱、留得下审计;"
                + " 要开权限就把需要开哪一项告诉用户, 让他自己勾。")
    }
    return .allow
}

/** 按名字判 —— launch 那种"还没起来"的场景, 拿不到 NSRunningApplication。 */
func guardAppName(_ raw: String?) -> GuardVerdict {
    guard let raw, !raw.isEmpty else { return .allow }
    let lower = raw.lowercased()
    /* 传的可能就是 bundleId */
    for b in TERMINAL_BUNDLES + SELF_BUNDLES + SECURITY_BUNDLES where lower == b.lowercased() || lower.hasPrefix(b.lowercased() + ".") {
        return guardVerdictFor(bundleLike: b, shown: raw)
    }
    if FORBIDDEN_NAMES.contains(where: { lower == $0 || lower.contains($0) }) {
        return guardVerdictFor(bundleLike: lower.contains("keychain") || lower.contains("钥匙串") || lower.contains("security")
                               ? "com.apple.security" : "com.apple.Terminal", shown: raw)
    }
    return .allow
}

private func guardVerdictFor(bundleLike b: String, shown: String) -> GuardVerdict {
    if SELF_BUNDLES.contains(where: { b.hasPrefix($0) }) {
        return .deny(code: "app_forbidden_self", reason: "不允许操作 Neox 自己的窗口",
                     hint: "代点自己的审批卡等于自我授权。需要用户确认的事交回给用户说。")
    }
    if SECURITY_BUNDLES.contains(where: { b.hasPrefix($0) }) {
        return .deny(code: "app_forbidden_security", reason: "不允许操作系统的授权 / 密码窗口 (\(shown))",
                     hint: "这类窗口必须由用户本人点。把需要授权这件事告诉用户。")
    }
    return .deny(code: "app_forbidden_terminal", reason: "不允许操作终端类应用 (\(shown))",
                 hint: "往终端里打字等于执行任意命令, 绕过 execute_shell 的审批和沙箱。要跑命令就用 execute_shell。")
}
