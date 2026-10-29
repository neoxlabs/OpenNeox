import Cocoa
import ApplicationServices

/*
 * neox-os-bridge —— macOS OS 级 computer use 的原生桥
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是整套 computer use 里**唯一**的新增原生基建, 其余全在 TS 层。
 *
 * 为什么必须是原生: 对照组 AppleScript `System Events` 取元素属性,
 * 每取一个属性就是一次 AppleEvent 跨进程往返 —— 实测 **120 秒没跑完**。
 * 同样的活用 AXUIElement C API 在进程内做: Finder 72ms。
 *
 * 为什么随包走而不随插件走 (2026-09-09 实测钉死):
 *   · TCC 走**责任进程**: 一个 ad-hoc 签名的临时二进制 AXIsProcessTrusted=true,
 *     能读 Finder 全部窗口 —— 授权跟的是拉起它的 App, 不是二进制自己。
 *     所以由 Neox.app spawn 就继承 Neox.app 的辅助功能授权, 不需要单独授权条目。
 *   · 但**下载来的二进制会被 Gatekeeper 杀**: 同一个二进制打上 com.apple.quarantine
 *     再执行 → SIGKILL(137), 文件被系统直接删掉。摘掉 xattr 才能跑。
 *   → 结论: 桥必须随签名+公证的 app 走; 插件市场那份只带 TS。
 *
 * 用法: 直接跑 (无参) 进入 JSON-lines 服务模式; `--probe` 单发一次授权探测。
 */

// MARK: - 目标解析

/**
 * 按名字/bundleId 找一个在跑的 App。
 *
 * ⚠️ 模糊匹配**只在正规 App 里找** (activationPolicy == .regular)。
 * 实测踩到: 找 "Cursor" 模糊匹到了 `CursorUIViewService` —— 那是 Cursor 的一个
 * 辅助进程, 它当然"没有可见窗口", 于是报了个方向完全错的错误。
 * 同一类的还有各种 `XXX Helper (Renderer)` / `XXX Web Content`。
 * 精确匹配不受此限: 用户显式给了 bundleId 就该按他说的来。
 */
/**
 * 泵一次 run loop, 让 NSWorkspace 把待处理的通知消化掉。
 *
 * ─── 不泵会怎样 (2026-09-09 实测) ──────────────────────────────────────────
 * `NSWorkspace.shared.runningApplications` 靠 workspace 通知维护。我们这个桥是个
 * **常驻但没有 run loop** 的命令行进程 (主循环是阻塞的 readLine), 通知永远没人处理,
 * 于是那个列表**冻结在进程启动那一刻**。
 *
 * 症状离真因非常远, 差点让我去查别的地方:
 *   · launch Cursor 明明成功了 (pid 58590), 紧接着 dump 报 `app_not_found`
 *   · launch ChatGPT 的回执上写着"已启动 Codex (pid 54184)" —— 拿的是缓存里的旧对象
 *
 * 50ms 够消化掉积压的通知, 又不至于让每次调用都明显变慢。
 */
func pumpRunLoop() {
    CFRunLoopRunInMode(.defaultMode, 0.05, true)
}

/**
 * 直接问 WindowServer 要"现在屏幕上有窗口的进程"。
 *
 * ─── 为什么不能只靠 NSWorkspace (2026-09-09 第二次踩) ──────────────────────
 * `NSWorkspace.runningApplications` 靠 workspace 通知维护, 而我们这个桥没有 run loop,
 * 通知没人处理。第一次踩到时加了 pumpRunLoop() 以为解决了 —— 实际只治好了刚 launch
 * 那一下。真机扫主流应用时暴露: 桥的 apps 只报得出 5 个 (Finder/Chrome/微信/…),
 * 而 System Events 看得到「备忘录」「系统设置」都在跑, 于是每一个都报 no_window。
 *
 * CGWindowListCopyWindowInfo 是**实时查询**, 不走通知, 而且天然只返回有窗口的进程 ——
 * 正好是我们要的那批 (没窗口的应用本来也 dump 不了)。
 */
func windowOwners() -> [(pid: pid_t, name: String)] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var seen = Set<pid_t>()
    var out: [(pid_t, String)] = []
    for w in list {
        guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
              let owner = w[kCGWindowOwnerName as String] as? String,
              let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              !seen.contains(pid) else { continue }
        seen.insert(pid)
        out.append((pid, owner))
    }
    return out
}

/**
 * 按名字/bundleId 找一个在跑的 App。**先问 WindowServer, 后问 NSWorkspace。**
 *
 * ─── 顺序为什么必须是这个 (2026-09-09 真机, 同一个坑的第三种表现) ──────────
 * NSWorkspace 那份列表在这个没有 run loop 的进程里不只是"缺新起的", 还**留着已经
 * 退出的**。实测: 「备忘录」屏幕上明明开着窗口 (独立探针读到 AXWindows 有 1 个),
 * 桥却一路报 no_window —— 因为 NSWorkspace 里躺着一个早就退出的旧 Notes 进程,
 * 精确匹配先命中了它, 拿死 pid 去问 AX 当然什么都没有。
 *
 * WindowServer 的列表是实时查的, 而且天然只含"现在真有窗口"的进程 —— 对 dump 来说
 * 那正是唯一有意义的那批。NSWorkspace 退居兜底: 覆盖"刚 launch 还没建窗口"这类。
 *
 * 三种名字都认: WindowServer 的 owner 名 (中文系统上是「备忘录」)、
 * .app 的文件名 (Notes)、localizedName。用户说哪个都能找到同一个进程。
 */
/**
 * 从 WindowServer 拿某个进程主窗口的矩形。
 *
 * AX 那边的 AXPosition/AXSize 是**可以不支持的** —— 实测 QQ 的窗口单独取返回 -25205,
 * 批量取返回 axError 包装。而窗口明明就在屏幕上。没有几何信息, 视口裁剪就无从谈起,
 * 整个 dump 直接判死。
 *
 * WindowServer 的 kCGWindowBounds 是实时的、永远有值 —— 拿它当兜底。
 * (坐标系: CGWindow 的 bounds 原点在左上, 跟 AX 一致, 不用翻转。)
 */
func windowServerBounds(pid: pid_t) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard let p = w[kCGWindowOwnerPID as String] as? pid_t, p == pid,
              let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let width = b["Width"] as? Double, let height = b["Height"] as? Double,
              width > 1, height > 1 else { continue }
        return CGRect(x: x, y: y, width: width, height: height)
    }
    return nil
}

