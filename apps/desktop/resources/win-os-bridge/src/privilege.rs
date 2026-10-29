//! 桥自己的完整性 / UIAccess / 安装路径 —— Windows 真权限状态。
//!
//! ─── 为什么这不是"授权条目" ──────────────────────────────────────────────
//! mac 的 TCC 是用户勾一下就能给的。Windows 对应的边界是 UIPI: Medium 完整性
//! 的进程 **SendInput / UIA 驱动不了 High** (管理员) 窗口, 失败还经常是静默的。
//! 用户点不出一条"允许 Neox 操控管理员应用"的系统开关。
//!
//! 真能跨过 UIPI 的路只有两条, 都是 **OS 认的权限**, 不是我们自己假装的:
//!   1. **UIAccess** (`uiAccess=true` + Authenticode 签名 + 装在 Program Files)
//!      —— NVDA 那条。未签名 / 不在安全路径 → Windows **直接不让进程起来**,
//!      所以日常 dev 桥绝不能把这个开关写进 manifest。
//!   2. **管理员完整性** —— 人点一次 UAC (`runas`), 桥以 High IL 常驻本会话。
//!      UAC 同意框本身 (`consent.exe`) 仍由人点, 守卫不会代点。
//!
//! 这一层只负责把事实说清楚, 并在"目标比桥更高"时提前回 `need_elevation`,
//! 而不是让 SendInput 静默丢键、模型以为点成功了。

use crate::protocol::{fail, ok};
use serde_json::{json, Value};
use std::mem::size_of;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
    TokenIntegrityLevel, TokenUIAccess, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

const RID_UNTRUSTED: u32 = 0x0000;
const RID_LOW: u32 = 0x1000;
const RID_MEDIUM: u32 = 0x2000;
const RID_MEDIUM_PLUS: u32 = 0x2100;
const RID_HIGH: u32 = 0x3000;
const RID_SYSTEM: u32 = 0x4000;

#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub integrity: &'static str,
    pub elevated: bool,
    pub ui_access: bool,
    pub secure_path: bool,
}

impl Snapshot {
    pub fn can_drive_elevated(self) -> bool {
        self.elevated || self.ui_access || rank(self.integrity) >= rank("high")
    }
}

fn rank(name: &str) -> u8 {
    match name {
        "untrusted" => 0,
        "low" => 1,
        "medium" => 2,
        "medium_plus" => 3,
        "high" => 4,
        "system" => 5,
        _ => 2,
    }
}

fn rid_name(rid: u32) -> &'static str {
    match rid {
        RID_UNTRUSTED => "untrusted",
        RID_LOW => "low",
        RID_MEDIUM => "medium",
        RID_MEDIUM_PLUS => "medium_plus",
        RID_HIGH => "high",
        RID_SYSTEM => "system",
        _ if rid >= RID_SYSTEM => "system",
        _ if rid >= RID_HIGH => "high",
        _ if rid >= RID_MEDIUM_PLUS => "medium_plus",
        _ if rid >= RID_MEDIUM => "medium",
        _ if rid >= RID_LOW => "low",
        _ => "untrusted",
    }
}

fn secure_path() -> bool {
    let Ok(p) = std::env::current_exe() else {
        return false;
    };
    let s = p.to_string_lossy().to_ascii_lowercase();
    s.contains(r"\program files\") || s.contains(r"\program files (x86)\")
}

unsafe fn token_of(process: HANDLE) -> Option<HANDLE> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    Some(token)
}

unsafe fn integrity_of_token(token: HANDLE) -> &'static str {
    let mut buf = vec![0u8; 256];
    let mut len = 0u32;
    if GetTokenInformation(
        token,
        TokenIntegrityLevel,
        Some(buf.as_mut_ptr().cast()),
        buf.len() as u32,
        &mut len,
    )
    .is_err()
    {
        return "medium";
    }
    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let sid = label.Label.Sid;
    if sid.is_invalid() {
        return "medium";
    }
    let count = *GetSidSubAuthorityCount(sid);
    if count == 0 {
        return "medium";
    }
    let rid = *GetSidSubAuthority(sid, (count - 1) as u32);
    rid_name(rid)
}

