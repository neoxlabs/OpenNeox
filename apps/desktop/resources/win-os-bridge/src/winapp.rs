//! Windows 窗口 / 进程枚举 —— 桥的"目标解析"层。
//!
//! 对应 mac 的 `windowOwners()` + `findApp()` (见 os-bridge/src/main.swift 里那一大段
//! 注释): mac 那边踩的坑是 NSWorkspace 的列表靠通知维护, 桥没有 run loop 于是列表冻结
//! 在启动那一刻 —— 最后改用 WindowServer 实时查询。
//!
//! Windows 上直接是实时的: `EnumWindows` 每次调用都过一遍当前桌面, 不存在缓存陈旧
//! 那类问题。但另一类坑是现成的: **每个应用都有若干隐形/辅助窗口**
//! (mac 那边对应 `CursorUIViewService` 这种辅助进程)。所以"主窗口"要挑:
//! 可见 + 有标题 + 不属于工具窗口 + 面积最大。

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::{PWSTR, BOOL};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW,
    GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
    SetWindowPos, ShowWindow, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GW_ENABLEDPOPUP, GW_OWNER,
    HWND_NOTOPMOST, HWND_TOPMOST, SW_RESTORE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    WS_EX_TOOLWINDOW,
};

#[derive(Clone, Debug)]
pub struct RawWindow {
    pub hwnd: HWND,
    pub pid: u32,
    pub title: String,
    pub class: String,
}

#[derive(Clone, Debug)]
pub struct WinApp {
    /// 进程可执行文件名 (不含扩展名), 例如 notepad / chrome / explorer
    pub name: String,
    /// 完整可执行路径 (Guard 按它判"是不是终端")
    pub exe_path: String,
    pub pid: u32,
    /// 该进程的主窗口 (没有窗口时是 0 —— 例如某些后台应用)
    pub hwnd: HWND,
    pub title: String,
    pub frontmost: bool,
}

/// 枚举当前所有**有可见顶层窗口**的窗口。
fn enum_windows() -> Vec<RawWindow> {
    let mut out: Vec<RawWindow> = Vec::new();
    let ptr = &mut out as *mut Vec<RawWindow> as isize;

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<RawWindow>);
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            /* 有属主的窗口是对话框/工具窗, 不是应用主窗口 */
            let owner = GetWindow(hwnd, GW_OWNER).unwrap_or(HWND(std::ptr::null_mut()));
            if !owner.0.is_null() {
                return BOOL(1);
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let title = window_text(hwnd);
            if title.is_empty() {
                return BOOL(1);
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return BOOL(1);
            }
            list.push(RawWindow {
                hwnd,
                pid,
                title,
                class: window_class(hwnd),
            });
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(ptr));
    }
    out
}

/// 该进程所有可见顶层窗, **含属主对话框**。
///
/// `enum_windows` 会丢掉有 GW_OWNER 的窗 (那是给"找主窗口"用的: 设置 /
/// 查找 / 轻量弹层都是属主对话框)。dump 如果也丢掉它们, 弹层里的控件
/// 永远不在编号表里, 点开设置只会回报成功、下一张 snapshot 仍是主窗。
pub fn process_windows(pid: u32) -> Vec<RawWindow> {
    let mut out: Vec<RawWindow> = Vec::new();
    let ptr = &mut out as *mut Vec<RawWindow> as isize;
    let want = pid;

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<RawWindow>);
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut wpid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut wpid));
            if wpid == 0 {
                return BOOL(1);
            }
            let r = window_rect(hwnd);
            if (r.right - r.left) < 32 || (r.bottom - r.top) < 32 {
                return BOOL(1);
            }
            list.push(RawWindow {
                hwnd,
                pid: wpid,
                title: window_text(hwnd),
                class: window_class(hwnd),
            });
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(ptr));
    }
    out.into_iter().filter(|w| w.pid == want).collect()
}

pub fn is_owned(hwnd: HWND) -> bool {
    let owner = unsafe { GetWindow(hwnd, GW_OWNER) }.unwrap_or(HWND(std::ptr::null_mut()));
    !owner.0.is_null()
}