func findApp(name: String?, pid: Int32?) -> NSRunningApplication? {
    if let pid { return NSRunningApplication(processIdentifier: pid) }
    guard let name, !name.isEmpty else { return NSWorkspace.shared.frontmostApplication }
    let lower = name.lowercased()

    /* 候选一次收齐: WindowServer 的实时列表 + NSWorkspace 的 (可能陈旧的) 那份。
     * 两份都可能给出对的答案, 也都可能给出错的 —— 所以不去猜哪份更可靠 (我猜错过两次:
     * 先是信 NSWorkspace 拿到已退出的旧 Notes 进程, 又反过来只信 WindowServer 把
     * 本来好的 QQ 弄坏了)。**判据直接用"这个 pid 到底能不能拿到 AX 窗口"**。
     *
     * ⚠️ pumpRunLoop **不能放在这儿的最前面**: 它固定花 50ms, 而 findApp 每次
     * dump / signature 都要走一遍 —— 实测那 ~100ms 的固定开销里一半是它。
     * WindowServer 那份是实时查的, 根本不需要 pump; 只有真落到 NSWorkspace 兜底
     * 时才值得付这 50ms。 */
    var candidates: [NSRunningApplication] = []
    var seen = Set<pid_t>()
    let add = { (app: NSRunningApplication?) in
        guard let app, !seen.contains(app.processIdentifier) else { return }
        seen.insert(app.processIdentifier)
        candidates.append(app)
    }
    let matches = { (app: NSRunningApplication, owner: String) -> Bool in
        let bundleName = app.bundleURL?.deletingPathExtension().lastPathComponent ?? ""
        /* 三种名字都认: WindowServer 的 owner 名 (中文系统上是「备忘录」)、
         * .app 的文件名 (Notes)、localizedName / bundleId。 */
        for candidate in [owner, bundleName, app.localizedName ?? "", app.bundleIdentifier ?? ""] {
            if candidate.isEmpty { continue }
            if candidate == name || candidate.lowercased().contains(lower) { return true }
        }
        return false
    }
    for (p, owner) in windowOwners() {
        if let app = NSRunningApplication(processIdentifier: p), matches(app, owner) { add(app) }
    }
    /* WindowServer 那批已经命中就别再问 NSWorkspace 了 —— 省掉 pump 的 50ms。
     * 只有一个候选都没有时才兜底 (刚 launch 还没建窗口的应用走这条)。 */
    if candidates.isEmpty {
        pumpRunLoop()
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
            if matches(app, "") { add(app) }
        }
    }

    /* 判据: 候选必须**窗口拿得到, 而且那个窗口有几何**。
     *
     * 只判"AXWindows 非空"不够 —— 实测 QQ: CGWindowList 报的 ownerPID 是它的辅助进程,
     * 那个 pid 的 AXWindows 也返回 1 个元素, 但那是个**无效的窗口引用**:
     * 读 AXPosition 返回 -25205, System Events 直接说 "Can't get window 1 … Invalid index"。
     * 拿它当结果, 整个 dump 就在一个死引用上打转 (今天我就是这么把本来好的 QQ 弄坏的)。
     *
     * Electron / 多进程应用普遍如此: 窗口的 owner 是渲染进程, AX 树在主进程上。 */
    for app in candidates {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        guard let win = axMainWindow(ax), axFrame(win) != nil else { continue }
        return app
    }
    /* 退而求其次: 至少 AX 里有窗口的 (几何可以后面用 WindowServer 兜) */
    for app in candidates where !axWindows(AXUIElementCreateApplication(app.processIdentifier)).isEmpty {
        return app
    }
    return candidates.first
}

/**
 * 挑"该操作的那个窗口"。**不能直接拿 axWindows().first。**
 *
 * ─── 为什么 (2026-09-09 真机, 这个坑让我以为整台机器的 AX 都坏了) ──────────
 * Finder 有 5 个 AX 窗口, 第一个是个 **0×0** 的 —— 拿它当窗口矩形, 视口裁剪就把
 * 所有元素都裁掉, dump 出来 0 个元素、axBlind=true。而 AX 本身完全正常
 * (AXPosition err=0)。症状是"全机器所有应用同时读不到元素", 极像授权掉了,
 * 我照着那个方向找了很久。
 *
 * 顺序: AXMainWindow → AXFocusedWindow → 面积最大的那个。
 */
func axMainWindow(_ app: AXUIElement) -> AXUIElement? {
    for attr in ["AXMainWindow", "AXFocusedWindow"] {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, attr as CFString, &v) == .success,
           let w = v, CFGetTypeID(w) == AXUIElementGetTypeID() {
            let win = w as! AXUIElement
            if let f = axFrame(win), f.width > 1, f.height > 1 { return win }
        }
    }
    /* 都没有就挑面积最大的 —— 0×0 那种绝不会赢 */
    return axWindows(app)
        .compactMap { w -> (AXUIElement, CGFloat)? in
            guard let f = axFrame(w), f.width > 1, f.height > 1 else { return nil }
            return (w, f.width * f.height)
        }
        .max(by: { $0.1 < $1.1 })?.0
        ?? axWindows(app).first
}

func axWindows(_ app: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

/** 屏幕录制授权。CGPreflightScreenCaptureAccess 不弹窗, 只问状态。 */
func hasScreenRecording() -> Bool {
    if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
    return true
}

// MARK: - 各 op

func opProbe(_ req: Request) {
    var r = OkResult(id: req.id, ok: true)
    r.trusted = AXIsProcessTrusted()
    r.screenRecording = hasScreenRecording()
    emit(r)
}

/**
 * 主动请求辅助功能授权 —— **弹系统对话框, 并把设置页直接打开到那一栏**。
 *
 * 为什么不能只报错让用户自己去找 (用户原话:「应该 neox 主动打开让用户可以直接授权才对」):
 * "系统设置 → 隐私与安全性 → 辅助功能" 这条路径要点四五下, 而且授权失效时列表里
 * 那一项**看起来是勾着的** —— 用户会觉得已经给过了。正确的做法是我们把窗弹到他面前。
 *
 * 两件事一起做:
 *   · AXIsProcessTrustedWithOptions(prompt: true) —— 系统那个"想要控制这台电脑"的对话框。
 *     注意它**只在从未授权过时**才弹; 授权记录还在(哪怕已失效)时它一声不响。
 *   · 所以再补一刀: 直接打开设置页的辅助功能那一栏, 用户一眼就能看到开关。
 *
 * 授权失效那种情况必须让用户**取消勾选再重新勾上** —— 只勾不取消是没用的,
 * 因为记录本来就在。这句话得由调用方说给用户听 (见 accessibility_degraded 的 hint)。
 */
/**
 * 往上走进程链, 找出"这次授权会记在谁名下"。
 *
 * TCC 的授权不记在桥自己头上, 记在**责任进程**上 —— 也就是那条链上第一个有 .app
 * 身份的祖先。所以:
 *   · 从 Neox.app 里 spawn 的桥 → 授权条目叫「Neox」
 *   · dev 模式 (npm run ui:dev) → 祖先是 node_modules 里的 Electron → 条目叫「Electron」
 *   · 从终端跑测试 → 条目叫终端的名字 (Termius / iTerm / Terminal)
 *
 * 不告诉用户这个的后果实测过: 弹了授权窗、开了设置页, 用户在列表里**找不到 Neox**,
 * 因为那次请求根本不是 Neox 发的。
 */
func responsibleAppName() -> String {
    var pid = getppid()
    for _ in 0..<8 {
        guard pid > 1 else { break }
        if let app = NSRunningApplication(processIdentifier: pid), app.bundleURL != nil {
            return app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "?"
        }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { break }
        let parent = info.kp_eproc.e_ppid
        guard parent != pid else { break }
        pid = parent
    }
    /* 父链上一个有 bundle 身份的祖先都没有 = 我们是被 launchd 直接拉起的,
     * 也就是**独立身份** —— 那正是想要的形态 (辅助功能列表里单独一条)。
     * 这不是"认不出来", 是"没有责任进程"。 */
    if let own = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String {
        return "\(own) (独立身份)"
    }
    return "(认不出来 —— 多半是从终端直接跑的裸二进制)"
}

func opRequestAccess(_ req: Request) {
    let before = AXIsProcessTrusted()
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let prompted = AXIsProcessTrustedWithOptions(opts)

    /* 屏幕录制是**第二个**权限, 视觉兜底层要它 (自绘 UI 只能靠看截图操作)。
     * 跟辅助功能是两条独立的授权, 给了一个不等于有另一个 —— 实测: 辅助功能勾好了,
     * 截图仍然报 no_screen_recording。所以一次把两个都要了, 别让用户来回两趟。 */
    var screenAsked = false
    if #available(macOS 10.15, *) {
        if !CGPreflightScreenCaptureAccess() {
            screenAsked = CGRequestScreenCaptureAccess()
        }
    }

    /* 打开设置页。x-apple.systempreferences 这个 scheme 在 Ventura 之后仍然有效。
     * 缺哪个开哪个: 辅助功能没给就开辅助功能页, 只缺屏幕录制就直接开录制页 ——
     * 把用户送到他实际要点的那一栏, 而不是笼统的隐私页。 */
    var opened = false
    let pane = prompted
        ? "com.apple.preference.security?Privacy_ScreenCapture"
        : "com.apple.preference.security?Privacy_Accessibility"
    if let url = URL(string: "x-apple.systempreferences:\(pane)") {
        opened = NSWorkspace.shared.open(url)
    }
    _ = screenAsked

    var r = OkResult(id: req.id, ok: true)
    r.trusted = prompted
    r.screenRecording = hasScreenRecording()
    /* 必须报出"去列表里找哪个名字" —— 否则用户打开设置页找不到 Neox, 以为坏了 */
    r.value = "这次授权会记在「\(responsibleAppName())」名下 (TCC 认责任进程, 不认桥自己)。"
        + " 辅助功能=\(prompted ? "已授权" : "还没给"), 屏幕录制=\(hasScreenRecording() ? "已授权" : "还没给")"
        + "; 已弹系统授权对话框" + (opened ? "; 已打开对应的设置页" : "; 设置页没打开")
        + "。两个权限是独立的: 辅助功能用来读界面和点按钮, 屏幕录制用来给自绘 App 截图。"
    emit(r)
}

