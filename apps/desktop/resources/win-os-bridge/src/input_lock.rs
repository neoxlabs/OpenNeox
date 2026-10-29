//! 操控期间拦住用户鼠标/键盘, 放行 SendInput 注入, 「退出」热区可点, Esc 停操控.
//!
//! 低级钩子 (WH_MOUSE_LL / WH_KEYBOARD_LL) 能看见 LLMHF_INJECTED / LLKHF_INJECTED.
//! 用户的事件吞掉; 桥自己 SendInput 带注入标记, 照样打到目标应用.
//! 叠加层必须鼠标穿透, 否则 SendInput 会点到遮罩上.
//!
//! 「退出」热区必须跟 overlay-entry.ts #overlay-stop 对齐 (CSS px @ 96dpi):
//! left 16, top 14, 88x32. 以前 440x96 会把 WPS 顶栏点击吞掉.

use crate::protocol::{emit, event};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CopyIcon, CreateCursor, DestroyCursor, DispatchMessageW, EnumWindows,
    FindWindowW, GetMessageW, GetSystemMetrics, GetWindowTextW, HOOKPROC, KBDLLHOOKSTRUCT,
    MSLLHOOKSTRUCT, OCR_APPSTARTING, OCR_IBEAM, OCR_NORMAL, OCR_SIZEALL, OCR_SIZENESW, OCR_SIZENS,
    OCR_SIZENWSE, OCR_SIZEWE, OCR_WAIT, SetSystemCursor, SetWindowsHookExW, ShowWindow,
    SystemParametersInfoW, TranslateMessage, UnhookWindowsHookEx, HCURSOR, SPI_SETCURSORS,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_HIDE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_SYSKEYDOWN, MSG,
};

const LLMHF_INJECTED: u32 = 0x0000_0001;
const LLKHF_INJECTED: u32 = 0x0000_0010;

/// 跟 overlay-entry.ts `#overlay-stop` 对齐 (CSS 像素, 按系统 DPI 缩放).
const STOP_LEFT_PX: i32 = 16;
const STOP_TOP_PX: i32 = 14;
const STOP_W_PX: i32 = 88;
const STOP_H_PX: i32 = 32;

static LOCKED: AtomicBool = AtomicBool::new(false);
static HOOKS_ON: AtomicBool = AtomicBool::new(false);
static LAST_ESC_MS: AtomicU64 = AtomicU64::new(0);
static CURSORS_HIDDEN: AtomicBool = AtomicBool::new(false);
static STOPPING_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn in_stop_hole(pt: POINT) -> bool {
    let dpi = unsafe { GetDpiForSystem() } as i32;
    let dpi = if dpi <= 0 { 96 } else { dpi };
    let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let x0 = vx + STOP_LEFT_PX * dpi / 96;
    let y0 = vy + STOP_TOP_PX * dpi / 96;
    let x1 = x0 + STOP_W_PX * dpi / 96;
    let y1 = y0 + STOP_H_PX * dpi / 96;
    pt.x >= x0 && pt.x < x1 && pt.y >= y0 && pt.y < y1
}

fn user_stop_flag_path() -> std::path::PathBuf {
    std::env::temp_dir().join("neox-os-bridge.user-stop")
}

/// 钩子线程立刻写旗标, 不走 stdout 锁 —— dump 正在刷大 JSON 时宿主也能收遮罩.
fn signal_stop_flag() {
    let _ = std::fs::write(user_stop_flag_path(), format!("{}", now_ms()));
}

fn clear_stop_flag() {
    let _ = std::fs::write(user_stop_flag_path(), "0");
}

