//! 输入注入 —— SendInput 那一层。
//!
//! 对应 mac 的 `Input.swift` (那边是 CGEvent)。语义对齐, 但有一条**平台差异
//! 必须说清楚**, 它会影响上层的动作选择:
//!
//!   · mac: 键盘/鼠标事件可以**定向发给某个 pid**, 目标应用在后台也能收到 ——
//!     所以那边敢承诺"不移动光标、不抢焦点、用户可以同时用这台电脑干别的"。
//!   · Windows: `SendInput` 把事件投进**前台窗口**的输入队列。要往一个后台应用
//!     打字, 只能先把它切到前台 (AttachThreadInput 那类旁路既不可靠也不是给
//!     自动化用的)。**坐标点击同理 —— SendInput 的鼠标事件是真的移动光标。**
//!
//! 所以这一层的能力边界是:
//!   · UIA pattern 能做的事 (invoke / setValue / select / expand / toggle / focus)
//!     → 不抢焦点、不动光标, 跟 mac 一致。**上层应该优先走这些。**
//!   · type / key / click_at / scroll → 需要前台, 会动光标。
//! 这不是"实现得不够好", 是 Windows 的输入模型; 桥的职责是**如实**, 不是假装。

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEINPUT, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, VIRTUAL_KEY, VkKeyScanW,
    VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_HOME, VK_INSERT, VK_LEFT,
    VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

fn keyboard_input(vk: VIRTUAL_KEY, scan: u16, up: bool, unicode: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if unicode {
        flags |= KEYEVENTF_UNICODE;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) -> u32 {
    if inputs.is_empty() {
        return 0;
    }
    unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) }
}

/// 屏幕坐标 → SendInput 的 0..65535 归一化虚拟屏坐标。
fn normalize(x: i32, y: i32) -> (i32, i32) {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
        )
    };
    let nx = ((x - vx) as i64 * 65535 / (vw as i64 - 1).max(1)) as i32;
    let ny = ((y - vy) as i64 * 65535 / (vh as i64 - 1).max(1)) as i32;
    (nx.clamp(0, 65535), ny.clamp(0, 65535))
}

/// 按 Unicode 直接注入一段文本。
///
/// 用 KEYEVENTF_UNICODE 而不是"把字符翻译成虚拟键 + Shift 组合": 中文/emoji/
/// 任意符号都能一次过, 也不用猜键盘布局。
///
/// **分批发, 中间给几毫秒**: 一次性灌进去几百个事件时, 目标应用的消息循环
/// 还在处理"窗口刚被激活"那一批消息, 后到的输入会被挤掉 —— 实测症状是
/// "回执说写了 9 个字符, 记事本里只多了一个"。8 个字符一批、每批间隔 6ms,
/// 400 字的文本也就多花 300ms, 比"少几个字还说自己成功"划算得多。
pub fn type_unicode(text: &str) -> (u32, usize) {
    /* 一次一个字符, 中间隔 12ms。
     *
     * 为什么不整批灌: 实测过整批 8 个字符一次 SendInput —— 事件数确实全插进去了
     * (keyEvents=18/18), 但目标应用处理时会丢/串字符 (连发两轮的结果是
     * "typed-ok" 变成 "typedkok": 少了一个 '-')。而"一个字符一次 + 小间隔"
     * 三批各 1/2/6 字符全部原样落地。慢一点是划算的: 长文本本来就该用 setValue
     * (一次 IPC 写完整段, 快一个量级)。 */
    const GAP_MS: u64 = 12;
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut inserted_total = 0u32;
    let retries = 0usize;
    for (i, unit) in units.iter().enumerate() {
        let batch = [
            keyboard_input(VIRTUAL_KEY(0), *unit, false, true),
            keyboard_input(VIRTUAL_KEY(0), *unit, true, true),
        ];
        let mut tries = 0;
        loop {
            let n = send(&batch) as usize;
            inserted_total += n as u32;
            if n >= 2 || tries >= 3 {
                break;
            }
            tries += 1;
        }
        if i + 1 < units.len() {
            std::thread::sleep(std::time::Duration::from_millis(GAP_MS));
        }
    }
    (inserted_total, retries)
}

