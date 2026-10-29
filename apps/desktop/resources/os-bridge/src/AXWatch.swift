import Cocoa
import ApplicationServices

/*
 * AXObserver —— 让"等界面变"从空睡变成被叫醒。
 * ═══════════════════════════════════════════════════════════════════════════
 * expectChange 原本是每 250ms dump 一次去比。两个成本:
 *   · 延迟   —— 界面 20ms 就变好了, 也要等到下一个 250ms 边界才发现;
 *   · 白干   —— 每一轮都是一次完整 dump (Electron 系 App 一次就要几百毫秒到几秒)。
 * 这里注册系统的辅助功能通知, 有事件就立刻返回, 没事件就睡到超时。
 *
 * ─── 为什么这是"提前叫醒"而不是"改判据" ────────────────────────────────────
 * 通知**不保证完整**: 注册在某个元素上的通知只为那个元素发, 而各家 App 在
 * 应用级元素上到底发不发 kAXValueChanged 完全看它自己的实现。所以绝不能拿
 * "有没有通知"当断言 —— 那会在不发通知的 App 上把"界面确实变了"判成没变。
 *
 * 它只替掉轮询里那次 `sleep(250ms)`: 有通知就早点醒, 没有就睡满。断言仍然由
 * TS 侧 dump 之后自己比。最坏情况退化成原来的固定睡眠, 不可能更差。
 *
 * ⚠️ AXObserver 要挂在 **CFRunLoop** 上。桥是一条请求一条请求同步处理的
 * (见 main.swift 的 serveOne), 所以直接挂在当前线程的 runloop 上跑就行 ——
 * 不需要另起线程, 也就没有"表在这条线程、通知在那条线程"的竞态。
 */

/** 应用级元素上会发的通知 —— 窗口/菜单/焦点这类"大动静"。 */
private let APP_NOTIFICATIONS: [String] = [
    kAXWindowCreatedNotification as String,
    kAXFocusedWindowChangedNotification as String,
    kAXMainWindowChangedNotification as String,
    kAXFocusedUIElementChangedNotification as String,
    kAXSheetCreatedNotification as String,
    kAXDrawerCreatedNotification as String,
    kAXMenuOpenedNotification as String,
    kAXMenuClosedNotification as String,
    kAXWindowMiniaturizedNotification as String,
    kAXWindowDeminiaturizedNotification as String,
    kAXApplicationActivatedNotification as String,
    kAXValueChangedNotification as String,
    kAXTitleChangedNotification as String,
    kAXLayoutChangedNotification as String,
    kAXUIElementDestroyedNotification as String,
    kAXCreatedNotification as String,
]

/** 窗口级元素上会发的通知 —— 列表行数、选区这类"窗口内部的变化"。 */
private let WINDOW_NOTIFICATIONS: [String] = [
    kAXValueChangedNotification as String,
    kAXTitleChangedNotification as String,
    kAXLayoutChangedNotification as String,
    kAXRowCountChangedNotification as String,
    kAXSelectedChildrenChangedNotification as String,
    kAXSelectedRowsChangedNotification as String,
    kAXSelectedTextChangedNotification as String,
    kAXResizedNotification as String,
    kAXUIElementDestroyedNotification as String,
    kAXCreatedNotification as String,
]

/** 通知回调里攒下来的事件名。同步处理模型下只有一个等待者, 用全局的就够了。 */
private var watchHits: [String] = []

private func watchCallback(_ observer: AXObserver, _ element: AXUIElement,
                           _ notification: CFString, _ ctx: UnsafeMutableRawPointer?) {
    watchHits.append(notification as String)
    /* 拿到第一条就把 runloop 停掉 —— 我们要的是"有动静了", 不是"数清楚几条"。 */
    CFRunLoopStop(CFRunLoopGetCurrent())
}

struct WatchOutcome {
    let fired: [String]
    let ms: Int
}

/**
 * 等这个进程的界面出动静, 最多等 timeout 秒。
 *
 * 返回 fired 为空 = 睡满了也没通知。**这不等于界面没变** (见文件头): 调用方仍然要
 * 自己 dump 去比。
 */
func waitForAXChange(pid: pid_t, timeout: TimeInterval) -> WatchOutcome {
    let t0 = Date()
    watchHits = []

    var observer: AXObserver?
    guard AXObserverCreate(pid, watchCallback, &observer) == .success, let obs = observer else {
        /* 建不出观察者 (进程没了 / 没授权) —— 退化成纯睡眠, 不报错。
         * 报错的话调用方就得为"能不能观察"分两条路, 而它本来就只是个提前叫醒。 */
        Thread.sleep(forTimeInterval: timeout)
        return WatchOutcome(fired: [], ms: Int(Date().timeIntervalSince(t0) * 1000))
    }

    let app = AXUIElementCreateApplication(pid)
    for n in APP_NOTIFICATIONS {
        AXObserverAddNotification(obs, app, n as CFString, nil)
    }
    /* 再挂一份到焦点窗口上 —— 元素级通知只为注册的那个元素发, 挂在应用元素上
     * 收不到窗口内部的行数/选区变化。只挂焦点窗口这一个, 不遍历整棵树:
     * 一棵树几百个元素, 逐个注册的 IPC 开销比它省下来的还多。 */
    var win: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &win) == .success,
       let w = win, CFGetTypeID(w) == AXUIElementGetTypeID() {
        let window = w as! AXUIElement
        for n in WINDOW_NOTIFICATIONS {
            AXObserverAddNotification(obs, window, n as CFString, nil)
        }
    }

    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    CFRunLoopRunInMode(.defaultMode, timeout, false)
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)

    let fired = watchHits
    watchHits = []
    return WatchOutcome(fired: fired, ms: Int(Date().timeIntervalSince(t0) * 1000))
}
