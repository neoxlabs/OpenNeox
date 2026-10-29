//! Java Access Bridge —— Swing/AWT 的结构化树, 跟 UIA 同一套编号语义。
//!
//! Windows UI Automation 看见的 Java 窗往往只有标题栏四个按钮 (uia.rs 的 is_chrome
//! 就是为这个写的)。真正的控件树在 JVM 里, 经 **Java Access Bridge** 出来:
//! 本进程加载目标 JRE 的 `windowsaccessbridge-64.dll`, JVM 里那份
//! `javaaccessbridge.dll` 把 AccessibleContext 递过来。
//!
//! 不抄 OpenJDK 的 AccessBridgeCalls.c (那份是 GPL/BSD 混着的包装层)。我们只按
//! 公开 ABI GetProcAddress, 结构体尺寸来自 Oracle JAB 文档
//! (MAX_STRING_SIZE=1024 / SHORT_STRING_SIZE=256 wchar)。
//!
//! 两条必须写进代码的约束:
//!   1. 所有 JAB 调用必须发生在调用过 `Windows_run` 的那条线程, 而且那条线程要
//!      泵窗口消息 —— JAB 靠隐藏窗 + WM_COPYDATA 跟 JVM 说话, 主循环的阻塞
//!      stdin 读做不了这件事, 所以这里是独立工作线程。
//!   2. DLL 必须跟**目标 JVM** 同一套 JBR/JRE。本机 JAVA_HOME 是 JDK 8, IDEA 是
//!      JBR 21, 拿错 DLL 结构体会对不上。永远先从目标进程的 java.dll 旁边找。