/// 单个按键 + 修饰键。修饰键按下 → 主键 → 修饰键抬起 (顺序反着来才对)。
/// `needs_shift` 是键盘布局算出来的额外要求 (大写字母、`!@#` 这类)。
pub fn press_key(vk: VIRTUAL_KEY, modifiers: &[String], needs_shift: bool) -> bool {
    let mut downs: Vec<INPUT> = Vec::new();
    let mut ups: Vec<INPUT> = Vec::new();
    let mut shift_held = false;
    for m in modifiers {
        let mv = match m.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "win" | "super" => VK_LWIN,
            "ctrl" | "control" => VK_CONTROL,
            "alt" | "option" | "opt" => VK_MENU,
            "shift" => {
                shift_held = true;
                VK_SHIFT
            }
            _ => return false,
        };
        downs.push(keyboard_input(mv, 0, false, false));
        ups.push(keyboard_input(mv, 0, true, false));
    }
    /* 布局要求 shift 而调用方没给: 自己按上。不按的话 `key "X"` 会打出小写 x ——
     * 调用方说的是"按 X", 不是"按 x"。 */
    if needs_shift && !shift_held {
        downs.push(keyboard_input(VK_SHIFT, 0, false, false));
        ups.push(keyboard_input(VK_SHIFT, 0, true, false));
    }
    downs.push(keyboard_input(vk, 0, false, false));
    ups.push(keyboard_input(vk, 0, true, false));
    downs.extend(ups);
    send(&downs);
    true
}

/// 键盘上某个键的虚拟键码 + **是否需要 shift** (大写字母 / 符号)。
/// 名字跟 mac 的 KEY_CODES 对齐 (return / escape / …), 另外任何单个字符都认
/// (走 VkKeyScanW, 于是 ctrl+c 这种组合也成立)。
pub fn vk_for(key: &str) -> Option<(VIRTUAL_KEY, bool)> {
    let k = key.trim();
    let lower = k.to_ascii_lowercase();
    let named = match lower.as_str() {
        "return" | "enter" => Some(VK_RETURN),
        "tab" => Some(VK_TAB),
        "escape" | "esc" => Some(VK_ESCAPE),
        "space" => Some(VK_SPACE),
        "backspace" | "delete_back" => Some(VK_BACK),
        "delete" | "del" => Some(VK_DELETE),
        "insert" | "ins" => Some(VK_INSERT),
        "up" => Some(VK_UP),
        "down" => Some(VK_DOWN),
        "left" => Some(VK_LEFT),
        "right" => Some(VK_RIGHT),
        "home" => Some(VK_HOME),
        "end" => Some(VK_END),
        "pageup" | "page_up" => Some(VK_PRIOR),
        "pagedown" | "page_down" => Some(VK_NEXT),
        _ => None,
    };
    if let Some(v) = named {
        return Some((v, false));
    }
    /* f1..f24 */
    if let Some(n) = lower.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some((VIRTUAL_KEY(VK_F1.0 + (n - 1)), false));
        }
    }
    /* 单个字符: 交给键盘布局算 (高位字节的第 0 位 = 要 shift) */
    let mut chars = k.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let scan = unsafe { VkKeyScanW(c as u16) };
    if scan == -1 {
        return None;
    }
    let needs_shift = (scan >> 8) & 0xff & 1 != 0;
    Some((VIRTUAL_KEY((scan & 0xff) as u16), needs_shift))
}

/// `alt+insert` / `ctrl+alt+shift+s` 写在 key 里时拆成 (vk, modifiers, shift)。
/// 模型经常把和弦塞进 key, 而不是 modifiers 数组 —— 不拆就会 unknown_key。
pub fn parse_key_spec(key: &str, extra_mods: &[String]) -> Option<(VIRTUAL_KEY, Vec<String>, bool)> {
    let raw = key.trim();
    if raw.is_empty() {
        return None;
    }
    let mut mods: Vec<String> = extra_mods
        .iter()
        .map(|m| m.trim().to_ascii_lowercase())
        .filter(|m| !m.is_empty())
        .collect();
    let mut key_tok = raw.to_string();
    if raw != "+" && raw.contains('+') {
        let parts: Vec<&str> = raw.split('+').filter(|s| !s.is_empty()).collect();
        if parts.len() >= 2 {
            key_tok = parts[parts.len() - 1].to_string();
            for p in &parts[..parts.len() - 1] {
                let m = p.to_ascii_lowercase();
                if !mods.iter().any(|x| x == &m) {
                    mods.push(m);
                }
            }
        }
    }
    let (vk, needs_shift) = vk_for(&key_tok)?;
    Some((vk, mods, needs_shift))
}