unsafe fn elevation_of_token(token: HANDLE) -> bool {
    let mut info = TOKEN_ELEVATION::default();
    let mut len = 0u32;
    if GetTokenInformation(
        token,
        TokenElevation,
        Some((&mut info as *mut TOKEN_ELEVATION).cast()),
        size_of::<TOKEN_ELEVATION>() as u32,
        &mut len,
    )
    .is_err()
    {
        return false;
    }
    info.TokenIsElevated != 0
}

unsafe fn ui_access_of_token(token: HANDLE) -> bool {
    let mut flag: u32 = 0;
    let mut len = 0u32;
    if GetTokenInformation(
        token,
        TokenUIAccess,
        Some((&mut flag as *mut u32).cast()),
        size_of::<u32>() as u32,
        &mut len,
    )
    .is_err()
    {
        return false;
    }
    flag != 0
}

pub fn snapshot() -> Snapshot {
    unsafe {
        let proc = GetCurrentProcess();
        let Some(token) = token_of(proc) else {
            return Snapshot {
                integrity: "medium",
                elevated: false,
                ui_access: false,
                secure_path: secure_path(),
            };
        };
        let snap = Snapshot {
            integrity: integrity_of_token(token),
            elevated: elevation_of_token(token),
            ui_access: ui_access_of_token(token),
            secure_path: secure_path(),
        };
        let _ = CloseHandle(token);
        snap
    }
}

pub fn process_integrity(pid: u32) -> Option<&'static str> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let token = match token_of(proc) {
            Some(t) => t,
            None => {
                let _ = CloseHandle(proc);
                return None;
            }
        };
        let name = integrity_of_token(token);
        let _ = CloseHandle(token);
        let _ = CloseHandle(proc);
        Some(name)
    }
}

pub fn snapshot_json() -> Value {
    let s = snapshot();
    json!({
        "integrity": s.integrity,
        "elevated": s.elevated,
        "uiAccess": s.ui_access,
        "securePath": s.secure_path,
        "canDriveElevated": s.can_drive_elevated(),
        "uac": "UAC 同意框必须由人点, 守卫不会代点 consent.exe",
    })
}

pub fn inject(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        o.insert("privilege".to_string(), snapshot_json());
    }
}

/// 目标完整性比桥高、桥又不能跨 UIPI → 明确失败, 别让 SendInput 静默丢键。
pub fn fail_if_blocked(id: i64, pid: u32) -> Option<Value> {
    let self_p = snapshot();
    if self_p.can_drive_elevated() {
        return None;
    }
    let target = process_integrity(pid)?;
    if rank(target) <= rank(self_p.integrity) {
        return None;
    }
    Some(fail(
        id,
        "need_elevation",
        &format!(
            "目标进程是 {target} 完整性, 当前桥是 {} — UIPI 会静默丢掉输入",
            self_p.integrity
        ),
        Some(
            "这是完整性隔离, 不是授权条目。当前桥控不了管理员应用, 普通应用仍能控。\
             UAC 同意框永远由你点, Neox 不会代点。",
        ),
    ))
}

pub fn already_elevated_reply(id: i64) -> Value {
    let s = snapshot();
    ok(
        id,
        json!({
            "value": if s.can_drive_elevated() {
                format!(
                    "桥已经能驱动管理员应用 (integrity={} elevated={} uiAccess={})",
                    s.integrity, s.elevated, s.ui_access
                )
            } else {
                "桥仍是中等完整性".to_string()
            },
            "alreadyElevated": s.can_drive_elevated(),
            "privilege": snapshot_json(),
        }),
    )
}
