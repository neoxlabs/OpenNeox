import Cocoa
import ApplicationServices

/*
 * 输入层 —— 三级, 永远从上往下选。
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. AX 动作 (AXPress / setValue / focus)  —— 首选。不动光标, 不抢焦点,
 *      不受窗口遮挡影响, 也不受动画影响。实测按一个按钮 132.8ms (含 UI 响应)。
 *   2. 后台事件注入 (CGEventPostToPid)       —— **只对键盘有效**。事件直投目标进程,
 *      实测: 往没有焦点的 TextEdit 打 18 个字符 32ms (1.78ms/字符), 用户光标没动、前台没被抢。
 *      鼠标事件这样投基本被丢 (2026-09-30 Calculator 实测), 按坐标点击走 clickPoint:
 *      先 AX 命中测试按下, 不行再到第 3 级。
 *   3. 真光标 (CGEventPost 全局)             —— 坐标点击的兜底 / hover / drag。
 *      会把应用提到前台; 点完把光标放回原处。
 *
 * 顺序不能反: 越往下越像"猜", 也越容易在用户眼皮底下乱动。
 */

/** 常用按键的虚拟键码。只列 agent 真会用到的, 不做全键盘映射。 */
let KEY_CODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "a": 0, "s": 1, "c": 8, "v": 9, "x": 7, "z": 6, "f": 3, "w": 13, "q": 12, "r": 15, "t": 17,
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for n in names.map({ $0.lowercased() }) {
        switch n {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

/**
 * 往目标进程打字。走 unicode string, 不查键盘布局 ——
 * 中文/emoji/任何输入法状态下都一样, 而且不受用户当前输入法影响。
 */
func typeText(_ text: String, toPid pid: pid_t) {
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in text.unicodeScalars {
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
        var buf = Array(String(ch).utf16)   /* 非 BMP 字符是代理对, 必须按 UTF-16 发 */
        down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
        up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: &buf)
        down.postToPid(pid)
        up.postToPid(pid)
    }
}

func pressKey(_ key: String, modifiers: [String], toPid pid: pid_t) -> Bool {
    guard let code = KEY_CODES[key.lowercased()] else { return false }
    let src = CGEventSource(stateID: .hidSystemState)
    let flags = modifierFlags(modifiers)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return false }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    up.postToPid(pid)
    return true
}

/**
 * 按屏幕坐标点一下 —— 真能点中的那条路 (2026-09-30 真机)。
 *
 *   原来的 clickAt / rightClickAt 走 postToPid, 对鼠标事件基本无效: Calculator (SwiftUI)
 *   按钮正中心, 后台、前台、带窗口号都试过, 回 ok 而显示纹丝不动 —— 看屏点击此前从来
 *   没真点中过, 已删。键盘事件 postToPid 是好的 (typeText / pressKey 照旧)。
 *
 *   ① AX 命中测试: 该点下的元素 (或往上两层) 支持 AXPress 就按 —— 后台、不动光标。
 *   ② 否则真点击: 把应用提到前台, 确认该点最上层的窗口确实是它的 (不是就不点 ——
 *      宁可失败也不能点到别的应用上), HID 点完把光标放回原处。
 * 返回走的哪条路 ("ax-hit" / "hid"), 点不了返回 nil。
 *
 * right = 右键: 调用方先试过 AXShowMenu (多数控件不实现)。发的是原生右键, 不用 ctrl+左键 ——
 * Electron 收到的是带 ctrl 的左键, 行为跟右键不一样。
 */
func clickPoint(_ p: CGPoint, app: NSRunningApplication, clickCount: Int = 1, right: Bool = false) -> String? {
    let pid = app.processIdentifier
    if clickCount == 1 && !right && axPressAt(p, pid: pid) { return "ax-hit" }
    if !app.isActive {
        app.activate(options: [])
        for _ in 0..<10 where topWindowOwner(at: p) != pid { usleep(50_000) }
    }
    guard topWindowOwner(at: p) == pid else { return nil }
    let saved = CGEvent(source: nil)?.location
    let src = CGEventSource(stateID: .hidSystemState)
    let (downType, upType, button): (CGEventType, CGEventType, CGMouseButton) = right
        ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    for i in 1...max(1, clickCount) {
        guard let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: p, mouseButton: button),
              let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: p, mouseButton: button) else { return nil }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
    if let s = saved { usleep(30_000); CGWarpMouseCursorPosition(s) }
    return "hid"
}

/** 该点下支持 AXPress 的元素 (命中元素或往上两层) —— 按下去 */
func axPressAt(_ p: CGPoint, pid: pid_t) -> Bool {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(p.x), Float(p.y), &hit) == .success,
          var cur = hit else { return false }
    for _ in 0..<3 {
        if axActions(cur).contains(kAXPressAction as String) {
            return AXUIElementPerformAction(cur, kAXPressAction as CFString) == .success
        }
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parent) == .success,
              let par = parent, CFGetTypeID(par) == AXUIElementGetTypeID() else { break }
        cur = par as! AXUIElement
    }
    return false
}

/** 屏幕这个点上最上层的普通窗口属于哪个进程 */
func topWindowOwner(at p: CGPoint) -> pid_t? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: b), rect.contains(p) else { continue }
        return w[kCGWindowOwnerPID as String] as? pid_t
    }
    return nil
}