#[cfg(test)]
mod tests {
    use super::{parse_key_spec, vk_for};
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_INSERT, VK_RETURN, VK_S};

    #[test]
    fn insert_and_return_are_named_keys() {
        assert_eq!(vk_for("insert").unwrap().0, VK_INSERT);
        assert_eq!(vk_for("ins").unwrap().0, VK_INSERT);
        assert_eq!(vk_for("return").unwrap().0, VK_RETURN);
        assert_eq!(vk_for("enter").unwrap().0, VK_RETURN);
    }

    #[test]
    fn chord_in_key_splits_modifiers() {
        let (vk, mods, _) = parse_key_spec("alt+insert", &[]).unwrap();
        assert_eq!(vk, VK_INSERT);
        assert!(mods.iter().any(|m| m == "alt"));

        let (vk, mods, _) = parse_key_spec("ctrl+alt+shift+s", &[]).unwrap();
        assert_eq!(vk, VK_S);
        assert!(mods.iter().any(|m| m == "ctrl"));
        assert!(mods.iter().any(|m| m == "alt"));
        assert!(mods.iter().any(|m| m == "shift"));
    }

    #[test]
    fn extra_modifiers_merge() {
        let (vk, mods, _) = parse_key_spec("insert", &["alt".into()]).unwrap();
        assert_eq!(vk, VK_INSERT);
        assert!(mods.iter().any(|m| m == "alt"));
    }
}

/// 坐标点击 (左键/右键)。**会移动用户的鼠标** —— Windows 的 SendInput 没有
/// "不移动光标地点一下"这回事, 见文件头。
pub fn click_at(x: i32, y: i32, right: bool) {
    let (nx, ny) = normalize(x, y);
    let abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let (down, up) = if right {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    /* 先把系统光标落到点上再按下: 部分办公软件忽略「瞬发」的注入点击. */
    let _ = unsafe { SetCursorPos(x, y) };
    std::thread::sleep(std::time::Duration::from_millis(25));
    send(&[mouse_input(MOUSEEVENTF_MOVE | abs, nx, ny, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(20));
    send(&[mouse_input(abs | down, nx, ny, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(40));
    send(&[mouse_input(abs | up, nx, ny, 0)]);
}

/// 只把光标移过去, 不按下。功能区/下拉图库常靠 WM_MOUSEMOVE 停住才展开,
/// 直接 click_at 会"展开再被点击关掉"。
pub fn hover_at(x: i32, y: i32) {
    let (nx, ny) = normalize(x, y);
    let abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let _ = unsafe { SetCursorPos(x, y) };
    std::thread::sleep(std::time::Duration::from_millis(20));
    send(&[mouse_input(MOUSEEVENTF_MOVE | abs, nx, ny, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(180));
}

/// 双击。第二下要紧跟第一下, 间隔太长应用会当成两次单击。
pub fn double_click_at(x: i32, y: i32) {
    click_at(x, y, false);
    std::thread::sleep(std::time::Duration::from_millis(40));
    let (nx, ny) = normalize(x, y);
    let abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[mouse_input(abs | MOUSEEVENTF_LEFTDOWN, nx, ny, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(30));
    send(&[mouse_input(abs | MOUSEEVENTF_LEFTUP, nx, ny, 0)]);
}

/// 按住拖到终点。中间插几步 MOVE, 否则不少应用只认"瞬移"。
pub fn drag_to(x1: i32, y1: i32, x2: i32, y2: i32) {
    let abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let (n1x, n1y) = normalize(x1, y1);
    let _ = unsafe { SetCursorPos(x1, y1) };
    std::thread::sleep(std::time::Duration::from_millis(20));
    send(&[mouse_input(MOUSEEVENTF_MOVE | abs, n1x, n1y, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(20));
    send(&[mouse_input(abs | MOUSEEVENTF_LEFTDOWN, n1x, n1y, 0)]);
    std::thread::sleep(std::time::Duration::from_millis(40));
    const STEPS: i32 = 8;
    for i in 1..=STEPS {
        let x = x1 + (x2 - x1) * i / STEPS;
        let y = y1 + (y2 - y1) * i / STEPS;
        let (nx, ny) = normalize(x, y);
        let _ = unsafe { SetCursorPos(x, y) };
        send(&[mouse_input(MOUSEEVENTF_MOVE | abs, nx, ny, 0)]);
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    let (n2x, n2y) = normalize(x2, y2);
    send(&[mouse_input(abs | MOUSEEVENTF_LEFTUP, n2x, n2y, 0)]);
}

/// 滚轮。dy 跟 mac 一致: 负数是往下滚 (WHEEL_DELTA 一格 120)。
pub fn scroll_at(x: i32, y: i32, dy: f64) {
    let (nx, ny) = normalize(x, y);
    let abs = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let delta = (-dy * 120.0) as i32;
    send(&[
        mouse_input(MOUSEEVENTF_MOVE | abs, nx, ny, 0),
        mouse_input(abs | MOUSEEVENTF_WHEEL, nx, ny, delta),
    ]);
}

/// 窗口中心坐标 (没点名 target 时的兜底落点)。
pub fn center_of(rect: windows::Win32::Foundation::RECT) -> POINT {
    POINT {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
    }
}
