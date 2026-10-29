//! 目标边界 —— 三层里的**权威那一层**。
//!
//! 对应 mac 的 `Guard.swift` + `computerGuard.ts`。那边文件头的三条理由一条不改:
//!   · 终端 —— 往里打字回车 = 执行任意命令, 绕过 execute_shell 的审批/沙箱/风险评估
//!   · Neox 自己 —— 审批卡是我们自己的窗口, 代点「允许」= 自我授权
//!   · 系统授权/密码窗口 —— 那些窗口存在的唯一理由就是"必须由人亲手点"
//!
//! ─── 收口为什么必须在分发之前 ───────────────────────────────────────────────
//! 每个 op 各判一次等于漏一个 op 就漏一整条路, 而这条边界漏一次的代价是
//! "绕过所有审批执行任意命令"。所以入口处统一判, 判据跟各 op 自己怎么找目标
//! **逐字一致** (点名了 app/pid 就按点的判; 没点名就按前台判)。
//!
//! ─── Windows 与 mac 的差异 ──────────────────────────────────────────────────
//!   · mac 按 bundleId 判 (com.apple.Terminal), Windows 没有 bundleId ——
//!     按**可执行文件名**判 (cmd / powershell / wt …)。
//!   · 这一层在 Windows 上还有一条 mac 没有的**硬约束**: UIPI。非提权的桥
//!     驱动不了提权进程 (SendInput 被静默丢弃、UIA 读不到)。所以"用户以管理员
//!     身份开的终端"其实是点不动的 —— 但那不该成为我们不判的理由: 判据要挡的是
//!     **普通权限下的终端**, 那种是能点开的。

use crate::winapp::{exe_stem, WinApp};

/// 硬拒的理由 —— code 跟 TS 侧 computerGuard.ts 保持同一套词汇
/// (宿主按 code 决定给模型一句什么话)。
pub struct Denial {
    pub code: &'static str,
    pub reason: String,
    pub hint: String,
}

/// 终端/解释器 —— 一条都不许碰。
const TERMINALS: &[&str] = &[
    "cmd", "powershell", "pwsh", "wt", "windowsterminal", "conhost", "mintty", "bash", "wsl",
    "ubuntu", "debian", "kali", "git-bash", "conemu", "conemu64", "conemuc", "alacritty",
    "wezterm", "nu", "xshell", "putty", "securecrt", "tabby", "terminus", "hyper",
];

/// 系统授权 / 凭据 / 提权路径。
const SECURITY: &[&str] = &[
    "consent",     // UAC 同意框
    "logonui",     // 锁屏 / 登录
    "credwiz",     // 凭据备份向导
    "winlogon",
    "lsass",
    "csrss",
    "regedit",     // 注册表编辑器: 改注册表等于改系统配置
    "msconfig",
    "gpedit",
    "secpol",
    "certmgr",
    "diskmgmt",    // 磁盘管理: 分区操作不可逆
];

/// 系统设置 —— mac 那边也拦 (app_forbidden_settings)。用户自己开设置是用户的事,
/// 代点"关掉防火墙"不是。
const SETTINGS: &[&str] = &["systemsettings", "control", "mstsc"];

/// Neox 自己 —— 代点审批卡 = 自我授权。
const SELF: &[&str] = &["neox", "neox-os-bridge", "electron"];

fn hit(list: &[&str], name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    list.iter().any(|d| n == *d || n.starts_with(&format!("{d}-")) || n == format!("{d}.exe"))
}

/// 窗口标题不是进程名: 「neox-computer-use.docx - WPS 2019」以 neox- 开头,
/// 但那是文档, 不是 Neox 自己。进程名没有空格、也没有 office 扩展名.
fn looks_like_window_title(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains(' ')
        || n.contains(".doc")
        || n.contains(".ppt")
        || n.contains(".xls")
        || n.contains(".wps")
        || n.contains(".pdf")
}

fn is_self_name(stem: &str) -> bool {
    if looks_like_window_title(stem) {
        return false;
    }
    hit(SELF, stem)
}

/// 按**名字**判 —— launch 用这条路, 因为那时进程还没起来, 拿不到真实进程信息。
pub fn guard_name(app: Option<&str>) -> Option<Denial> {
    let app = app?.trim();
    if app.is_empty() {
        return None;
    }
    let stem = exe_stem(app);
    check(&stem, app)
}

/// 按**进程**判 —— 拿到真实 exe 路径后再判一次, 防止改名绕过
/// (mac 那边同一个道理: 名字匹配只在正规应用里找, 权威判据在桥里)。
pub fn guard_app(target: &WinApp) -> Option<Denial> {
    if target.pid == crate::winapp::self_pid() {
        return Some(Denial {
            code: "app_forbidden_self",
            reason: "这是桥自己".to_string(),
            hint: "选一个别的应用".to_string(),
        });
    }
    let stem = if target.name.is_empty() {
        exe_stem(&target.exe_path)
    } else {
        target.name.clone()
    };
    check(&stem, &target.exe_path)
}

fn check(stem: &str, raw: &str) -> Option<Denial> {
    if is_self_name(stem) {
        return Some(Denial {
            code: "app_forbidden_self",
            reason: format!("{raw} 是 Neox 自己"),
            hint: "审批卡是给你(用户)点的, 代点它等于自我授权。换一个目标应用。".to_string(),
        });
    }
    if hit(TERMINALS, stem) {
        return Some(Denial {
            code: "app_forbidden_terminal",
            reason: format!("{raw} 是终端/解释器"),
            hint: "终端里打字等于执行任意命令, 会绕过 shell 工具的审批与沙箱。要跑命令请用 execute_shell。".to_string(),
        });
    }
    if hit(SECURITY, stem) {
        return Some(Denial {
            code: "app_forbidden_security",
            reason: format!("{raw} 是系统授权/凭据/系统配置工具"),
            hint: "这些窗口存在的唯一理由是必须由人亲手点。请让用户自己操作。".to_string(),
        });
    }
    if hit(SETTINGS, stem) {
        return Some(Denial {
            code: "app_forbidden_settings",
            reason: format!("{raw} 是系统设置"),
            hint: "系统设置必须由用户自己改。告诉用户改哪一项即可。".to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::guard_name;

    #[test]
    fn neox_process_is_self() {
        assert!(guard_name(Some("Neox")).is_some());
        assert!(guard_name(Some("neox.exe")).is_some());
        assert!(guard_name(Some("electron")).is_some());
    }

    #[test]
    fn office_document_titled_neox_is_not_self() {
        assert!(guard_name(Some("neox-computer-use.docx - WPS 2019")).is_none());
        assert!(guard_name(Some("演示文稿1 - WPS 2019")).is_none());
        assert!(guard_name(Some("WPS Office")).is_none());
    }
}