/// 不等 Electron 轮询: 钩子线程直接把蓝罩窗藏掉, 不然已经开锁、罩子还盖着.
fn hide_computer_overlay() {
    unsafe extern "system" fn cb(hwnd: HWND, _lparam: LPARAM) -> BOOL {
        let mut buf = [0u16; 256];
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if n > 0 {
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            if title.contains("neox-computer-overlay") {
                let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
            }
        }
        BOOL(1)
    }
    unsafe {
        let title: Vec<u16> = "neox-computer-overlay\0".encode_utf16().collect();
        if let Ok(hwnd) = FindWindowW(None, PCWSTR(title.as_ptr())) {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        let _ = EnumWindows(Some(cb), LPARAM(0));
    }
}

fn emit_user_stop() {
    let t = now_ms();
    let prev = LAST_ESC_MS.load(Ordering::Relaxed);
    if t.saturating_sub(prev) > 400 {
        LAST_ESC_MS.store(t, Ordering::Relaxed);
        /* 顺序不能反: 先藏罩子 + 写旗标, 再开锁。先开锁的话用户已经能点桌面,
         * 蓝罩还要等 dump 把 stdout 让出来 / Electron 才 hide. */
        signal_stop_flag();
        hide_computer_overlay();
        unlock_user_input();
        STOPPING_UNTIL.store(t.saturating_add(500), Ordering::Relaxed);
        emit(&event("user_stop", json!({ "action": "user_stop" })));
    }
}

unsafe extern "system" fn mouse_ll(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = (info.flags & LLMHF_INJECTED) != 0;
        if !injected {
            let locked = LOCKED.load(Ordering::Relaxed);
            let stopping = now_ms() < STOPPING_UNTIL.load(Ordering::Relaxed);
            if locked || stopping {
                if locked && in_stop_hole(info.pt) && wparam.0 as u32 == WM_LBUTTONDOWN {
                    emit_user_stop();
                }
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_ll(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && LOCKED.load(Ordering::Relaxed) {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = (info.flags.0 & LLKHF_INJECTED) != 0;
        if !injected {
            let msg = wparam.0 as u32;
            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && info.vkCode == VK_ESCAPE.0 as u32 {
                emit_user_stop();
            }
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn hide_system_cursors() {
    if CURSORS_HIDDEN.swap(true, Ordering::Relaxed) {
        return;
    }
    let and_mask = [0xFFu8; 128];
    let xor_mask = [0u8; 128];
    unsafe {
        let Ok(blank) = CreateCursor(
            None,
            0,
            0,
            32,
            32,
            and_mask.as_ptr() as *const core::ffi::c_void,
            xor_mask.as_ptr() as *const core::ffi::c_void,
        ) else {
            CURSORS_HIDDEN.store(false, Ordering::Relaxed);
            return;
        };
        let ids = [
            OCR_NORMAL, OCR_IBEAM, OCR_WAIT, OCR_SIZEWE, OCR_SIZENS, OCR_SIZENWSE,
            OCR_SIZENESW, OCR_SIZEALL, OCR_APPSTARTING,
        ];
        for id in ids {
            if let Ok(copy) = CopyIcon(blank.into()) {
                let _ = SetSystemCursor(HCURSOR(copy.0), id);
            }
        }
        let _ = DestroyCursor(blank);
    }
}

fn restore_system_cursors() {
    if !CURSORS_HIDDEN.swap(false, Ordering::Relaxed) {
        return;
    }
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETCURSORS, 0, None, windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
}

fn ensure_hook_thread() {
    if HOOKS_ON.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::Builder::new()
        .name("neox-input-lock".into())
        .spawn(|| unsafe {
            let hmod = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
            let mouse: HOOKPROC = Some(mouse_ll);
            let kb: HOOKPROC = Some(keyboard_ll);
            let mh = SetWindowsHookExW(WH_MOUSE_LL, mouse, hmod, 0);
            let kh = SetWindowsHookExW(WH_KEYBOARD_LL, kb, hmod, 0);
            if mh.is_err() || kh.is_err() {
                HOOKS_ON.store(false, Ordering::Relaxed);
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if let Ok(h) = mh {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Ok(h) = kh {
                let _ = UnhookWindowsHookEx(h);
            }
        })
        .ok();
}

pub fn lock_user_input() {
    ensure_hook_thread();
    clear_stop_flag();
    LOCKED.store(true, Ordering::Relaxed);
    hide_system_cursors();
}

pub fn unlock_user_input() {
    /* 开锁同时把蓝罩藏掉: Electron 收 session_end 有 IPC 延迟,
     * 先开锁再等 hide 就是「已经能点桌面但罩子还在」. */
    hide_computer_overlay();
    LOCKED.store(false, Ordering::Relaxed);
    restore_system_cursors();
}

/// 进程退出前务必还原系统光标, 否则用户会一直看不见箭头.
pub fn shutdown() {
    unlock_user_input();
}