func opApps(_ req: Request) {
    pumpRunLoop()
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    /* 以 WindowServer 的实时列表为准, NSWorkspace 那份只用来补 bundleId ——
     * 它在这个没有 run loop 的进程里会陈旧到只剩五个应用 (见 windowOwners 的说明)。
     * 而且"有窗口"本来就是这个列表该有的口径: 没窗口的应用 dump 不了, 列出来只会误导。 */
    var apps = windowOwners().map { (pid, owner) -> AppInfo in
        let running = NSRunningApplication(processIdentifier: pid)
        return AppInfo(name: running?.localizedName ?? owner, bundleId: running?.bundleIdentifier,
                       pid: pid, frontmost: pid == front)
    }
    if apps.isEmpty {
        apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { AppInfo(name: $0.localizedName ?? "?", bundleId: $0.bundleIdentifier,
                           pid: $0.processIdentifier, frontmost: $0.processIdentifier == front) }
    }
    var r = OkResult(id: req.id, ok: true)
    r.apps = apps
    emit(r)
}

/**
 * Chromium / Electron 系默认**不生成 web 内容的 AX 树** (省性能), 于是整个正文在 AX 里是空的。
 * `AXManualAccessibility` 是 Chromium 的点亮开关。
 *
 * 实测 (2026-09-09):
 *   QQ (Electron):  144 → **575** 节点, 开关返回 0, 建树要等 ~1.5s
 *   微信 (原生自绘): 开关返回 -25205 (不支持), 怎么点都是 198 —— 那种只能走视觉层
 *
 * 一个 pid 只点一次: 点亮本身要等一秒多, 每次 dump 都等就把感知从 200ms 拖成 1.7s。
 */
var enhancedPids = Set<pid_t>()

func tryEnhance(_ axApp: AXUIElement, pid: pid_t) -> Bool {
    if enhancedPids.contains(pid) { return false }
    let e = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    /* 只有真的点成了才记进表 —— 冷启动时点太早会失败 (App 还没准备好接这个属性),
     * 无条件记进去就等于"这个 pid 永远不再尝试点亮", 那正是 Cursor 冷启动后
     * 一直只有 5 个元素的原因。 */
    guard e == .success else { return false }
    enhancedPids.insert(pid)
    Thread.sleep(forTimeInterval: 1.5)   /* 实测 0.5s 不够 (145), 1.5s 才建完 (575) */
    return true
}

/**
 * 启动 (或唤醒) 一个 App, 等它把窗口开出来。
 *
 * 为什么要有: agent 接到"打开 Codex 看一眼"这种活, 第一步就是"那个 App 还没开"。
 * 没有这个 op 的话它只能去 shell 里 `open -a`, 那既绕又拿不到"开好了没有"的回执。
 *
 * 用 NSWorkspace 而不是 `open -a`: 拿得到 pid, 也就能轮询"窗口出来了没有" ——
 * 应用冷启动要好几秒, 不等窗口就 dump 只会拿到一个空树, 然后被判成 axBlind。
 */
func opLaunch(_ req: Request) {
    guard let name = req.app, !name.isEmpty else {
        fail(req.id, "missing_app", "launch 需要 app (名字或 bundleId)")
        return
    }
    let t0 = Date()
    let fm = FileManager.default
    var url: URL?
    /* bundleId 优先 —— 名字可能有多个同名 App */
    if name.contains(".") , let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
        url = u
    } else {
        /* CoreServices 那条是给 Finder / 访达 这类系统应用的 —— 它们不在 /Applications,
         * 少了这一条 launch 会报 app_not_installed, 而 Finder 明明就在跑。 */
        for dir in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications",
                    "/System/Library/CoreServices"] {
            let candidate = "\(dir)/\(name).app"
            if fm.fileExists(atPath: candidate) { url = URL(fileURLWithPath: candidate); break }
        }
        if url == nil, let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { url = u }
    }
    guard let appURL = url else {
        fail(req.id, "app_not_installed", "找不到叫「\(name)」的 App",
             hint: "用 op=apps 看当前在跑的; 名字要跟 /Applications 里的文件名一致 (不含 .app), 或者直接给 bundleId。")
        return
    }

    /* 已经在跑就别再 open 一遍 —— 实测 openApplication 对在跑的 App 会拿到一个新的
     * NSRunningApplication 句柄, 有些 App (Cursor) 甚至会起第二个实例, 然后 dump 到的是
     * 那个还没建好界面的新进程: 241 个元素变成 5 个, 直接被判成 axBlind。 */
    pumpRunLoop()
    if let already = NSWorkspace.shared.runningApplications.first(where: {
        $0.activationPolicy == .regular && $0.bundleURL?.standardizedFileURL == appURL.standardizedFileURL
    }) {
        var r = OkResult(id: req.id, ok: true)
        r.ms = Int(Date().timeIntervalSince(t0) * 1000)
        r.value = "\(already.localizedName ?? name) 本来就在跑 (pid \(already.processIdentifier))"
        emit(r)
        return
    }

    let cfg = NSWorkspace.OpenConfiguration()
    /* 不抢前台 —— 整套 computer use 的前提就是"用户还能同时用这台电脑"。
     * 有些 App 冷启动时自己会跳到前台, 那是它的行为, 我们不主动要。 */
    cfg.activates = false
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    var launchError: Error?
    NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { app, err in
        launched = app; launchError = err; sem.signal()
    }
    _ = sem.wait(timeout: .now() + 20)
    if let launchError {
        fail(req.id, "launch_failed", "启动失败: \(launchError.localizedDescription)")
        return
    }
    guard let app = launched else {
        fail(req.id, "launch_failed", "启动没有回执 (20 秒内没起来)")
        return
    }

    /* 等到"界面真的能读了", 不是"窗口出现了"。
     *
     * 实测 (Cursor 冷启动): 窗口 1 秒就有了, 但那时 AX 树里只有 5 个节点 —— 直接 dump
     * 会被判成 axBlind, 而它明明是个 AX 好使的 App (热态能拿到 241 个)。
     * 所以判据是**窗口里有像样的内容**, 差别就是 agent 拿到"这个 App 没法操作"还是拿到界面。
     *
     * 用 sleep 轮询而不是 pumpRunLoop: 这里等的是目标进程建树, 跟我们自己的通知无关。 */
    let deadline = Date().addingTimeInterval(Double(req.budget ?? 15))
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var haveWindow = false
    var ready = false
    while Date() < deadline {
        let wins = axWindows(axApp)
        if let w = wins.first, let rect = axFrame(w) {
            haveWindow = true
            /* 判据得跟 dump 的判据**是同一个**, 否则就是"我这边说好了, 那边说不行"。
             * 这里用一次小预算的试采 (200 个节点封顶), 看有没有真的可交互元素。
             * 第一版用"顶层子节点 >= 3"当便宜判据, 结果 Cursor 1 秒就"就绪"了,
             * 紧接着 dump 只有 5 个元素被判 axBlind —— 便宜判据和真判据对不上就是这个下场。 */
            let probe = dumpWindow(w, clip: rect, budget: 200, into: ElementTable(), startId: 1)
            if probe.elements.filter({ $0.actionable }).count >= 5 { ready = true; break }
            /* 树还是空的 → 试着点亮 Chromium 的 web AX (Electron 冷启动时点太早会失败, 所以在这儿重试) */
            _ = tryEnhance(axApp, pid: app.processIdentifier)
        }
        Thread.sleep(forTimeInterval: 0.3)
    }
    _ = ready
    /* 走之前再泵一次 —— 下一条 dump 请求要能在 runningApplications 里看到刚起来的这个 */
    pumpRunLoop()

    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    /* 报回执时**说清楚打开的是哪个包** —— 只报 localizedName 的话, 打开错了 App 都看不出来
     * (实测: launch "ChatGPT" 的回执上写着 "Codex 已启动", 因为回调给的句柄不是我以为的那个)。 */
    r.value = haveWindow
        ? "已启动 \(app.localizedName ?? name) (pid \(app.processIdentifier), \(appURL.lastPathComponent))"
        : "\(app.localizedName ?? name) 起来了 (pid \(app.processIdentifier), \(appURL.lastPathComponent)), 但 \(Int(Date().timeIntervalSince(t0)))s 内还没有可见窗口 —— 可能还在加载, 或者它是无窗口的后台应用"
    emit(r)
}