/// 对话框属主链是否落到 `ancestor`。explorer.exe 一个 pid 挂着所有文件夹窗,
/// 只按 pid 扫对话框会把「是否取消传输」抢到 Documents 的 dump 上。
pub fn is_owned_by(hwnd: HWND, ancestor: HWND) -> bool {
    if hwnd.0.is_null() || ancestor.0.is_null() {
        return false;
    }
    let mut h = hwnd;
    for _ in 0..8 {
        let owner = unsafe { GetWindow(h, GW_OWNER) }.unwrap_or(HWND(std::ptr::null_mut()));
        if owner.0.is_null() {
            return false;
        }
        if owner.0 == ancestor.0 {
            return true;
        }
        h = owner;
    }
    false
}

fn window_area(hwnd: HWND) -> i64 {
    let r = window_rect(hwnd);
    (r.right - r.left).max(0) as i64 * (r.bottom - r.top).max(0) as i64
}

/// dump / 截图 / 签名该扫哪几扇窗。
///
/// 有足够大的属主对话框时 **只返回对话框** (前台优先, 再按面积)。设置开着还去
/// 扫 IDEA 主窗, 800 个预算会被项目树吃光, keymap 一个节点都进不来。
/// 没有对话框时退回主窗, 和以前一样。
pub fn dump_windows(pid: u32, main: HWND) -> Vec<RawWindow> {
    let all = process_windows(pid);
    let front = unsafe { GetForegroundWindow() };
    let mut dialogs: Vec<RawWindow> = all
        .iter()
        .filter(|w| {
            if w.hwnd.0 == main.0 {
                return false;
            }
            let r = window_rect(w.hwnd);
            let (wd, ht) = (r.right - r.left, r.bottom - r.top);
            if wd < 80 || ht < 80 {
                return false;
            }
            /* 属主对话框要有标题才算 (记事本查找、IDEA 设置)。
             * WPS/Qt 会挂一堆没标题的 QWidget  overlay, 把它们当对话框
             * 会把 snapshot 从主窗抢走, 截图还是黑的。
             * Swing 轻量弹层 (SunAwtWindow) 经常没标题, 仍要扫。 */
            let sun = w.class.to_ascii_lowercase().contains("sunawt");
            is_owned_by(w.hwnd, main) && (!w.title.trim().is_empty() || sun)
        })
        .cloned()
        .collect();
    if !dialogs.is_empty() {
        dialogs.sort_by(|a, b| {
            let af = a.hwnd.0 == front.0;
            let bf = b.hwnd.0 == front.0;
            match (af, bf) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => window_area(b.hwnd).cmp(&window_area(a.hwnd)),
            }
        });
        return dialogs;
    }
    all.into_iter()
        .find(|w| w.hwnd.0 == main.0)
        .into_iter()
        .collect()
}

/// 把目标换成"现在该扫的那扇窗": 设置/查找开着就是对话框, 否则仍是主窗。
pub fn with_dialog(mut app: WinApp) -> WinApp {
    if app.hwnd.0.is_null() {
        return app;
    }
    if let Some(w) = dump_windows(app.pid, app.hwnd).into_iter().next() {
        app.hwnd = w.hwnd;
        app.title = w.title;
    }
    app
}

pub fn window_text(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len + 2) as usize];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

pub fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

pub fn window_rect(hwnd: HWND) -> RECT {
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    r
}