/**
 * 在一个文本元素里**选中指定的一段文字**。
 *
 * 为什么要有这个而不是让模型 cmd+A: 「把这段改掉」是 CU 的高频意图, 而 cmd+A 只能全选。
 * 走 AXSelectedTextRange 还有一个 cmd+A 给不了的东西 —— **消歧**: 同一段文字在正文里
 * 出现多次时, 调用方可以给 occurrence 指定第几个, 而键盘操作只能一遍遍按 cmd+G 猜。
 *
 * 返回值是选中的范围 (loc,len), 让调用方能确认真的选中了它想要的那一段 ——
 * 只回一句 "ok" 的话, 选错了地方跟选对了长得一模一样。
 */
enum SelectOutcome {
    case ok(loc: Int, len: Int, total: Int)
    case notFound(total: Int, occurrences: Int)
    case failure(AXFailure)
}

func selectText(_ el: AXUIElement, find: String?, occurrence: Int) -> SelectOutcome {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &raw) == .success,
          let full = raw as? String else {
        return .failure(.unsupported("读取 AXValue"))
    }
    /* AXSelectedTextRange 的单位是 **UTF-16 code unit**, 不是 Character 也不是字节。
     * 拿 String.count 去算的话, 中文没事, emoji (代理对) 会整体错位。 */
    let hay = Array(full.utf16)
    var loc = 0
    var len = hay.count

    if let needle = find, !needle.isEmpty {
        let pin = Array(needle.utf16)
        var hits: [Int] = []
        if pin.count <= hay.count {
            for i in 0...(hay.count - pin.count) where Array(hay[i..<(i + pin.count)]) == pin {
                hits.append(i)
            }
        }
        guard !hits.isEmpty else { return .notFound(total: hay.count, occurrences: 0) }
        let n = max(1, occurrence)
        guard n <= hits.count else { return .notFound(total: hay.count, occurrences: hits.count) }
        loc = hits[n - 1]
        len = pin.count
    }

    var range = CFRange(location: loc, length: len)
    guard let value = AXValueCreate(.cfRange, &range) else {
        return .failure(.other("构造 AXValue range 失败"))
    }
    let e = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, value)
    if e != .success {
        var probe: CFTypeRef?
        let alive = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &probe) == .success
        if !alive { return .failure(.gone) }
        return .failure(e == .attributeUnsupported || e == .actionUnsupported
                        ? .unsupported("设置选区 (这个元素不是可选文本)")
                        : .other("设置选区失败 (AXError \(e.rawValue))"))
    }
    return .ok(loc: loc, len: len, total: hay.count)
}

func scrollAt(_ p: CGPoint, dx: Double, dy: Double, toPid pid: pid_t) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let ev = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
                           wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return }
    ev.location = p
    ev.postToPid(pid)
}

/**
 * 对元素执行 AX 动作。返回 nil 表示成功, 否则是错误码。
 *
 * setValue 走 AXValue 直接写 —— 比逐字符敲快一个量级, 而且不会被输入法/自动补全干扰。
 * 写不进去 (只读 / 不支持) 时**明确返回失败**, 让调用方退回打字, 而不是假装成功。
 */
enum AXFailure {
    /** 元素本身已经不存在了 (窗口关了 / 界面重建过)。跟"这个动作不支持"完全是两回事。 */
    case gone
    /** 元素还在, 但不支持这个动作。调用方应该退回坐标点击或换个动作。 */
    case unsupported(String)
    /** 其余 (元素忙 / 没权限 / 参数不对)。 */
    case other(String)
}

/**
 * 对元素执行 AX 动作。成功返回 nil。
 *
 * 失败必须分类, 不能笼统报一句 "action failed" —— 冒烟测试里就抓到过:
 * 窗口已经关了, 编号还在表里, 底层元素是死的。当时报的是 `ax_action_failed`,
 * 模型看到这个只会重试同一个编号; 报 `stale_handle` 它才知道要重新 dump。
 * (同一条教训在 browser_run 上踩过: "选择器没命中"和"动作没生效"必须分开报。)
 */
func performAX(_ el: AXUIElement, action: String, text: String?) -> AXFailure? {
    /* 错误码本身分不清"元素死了"和"元素活着但不支持": 实测 TextEdit 里一个已经随窗口
     * 销毁的按钮, AXPress 返回的是 attributeUnsupported (-25205) 而不是 invalidUIElement。
     * 所以失败时**再花一趟 IPC 探一下元素还在不在** —— 读个最便宜的 AXRole。
     * 只在失败路径上多这一趟, 换来的是模型知道该"重新 dump"还是"换个动作"。 */
    func stillAlive() -> Bool {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &v) == .success
    }
    func wrap(_ e: AXError, _ what: String) -> AXFailure? {
        switch e {
        case .success: return nil
        case .invalidUIElement, .cannotComplete: return .gone
        case .actionUnsupported, .attributeUnsupported:
            return stillAlive() ? .unsupported(what) : .gone
        default:
            return stillAlive() ? .other("\(what) 失败 (AXError \(e.rawValue))") : .gone
        }
    }
    switch action.lowercased() {
    case "press", "click":
        return wrap(AXUIElementPerformAction(el, kAXPressAction as CFString), "AXPress")
    case "showmenu":
        return wrap(AXUIElementPerformAction(el, kAXShowMenuAction as CFString), "AXShowMenu")
    case "confirm":
        return wrap(AXUIElementPerformAction(el, kAXConfirmAction as CFString), "AXConfirm")
    case "cancel":
        return wrap(AXUIElementPerformAction(el, kAXCancelAction as CFString), "AXCancel")
    case "focus":
        return wrap(AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue), "设置焦点")
    case "setvalue":
        guard let t = text else { return .other("setValue 需要 text") }
        return wrap(AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, t as CFTypeRef), "写入 AXValue")
    default:
        return .other("不认识的动作: \(action)")
    }
}