/**
 * 上一次 dump 的结果 —— 增量 dump 拿它做对比。
 *
 * 只留**一份**: 增量的用法是"跟我上次看到的比", 而调用方手里也只有最近那一份。
 * 存多份除了占内存没有任何用处, 还会让"到底跟哪一份比"变成一个要猜的问题。
 */
private var lastDumpSnapshot: (pid: pid_t, epoch: Int, byId: [Int: Element])? = nil

/** 两个元素在"用户看得见的层面"上是不是同一个样子 —— 位置抖动 1~2px 不算变。 */
private func sameElement(_ a: Element, _ b: Element) -> Bool {
    a.role == b.role && a.label == b.label && a.value == b.value
        && a.actionable == b.actionable && a.enabled == b.enabled && a.focused == b.focused
        && abs(a.x - b.x) <= 2 && abs(a.y - b.y) <= 2
        && abs(a.w - b.w) <= 2 && abs(a.h - b.h) <= 2
}

func opDump(_ req: Request) {
    guard AXIsProcessTrusted() else {
        fail(req.id, "not_trusted", "没有辅助功能授权",
             hint: "别让用户自己去翻设置 —— 调 computer_check_access({prompt: true}) 把授权对话框和设置页弹给他。"
                 + " 注意 dev 版和打包版是两个不同的授权条目, 重新签名后授权会失效需要重勾。")
        return
    }
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    let wins = axWindows(axApp)
    let mainWin = axMainWindow(axApp)
    /* 两种失败必须分开报 —— 混在一句 "没有可见窗口" 里, 我为此在错误的方向上找了很久:
     * 窗口明明在屏幕上, 报的却是"没窗口", 真因其实是那个窗口读不出几何信息。 */
    guard let win = mainWin ?? wins.first else {
        fail(req.id, "no_window", "\(app.localizedName ?? "?") (pid \(app.processIdentifier)) 的 AX 树里没有窗口",
             hint: "应用可能刚启动还没建窗口, 或者窗口全部最小化了。")
        return
    }
    /* 几何取不到就问 WindowServer —— AX 的 AXPosition/AXSize 是可以不支持的
     * (QQ 实测: 单独取 -25205, 批量取 axError), 而窗口就在屏幕上。 */
    /* 「授权半失效」要单独报, 不能混成 axBlind (2026-09-09 真机, 查了很久):
     *
     *   症状: AXIsProcessTrusted() 返回 true, 窗口在 AXWindows 里也数得出来, 但每个窗口的
     *   AXPosition/AXSize 都返回 -25205 / axError。同一时刻 Apple 自己的 System Events
     *   也读不到 ("Can't get window 1 … Invalid index -1719")。
     *   典型成因: 授权是绑二进制/签名的, 应用更新或重签名后 TCC 里的记录还在
     *   (所以 trusted 仍是 true) 但实际权限已经失效。
     *
     *   为什么必须分开报: 报成 axBlind 会让模型以为"这个应用是自绘 UI, 不支持",
     *   于是它去告诉用户"做不了" —— 而真相是**去系统设置重新勾一下就好了**。
     *   判据: 窗口存在 + AX 几何全拿不到 + 连 WindowServer 的 bounds 都对不上用场。 */
    if axFrame(win) == nil, wins.allSatisfy({ axFrame($0) == nil }) {
        fail(req.id, "accessibility_degraded",
             "\(app.localizedName ?? "?") 有 \(wins.count) 个窗口, 但一个都读不出位置大小 —— 辅助功能授权可能已失效",
             hint: "AXIsProcessTrusted 说有授权, 但实际读取被拒 (常见于应用更新/重签名之后)。"
                 + " **别让用户自己去翻设置** —— 调 computer_check_access({prompt: true}),"
                 + " 那会把系统授权对话框和「辅助功能」设置页直接弹到他面前。"
                 + " 到了那里要让他把 Neox **取消勾选再重新勾上**: 记录本来就在, 只勾不取消没有用。"
                 + " 这不是应用不支持, 别当成自绘 UI。")
        return
    }

    guard let rect = axFrame(win) ?? windowServerBounds(pid: app.processIdentifier) else {
        fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 有 \(wins.count) 个窗口, 但 AX 和 WindowServer 都读不出位置大小",
             hint: "窗口可能被最小化了, 或者在别的 Space 上。把它切到前台再试。")
        return
    }

    var out = dumpWindow(win, clip: rect, budget: req.budget ?? 800, into: table,
                         startId: table.beginDump(pid: app.processIdentifier))

    /* AX 判瞎要有量化判据, 不能靠猜 —— 实测差异极大:
     * Cursor 208 个可交互 / Finder 183 / Chrome 外壳 62 / **QQ 和微信各 3 个**。
     * 只有窗口红绿灯、正文一个元素都没有, 就是这个判据要抓的形态。 */
    var actionable = out.elements.filter { $0.actionable }.count
    var enhanced = false

    /* 空树先别急着判死: Electron 系只是没点亮, 点一下就有了 (QQ: 3 → 见下方实测)。
     * 点亮要等 1.5s, 所以只在**判瞎时**才做, 且每个 pid 只做一次。 */
    if actionable < 5, tryEnhance(axApp, pid: app.processIdentifier) {
        if let win2 = axMainWindow(axApp), let rect2 = axFrame(win2) ?? windowServerBounds(pid: app.processIdentifier) {
            out = dumpWindow(win2, clip: rect2, budget: req.budget ?? 800, into: table,
                             startId: table.beginDump(pid: app.processIdentifier))
            actionable = out.elements.filter { $0.actionable }.count
            enhanced = true
        }
    }
    let blind = actionable < 5

    /* ─── 增量 ────────────────────────────────────────────────────────────
     * 前提是**编号稳定** (ElementTable.idFor): 同一个元素跨 dump 是同一个号,
     * 所以"没变的"才能只回一个号。编号一变这套就没有意义了。
     *
     * 命中条件: 调用方给了 since, 且它正是我们上一次给出的 epoch, 且还是同一个 pid。
     * 任何一条不满足就退回全量 —— 增量对不上时**必须退回全量**, 不能猜,
     * 猜错的代价是调用方手里那份视图从此跟真实界面对不上, 而且没有任何报错。 */
    var payloadElements = out.elements
    var unchangedIds: [Int]? = nil
    var removedIds: [Int]? = nil
    var isIncremental = false
    let currentById = Dictionary(out.elements.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

    if let since = req.since, let prev = lastDumpSnapshot,
       prev.pid == app.processIdentifier, prev.epoch == since {
        var changed: [Element] = []
        var unchanged: [Int] = []
        for e in out.elements {
            if let old = prev.byId[e.id], sameElement(old, e) { unchanged.append(e.id) }
            else { changed.append(e) }
        }
        payloadElements = changed
        unchangedIds = unchanged
        removedIds = prev.byId.keys.filter { currentById[$0] == nil }.sorted()
        isIncremental = true
    }

    lastDumpSnapshot = (pid: app.processIdentifier, epoch: table.epoch, byId: currentById)

    emit(DumpResult(
        id: req.id, ok: true,
        app: app.localizedName ?? "?", pid: app.processIdentifier,
        epoch: table.epoch, ms: out.ms,
        window: ["x": Int(rect.minX), "y": Int(rect.minY), "w": Int(rect.width), "h": Int(rect.height)],
        visited: out.visited, elements: payloadElements,
        axBlind: blind,
        note: blind
            ? "这个 App 的 AX 树是空的 (可交互元素 \(actionable) 个)\(enhanced ? ", 点亮 AXManualAccessibility 后仍然是空" : "") —— 原生自绘 UI。别在这儿硬点元素编号, 改走截图 + 坐标。"
            : (enhanced ? "这个 App 的 AX 树是点亮 AXManualAccessibility 之后拿到的 (Electron/Chromium 系默认不吐)。" : nil),
        unchanged: unchangedIds,
        removed: removedIds,
        incremental: isIncremental ? true : nil
    ))
}