/// 进程可执行文件的完整路径。拿不到 (权限/进程已退) 返回空串。
pub fn process_path(pid: u32) -> String {
    unsafe {
        let h = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(h);
        if r.is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

/// 路径 → 进程名 (不含扩展名, 小写)。`C:\Windows\System32\notepad.exe` → `notepad`
pub fn exe_stem(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let stem = file.strip_suffix(".exe").unwrap_or(file);
    stem.to_ascii_lowercase()
}

/// 产品名 / 常见叫法 → 进程 stem。
///
/// 模型说「IntelliJ IDEA」, 任务管理器里是 idea64.exe, 窗口标题又是
/// 「项目 – 文件」不含产品名。不归一化, dump 直接 `app_not_found`。
/// 只收公认别名, 不按菜单配方绑动作。
pub fn canonical_app_stem(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    let n = n.strip_suffix(".exe").unwrap_or(n.as_str()).trim();
    if n == "idea" || n == "idea64" || n.starts_with("intellij") {
        return "idea64".into();
    }
    if n == "studio64" || n.starts_with("android studio") {
        return "studio64".into();
    }
    if n == "pycharm64" || n == "pycharm" || n.starts_with("pycharm ") {
        return "pycharm64".into();
    }
    if n == "webstorm" || n == "webstorm64" {
        return "webstorm64".into();
    }
    if n == "goland" || n == "goland64" {
        return "goland64".into();
    }
    if n == "clion" || n == "clion64" {
        return "clion64".into();
    }
    if n == "datagrip" || n == "datagrip64" {
        return "datagrip64".into();
    }
    if n == "phpstorm" || n == "phpstorm64" {
        return "phpstorm64".into();
    }
    if n == "rider" || n == "rider64" {
        return "rider64".into();
    }
    if n == "rubymine" || n == "rubymine64" {
        return "rubymine64".into();
    }
    if n == "notepad++" || n == "notepadpp" || n == "notepad plus plus" {
        return "notepad++".into();
    }
    if n == "wpp"
        || n == "wps presentation"
        || n.contains("wps 演示")
        || n.contains("wps演示")
        || n == "金山演示"
    {
        return "wpp".into();
    }
    if n == "et" || n == "wps et" {
        return "et".into();
    }
    if n == "wps" || n == "wpsoffice" || n == "kingsoft" || n == "wps office" {
        return "wps".into();
    }
    n.to_string()
}

/// Chromium/Electron 顶层窗的 class。主窗和表情/@ 弹层都是这个, 要用几何区分。
pub fn is_chromium_class(class: &str) -> bool {
    let c = class.to_ascii_lowercase();
    c.contains("chrome_widgetwin") || c.contains("chrome_renderwidgethosthwnd")
}

/// 弹层比主窗小一半以上, 才不会把整窗遮罩 / DevTools 当成表情面板。
pub fn is_chromium_flyout_geom(main_w: i32, main_h: i32, w: i32, h: i32) -> bool {
    if w < 48 || h < 48 {
        return false;
    }
    let main_area = (main_w.max(1) as i64) * (main_h.max(1) as i64);
    let area = (w as i64) * (h as i64);
    area * 2 < main_area
}

/// Chromium 无标题弹层 (表情面板、@ 提及)。**不**当 dump 主目标 —— 否则截图被抢走,
/// WPS 那种没标题的整窗 overlay 也会误伤。只作为额外 UIA 根, 编号拼进主窗元素表。
pub fn chromium_flyouts(pid: u32, main: HWND) -> Vec<RawWindow> {
    if main.0.is_null() {
        return Vec::new();
    }
    let mr = window_rect(main);
    let mw = mr.right - mr.left;
    let mh = mr.bottom - mr.top;
    let mut out: Vec<RawWindow> = process_windows(pid)
        .into_iter()
        .filter(|w| {
            if w.hwnd.0 == main.0 {
                return false;
            }
            if !is_chromium_class(&w.class) {
                return false;
            }
            let r = window_rect(w.hwnd);
            if !is_chromium_flyout_geom(mw, mh, r.right - r.left, r.bottom - r.top) {
                return false;
            }
            is_owned_by(w.hwnd, main) || is_owned(w.hwnd)
        })
        .collect();
    if let Ok(popup) = unsafe { GetWindow(main, GW_ENABLEDPOPUP) } {
        if !popup.0.is_null() && popup.0 != main.0 {
            let r = window_rect(popup);
            if is_chromium_flyout_geom(mw, mh, r.right - r.left, r.bottom - r.top)
                && !out.iter().any(|w| w.hwnd.0 == popup.0)
            {
                out.push(RawWindow {
                    hwnd: popup,
                    pid,
                    title: window_text(popup),
                    class: window_class(popup),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_app_stem, is_chromium_class, is_chromium_flyout_geom, office_window_rank,
        skip_slow_ax_probe,
    };

    #[test]
    fn idea_product_name_maps_to_idea64() {
        for n in [
            "IntelliJ IDEA",
            "intellij",
            "idea",
            "idea64.exe",
            "IDEA",
            "IntelliJ IDEA Community Edition",
        ] {
            assert_eq!(canonical_app_stem(n), "idea64", "{n}");
        }
    }

    #[test]
    fn unknown_names_keep_stem() {
        assert_eq!(canonical_app_stem("notepad.exe"), "notepad");
        assert_eq!(canonical_app_stem("Google Chrome"), "google chrome");
        assert_eq!(canonical_app_stem("qq"), "qq");
        assert_eq!(canonical_app_stem("wps"), "wps");
        assert_eq!(canonical_app_stem("wpp"), "wpp");
    }

    #[test]
    fn office_launcher_ranks_below_presentation() {
        assert_eq!(office_window_rank("WPS - WPS 2019"), 0);
        assert_eq!(office_window_rank("WPS 2019"), 0);
        assert_eq!(office_window_rank("WPS Office"), 0);
        assert_eq!(office_window_rank("演示文稿1 - WPS 2019"), 4);
        assert!(office_window_rank("neox.docx - WPS 2019") > office_window_rank("WPS - WPS 2019"));
    }

    #[test]
    fn wps_presentation_alias_maps_to_wpp() {
        for n in ["wpp", "wpp.exe", "WPS Presentation", "WPS 演示", "WPS 演示文稿"] {
            assert_eq!(canonical_app_stem(n), "wpp", "{n}");
        }
    }

    #[test]
    fn wps_family_skips_slow_empty_ax() {
        for stem in ["wps", "wpp", "et", "wpspdf", "wpsoffice"] {
            assert!(skip_slow_ax_probe(stem), "{stem}");
        }
        assert!(!skip_slow_ax_probe("idea64"));
        assert!(!skip_slow_ax_probe("qq"));
    }

    #[test]
    fn chromium_emoji_panel_is_flyout_not_main() {
        assert!(is_chromium_class("Chrome_WidgetWin_1"));
        assert!(is_chromium_class("Chrome_RenderWidgetHostHWND"));
        assert!(!is_chromium_class("QWidget"));
        assert!(is_chromium_flyout_geom(1400, 740, 320, 400));
        assert!(!is_chromium_flyout_geom(1400, 740, 1400, 740));
        assert!(!is_chromium_flyout_geom(1400, 740, 20, 20));
    }
}

/// 一个进程的"主窗口": 可见顶层窗口里面积最大的那个。
fn main_window_of(pid: u32, windows: &[RawWindow]) -> Option<RawWindow> {
    let mut best: Option<(&RawWindow, i64)> = None;
    for w in windows.iter().filter(|w| w.pid == pid) {
        let r = window_rect(w.hwnd);
        let area = ((r.right - r.left) as i64) * ((r.bottom - r.top) as i64);
        if best.map_or(true, |(_, a)| area > a) {
            best = Some((w, area));
        }
    }
    best.map(|(w, _)| w.clone())
}

fn office_family(stem: &str) -> bool {
    matches!(stem, "wps" | "wpp" | "et" | "wpspdf" | "wpsoffice")
}

/// WPS/Office 自绘窗: UIA 永远空。dump 里 500ms 重试和 JAB 只会把每次感知拖慢半秒以上。
pub fn skip_slow_ax_probe(stem: &str) -> bool {
    office_family(stem)
}

/// 办公套件多窗时优先真正的文档, 不要停在启动页「WPS - WPS 2019」。
pub fn office_window_rank(title: &str) -> u8 {
    let t = title.to_ascii_lowercase();
    if t.contains("演示") || t.contains(".ppt") || t.contains("slideshow") {
        return 4;
    }
    if t.contains("工作簿") || t.contains(".xls") {
        return 4;
    }
    if t.contains(".doc") || t.contains(".wps") {
        return 3;
    }
    if t.contains("文档") && t.contains("wps") {
        return 3;
    }
    if t.contains(".pdf") {
        return 3;
    }
    if t == "wps"
        || t == "wps 2019"
        || t == "wps office"
        || t.starts_with("wps -")
        || t.starts_with("wps office ")
        || (t.starts_with("wps ")
            && !t.contains('.')
            && !t.contains("演示")
            && !t.contains("文档")
            && !t.contains("工作簿")
            && !t.contains("ppt")
            && !t.contains("xls")
            && !t.contains("doc"))
    {
        return 0;
    }
    1
}

/// 列出所有在跑的、有窗口的应用。
///
/// **按窗口而不是 pid 去重**: WPS 文字和演示经常是两个 wps.exe, 也可能同进程两扇窗;
/// 只留一扇的话模型永远看不见「演示文稿1」。
pub fn list_apps() -> Vec<WinApp> {
    let windows = enum_windows();
    let front = unsafe { GetForegroundWindow() };
    windows
        .iter()
        .map(|w| {
            let exe_path = process_path(w.pid);
            WinApp {
                name: exe_stem(&exe_path),
                exe_path,
                pid: w.pid,
                hwnd: w.hwnd,
                title: w.title.clone(),
                frontmost: w.hwnd == front,
            }
        })
        .collect()
}

/// 同一套软件里、当前目标以外的可见窗 (WPS 文字 vs 演示)。
pub fn peer_windows(hwnd: HWND, stem: &str) -> Vec<WinApp> {
    let family = office_family(stem);
    list_apps()
        .into_iter()
        .filter(|a| a.hwnd != hwnd && (a.name == stem || (family && office_family(&a.name))))
        .collect()
}

/// 多个同名窗: 前台优先, 否则取 z-order 最前 (EnumWindows 顺序), 不要按面积 ——
/// Word 文档往往比 PPT 大, 按面积会控错窗。
fn pick_best_window<'a>(cands: &[&'a RawWindow], front: HWND) -> Option<&'a RawWindow> {
    if cands.is_empty() {
        return None;
    }
    let rank = |w: &RawWindow| office_window_rank(&w.title);
    let best = cands.iter().copied().map(rank).max().unwrap_or(0);
    let pool: Vec<&RawWindow> = cands.iter().copied().filter(|w| rank(w) == best).collect();
    pool.iter()
        .copied()
        .find(|w| w.hwnd == front)
        .or(Some(pool[0]))
}

/// 按名字或 pid 找一个在跑的应用。
///
/// 匹配规则 (对应 mac 的 findApp):
///   · 给了 pid  → 只认 pid (进程没有窗口也返回, 由上层报 no_window)
///   · 给了名字  → **先标题** (同一套办公软件多个窗都叫 wps.exe, 只比进程名会控错窗)
///                再精确进程名 (多个命中取前台, 否则最大窗), 最后前缀模糊
/// 都匹配不上返回 None → 上层报 `app_not_found`。
pub fn find_app(name: Option<&str>, pid: Option<i32>) -> Option<WinApp> {
    let windows = enum_windows();
    let front = unsafe { GetForegroundWindow() };
    let make = |w: &RawWindow| -> WinApp {
        let exe_path = process_path(w.pid);
        WinApp {
            name: exe_stem(&exe_path),
            exe_path,
            pid: w.pid,
            hwnd: w.hwnd,
            title: w.title.clone(),
            frontmost: w.hwnd == front,
        }
    };

    if let Some(p) = pid {
        let p = p as u32;
        match main_window_of(p, &windows) {
            Some(w) => return Some(make(&w)),
            None => {
                /* 没有可见窗口但进程还在: 仍然返回它, 让上层报 no_window (跟 mac 一致) */
                let exe_path = process_path(p);
                if exe_path.is_empty() {
                    return None;
                }
                return Some(WinApp {
                    name: exe_stem(&exe_path),
                    exe_path,
                    pid: p,
                    hwnd: HWND(std::ptr::null_mut()),
                    title: String::new(),
                    frontmost: false,
                });
            }
        }
    }

    let want = name?.trim().to_ascii_lowercase();
    if want.is_empty() {
        return None;
    }
    let want_stem = canonical_app_stem(&want);

    /* ① 窗口标题精确。命中启动页时, 若同套软件已经有文档窗, 改控文档. */
    if let Some(w) = windows.iter().find(|w| w.title.to_lowercase() == want) {
        if office_window_rank(&w.title) == 0 {
            let family = office_family(&exe_stem(&process_path(w.pid)));
            let docs: Vec<&RawWindow> = windows
                .iter()
                .filter(|o| {
                    office_window_rank(&o.title) > 0
                        && (o.pid == w.pid
                            || (family && office_family(&exe_stem(&process_path(o.pid)))))
                })
                .collect();
            if let Some(better) = pick_best_window(&docs, front) {
                return Some(make(better));
            }
        }
        return Some(make(w));
    }
    /* ② 标题包含 —— 必须在进程名之前. 「演示文稿1 - WPS 2019」若先按 wps.exe
     *    会命中文字文档那扇更大的窗. */
    if want.chars().count() >= 2 {
        let hits: Vec<&RawWindow> = windows
            .iter()
            .filter(|w| w.title.to_lowercase().contains(&want))
            .collect();
        if let Some(w) = pick_best_window(&hits, front) {
            return Some(make(w));
        }
    }
    /* ③ 演示文稿: 启动器是 wpp.exe (常常没标题), 真正的窗在 wps.exe 上且标题带「演示」 */
    if want_stem == "wpp" || want.contains("演示") || want.contains("presentation") || want.contains(".ppt") {
        let ppt: Vec<&RawWindow> = windows
            .iter()
            .filter(|w| {
                let t = w.title.to_lowercase();
                t.contains("演示") || t.contains(".ppt") || t.contains("slideshow")
            })
            .collect();
        if let Some(w) = pick_best_window(&ppt, front) {
            return Some(make(w));
        }
    }
    if want_stem == "et" || want.contains("工作簿") || want.contains(".xls") {
        let sheets: Vec<&RawWindow> = windows
            .iter()
            .filter(|w| {
                let t = w.title.to_lowercase();
                t.contains("工作簿") || t.contains(".xls")
            })
            .collect();
        if let Some(w) = pick_best_window(&sheets, front) {
            return Some(make(w));
        }
    }

    /* ④a wpp /「WPS 演示」: 不要把 Word 文档 (rank 3) 当成演示窗 */
    if want_stem == "wpp" {
        let wpp_exe: Vec<&RawWindow> = windows
            .iter()
            .filter(|w| exe_stem(&process_path(w.pid)) == "wpp")
            .collect();
        if let Some(w) = pick_best_window(&wpp_exe, front) {
            return Some(make(w));
        }
        let homes: Vec<&RawWindow> = windows
            .iter()
            .filter(|w| {
                office_family(&exe_stem(&process_path(w.pid))) && office_window_rank(&w.title) == 0
            })
            .collect();
        if let Some(w) = pick_best_window(&homes, front) {
            return Some(make(w));
        }
    }

    let mut pids: Vec<u32> = windows.iter().map(|w| w.pid).collect();
    pids.sort_unstable();
    pids.dedup();

    /* ④ 进程名精确 —— 办公套件按家族匹配; 多个窗取前台 / z-order, 不取最大面积 */
    let family = office_family(&want_stem);
    let stem_wins: Vec<&RawWindow> = windows
        .iter()
        .filter(|w| {
            let s = exe_stem(&process_path(w.pid));
            s == want_stem || (family && office_family(&s))
        })
        .collect();
    if let Some(w) = pick_best_window(&stem_wins, front) {
        return Some(make(w));
    }
    /* ⑤ 进程名前缀 */
    for p in &pids {
        let path = process_path(*p);
        let stem = exe_stem(&path);
        if stem.is_empty() {
            continue;
        }
        if stem.starts_with(&want_stem) && !stem.contains("helper") && !stem.contains("crashpad") {
            if let Some(w) = main_window_of(*p, &windows) {
                return Some(make(&w));
            }
        }
    }
    None
}

/// 当前前台应用。
pub fn foreground_app() -> Option<WinApp> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    let exe_path = process_path(pid);
    Some(WinApp {
        name: exe_stem(&exe_path),
        exe_path,
        pid,
        hwnd,
        title: window_text(hwnd),
        frontmost: true,
    })
}

/// 把一个窗口抢到前台, **并在整个会话期间保持线程附着** —— 输入类动作用它。
///
/// ─── 为什么要"保持附着"而不是"设完就摘" ────────────────────────────────────
/// 第一版是 attach → SetForegroundWindow → detach, 结果实测: 键入 9 个字符,
/// 记事本里只多了 2 个, 而且是最前面那 2 个 —— 摘下附着之后, 输入队列的前台
/// 归属被还回去了, 后到的键又落到原来的窗口上。症状离真因非常远
/// (回执说"写了 9 个字符", 界面只多了 2 个)。
///
/// 所以: 附着 → 设前台 → **保持附着发完输入** → Drop 时摘。
pub struct ForegroundSession {
    attached: bool,
    fg_thread: u32,
    cur_thread: u32,
    hwnd: HWND,
    /// 结束时它到底有没有在前台。抢不到要如实说, 不能假装成功。
    pub ok: bool,
}

impl ForegroundSession {
    pub fn begin(hwnd: HWND) -> Self {
        if hwnd.0.is_null() {
            return Self { attached: false, fg_thread: 0, cur_thread: 0, hwnd, ok: false };
        }
        unsafe {
            let cur_thread = GetCurrentThreadId();
            raise_window(hwnd);

            /* 先试**不附着**的正路: 能成就不碰输入队列 (附着本身就是副作用)。 */
            let mut ok = assert_foreground(hwnd);
            let mut attached = false;
            let mut fg_thread = 0;

            if !ok {
                /* 抢不到 (后台进程的常见处境: SetForegroundWindow 有前台锁)。
                 * 附着自己线程到当前前台线程的输入队列上, 再抢一次就有了。
                 * 附着**保持到这次输入发完** —— 中途摘掉会把前台归属还回去,
                 * 后到的键又落到原来的窗口上 (实测: 9 个字只进去 2 个)。 */
                let fg = GetForegroundWindow();
                let mut fg_pid: u32 = 0;
                fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, Some(&mut fg_pid)) };
                attached = fg_thread != 0
                    && fg_thread != cur_thread
                    && AttachThreadInput(cur_thread, fg_thread, true).as_bool();
                raise_window(hwnd);
                ok = assert_foreground(hwnd);
            }

            /* ⚠️ **必须**再 SetFocus 到目标窗口, 而且这一步不能省。
             *
             * 「前台窗口」和「焦点窗口」在 Windows 上是两个东西: 键盘事件发给
             * **前台线程的焦点窗口**。后台进程把前台抢过来之后, 目标线程那边
             * 可能压根没有焦点窗口 —— 于是前台明明是我们的, 键发出去静默消失。
             * 实测 (A/B 对照): 有这一行, 连发 3 批 ('A' / 'BC' / 'DEFGHI') 一个不丢;
             * 去掉它, 同样的调用一个字都进不去, 而回执里 fgOk/fgBeforeSend 全是 true
             * —— 这种"所有断言都说成功、界面就是不动"最费时间, 所以把结论写在这。 */
            let _ = SetFocus(Some(hwnd));
            ok = GetForegroundWindow() == hwnd;

            Self { attached, fg_thread, cur_thread, hwnd, ok }
        }
    }

    /// 抢到前台之后等一小会儿 —— SetForegroundWindow 是**异步**的
    /// (WM_ACTIVATE 是投递的): 立刻发键的话前几个字符会丢。
    pub fn settle(&self) {
        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    /// 发输入**之前**再确认一次前台还在自己手上。
    ///
    /// 实测: 从别的进程抢来前台之后, 前台可能在发输入前的那几十毫秒里被还回去
    /// (用户点了别处、控制台窗口把自己弹上来…), 那时键就发到别处去了。所以
    /// 不是"设完就算", 而是"发之前再确认一次, 并把结果如实回给上层"。
    pub fn assert_now(&self) -> bool {
        assert_foreground(self.hwnd)
    }
}

/// 脚本级前台占用: computer_run 整段期间保持附着, 避免每一步 Drop 后 WPS 主页把演示窗压回去。
static HOLD_ACTIVE: AtomicBool = AtomicBool::new(false);

thread_local! {
    static FG_HOLD: RefCell<Option<ForegroundSession>> = const { RefCell::new(None) };
}

fn hwnd_eq(a: HWND, b: HWND) -> bool {
    a.0 == b.0
}

/// 一步输入用的前台守卫。脚本占用已存在时**不**再新建会话, 否则内层 Drop 会把附着摘掉。
pub struct FrontGuard {
    _owned: Option<ForegroundSession>,
    hwnd: HWND,
    pub ok: bool,
}

impl FrontGuard {
    pub fn acquire(hwnd: HWND) -> Self {
        if hwnd.0.is_null() {
            return Self { _owned: None, hwnd, ok: false };
        }
        if HOLD_ACTIVE.load(Ordering::SeqCst) {
            return FG_HOLD.with(|slot| {
                let mut g = slot.borrow_mut();
                let reuse = matches!(g.as_ref(), Some(fg) if hwnd_eq(fg.hwnd, hwnd));
                if !reuse {
                    *g = None;
                    let session = ForegroundSession::begin(hwnd);
                    session.settle();
                    let ok = session.ok;
                    *g = Some(session);
                    return Self { _owned: None, hwnd, ok };
                }
                let ok = match g.as_ref() {
                    Some(fg) if fg.assert_now() => true,
                    _ => {
                        raise_window(hwnd);
                        g.as_ref().map(|fg| fg.assert_now()).unwrap_or(false)
                    }
                };
                Self { _owned: None, hwnd, ok }
            });
        }
        let session = ForegroundSession::begin(hwnd);
        session.settle();
        let ok = session.ok;
        Self { _owned: Some(session), hwnd, ok }
    }

    pub fn assert_now(&self) -> bool {
        assert_foreground(self.hwnd)
    }
}

pub fn hold_foreground(app: Option<&str>, pid: Option<i32>) {
    HOLD_ACTIVE.store(true, Ordering::SeqCst);
    let Some(t) = find_app(app, pid)
        .map(with_dialog)
        .or_else(|| foreground_app().map(with_dialog))
    else {
        return;
    };
    if t.hwnd.0.is_null() {
        return;
    }
    let _ = FrontGuard::acquire(t.hwnd);
}

pub fn release_foreground() {
    HOLD_ACTIVE.store(false, Ordering::SeqCst);
    FG_HOLD.with(|slot| {
        slot.borrow_mut().take();
    });
}

/// 把窗口抬到同级最前。TOPMOST 闪一下再撤回: 只 SetForegroundWindow 时,
/// WPS 主页仍盖着演示窗, click_at 的屏幕坐标会点到主页上.
pub fn raise_window(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = AllowSetForegroundWindow(u32::MAX);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_NOTOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

fn root_at_point(x: i32, y: i32) -> HWND {
    unsafe {
        let hit = WindowFromPoint(POINT { x, y });
        if hit.0.is_null() {
            return hit;
        }
        let root = GetAncestor(hit, GA_ROOT);
        if root.0.is_null() { hit } else { root }
    }
}

fn is_overlay_hwnd(hwnd: HWND) -> bool {
    window_text(hwnd).contains("neox-computer-overlay")
}

/// 这一点的屏幕像素是不是目标窗 (或它的属主对话框 / 操控遮罩).
pub fn point_reaches_window(hwnd: HWND, x: i32, y: i32) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let hit = root_at_point(x, y);
    if hit.0.is_null() {
        return false;
    }
    hit.0 == hwnd.0 || is_owned_by(hit, hwnd) || is_overlay_hwnd(hit)
}

/// 挡住目标窗的那扇窗的标题。没有挡住返回 None.
pub fn covering_title(hwnd: HWND, x: i32, y: i32) -> Option<String> {
    let hit = root_at_point(x, y);
    if hit.0.is_null() || hit.0 == hwnd.0 || is_owned_by(hit, hwnd) || is_overlay_hwnd(hit) {
        return None;
    }
    let t = window_text(hit);
    if t.is_empty() { Some("(无标题窗)".into()) } else { Some(t) }
}

/// 把窗口设成前台并**当场核对**结果。
pub fn assert_foreground(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    unsafe {
        if GetForegroundWindow() == hwnd {
            return true;
        }
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        GetForegroundWindow() == hwnd
    }
}

impl Drop for ForegroundSession {
    fn drop(&mut self) {
        if self.attached {
            unsafe {
                let _ = AttachThreadInput(self.cur_thread, self.fg_thread, false);
            }
        }
    }
}

/// 一次性抢前台 (不需要随后发输入的场景, 例如 launch 的"切到它")。
pub fn force_foreground(hwnd: HWND) -> bool {
    FrontGuard::acquire(hwnd).ok
}

/// 兼容旧名字: 不关心结果的地方 (例如 launch 的"切过去") 用它。
pub fn bring_to_front(hwnd: HWND) {
    let _ = force_foreground(hwnd);
}

/// 本进程 pid —— Guard 用: "别操作 Neox 自己" 里也包含"别操作桥自己"。
pub fn self_pid() -> u32 {
    std::process::id()
}