use crate::uia::Row;
use crate::winapp;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use windows::core::{BOOL, PCSTR, PCWSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::ProcessStatus::{EnumProcessModules, GetModuleFileNameExW};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

const MAX_STRING: usize = 1024;
const SHORT_STRING: usize = 256;
const MAX_ACTION_INFO: usize = 256;
const MAX_ACTIONS_TO_DO: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct Handle {
    pub vm_id: i32,
    pub ac: i64,
}

pub struct Collected {
    pub row: Row,
    pub el: Handle,
}

pub struct Dump {
    pub items: Vec<Collected>,
    pub visited: usize,
    pub status: Status,
}

#[derive(Clone, Debug)]
pub enum Status {
    Ok,
    NotJava,
    /// 窗口是 Java 的, 但树是空的 —— 典型: IDEA 没开 Support screen readers,
    /// JVM 把 AccessibleContext 优化掉了。
    NoTree { reason: String },
    DllMissing { tried: String },
    InitFailed { error: String },
}

#[derive(Clone)]
pub struct Session {
    tx: mpsc::Sender<Job>,
}

struct Job {
    call: Call,
    reply: mpsc::Sender<Outcome>,
}

enum Call {
    IsJava(isize),
    Dump { hwnd: isize, win: RECT, budget: usize },
    DumpAt { parent: isize, x: i32, y: i32, win: RECT, budget: usize },
    Signature { hwnd: isize, win: RECT, budget: usize },
    Info(Handle),
    Press(Handle),
    SetValue { h: Handle, text: String },
    Focus(Handle),
    Read(Handle),
    Release(Vec<Handle>),
}

enum Outcome {
    Flag(bool),
    Dump(Dump),
    Sig { texts: Vec<String>, counts: Vec<(String, usize)> },
    Info(Option<LiveInfo>),
    Ok(bool),
    Text(Option<String>),
    Unit,
    Timeout,
}

struct LiveInfo {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    value: Option<String>,
    focused: bool,
}

#[repr(C)]
struct AccessibleContextInfo {
    name: [u16; MAX_STRING],
    description: [u16; MAX_STRING],
    role: [u16; SHORT_STRING],
    role_en_us: [u16; SHORT_STRING],
    states: [u16; SHORT_STRING],
    states_en_us: [u16; SHORT_STRING],
    index_in_parent: i32,
    children_count: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    accessible_component: i32,
    accessible_action: i32,
    accessible_selection: i32,
    accessible_text: i32,
    accessible_interfaces: i32,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct AccessibleActionInfo {
    name: [u16; SHORT_STRING],
}

#[repr(C)]
struct AccessibleActions {
    actions_count: i32,
    action_info: [AccessibleActionInfo; MAX_ACTION_INFO],
}

#[repr(C)]
struct AccessibleActionsToDo {
    actions_count: i32,
    actions: [AccessibleActionInfo; MAX_ACTIONS_TO_DO],
}

type FnWindowsRun = unsafe extern "system" fn();
type FnIsJavaWindow = unsafe extern "system" fn(HWND) -> BOOL;
type FnFromHwnd = unsafe extern "system" fn(HWND, *mut i32, *mut i64) -> BOOL;
type FnFromFocus = unsafe extern "system" fn(HWND, *mut i32, *mut i64) -> BOOL;
type FnFromAt = unsafe extern "system" fn(i32, i64, i32, i32, *mut i64) -> BOOL;
type FnContextInfo = unsafe extern "system" fn(i32, i64, *mut AccessibleContextInfo) -> BOOL;
type FnChild = unsafe extern "system" fn(i32, i64, i32) -> i64;
type FnRelease = unsafe extern "system" fn(i32, i64);
type FnGetActions = unsafe extern "system" fn(i32, i64, *mut AccessibleActions) -> BOOL;
type FnDoActions = unsafe extern "system" fn(i32, i64, *mut AccessibleActionsToDo, *mut i32) -> BOOL;
type FnSetText = unsafe extern "system" fn(i32, i64, *const u16) -> BOOL;
type FnFocus = unsafe extern "system" fn(i32, i64) -> BOOL;
type FnValue = unsafe extern "system" fn(i32, i64, *mut u16, i16) -> BOOL;

struct Api {
    _module: windows::Win32::Foundation::HMODULE,
    windows_run: FnWindowsRun,
    is_java_window: FnIsJavaWindow,
    from_hwnd: FnFromHwnd,
    from_focus: Option<FnFromFocus>,
    from_at: Option<FnFromAt>,
    context_info: FnContextInfo,
    child: FnChild,
    release: FnRelease,
    get_actions: Option<FnGetActions>,
    do_actions: Option<FnDoActions>,
    set_text: Option<FnSetText>,
    request_focus: Option<FnFocus>,
    get_value: Option<FnValue>,
}

impl Session {
    /// 按目标进程找 DLL 并拉起工作线程。失败原因给上层写进 dump.note。
    pub fn start(pid: u32, exe_path: &str) -> Result<Self, String> {
        let dll = find_bridge_dll(pid, exe_path).ok_or_else(|| {
            format!(
                "找不到目标 JVM 的 windowsaccessbridge-64.dll (pid {pid})。IDEA/JBR 应在 jbr\\bin 下。"
            )
        })?;
        let (tx, rx) = mpsc::channel::<Job>();
        let dll_for_thread = dll.clone();
        std::thread::Builder::new()
            .name("neox-jab".into())
            .spawn(move || worker(dll_for_thread, rx))
            .map_err(|e| format!("JAB 工作线程拉不起来: {e}"))?;
        Ok(Self { tx })
    }

    fn call(&self, call: Call, timeout: Duration) -> Outcome {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Job { call, reply: tx }).is_err() {
            return Outcome::Timeout;
        }
        rx.recv_timeout(timeout).unwrap_or(Outcome::Timeout)
    }

    pub fn is_java_window(&self, hwnd: HWND) -> bool {
        match self.call(Call::IsJava(hwnd_to_isize(hwnd)), Duration::from_secs(3)) {
            Outcome::Flag(v) => v,
            _ => false,
        }
    }

    pub fn dump(&self, hwnd: HWND, win: RECT, budget: usize) -> Dump {
        /* IDEA 主窗实测 ~12s 才吐出完整树; 4s 会把一次成功的 dump 判超时,
         * 再把 HWND 加进 jab_skip, 后面全改走截图。弹层已在 hwnd_safe_to_attach
         * 跳过, 这里等的是主窗。 */
        match self.call(
            Call::Dump { hwnd: hwnd_to_isize(hwnd), win, budget },
            Duration::from_secs(12),
        ) {
            Outcome::Dump(d) => d,
            Outcome::Timeout => Dump {
                items: Vec::new(),
                visited: 0,
                status: Status::InitFailed { error: "JAB dump 超时 (12s)".into() },
            },
            _ => Dump {
                items: Vec::new(),
                visited: 0,
                status: Status::InitFailed { error: "JAB dump 回了未知结果".into() },
            },
        }
    }

    /// 对话框 HWND 还没登记进 Access Bridge 时: 从主窗根出发, 按屏幕坐标取那一棵子树。
    pub fn dump_at(&self, parent: HWND, x: i32, y: i32, win: RECT, budget: usize) -> Dump {
        match self.call(
            Call::DumpAt { parent: hwnd_to_isize(parent), x, y, win, budget },
            Duration::from_secs(4),
        ) {
            Outcome::Dump(d) => d,
            Outcome::Timeout => Dump {
                items: Vec::new(),
                visited: 0,
                status: Status::InitFailed { error: "JAB dump_at 超时 (4s)".into() },
            },
            _ => Dump {
                items: Vec::new(),
                visited: 0,
                status: Status::InitFailed { error: "JAB dump_at 回了未知结果".into() },
            },
        }
    }

    pub fn signature(&self, hwnd: HWND, win: RECT, budget: usize) -> Option<(Vec<String>, Vec<(String, usize)>)> {
        match self.call(
            Call::Signature { hwnd: hwnd_to_isize(hwnd), win, budget },
            Duration::from_secs(4),
        ) {
            Outcome::Sig { texts, counts } => Some((texts, counts)),
            _ => None,
        }
    }

    pub fn live_rect(&self, h: Handle) -> Option<RECT> {
        match self.call(Call::Info(h), Duration::from_secs(2)) {
            Outcome::Info(Some(i)) if i.w > 0 && i.h > 0 => Some(RECT {
                left: i.x,
                top: i.y,
                right: i.x + i.w,
                bottom: i.y + i.h,
            }),
            _ => None,
        }
    }

    pub fn is_alive(&self, h: Handle) -> bool {
        matches!(self.call(Call::Info(h), Duration::from_secs(2)), Outcome::Info(Some(_)))
    }

    pub fn press(&self, h: Handle) -> bool {
        matches!(self.call(Call::Press(h), Duration::from_millis(600)), Outcome::Ok(true))
    }

    pub fn set_value(&self, h: Handle, text: &str) -> bool {
        matches!(
            self.call(Call::SetValue { h, text: text.to_string() }, Duration::from_secs(4)),
            Outcome::Ok(true)
        )
    }

    pub fn focus(&self, h: Handle) -> bool {
        matches!(self.call(Call::Focus(h), Duration::from_secs(2)), Outcome::Ok(true))
    }

    pub fn read(&self, h: Handle) -> Option<String> {
        match self.call(Call::Read(h), Duration::from_secs(2)) {
            Outcome::Text(v) => v,
            Outcome::Info(Some(i)) => i.value,
            _ => None,
        }
    }

    pub fn has_focus(&self, h: Handle) -> bool {
        match self.call(Call::Info(h), Duration::from_secs(2)) {
            Outcome::Info(Some(i)) => i.focused,
            _ => false,
        }
    }

    pub fn release_all(&self, hs: &[Handle]) {
        if hs.is_empty() {
            return;
        }
        let _ = self.call(Call::Release(hs.to_vec()), Duration::from_secs(3));
    }
}

/// 窗口类名 / 路径像不像 Java。不调用 JAB, 用来决定要不要付 DLL 初始化的钱。
pub fn looks_like_java(hwnd: HWND, exe_path: &str) -> bool {
    let class = winapp::window_class(hwnd).to_ascii_lowercase();
    if class.contains("sunawt") || class.contains("javax.swing") || class.contains("glasswnd") {
        return true;
    }
    let p = exe_path.to_ascii_lowercase();
    p.contains("jetbrains")
        || p.contains("idea64")
        || p.contains("pycharm")
        || p.contains("goland")
        || p.contains("webstorm")
        || p.contains("clion")
        || p.contains("datagrip")
        || p.contains("rider64")
        || p.contains("studio64")
        || p.contains(r"\jbr\")
}

/// 能不能对这个 HWND 调 JAB。
///
/// `SunAwtDialog` 是 Swing 模态窗 (各家 Java 应用的 Settings / About / 打开文件)。
/// 对它调 `getAccessibleContextFromHWND` 会卡在嵌套 EDT 里, 整座桥的 JAB 线程
/// 一起死 —— 不是某一个产品的特殊路径, 是 Access Bridge 跟模态窗的通用冲突。
///
/// 属主 `SunAwtWindow` 是菜单 / 弹出列表 / 浮动提示。对它 fromHWND 同样会卡
/// 30s+, 而 stdin 侧已经超时并继续排队, 整座 JAB 线程堵死。主窗是
/// `SunAwtFrame`, 不走这条。弹层改走 axBlind + 截图 + click_at。
pub fn hwnd_safe_to_attach(hwnd: HWND) -> bool {
    let class = winapp::window_class(hwnd).to_ascii_lowercase();
    if class.contains("sunawtdialog") {
        return false;
    }
    if class.contains("sunawtwindow") && winapp::is_owned(hwnd) {
        return false;
    }
    true
}

fn hwnd_to_isize(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

fn isize_to_hwnd(v: isize) -> HWND {
    HWND(v as *mut core::ffi::c_void)
}

fn find_bridge_dll(pid: u32, exe_path: &str) -> Option<PathBuf> {
    if let Some(p) = dll_from_modules(pid) {
        return Some(p);
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if !exe_path.is_empty() {
        if let Some(dir) = Path::new(exe_path).parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("jbr").join("bin"));
            if let Some(root) = dir.parent() {
                dirs.push(root.join("jbr").join("bin"));
                dirs.push(root.join("jre64").join("bin"));
                dirs.push(root.join("jre").join("bin"));
            }
        }
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        dirs.push(PathBuf::from(&home).join("bin"));
        dirs.push(PathBuf::from(&home).join("jre").join("bin"));
    }
    dirs.push(PathBuf::from(r"C:\Windows\System32"));
    for d in dirs {
        for name in ["windowsaccessbridge-64.dll", "WindowsAccessBridge-64.dll"] {
            let p = d.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn dll_from_modules(pid: u32) -> Option<PathBuf> {
    unsafe {
        let proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut mods = [windows::Win32::Foundation::HMODULE::default(); 512];
        let mut needed = 0u32;
        let ok = EnumProcessModules(
            proc,
            mods.as_mut_ptr(),
            (std::mem::size_of_val(&mods)) as u32,
            &mut needed,
        );
        if ok.is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(proc);
            return None;
        }
        let n = (needed as usize / std::mem::size_of::<windows::Win32::Foundation::HMODULE>()).min(mods.len());
        let mut java_dir: Option<PathBuf> = None;
        for m in &mods[..n] {
            let mut buf = [0u16; 520];
            let len = GetModuleFileNameExW(Some(proc), Some(*m), &mut buf);
            if len == 0 {
                continue;
            }
            let path = PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]));
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            if name.contains("windowsaccessbridge") {
                let _ = windows::Win32::Foundation::CloseHandle(proc);
                return Some(path);
            }
            if name == "java.dll" || name == "jvm.dll" || name == "javaaccessbridge.dll" {
                if let Some(dir) = path.parent() {
                    java_dir = Some(dir.to_path_buf());
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(proc);
        if let Some(dir) = java_dir {
            for name in ["windowsaccessbridge-64.dll", "WindowsAccessBridge-64.dll"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }
}

fn load_api(dll: &Path) -> Result<Api, String> {
    let wide: Vec<u16> = dll.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let module = unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }.map_err(|e| {
        format!("LoadLibrary {} 失败: {e}", dll.display())
    })?;
    unsafe fn req<T>(module: windows::Win32::Foundation::HMODULE, name: &[u8]) -> Result<T, String> {
        let p = GetProcAddress(module, PCSTR(name.as_ptr())).ok_or_else(|| {
            format!("JAB DLL 缺导出 {}", String::from_utf8_lossy(name).trim_end_matches('\0'))
        })?;
        Ok(std::mem::transmute_copy(&p))
    }
    unsafe fn opt<T>(module: windows::Win32::Foundation::HMODULE, name: &[u8]) -> Option<T> {
        let p = GetProcAddress(module, PCSTR(name.as_ptr()))?;
        Some(std::mem::transmute_copy(&p))
    }
    unsafe {
        Ok(Api {
            _module: module,
            windows_run: req(module, b"Windows_run\0")?,
            is_java_window: req(module, b"isJavaWindow\0")?,
            from_hwnd: req(module, b"getAccessibleContextFromHWND\0")?,
            from_focus: opt(module, b"getAccessibleContextWithFocus\0"),
            from_at: opt(module, b"getAccessibleContextAt\0"),
            context_info: req(module, b"getAccessibleContextInfo\0")?,
            child: req(module, b"getAccessibleChildFromContext\0")?,
            release: req(module, b"releaseJavaObject\0")?,
            get_actions: opt(module, b"getAccessibleActions\0"),
            do_actions: opt(module, b"doAccessibleActions\0"),
            set_text: opt(module, b"setTextContents\0"),
            request_focus: opt(module, b"requestFocus\0"),
            get_value: opt(module, b"getCurrentAccessibleValueFromContext\0"),
        })
    }
}

fn pump() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn worker(dll: PathBuf, rx: mpsc::Receiver<Job>) {
    let api = match load_api(&dll) {
        Ok(a) => a,
        Err(_) => {
            /* 初始化失败: 把之后每条请求都答 InitFailed, 让上层把原因写进 dump */
            while let Ok(job) = rx.recv() {
                let _ = job.reply.send(Outcome::Dump(Dump {
                    items: Vec::new(),
                    visited: 0,
                    status: Status::DllMissing { tried: dll.display().to_string() },
                }));
            }
            return;
        }
    };
    unsafe { (api.windows_run)() };
    /* JVM 通过隐藏窗登记自己, 刚 Windows_run 完立刻 isJavaWindow 经常是 false */
    let warmup = std::time::Instant::now();
    while warmup.elapsed() < Duration::from_millis(400) {
        pump();
        std::thread::sleep(Duration::from_millis(20));
    }
    loop {
        pump();
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(job) => {
                pump();
                let out = dispatch(&api, job.call);
                let _ = job.reply.send(out);
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn dispatch(api: &Api, call: Call) -> Outcome {
    match call {
        Call::IsJava(hwnd) => {
            let v = unsafe { (api.is_java_window)(isize_to_hwnd(hwnd)) }.as_bool();
            Outcome::Flag(v)
        }
        Call::Dump { hwnd, win, budget } => {
            let h = isize_to_hwnd(hwnd);
            if !hwnd_safe_to_attach(h) {
                return Outcome::Dump(Dump {
                    items: Vec::new(),
                    visited: 0,
                    status: Status::NotJava,
                });
            }
            Outcome::Dump(collect(api, h, win, budget, true))
        }
        Call::DumpAt { parent, x, y, win, budget } => {
            Outcome::Dump(collect_at(api, isize_to_hwnd(parent), x, y, win, budget))
        }
        Call::Signature { hwnd, win, budget } => {
            let h = isize_to_hwnd(hwnd);
            if !hwnd_safe_to_attach(h) {
                return Outcome::Sig {
                    texts: Vec::new(),
                    counts: Vec::new(),
                };
            }
            let d = collect(api, h, win, budget, false);
            let mut texts = Vec::new();
            let mut counts: Vec<(String, usize)> = Vec::new();
            for it in &d.items {
                if !it.row.actionable && !it.row.label.is_empty() {
                    texts.push(it.row.label.clone());
                }
                if let Some((_, n)) = counts.iter_mut().find(|(k, _)| k == &it.row.role) {
                    *n += 1;
                } else {
                    counts.push((it.row.role.clone(), 1));
                }
            }
            /* signature 不持有句柄 —— 立刻放掉, 否则 JVM 全局引用泄漏 */
            for it in &d.items {
                unsafe { (api.release)(it.el.vm_id, it.el.ac) };
            }
            Outcome::Sig { texts, counts }
        }
        Call::Info(h) => Outcome::Info(live_info(api, h)),
        Call::Press(h) => Outcome::Ok(do_press(api, h)),
        Call::SetValue { h, text } => Outcome::Ok(do_set_text(api, h, &text)),
        Call::Focus(h) => Outcome::Ok(do_focus(api, h)),
        Call::Read(h) => Outcome::Text(live_info(api, h).and_then(|i| i.value)),
        Call::Release(hs) => {
            for h in hs {
                unsafe { (api.release)(h.vm_id, h.ac) };
            }
            Outcome::Unit
        }
    }
}

fn context_from_hwnd(api: &Api, hwnd: HWND) -> (bool, i32, i64) {
    /* 新对话框刚 Show 时 HWND 还没登记: isJavaWindow=false。
     * 这时调用 getAccessibleContextFromHWND 会在 JVM 里卡住 (实测 30s 才被外层超时杀掉)。
     * 所以只在 isJavaWindow=true 之后才问树, 最多等 1.2s。 */
    let deadline = std::time::Instant::now() + Duration::from_millis(1200);
    loop {
        pump();
        let is_java = unsafe { (api.is_java_window)(hwnd) }.as_bool();
        if is_java {
            let mut vm_id: i32 = 0;
            let mut root_ac: i64 = 0;
            let got = unsafe { (api.from_hwnd)(hwnd, &mut vm_id, &mut root_ac) }.as_bool();
            if got && root_ac != 0 {
                return (true, vm_id, root_ac);
            }
            if let Some(ff) = api.from_focus {
                let got_f = unsafe { ff(hwnd, &mut vm_id, &mut root_ac) }.as_bool();
                if got_f && root_ac != 0 {
                    return (true, vm_id, root_ac);
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    (false, 0, 0)
}

fn collect_at(api: &Api, parent: HWND, x: i32, y: i32, win: RECT, budget: usize) -> Dump {
    let Some(from_at) = api.from_at else {
        return Dump {
            items: Vec::new(),
            visited: 0,
            status: Status::NotJava,
        };
    };
    let (got, vm_id, root_ac) = context_from_hwnd(api, parent);
    if !got || root_ac == 0 {
        return Dump {
            items: Vec::new(),
            visited: 0,
            status: Status::NotJava,
        };
    }
    pump();
    let mut ac: i64 = 0;
    let hit = unsafe { from_at(vm_id, root_ac, x, y, &mut ac) }.as_bool();
    unsafe { (api.release)(vm_id, root_ac) };
    if !hit || ac == 0 {
        return Dump {
            items: Vec::new(),
            visited: 0,
            status: Status::NoTree {
                reason: "对话框 HWND 还没进 Access Bridge, 按坐标从主窗取子树也没打中。稍后再 snapshot。".into(),
            },
        };
    }
    collect_from(api, Handle { vm_id, ac }, win, budget, true)
}

fn collect(api: &Api, hwnd: HWND, win: RECT, budget: usize, keep: bool) -> Dump {
    let budget = if budget == 0 { crate::uia::DEFAULT_BUDGET } else { budget };
    let is_java = unsafe { (api.is_java_window)(hwnd) }.as_bool();
    let (got, vm_id, root_ac) = context_from_hwnd(api, hwnd);
    if !got || root_ac == 0 {
        return Dump {
            items: Vec::new(),
            visited: 0,
            status: if is_java {
                Status::NoTree {
                    reason: "IsJavaWindow=true 但 GetAccessibleContextFromHWND 是空的。JetBrains IDE 要开 Settings → Appearance → Support screen readers (下次启动生效), JVM 才会把 Swing 树交给 JAB。".into(),
                }
            } else {
                Status::NotJava
            },
        };
    }
    collect_from(api, Handle { vm_id, ac: root_ac }, win, budget, keep)
}

fn collect_from(api: &Api, start: Handle, win: RECT, budget: usize, keep: bool) -> Dump {
    let budget = if budget == 0 { crate::uia::DEFAULT_BUDGET } else { budget };
    let mut items: Vec<Collected> = Vec::new();
    let mut visited = 0usize;
    let mut queue: std::collections::VecDeque<Handle> = std::collections::VecDeque::new();
    queue.push_back(start);
    /* 完整 4×budget 会把 IDEA 工程树每个折叠节点都问一遍, 157 个有效控件要 12s。
     * 屏幕外 / 折叠的不往下走, visit 上限跟编号预算同量级。 */
    let visit_cap = budget.saturating_mul(2);

    while let Some(h) = queue.pop_front() {
        if visited >= visit_cap {
            unsafe { (api.release)(h.vm_id, h.ac) };
            continue;
        }
        visited += 1;
        if visited % 12 == 0 {
            pump();
        }
        let info = match read_info(api, h) {
            Some(i) => i,
            None => {
                unsafe { (api.release)(h.vm_id, h.ac) };
                continue;
            }
        };
        let states = wchar(&info.states_en_us).to_ascii_lowercase();
        let showing = states.is_empty() || states.contains("showing") || states.contains("visible");
        let rect = RECT {
            left: info.x,
            top: info.y,
            right: info.x + info.width,
            bottom: info.y + info.height,
        };
        let has_rect = info.width > 0 && info.height > 0;
        let in_view = !has_rect || in_window(rect, win);
        let children = info.children_count.max(0) as usize;
        let collapsed = states.contains("collapsed")
            || (states.contains("expandable") && !states.contains("expanded"));
        let role_en = wchar(&info.role_en_us);
        let role_loc = wchar(&info.role);
        let role = map_role(if role_en.is_empty() { &role_loc } else { &role_en });

        /* 先把孩子入队, 再决定父节点进不进表 —— 进表的句柄要留着给 press,
         * 不进表的立刻 release。先 release 再 GetChild 是 use-after-free。 */
        let kid_cap = child_walk_cap(&role, collapsed, in_view || !has_rect);
        if showing && items.len() < budget && kid_cap > 0 {
            for i in 0..children.min(kid_cap) {
                let child = unsafe { (api.child)(h.vm_id, h.ac, i as i32) };
                if child != 0 {
                    queue.push_back(Handle { vm_id: h.vm_id, ac: child });
                }
            }
        }

        let mut kept = false;
        if showing && in_view {
            if let Some(row) = row_from_info(&info, items.len() as i64) {
                if keep || row.actionable || !row.label.is_empty() {
                    items.push(Collected { row, el: h });
                    kept = true;
                }
            }
        }
        if !kept {
            unsafe { (api.release)(h.vm_id, h.ac) };
        }
        if items.len() >= budget {
            break;
        }
    }
    /* 队列里没来得及走的节点也要放掉 */
    while let Some(h) = queue.pop_front() {
        if items.iter().all(|c| !(c.el.ac == h.ac && c.el.vm_id == h.vm_id)) {
            unsafe { (api.release)(h.vm_id, h.ac) };
        }
    }

    let informative = items.iter().filter(|c| !is_chrome_role(&c.row.role, &c.row.label)).count();
    let status = if informative >= 3 {
        Status::Ok
    } else {
        Status::NoTree {
            reason: "JAB 接到了窗口, 但有效控件不到 3 个。JetBrains IDE 默认关掉读屏树 (性能)。开 Settings → Appearance → Support screen readers 后重启 IDE, 再 snapshot。".into(),
        }
    };
    Dump { items, visited, status }
}

fn read_info(api: &Api, h: Handle) -> Option<AccessibleContextInfo> {
    unsafe {
        let mut info: AccessibleContextInfo = std::mem::zeroed();
        if (api.context_info)(h.vm_id, h.ac, &mut info).as_bool() {
            Some(info)
        } else {
            None
        }
    }
}

fn live_info(api: &Api, h: Handle) -> Option<LiveInfo> {
    let info = read_info(api, h)?;
    let states = wchar(&info.states_en_us).to_ascii_lowercase();
    let mut value = wchar(&info.name);
    if let Some(get) = api.get_value {
        let mut buf = [0u16; SHORT_STRING];
        if unsafe { get(h.vm_id, h.ac, buf.as_mut_ptr(), buf.len() as i16) }.as_bool() {
            let v = wchar(&buf);
            if !v.is_empty() {
                value = v;
            }
        }
    }
    Some(LiveInfo {
        x: info.x,
        y: info.y,
        w: info.width,
        h: info.height,
        value: if value.is_empty() { None } else { Some(value) },
        focused: states.contains("focused"),
    })
}

fn do_press(api: &Api, h: Handle) -> bool {
    let Some(get) = api.get_actions else { return false };
    let Some(doit) = api.do_actions else { return false };
    unsafe {
        let mut actions: Box<AccessibleActions> = Box::new(std::mem::zeroed());
        if !get(h.vm_id, h.ac, actions.as_mut()).as_bool() || actions.actions_count <= 0 {
            return false;
        }
        let n = actions.actions_count.min(MAX_ACTION_INFO as i32) as usize;
        let mut order: Vec<usize> = (0..n).collect();
        if let Some(i) = (0..n).find(|&i| {
            let name = wchar(&actions.action_info[i].name).to_ascii_lowercase();
            name == "click" || name == "press" || name == "toggle" || name == "doclick"
                || name.contains("click")
        }) {
            order.retain(|&x| x != i);
            order.insert(0, i);
        }
        for idx in order {
            let mut todo: AccessibleActionsToDo = std::mem::zeroed();
            todo.actions_count = 1;
            todo.actions[0] = actions.action_info[idx];
            let mut failure = -1i32;
            if doit(h.vm_id, h.ac, &mut todo, &mut failure).as_bool() {
                return true;
            }
        }
        false
    }
}

fn do_set_text(api: &Api, h: Handle, text: &str) -> bool {
    let Some(set) = api.set_text else { return false };
    let mut wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { set(h.vm_id, h.ac, wide.as_mut_ptr()) }.as_bool()
}

fn do_focus(api: &Api, h: Handle) -> bool {
    let Some(f) = api.request_focus else { return false };
    unsafe { f(h.vm_id, h.ac) }.as_bool()
}

fn row_from_info(info: &AccessibleContextInfo, id: i64) -> Option<Row> {
    let role_en = wchar(&info.role_en_us);
    let role_loc = wchar(&info.role);
    let role = map_role(if role_en.is_empty() { &role_loc } else { &role_en });
    let name = wchar(&info.name);
    let desc = wchar(&info.description);
    let states = wchar(&info.states_en_us).to_ascii_lowercase();
    let label = if !name.is_empty() { name.clone() } else { desc.clone() };
    let has_action = info.accessible_action != 0;
    let has_text = info.accessible_text != 0;
    let editable = states.contains("editable");
    let enabled = !states.contains("disabled") && !states.contains("unavailable");
    let focused = states.contains("focused");
    let actionable = is_actionable(&role, has_action, has_text, editable);
    /* 容器不进编号表: 点它们是假通过的来源 (跟 UIA NEVER_ACTIONABLE 同一条规矩) */
    if !actionable && label.is_empty() {
        return None;
    }
    if is_container(&role) && !actionable {
        return None;
    }
    let mut actions = Vec::new();
    if has_action && actionable {
        actions.push("invoke".into());
    }
    if (has_text || role == "Edit") && (editable || has_text) {
        actions.push("setValue".into());
    }
    Some(Row {
        id,
        role: role.clone(),
        subrole: if role_en.is_empty() { None } else { Some(role_en) },
        label,
        role_desc: if desc.is_empty() { None } else { Some(desc) },
        value: if name.is_empty() { None } else { Some(name) },
        x: info.x,
        y: info.y,
        w: info.width.max(0),
        h: info.height.max(0),
        actionable,
        actions,
        enabled,
        focused,
    })
}

fn is_actionable(role: &str, has_action: bool, has_text: bool, editable: bool) -> bool {
    match role {
        "Button" | "CheckBox" | "RadioButton" | "MenuItem" | "Hyperlink" | "TabItem"
        | "ListItem" | "TreeItem" | "ComboBox" | "Slider" | "Spinner" | "SplitButton" => true,
        "Edit" => has_text || editable || has_action,
        _ => has_action && !is_container(role),
    }
}

fn is_container(role: &str) -> bool {
    matches!(
        role,
        "Pane" | "Window" | "Frame" | "Dialog" | "Group" | "ToolBar" | "MenuBar"
            | "StatusBar" | "ScrollBar" | "Separator" | "Menu" | "Table" | "Tree" | "List"
            | "Tab" | "RootPane"
    )
}

/// 往下走几层孩子。折叠 / 屏幕外的容器不展开 —— 那是 Java IDE 主窗 dump 12s 的主因。
fn child_walk_cap(role: &str, collapsed: bool, walkable: bool) -> usize {
    if collapsed || !walkable {
        return 0;
    }
    if matches!(role, "Tree" | "List" | "Table" | "TreeItem" | "ListItem") {
        16
    } else {
        48
    }
}

#[cfg(test)]
mod walk_tests {
    use super::child_walk_cap;

    #[test]
    fn collapsed_and_offscreen_are_not_walked() {
        assert_eq!(child_walk_cap("Tree", true, true), 0);
        assert_eq!(child_walk_cap("Button", false, false), 0);
        assert_eq!(child_walk_cap("TreeItem", false, true), 16);
        assert_eq!(child_walk_cap("Button", false, true), 48);
    }
}

fn is_chrome_role(role: &str, label: &str) -> bool {
    if role == "TitleBar" {
        return true;
    }
    matches!(
        label.trim(),
        "最小化" | "最大化" | "关闭" | "还原" | "系统"
            | "Minimize" | "Maximize" | "Close" | "Restore" | "System"
    )
}

fn map_role(en: &str) -> String {
    match en.trim().to_ascii_lowercase().as_str() {
        "push button" | "toggle button" => "Button",
        "check box" => "CheckBox",
        "radio button" => "RadioButton",
        "combo box" => "ComboBox",
        "text" | "password text" | "edit bar" | "text area" => "Edit",
        "hyperlink" => "Hyperlink",
        "label" => "Text",
        "menu item" => "MenuItem",
        "menu" | "popup menu" => "Menu",
        "menu bar" => "MenuBar",
        "page tab" => "TabItem",
        "page tab list" => "Tab",
        "list item" => "ListItem",
        "list" => "List",
        "tree item" => "TreeItem",
        "tree" => "Tree",
        "slider" => "Slider",
        "spin box" => "Spinner",
        "tool bar" => "ToolBar",
        "separator" => "Separator",
        "progress bar" => "ProgressBar",
        "status bar" => "StatusBar",
        "table" => "Table",
        "table cell" => "DataItem",
        "frame" | "window" => "Window",
        "dialog" => "Dialog",
        "panel" | "viewport" | "scroll pane" | "split pane" | "layered pane" | "layeredpane"
        | "glass pane" | "filler" => "Pane",
        "root pane" => "RootPane",
        other if other.is_empty() => "Pane",
        other => return title_case(other),
    }
    .to_string()
}

fn title_case(s: &str) -> String {
    s.split(|c: char| c == ' ' || c == '-' || c == '_')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

fn wchar(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n]).trim().to_string()
}

fn in_window(r: RECT, win: RECT) -> bool {
    if r.right <= r.left || r.bottom <= r.top {
        return false;
    }
    !(r.right <= win.left || r.left >= win.right || r.bottom <= win.top || r.top >= win.bottom)
}