/** 轻量签名 —— 变化断言每隔几百毫秒调一次, 走这条而不是完整 dump。见 collectSignature。 */
func opSignature(_ req: Request) {
    guard AXIsProcessTrusted() else {
        fail(req.id, "not_trusted", "没有辅助功能授权")
        return
    }
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let win = axWindows(axApp).first, let rect = axFrame(win) else {
        fail(req.id, "no_window", "\(app.localizedName ?? "?") 没有可见窗口")
        return
    }
    let out = collectSignature(win, clip: rect, budget: req.budget ?? 800)
    emit(SignatureResult(id: req.id, ok: true, ms: out.ms, texts: out.texts, labels: out.labels, counts: out.counts))
}

/** 拿元素句柄。id 无效 / 表已过期都要**分开报**, 这两件事的处置完全不同。 */
func resolveTarget(_ req: Request) -> AXUIElement? {
    guard let t = req.target else {
        fail(req.id, "missing_target", "这个操作需要 target (元素编号)")
        return nil
    }
    guard let el = table.get(t) else {
        fail(req.id, "stale_handle", "元素 \(t) 不在元素表里 (表里共 \(table.count) 个, epoch=\(table.epoch))",
             hint: "编号只能来自 dump 的返回值, 不能自己编。发出去的编号会一直有效 (换了目标 App 才整表清空), 所以拿不到多半是编号写错了。")
        return nil
    }
    return el
}

func opAct(_ req: Request) {
    guard let el = resolveTarget(req) else { return }
    let t0 = Date()
    if let err = performAX(el, action: req.action ?? "press", text: req.text) {
        switch err {
        case .gone:
            fail(req.id, "stale_handle", "元素 \(req.target ?? -1) 已经不存在了 (窗口关了, 或界面重建过)",
                 hint: "编号还在表里不代表元素还活着。重新 dump 拿新编号 —— 别重试同一个编号。")
        case .unsupported(let what):
            fail(req.id, "unsupported_action", "这个元素不支持 \(what)",
                 hint: "退回 op=click (后台坐标点击), 或先 act focus 再 type。")
        case .other(let msg):
            fail(req.id, "ax_action_failed", msg,
                 hint: "元素还在但动作没成 —— 可能是它当前不可用 (enabled=false), 或界面正忙。重新 dump 看一眼状态。")
        }
        return
    }
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    emit(r)
}

/**
 * 右键 / 上下文菜单。
 *
 * 能走 AXShowMenu 就走它 —— 不动鼠标也不抢焦点, 是干净的那条路; 否则退到后台右键事件。
 * **走了哪条必须在回执里说明白** (via 字段): 两条路的副作用不一样, 模型下一步该等什么也不一样。
 *
 * ⚠️ 判据只能看元素的 **action 列表**, 不能看 AXShowMenu 的返回值。
 * 真机 (计算器的 Delete 按钮, actions 只有 AXPress): AXUIElementPerformAction
 * 打 AXShowMenu 照样回 .success, 菜单一个没出。按返回值判的话这条兜底路径永远
 * 不会被走到, 而模型收到的是一句 ok —— 静默空转, 比明着失败难查十倍。
 */
func opShowMenu(_ req: Request) {
    if let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1, req.target == nil {
        guard let app = findApp(name: req.app, pid: req.pid) else {
            fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
            return
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
            ?? windowServerBounds(pid: app.processIdentifier) else {
            fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
            return
        }
        let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
        guard clickPoint(point, app: app, right: true) != nil else { failPointClick(req); return }
        var r = OkResult(id: req.id, ok: true)
        r.via = "rightclick"
        emit(r)
        return
    }
    guard let el = resolveTarget(req) else { return }
    let t0 = Date()
    var names: CFArray?
    let supportsAX = AXUIElementCopyActionNames(el, &names) == .success
        && ((names as? [String]) ?? []).contains(kAXShowMenuAction as String)

    var via = "ax"
    if supportsAX, let err = performAX(el, action: "showMenu", text: nil) {
        switch err {
        case .gone:
            fail(req.id, "stale_handle", "元素 \(req.target ?? -1) 已经不存在了",
                 hint: "重新 dump 拿新编号。")
            return
        case .unsupported, .other:
            via = ""   /* 列表里写着支持却失败了 —— 照样退到右键 */
        }
    } else if !supportsAX {
        via = ""
    }
    if via.isEmpty {
        /* 退到真右键。要坐标, 拿不到就只能如实失败 —— 不能瞎点屏幕中心。 */
        guard let f = axFrame(el) else {
            fail(req.id, "no_frame", "元素不支持 AXShowMenu, 也没有几何信息, 右键点不了",
                 hint: "先 dump 一次拿到带坐标的元素, 或改用 click_at 的相对坐标。")
            return
        }
        guard let app = NSRunningApplication(processIdentifier: req.pid ?? table.ownerPid),
              clickPoint(CGPoint(x: f.midX, y: f.midY), app: app, right: true) != nil else { failPointClick(req); return }
        via = "rightclick"
    }
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    r.via = via
    emit(r)
}

/** 在文本元素里选中一段。find 不给 = 全选; occurrence 用来消歧 (同一段文字出现多次)。 */
func opSelectText(_ req: Request) {
    guard let el = resolveTarget(req) else { return }
    let t0 = Date()
    switch selectText(el, find: req.find, occurrence: req.occurrence ?? 1) {
    case .ok(let loc, let len, let total):
        var r = OkResult(id: req.id, ok: true)
        r.ms = Int(Date().timeIntervalSince(t0) * 1000)
        r.selection = ["loc": loc, "len": len, "total": total]
        emit(r)
    case .notFound(let total, let hits):
        fail(req.id, "text_not_found",
             hits == 0
                ? "元素里没有这段文字 (全文 \(total) 个字符)"
                : "只找到 \(hits) 处, 要不到第 \(req.occurrence ?? 1) 处",
             hint: "先 read 一次看看实际文本 —— 别按记忆里的写法猜, 空格和标点常常对不上。")
    case .failure(let err):
        switch err {
        case .gone:
            fail(req.id, "stale_handle", "元素已经不存在了", hint: "重新 dump 拿新编号。")
        case .unsupported(let what):
            fail(req.id, "unsupported_action", "这个元素不支持 \(what)",
                 hint: "只有真正的文本控件 (AXTextField / AXTextArea) 能选区。网页里的正文要走浏览器工具。")
        case .other(let msg):
            fail(req.id, "ax_action_failed", msg)
        }
    }
}

/**
 * 等界面出动静 (最多 budget 毫秒)。**这不是断言, 是提前叫醒** —— 见 AXWatch.swift 文件头。
 * fired 为空只代表"没收到通知", 不代表界面没变; 调用方仍然要 dump 去比。
 */
func opWatch(_ req: Request) {
    let pid = req.pid ?? (findApp(name: req.app, pid: nil)?.processIdentifier ?? table.ownerPid)
    guard pid > 0 else { fail(req.id, "no_target_pid", "没有目标进程 —— 先 dump 一次或显式给 pid"); return }
    /* 上限 10s: 客户端一条请求 15s 超时, 留够回程余量。 */
    let ms = min(max(req.budget ?? 250, 1), 10_000)
    let out = waitForAXChange(pid: pid, timeout: Double(ms) / 1000.0)
    var r = OkResult(id: req.id, ok: true)
    r.ms = out.ms
    r.fired = out.fired
    emit(r)
}

func opType(_ req: Request) {
    guard let text = req.text else { fail(req.id, "missing_text", "type 需要 text"); return }
    if let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1, req.target == nil {
        guard let app = findApp(name: req.app, pid: req.pid) else {
            fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
            return
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
            ?? windowServerBounds(pid: app.processIdentifier) else {
            fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
            return
        }
        let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
        let t0 = Date()
        guard let via = clickPoint(point, app: app) else { failPointClick(req); return }
        typeText(text, toPid: app.processIdentifier)
        var r = OkResult(id: req.id, ok: true)
        r.ms = Int(Date().timeIntervalSince(t0) * 1000)
        r.via = via
        emit(r)
        return
    }
    let pid = req.pid ?? table.ownerPid
    guard pid > 0 else { fail(req.id, "no_target_pid", "没有目标进程 —— 先 dump 一次或显式给 pid"); return }
    let t0 = Date()
    /* 有 target 就先聚焦到那个元素上再打字 —— 否则字会落到"当前焦点"上, 那是个猜 */
    if let t = req.target, let el = table.get(t) {
        _ = performAX(el, action: "focus", text: nil)
    }
    typeText(text, toPid: pid)
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    emit(r)
}

func opKey(_ req: Request) {
    guard let key = req.key else { fail(req.id, "missing_key", "key 操作需要 key"); return }
    let pid = req.pid ?? table.ownerPid
    guard pid > 0 else { fail(req.id, "no_target_pid", "没有目标进程"); return }
    let t0 = Date()
    guard pressKey(key, modifiers: req.modifiers ?? [], toPid: pid) else {
        fail(req.id, "unknown_key", "不认识的按键: \(key)",
             hint: "支持: \(KEY_CODES.keys.sorted().joined(separator: ", "))")
        return
    }
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    emit(r)
}

func opClick(_ req: Request) {
    guard let el = resolveTarget(req) else { return }
    guard let f = axFrame(el) else { fail(req.id, "no_frame", "元素没有几何信息, 点不了"); return }
    let pid = req.pid ?? table.ownerPid
    let t0 = Date()
    guard let app = NSRunningApplication(processIdentifier: pid),
          let via = clickPoint(CGPoint(x: f.midX, y: f.midY), app: app) else { failPointClick(req); return }
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    r.via = via
    emit(r)
}

/** clickPoint 点不了: 窗口被挡住 / 切不到前台 —— 如实失败, 绝不点到别的应用上 */
func failPointClick(_ req: Request) {
    fail(req.id, "point_not_clickable", "那个位置点不了: 目标窗口不在最上层 (被别的窗口挡住) 或切不到前台",
         hint: "按元素编号操作 (后台可用), 或先 launch 把应用提到前台再试。")
}

/**
 * 按**窗口内的相对位置**点击 —— 视觉兜底层的落点。
 *
 * ─── 为什么是相对位置不是绝对坐标 ─────────────────────────────────────────
 * 自绘 UI (微信/飞书/Codex) 读不到元素, 只能把窗口截图交给视觉模型, 让它说"点这里"。
 * 模型按自己的坐标系报点, 宿主 (computerCoords.ts) 按截图尺寸折成比例传进来;
 * 我们这边现查窗口矩形再换算, 窗口被拖动/缩放也不偏。
 *
 * 落点走 clickPoint: 能 AX 命中就后台按, 否则提到前台真点 (postToPid 的鼠标事件点不中)。
 */
func opClickAt(_ req: Request) {
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    guard let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1 else {
        fail(req.id, "bad_ratio", "click_at 需要 dx / dy 作为窗口内的相对位置 (0~1)",
             hint: "左上角是 0,0; 右下角是 1,1。看截图估个比例就行, 别报绝对坐标。")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    /* 窗口矩形现查 —— 用户可能在两次调用之间把窗口拖走了 */
    guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
        ?? windowServerBounds(pid: app.processIdentifier) else {
        fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
        return
    }
    let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
    let t0 = Date()
    guard let via = clickPoint(point, app: app) else { failPointClick(req); return }
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    r.via = via
    r.value = "点了窗口内 (\(Int(rx * 100))%, \(Int(ry * 100))%) → 屏幕 (\(Int(point.x)), \(Int(point.y)))"
    emit(r)
}

/**
 * 真把系统光标移过去, 不按下。功能区/下拉图库常靠 hover 才展开。
 * 走全局 HID: postToPid 的 mouseMoved 到不了用户光标, 图库也就出不来。
 */
func hoverAt(_ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) else { return }
    move.post(tap: .cghidEventTap)
    usleep(180_000)
}

func dragTo(_ a: CGPoint, _ b: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left) else { return }
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    for i in 1...8 {
        let t = CGFloat(i) / 8
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        guard let move = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) else { continue }
        move.post(tap: .cghidEventTap)
        usleep(16_000)
    }
    guard let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left) else { return }
    up.post(tap: .cghidEventTap)
}

func opHover(_ req: Request) {
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    guard let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1 else {
        fail(req.id, "bad_ratio", "hover 需要 dx / dy 作为窗口内的相对位置 (0~1)",
             hint: "左上角是 0,0; 右下角是 1,1。看截图估个比例就行, 别报绝对坐标。")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
        ?? windowServerBounds(pid: app.processIdentifier) else {
        fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
        return
    }
    let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
    let t0 = Date()
    hoverAt(point)
    var r = OkResult(id: req.id, ok: true)
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    r.value = "悬停窗口内 (\(Int(rx * 100))%, \(Int(ry * 100))%) → 屏幕 (\(Int(point.x)), \(Int(point.y)))"
    emit(r)
}

func opDoubleClick(_ req: Request) {
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    if let t = req.target, let el = table.get(t), let f = axFrame(el) {
        guard clickPoint(CGPoint(x: f.midX, y: f.midY), app: app, clickCount: 2) != nil else { failPointClick(req); return }
        emit(OkResult(id: req.id, ok: true))
        return
    }
    guard let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1 else {
        fail(req.id, "bad_ratio", "double_click 需要 dx / dy 或 target",
             hint: "左上角是 0,0; 右下角是 1,1。")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
        ?? windowServerBounds(pid: app.processIdentifier) else {
        fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
        return
    }
    let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
    guard clickPoint(point, app: app, clickCount: 2) != nil else { failPointClick(req); return }
    emit(OkResult(id: req.id, ok: true))
}

func opDrag(_ req: Request) {
    guard let app = findApp(name: req.app, pid: req.pid) else {
        fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
        return
    }
    guard let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1,
          let rx2 = req.dx2, let ry2 = req.dy2, rx2 >= 0, rx2 <= 1, ry2 >= 0, ry2 <= 1 else {
        fail(req.id, "bad_ratio", "drag 需要 dx/dy 起点和 dx2/dy2 终点 (0~1)")
        return
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
        ?? windowServerBounds(pid: app.processIdentifier) else {
        fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
        return
    }
    let a = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
    let b = CGPoint(x: rect.minX + rect.width * rx2, y: rect.minY + rect.height * ry2)
    dragTo(a, b)
    emit(OkResult(id: req.id, ok: true))
}

func opScroll(_ req: Request) {
    let pid = req.pid ?? table.ownerPid
    if let rx = req.dx, let ry = req.dy, rx >= 0, rx <= 1, ry >= 0, ry <= 1, req.target == nil {
        guard let app = findApp(name: req.app, pid: req.pid) else {
            fail(req.id, "app_not_found", "找不到 App: \(req.app ?? "(前台)")")
            return
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let rect = axMainWindow(axApp).flatMap({ axFrame($0) })
            ?? windowServerBounds(pid: app.processIdentifier) else {
            fail(req.id, "no_window_geometry", "\(app.localizedName ?? "?") 读不出窗口位置, 没法换算坐标")
            return
        }
        let point = CGPoint(x: rect.minX + rect.width * rx, y: rect.minY + rect.height * ry)
        scrollAt(point, dx: 0, dy: -3, toPid: app.processIdentifier)
        emit(OkResult(id: req.id, ok: true))
        return
    }
    guard pid > 0 else { fail(req.id, "no_target_pid", "没有目标进程"); return }
    var point = CGPoint(x: 400, y: 400)
    if let t = req.target, let el = table.get(t), let f = axFrame(el) { point = CGPoint(x: f.midX, y: f.midY) }
    scrollAt(point, dx: req.dx ?? 0, dy: req.dy ?? -300, toPid: pid)
    emit(OkResult(id: req.id, ok: true))
}

func opReadValue(_ req: Request) {
    guard let el = resolveTarget(req) else { return }
    var r = OkResult(id: req.id, ok: true)
    r.value = axString(el, kAXValueAttribute as String) ?? axLabel(el)
    emit(r)
}

/**
 * App 图标 —— 卡片上那个小 logo。
 *
 * 为什么由桥来给, 而不是宿主自己去 /Applications 里猜文件名: 我们**已经**握着这个 App 的 pid,
 * `NSRunningApplication.bundleURL` 就是它真身的路径。按名字猜会在 QQ / 微信这类
 * 名字≠目录名的应用上翻车, 也认不出装在别处的 App。
 *
 * 不需要任何授权 —— 图标是 Launch Services 的公开信息, 没有辅助功能也拿得到。
 * 尺寸钉在 64pt(=128px @2x 的位图上限), 一张 ~6KB base64, 够卡片用。
 */
func opIcon(_ req: Request) {
    let pid = req.pid ?? findApp(name: req.app, pid: nil)?.processIdentifier
    var bundleURL: URL? = nil
    if let p = pid, let running = NSRunningApplication(processIdentifier: p) { bundleURL = running.bundleURL }
    if bundleURL == nil, let name = req.app, !name.isEmpty {
        /* 没在跑的 App (脚本第一步就是 launch 时会遇到) —— 按名字问 Launch Services。
         * bundleId 优先, 再退到显示名。 */
        if let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
            bundleURL = u
        } else if let p = NSWorkspace.shared.fullPath(forApplication: name) {
            bundleURL = URL(fileURLWithPath: p)
        }
    }
    guard let url = bundleURL else {
        fail(req.id, "app_not_found", "找不到这个 App: \(req.app ?? "(未指定)")")
        return
    }
    let icon = NSWorkspace.shared.icon(forFile: url.path)
    /* **必须重画一张小的**, 不能只设 icon.size 再 tiffRepresentation ——
     * 那个属性只影响绘制尺寸, 拿到的仍是图标里最大的那张 rep (512px),
     * 实测出来 353KB 的 base64, 塞进 UI 事件里纯属浪费。重画成 128px (卡片 64pt @2x)
     * 之后是 ~10KB。 */
    let side = 128
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
        fail(req.id, "icon_encode_failed", "建不出位图: \(url.path)")
        return
    }
    rep.size = NSSize(width: side, height: side)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    icon.draw(in: NSRect(x: 0, y: 0, width: side, height: side),
              from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fail(req.id, "icon_encode_failed", "图标编码失败: \(url.path)")
        return
    }
    var r = OkResult(id: req.id, ok: true)
    /* 给了 path 就**写成文件**, 只回一行路径。
     *
     * 2026-09-09 踩过: 图标以 dataURL 回去后一路挂在工具结果的 metadata 上, 而宿主对
     * 工具 output 有 12000 字符的预览上限 —— 13KB 的 base64 把整段 JSON 截断在半路,
     * 渲染层 parse 失败, 卡片一张都出不来 (症状是"卡片没了", 跟图标八竿子打不着)。
     * 写文件后 metadata 里只有一个路径, 渲染层走 neox-asset:// 读。 */
    if let out = req.path {
        do {
            try FileManager.default.createDirectory(
                atPath: (out as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: out))
            r.path = out
        } catch {
            fail(req.id, "icon_write_failed", "\(error)")
            return
        }
    } else {
        r.icon = "data:image/png;base64," + png.base64EncodedString()
        r.path = url.path
    }
    emit(r)
}

/** 窗口截图。走 screencapture -l<windowid> 只截目标窗口, 不截整屏 —— 又快又不泄露别的窗口。 */
func opScreenshot(_ req: Request) {
    guard hasScreenRecording() else {
        fail(req.id, "no_screen_recording", "没有屏幕录制授权",
             hint: "系统设置 → 隐私与安全性 → **屏幕录制** → 勾选「Neox Computer Use」。这跟辅助功能是两个独立的权限。\n" + "别让用户自己去翻 —— 调 computer_check_access({prompt: true}) 把设置页直接开到那一栏。")
        return
    }
    let path = req.path ?? NSTemporaryDirectory() + "neox-os-\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
    let t0 = Date()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var args = ["-x", "-t", "jpg"]
    /* 点了名就截点名的那个 —— 属主 pid 只在没点名时兜底 (同 handleRequestLine 的闸) */
    if let app = findApp(name: req.app, pid: req.pid ?? (req.app == nil && table.ownerPid > 0 ? table.ownerPid : nil)),
       let wid = frontWindowID(pid: app.processIdentifier) {
        /* -o 不带窗口阴影 (2026-09-30): 带阴影时 198×350 的窗口截出 532×836, 四周多 34pt,
         * 模型按图报的点全部偏移 —— 截图必须跟窗口矩形 (点击换算的基准) 一一对应。 */
        args += ["-o", "-l", String(wid)]
    }
    args.append(path)
    p.arguments = args
    /* **必须把子进程的 stdio 接到 /dev/null。**
     *
     * 2026-09-09 真机: socket 模式 (由 open 拉起的 LSBackgroundOnly app) 下,
     * 我们自己没有有效的 stdout/stderr。Process 默认让子进程继承它们, screencapture
     * 一往那儿写就把整个桥带死 —— 宿主看到的是 "桥连接断了", 跟截图八竿子打不着。
     * stdio 模式下不会发作 (那时 stdout 是真的), 所以这个坑只在正式路径上出现。 */
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run(); p.waitUntilExit() } catch {
        fail(req.id, "screencapture_failed", "\(error)")
        return
    }
    guard FileManager.default.fileExists(atPath: path) else {
        fail(req.id, "screencapture_empty", "screencapture 没有产出文件 (窗口可能已关闭)")
        return
    }
    var r = OkResult(id: req.id, ok: true)
    r.path = path
    r.ms = Int(Date().timeIntervalSince(t0) * 1000)
    emit(r)
}

/** 取某进程最前面那个窗口的 CGWindowID —— screencapture -l 要它。 */
func frontWindowID(pid: pid_t) -> CGWindowID? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard let owner = w[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
              let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let wid = w[kCGWindowNumber as String] as? CGWindowID else { continue }
        return wid
    }
    return nil
}

// MARK: - 主循环

/*
 * ─── 独立身份模式 (2026-09-09, 对标 Codex) ──────────────────────────────────
 * 用户实拍: macOS 的辅助功能列表里, OpenAI 那一项叫「**Codex Computer Use**」——
 * 是个跟 ChatGPT 分开的独立条目。这不是包装, 是唯一正确的做法, 它一次解决三个问题:
 *
 *   ① **dev 和打包版共用同一个授权条目**。被 spawn 的进程 TCC 记的是责任进程,
 *      于是 dev 下显示「Electron」、打包版显示「Neox」、从终端跑显示终端名 ——
 *      同一个能力在列表里有三个身份, 用户勾了一个另外两个还是不能用。
 *   ② **Neox 主体不必要辅助功能权限**。那是个能读你整个屏幕、能替你点任何按钮的
 *      权限, 不该压在主 app 头上。装了 computer-use 插件的人才需要给。
 *   ③ 用户能**单独关掉**电脑操作权限而不影响 Neox 其它功能。
 *
 * 做法: 桥不再由 Neox spawn 二进制, 而是用 open 启动 NeoxOSBridge.app —— 由 launchd
 * 拉起, 责任进程就是它自己, TCC 记在「Neox Computer Use」名下。
 * 通信从 stdio 换成 Unix domain socket (被 open 起来的 app 没有可用的 stdio)。
 */
if CommandLine.arguments.contains("--request-access") {
    /* 独立身份下请求授权: 这一弹会把「Neox Computer Use」加进辅助功能列表 */
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(opts)
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
        NSWorkspace.shared.open(url)
    }
    /* 给系统一点时间把对话框弹出来再退 —— 退太快对话框会跟着消失 */
    Thread.sleep(forTimeInterval: trusted ? 0.5 : 3.0)
    exit(trusted ? 0 : 2)
}

if CommandLine.arguments.contains("--probe") {
    let payload = ["trusted": AXIsProcessTrusted(), "screenRecording": hasScreenRecording()]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    print(String(data: data, encoding: .utf8)!)
    exit(AXIsProcessTrusted() ? 0 : 2)
}

/* ready 行让宿主知道桥活了 —— 跟 wakeWord 那座桥同一套约定 */
emit(OkResult(id: 0, ok: true, trusted: AXIsProcessTrusted(), screenRecording: hasScreenRecording()))

let decoder = JSONDecoder()

/** 处理一行请求。**两条管子 (stdio / socket) 共用这一份** —— 分两份实现迟早会分叉。 */
func handleRequestLine(_ line: String) {
    guard let data = line.data(using: .utf8), let req = try? decoder.decode(Request.self, from: data) else {
        emit(ErrResult(id: -1, ok: false, error: "解不开这行请求: \(line.prefix(200))", code: "bad_request"))
        return
    }
    /* ─── 硬边界: 终端 / Neox 自己 / 系统授权窗口 一律拒 (见 Guard.swift) ───────────
     *
     * 收口放在**分发之前**, 而不是每个 op 各判一次 —— 漏一个 op 就等于漏一整条路,
     * 而这条边界漏一次的代价是"绕过所有审批执行任意命令"。
     *
     * 目标怎么定 (必须跟各 op 自己的找法**逐字一致**):
     *   · 带了 app / pid   → 就是它, 元素表属主**不许**盖掉点名
     *   · dump / signature / launch 没点名 → 前台应用 (opDump 就是这么找的)
     *   · 其余动作类没点名 → 元素表的属主 pid
     *
     * 2026-09-13 真机: 原来一律 `req.pid ?? ownerPid` 优先于 app 名。于是
     *   ① `dump {}` 闸看的是旧属主 (放行), opDump 看的是前台 = Neox → 自我边界被绕过, 属主变成 Neox;
     *   ② 之后 dump Finder / QQ / 计算器, 闸按属主 pid 找到的全是 Neox → 一律 app_forbidden_self。
     * 属主要 dump 成功才会换, 而 dump 被闸挡着 —— 桥活多久就锁多久, 模型只能退回 shell 硬抠。
     */
    let needsTarget = ["launch", "dump", "signature", "act", "show_menu", "select_text", "type", "key",
                       "click", "click_at", "hover", "scroll", "read", "screenshot", "watch"].contains(req.op)
    if needsTarget {
        /* launch 的目标可能还没起来, 只能按名字判 */
        if case let .deny(code, reason, hint) = guardAppName(req.app) {
            fail(req.id, code, reason, hint: hint); return
        }
        let named = req.app != nil || req.pid != nil
        let perceives = ["launch", "dump", "signature"].contains(req.op)
        let target = named
            ? findApp(name: req.app, pid: req.pid)
            : (perceives || table.ownerPid <= 0
                ? NSWorkspace.shared.frontmostApplication
                : NSRunningApplication(processIdentifier: table.ownerPid))
        if case let .deny(code, reason, hint) = guardApp(target) {
            fail(req.id, code, reason, hint: hint); return
        }
    }

    switch req.op {
    case "probe":      opProbe(req)
    case "apps":       opApps(req)
    case "request_access": opRequestAccess(req)
    case "launch":     opLaunch(req)
    case "dump":       opDump(req)
    case "signature":  opSignature(req)
    case "act":        opAct(req)
    case "show_menu":  opShowMenu(req)
    case "select_text": opSelectText(req)
    case "watch":      opWatch(req)
    case "type":       opType(req)
    case "key":        opKey(req)
    case "click":      opClick(req)
    case "click_at":   opClickAt(req)
    case "hover":      opHover(req)
    case "double_click": opDoubleClick(req)
    case "drag":       opDrag(req)
    case "scroll":     opScroll(req)
    case "read":       opReadValue(req)
    case "icon":       opIcon(req)
    case "screenshot": opScreenshot(req)
    case "quit":       emit(OkResult(id: req.id, ok: true)); exit(0)
    default:           fail(req.id, "unknown_op", "不认识的 op: \(req.op)")
    }
}

/* ─── socket 模式: 由 launchd (open -a) 拉起时走这条 ────────────────────────
 * 为什么需要它: 只有被 open 拉起的 app 才有**自己的 TCC 身份**, 辅助功能列表里
 * 才会出现「Neox Computer Use」这一条 (对标 Codex)。而被 open 拉起的进程没有可用的
 * stdio, 所以协议换成 unix socket —— 协议内容一个字没变, 只是换了根管子。 */
if let i = CommandLine.arguments.firstIndex(of: "--serve"), i + 1 < CommandLine.arguments.count {
    let sockPath = CommandLine.arguments[i + 1]
    let server = SocketServer(path: sockPath)
    if let err = server.start() {
        FileHandle.standardError.write("socket 起不来: \(err)\n".data(using: .utf8)!)
        exit(3)
    }
    /* 宿主可能反复连断 (重启会话等), 所以循环接。一次只服务一个 —— 元素表是进程级的,
     * 多个会话共享一张表只会互相踩。 */
    while true {
        server.serveOne { line, write in
            emitSink = write
            defer { emitSink = nil }
            handleRequestLine(line)
        }
    }
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    handleRequestLine(trimmed)
}
