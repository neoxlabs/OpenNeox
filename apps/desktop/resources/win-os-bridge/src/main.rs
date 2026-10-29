//! neox-os-bridge —— Windows OS 级 computer use 的原生桥
//! ═══════════════════════════════════════════════════════════════════════════
//! 用法: 直接跑 (无参) 进入 JSON-lines 服务模式; `--probe` 单发一次探测。
//!
//! 与 mac 桥 (`resources/os-bridge/`) 的关系:
//!   · 协议层逐字相同 (protocol.rs 对着 Protocol.swift 抄的): 宿主不变, computerRun
//!     的动作语义不变, 提示词也不用分平台写两套。
//!   · 实现层完全不同: mac 是 AXUIElement (辅助功能) + CGEvent; Windows 是
//!     UI Automation (UIA) + SendInput, Java/Swing 再叠加 Java Access Bridge。
//!     两边的**能力**对齐, **机制**各自用本地的。
//!   · macOS 那套 unix socket / .app bundle 全部不要: 那是给 TCC 身份用的,
//!     Windows 没有对应概念, stdio 就够。
//!
//! 主循环是阻塞 read_line —— 桥没有自己的事件循环, 这是故意的: 所有等待
//! (expectChange / watch) 都由请求显式表达, 不靠隐式回调。

mod actions;
mod guard;
mod input;
mod input_lock;
mod jab;
mod privilege;
mod protocol;
mod shot;
mod uia;
mod winapp;

use actions::{op_act, op_click, op_click_at, op_double_click, op_drag, op_hover, op_key, op_read, op_scroll, op_show_menu, op_type};
use protocol::{emit, fail, ok, probe, Request};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, TcpListener};
use std::time::{Duration, Instant};
use windows::Win32::UI::Accessibility::IUIAutomationElement;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};
use windows::core::PCWSTR;
use winapp::WinApp;

/// 元素编号表 —— **常驻进程存在的理由**。
///
/// dump 一次拿到 200 个元素、编上号, 模型说"点 7 号" —— 7 号必须还能解引用。
/// 进程一退这张表就没了, 只能靠 (role,label,rect) 反查, 既慢又会认错人。
///
/// 句柄是 UIA 或 JAB: Java 窗的 UIA 树经常是瞎的, 编号必须解到 AccessibleContext 上。
enum El {
    Uia(IUIAutomationElement),
    Jab(jab::Handle),
}

struct Table {
    epoch: i64,
    pid: u32,
    app: String,
    /// dump 实际扫的那扇窗 (设置对话框开着时不是主窗)。
    hwnd: isize,
    /// "uia" | "jab" —— 回执里带出去, 上层/技能按它决定别用 click_at 硬点 Java。
    source: &'static str,
    els: Vec<El>,
    /// 跟 els 一一对应 —— `read` 要拿缓存里的 label 当兜底
    rows: Vec<uia::Row>,
}

struct State {
    uia: Option<uia::Uia>,
    jab: Option<jab::Session>,
    epoch: i64,
    table: Option<Table>,
    /// 对这个 HWND 调过 JAB 并超时 —— 下次直接当瞎的, 别再把工作线程卡死。
    jab_skip: Vec<isize>,
}

thread_local! {
    /// COM 是套间线程的 (UIA 走 STA), 所以状态挂线程本地而不是全局锁。
    static STATE: RefCell<State> = const { RefCell::new(State { uia: None, jab: None, epoch: 0, table: None, jab_skip: Vec::new() }) };
}

fn main() {
    /* 每显示器 DPI 感知 —— 不声明的话 GetWindowRect / UIA 的 bounding rect / SendInput
     * 会跑在三套不同的坐标系里, 高 DPI 屏上"点 (800,400)"会点到别处。
     * 必须在任何窗口/UIA 调用之前设。 */
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }

    let cli = parse_cli();

    /* build 脚本 / 冒烟用: 单发探测, 打完就退 (对应 mac build.sh 结尾那句 `"$BIN" --probe`) */
    if cli.probe {
        let mut v = probe(0);
        privilege::inject(&mut v);
        emit(&v);
        return;
    }

    if let Some(spec) = cli.listen {
        serve_listen(&spec, cli.nonce.as_deref());
        return;
    }

    serve_stdio();
}

struct Cli {
    probe: bool,
    listen: Option<String>,
    nonce: Option<String>,
}

fn parse_cli() -> Cli {
    let mut probe = false;
    let mut listen = None;
    let mut nonce = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--probe" => probe = true,
            "--listen" => listen = it.next(),
            "--nonce" => nonce = it.next(),
            other if let Some(rest) = other.strip_prefix("--listen=") => {
                listen = Some(rest.to_string());
            }
            other if let Some(rest) = other.strip_prefix("--nonce=") => {
                nonce = Some(rest.to_string());
            }
            _ => {}
        }
    }
    Cli { probe, listen, nonce }
}

fn emit_handshake() {
    let mut v = protocol::handshake();
    privilege::inject(&mut v);
    emit(&v);
}

fn serve_stdio() {
    emit_handshake();
    let stdin = std::io::stdin();
    serve_reader(stdin.lock());
}

/// 提权后的桥: 只绑 127.0.0.1, 写就绪文件, 等宿主连上来再切 TCP 回执。
/// 不绑 0.0.0.0 —— 这条管子后面是整台电脑。
fn serve_listen(spec: &str, nonce: Option<&str>) {
    let listener = match bind_loopback(spec) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("listen failed: {e}");
            std::process::exit(2);
        }
    };
    let addr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("local_addr failed: {e}");
            std::process::exit(2);
        }
    };
    write_ready_file(nonce.unwrap_or(""), addr.port());
    let (stream, peer) = match listener.accept() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("accept failed: {e}");
            std::process::exit(2);
        }
    };
    if !peer.ip().is_loopback() {
        eprintln!("refused non-loopback peer {peer}");
        std::process::exit(2);
    }
    drop(listener);
    let clone = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("clone tcp failed: {e}");
            std::process::exit(2);
        }
    };
    protocol::set_tcp_sink(clone);
    emit_handshake();
    serve_reader(BufReader::new(stream));
    let _ = std::fs::remove_file(ready_path());
}

fn bind_loopback(spec: &str) -> std::io::Result<TcpListener> {
    let raw = if spec.contains(':') {
        spec.to_string()
    } else {
        format!("{spec}:0")
    };
    let mut addr: std::net::SocketAddr = raw
        .parse()
        .unwrap_or_else(|_| "127.0.0.1:0".parse().expect("loopback"));
    if !addr.ip().is_loopback() {
        addr.set_ip(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    TcpListener::bind(addr)
}

fn ready_path() -> std::path::PathBuf {
    std::env::temp_dir().join("neox-os-bridge-elevated.json")
}

fn write_ready_file(nonce: &str, port: u16) {
    let body = json!({
        "nonce": nonce,
        "port": port,
        "pid": std::process::id(),
        "privilege": privilege::snapshot_json(),
    });
    let _ = std::fs::write(ready_path(), body.to_string());
}

fn serve_reader<R: BufRead>(mut reader: R) {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, /* EOF: 宿主走了, 桥跟着退 */
            Ok(_) => {}
            Err(_) => break,
        }
        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        handle(trimmed);
    }
}

/// 处理一行请求。**永不让单条坏请求掀掉整个桥** —— 桥一死, 宿主那边所有
/// 在等回执的调用只能等到超时, 症状离真因非常远。
fn handle(line: &str) {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            emit(&fail(-1, "bad_request", &format!("解不开这行请求: {e}"), None));
            return;
        }
    };
    let id = req.id;
    let op = req.op.clone();
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        STATE.with(|s| dispatch(&mut s.borrow_mut(), &req))
    }));
    match out {
        Ok(v) => emit(&v),
        Err(_) => emit(&fail(
            id,
            "bridge_panic",
            &format!("op={op} 内部异常 (已拦下, 桥还活着)"),
            None,
        )),
    }
}

fn dispatch(st: &mut State, req: &Request) -> Value {
    /* 硬边界: **分发之前**收口 —— 每个 op 各判一次等于漏一个 op 就漏一整条路,
     * 而这条边界漏一次的代价是"绕过所有审批执行任意命令"。 */
    if let Some(denied) = guard_gate(st, req) {
        return denied;
    }
    match req.op.as_str() {
        "probe" => {
            let mut v = probe(req.id);
            privilege::inject(&mut v);
            v
        }
        "apps" => op_apps(req),
        "elevate" => op_elevate(req),
        "launch" => op_launch(req),
        "dump" => op_dump(st, req),
        "signature" => op_signature(st, req),
        "act" => op_act(st, req),
        "click" => op_click(st, req),
        "click_at" => op_click_at(req),
        "hover" => op_hover(req),
        "double_click" => op_double_click(st, req),
        "drag" => op_drag(req),
        "type" => op_type(st, req),
        "key" => op_key(st, req),
        "read" => op_read(st, req),
        "scroll" => op_scroll(st, req),
        "show_menu" => op_show_menu(st, req),
        "watch" => op_watch(st, req),
        "screenshot" => op_screenshot(req),
        "request_access" => op_request_access(req),
        /* 这两个 Windows 上没有对应物 —— 如实回 unsupported_op, 让模型看到人话,
         * 而不是一个含糊的失败让它反复重试。 */
        "select_text" => fail(
            req.id,
            "unsupported_op",
            "Windows 桥暂不支持按文本片段选中 (mac 走的是 AX 的文本范围接口)",
            Some("要选内容可以传 key 组合: ctrl+a 全选, 或者用 setValue 直接写整段"),
        ),
        "icon" => fail(
            req.id,
            "unsupported_op",
            "Windows 桥暂不支持提取应用图标",
            Some("卡片的 logo 会退成首字母方块, 不影响操作"),
        ),
        "lock_user_input" => {
            input_lock::lock_user_input();
            winapp::hold_foreground(req.app.as_deref(), req.pid);
            ok(req.id, json!({ "locked": true }))
        }
        "unlock_user_input" => {
            winapp::release_foreground();
            input_lock::unlock_user_input();
            ok(req.id, json!({ "locked": false }))
        }
        "quit" => {
            input_lock::shutdown();
            emit(&ok(req.id, json!({})));
            std::process::exit(0);
        }
        other => fail(
            req.id,
            "unknown_op",
            &format!("Windows 桥还不认识这个 op: {other}"),
            None,
        ),
    }
}

/// 目标边界的统一入口。判据跟各 op 自己怎么找目标**逐字一致**:
///   · 点名了 app / pid   → 就是它
///   · dump / signature / launch 没点名 → 前台应用
///   · 其余动作类没点名   → 元素表的属主 (表里没有就退前台)
fn guard_gate(st: &State, req: &Request) -> Option<Value> {
    const NEEDS_TARGET: &[&str] = &[
        "launch", "dump", "signature", "act", "show_menu", "select_text", "type", "key",
        "click", "click_at", "hover", "double_click", "drag", "scroll", "read", "screenshot", "watch",
    ];
    if !NEEDS_TARGET.contains(&req.op.as_str()) {
        return None;
    }
    /* ① 先按名字判 —— launch 的目标可能还没起来, 那时只有名字 */
    if let Some(d) = guard::guard_name(req.app.as_deref()) {
        return Some(deny(req.id, &d));
    }
    /* ② 再按真实进程判 (改名绕不过这一道) */
    let named = req.app.is_some() || req.pid.is_some();
    let perceives = matches!(req.op.as_str(), "launch" | "dump" | "signature");
    let target = if named {
        winapp::find_app(req.app.as_deref(), req.pid)
    } else if perceives {
        winapp::foreground_app()
    } else {
        st.table
            .as_ref()
            .map(|t| t.pid as i32)
            .and_then(|p| winapp::find_app(None, Some(p)))
            .or_else(winapp::foreground_app)
    };
    if let Some(t) = target.as_ref() {
        if let Some(d) = guard::guard_app(t) {
            return Some(deny(req.id, &d));
        }
        /* launch 只是把应用拉起来, 还不驱动它; 截图是像素, UIPI 不挡 BitBlt。
         * 其余动作在目标完整性更高时必须先要真权限, 否则 SendInput 会静默丢。 */
        if req.op != "launch" && req.op != "screenshot" {
            if let Some(v) = privilege::fail_if_blocked(req.id, t.pid) {
                return Some(v);
            }
        }
    }
    None
}

fn deny(id: i64, d: &guard::Denial) -> Value {
    fail(id, d.code, &d.reason, Some(&d.hint))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * b4: 剩下的几个 op
 * ═══════════════════════════════════════════════════════════════════════════ */

/// `op=screenshot` —— 抓窗口截图到 path (上层传进来, 它得落在 neox-asset 放行的目录里)。
/// 自绘界面 (读不到元素) 的兜底眼睛: 给了图, 模型才能用 click_at 按比例点。
fn op_screenshot(req: &Request) -> Value {
    let path = match req.path.clone().filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => return fail(req.id, "missing_path", "screenshot 需要 path (落盘位置由调用方定)", None),
    };
    let target = match resolve_target(req) {
        Ok(t) => winapp::with_dialog(t),
        Err(v) => return v,
    };
    if target.hwnd.0.is_null() {
        return fail(req.id, "no_window", &format!("{} 没有可见窗口", target.name), None);
    }
    /* Qt/WPS 的 PrintWindow 经常是黑的, 要靠屏幕 BitBlt —— 窗口得在前台。
     * 会话必须活过 capture: 否则置前刚结束主页又压回来, 截到的是错窗.
     * computer_run 占用期间用 FrontGuard, 截完不许把脚本级附着摘掉. */
    let _fg = winapp::FrontGuard::acquire(target.hwnd);
    let rect = winapp::window_rect(target.hwnd);
    match shot::capture_window(target.hwnd, rect, &path) {
        Ok((w, h, bytes)) => ok(
            req.id,
            json!({ "path": path, "width": w, "height": h, "bytes": bytes }),
        ),
        Err(e) => fail(
            req.id,
            "screenshot_failed",
            &e,
            Some("窗口最小化时抓不到画面; 先把它还原再试"),
        ),
    }
}

/**
 * `op=watch` —— 等“界面变了”或等满 budget 毫秒, 哪个先到。
 *
 * mac 那边挂 AXObserver 收通知 (界面一动就醒: 实测 6000ms 的等待 525ms 就返回了),
 * 但那要注册 COM 事件处理器。Windows 这边用**轮询轻量签名**: 每 120ms 采一次,
 * 一变就回。语义一样 (它只负责“早点醒”, **不参与判断** —— 上层醒来后照样按签名比),
 * 实现少一层 COM, 也就少一处会漏事件的地方。
 */
fn op_watch(st: &mut State, req: &Request) -> Value {
    let budget = req.budget.unwrap_or(300).min(5_000) as u64;
    let target = match resolve_target(req) {
        Ok(t) => t,
        Err(v) => return v,
    };
    let base = signature_key(st, &target);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget);
    loop {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if std::time::Instant::now() >= deadline {
            return ok(req.id, json!({ "fired": [] }));
        }
        if signature_key(st, &target) != base {
            /* fired 里写的是“收到了哪些通知”。Windows 上没有通知这回事,
             * 所以写的是我们看到的变化 —— 上层不看内容, 只看“醒了”。 */
            return ok(req.id, json!({ "fired": ["uia-changed"] }));
        }
    }
}

/// 轻量签名的可比值 (文本 + 各角色计数)。只用于“变了没有”。
fn signature_key(st: &mut State, target: &WinApp) -> Option<String> {
    let focus = winapp::with_dialog(target.clone());
    if focus.hwnd.0.is_null() {
        return None;
    }
    let win = winapp::window_rect(focus.hwnd);
    let geom = format!(
        "{}:{}x{}",
        focus.title,
        (win.right - win.left).max(0),
        (win.bottom - win.top).max(0)
    );
    /* 模态 Swing 对话框: 别对 HWND 调 JAB, 否则 expectChange 轮询也会把桥卡死。 */
    if jab::looks_like_java(focus.hwnd, &focus.exe_path) && !jab::hwnd_safe_to_attach(focus.hwnd) {
        return Some(geom);
    }
    let use_jab = st.table.as_ref().map(|t| t.source == "jab").unwrap_or(false)
        || jab::looks_like_java(focus.hwnd, &focus.exe_path);
    if use_jab {
        if let Some(j) = st.jab.as_ref() {
            if let Some((texts, counts)) = j.signature(focus.hwnd, win, 200) {
                return Some(format!("{}|{:?}", texts.join("|"), counts));
            }
        }
    }
    let u = st.uia.as_ref()?;
    let root = u.element_from_hwnd(focus.hwnd).ok()?;
    let (mut texts, _labels, mut counts, _) = u.signature(&root, win, 200);
    for fly in winapp::chromium_flyouts(focus.pid, focus.hwnd).into_iter().take(4) {
        let fr = winapp::window_rect(fly.hwnd);
        let Ok(root) = u.element_from_hwnd(fly.hwnd) else { continue };
        let (t2, _l2, c2, _) = u.signature(&root, fr, 80);
        for t in t2 {
            if !texts.contains(&t) {
                texts.push(t);
            }
        }
        for (role, n) in c2 {
            if let Some(i) = counts.iter().position(|(k, _)| *k == role) {
                counts[i].1 += n;
            } else {
                counts.push((role, n));
            }
        }
    }
    Some(format!("{}|{:?}", texts.join("|"), counts))
}

/// `op=request_access` —— Windows 没有 TCC 勾选框, 但有真权限状态要报。
/// 上层开机弹窗 / computer_check_access 靠这一行决定要不要请用户点 UAC。
fn op_request_access(req: &Request) -> Value {
    let s = privilege::snapshot();
    let value = if s.can_drive_elevated() {
        format!(
            "可用 (integrity={} elevated={} uiAccess={}) —— 普通应用与管理员应用都能控",
            s.integrity, s.elevated, s.ui_access
        )
    } else {
        format!(
            "普通应用现在就能控 (integrity={})。管理员应用当前控不了 (需要更高完整性)。",
            s.integrity
        )
    };
    let mut v = ok(req.id, json!({ "value": value }));
    privilege::inject(&mut v);
    v
}

/// `op=elevate` —— ShellExecuteW runas 拉起自己的 `--listen` 副本。
/// UAC 同意框是系统的, 人点「是」之后就绪文件里会有端口, 宿主改连 TCP。
fn op_elevate(req: &Request) -> Value {
    let self_p = privilege::snapshot();
    if self_p.can_drive_elevated() {
        return privilege::already_elevated_reply(req.id);
    }
    if let Some(existing) = read_live_ready(None) {
        return ok(req.id, existing);
    }
    let nonce = req
        .nonce
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("n{}", std::process::id()));
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            return fail(
                req.id,
                "elevate_failed",
                &format!("找不到桥自己的路径: {e}"),
                None,
            )
        }
    };
    let args = format!("--listen 127.0.0.1:0 --nonce {nonce}");
    let wide_exe = to_wide(&exe.to_string_lossy());
    let wide_args = to_wide(&args);
    let h = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("runas"),
            PCWSTR(wide_exe.as_ptr()),
            PCWSTR(wide_args.as_ptr()),
            None,
            SW_HIDE,
        )
    };
    if h.0 as isize <= 32 {
        return fail(
            req.id,
            "uac_declined",
            "没有拉起管理员桥 (多半是 UAC 点了「否」, 或系统策略禁止提权)",
            Some("要控管理员应用必须由你点一次 Windows UAC「是」。点「否」的话普通应用仍然能控。"),
        );
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Some(existing) = read_live_ready(Some(nonce.as_str())) {
            return ok(req.id, existing);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    fail(
        req.id,
        "uac_timeout",
        "等了 120 秒还没等到管理员桥就绪",
        Some("如果 UAC 弹出来了请点「是」; 没弹可能是系统关掉了同意提示, 或杀软拦了。"),
    )
}

fn read_live_ready(want_nonce: Option<&str>) -> Option<Value> {
    let raw = std::fs::read_to_string(ready_path()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == 0 || !pid_alive(pid) {
        let _ = std::fs::remove_file(ready_path());
        return None;
    }
    if let Some(want) = want_nonce {
        if !want.is_empty() {
            let got = v.get("nonce").and_then(|n| n.as_str()).unwrap_or("");
            if got != want {
                return None;
            }
        }
    }
    let port = v.get("port")?.as_u64()? as u16;
    Some(json!({
        "value": format!("管理员桥已在 127.0.0.1:{port} (pid {pid})"),
        "port": port,
        "pid": pid,
        "alreadyElevated": false,
        "privilege": v.get("privilege").cloned().unwrap_or_else(privilege::snapshot_json),
    }))
}

fn pid_alive(pid: u32) -> bool {
    unsafe {
        match windows::Win32::System::Threading::OpenProcess(
            windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        ) {
            Ok(h) => {
                let _ = windows::Win32::Foundation::CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    }
}

/// 从元素表里按编号取元素。取不到一律明确报 `stale_handle`,
/// 而不是含糊的"没找到" —— 这两件事在诊断时完全不同。
fn pick_element<'a>(st: &'a State, req: &Request) -> Result<(&'a El, &'a uia::Row), Value> {
    let table = st.table.as_ref().ok_or_else(|| {
        fail(
            req.id,
            "no_table",
            "还没有元素表",
            Some("编号只能来自 computer_snapshot —— 先看一眼再动手"),
        )
    })?;
    let t = req.target.ok_or_else(|| {
        fail(
            req.id,
            "missing_target",
            &format!("{} 需要 target (元素编号)", req.op),
            None,
        )
    })?;
    let idx = t as usize;
    if t < 0 || idx >= table.els.len() {
        return Err(fail(
            req.id,
            "stale_handle",
            &format!("编号 {t} 不在当前元素表里 (表里只有 {} 个)", table.els.len()),
            Some("界面变过之后旧编号会失效: 重新 computer_snapshot 拿新编号, 别自己编"),
        ));
    }
    Ok((&table.els[idx], &table.rows[idx]))
}

fn replace_table(st: &mut State, new: Table, release_jab: bool) {
    if let Some(old) = st.table.take() {
        if release_jab {
            let hs: Vec<jab::Handle> = old
                .els
                .iter()
                .filter_map(|e| match e {
                    El::Jab(h) => Some(*h),
                    El::Uia(_) => None,
                })
                .collect();
            if !hs.is_empty() {
                if let Some(jab) = st.jab.as_ref() {
                    jab.release_all(&hs);
                }
            }
        }
    }
    st.table = Some(new);
}

fn ensure_jab(st: &mut State, pid: u32, exe_path: &str) -> Result<(), String> {
    if st.jab.is_some() {
        return Ok(());
    }
    match jab::Session::start(pid, exe_path) {
        Ok(s) => {
            st.jab = Some(s);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn ms_since(t0: std::time::Instant) -> u64 {
    t0.elapsed().as_millis() as u64
}

/// 列出在跑的应用。mac 的 AppInfo 是 `{name, bundleId, pid, frontmost}` ——
/// Windows 没有 bundleId, 换成语义等价的 exe 路径与窗口标题 (多出来的字段
/// 对老宿主无害, 它只读自己认识的那几个)。
fn op_apps(req: &Request) -> Value {
    let apps: Vec<Value> = winapp::list_apps()
        .into_iter()
        .map(|a| {
            json!({
                "name": a.name,
                "bundleId": null,
                "pid": a.pid,
                "frontmost": a.frontmost,
                "exe": a.exe_path,
                "title": a.title,
            })
        })
        .collect();
    ok(req.id, json!({ "apps": apps }))
}

/// 解析目标应用。判据跟 mac 的 opDump 对齐:
///   点名了 app/pid → 就用它; 什么都没给 → 前台应用。
fn resolve_target(req: &Request) -> Result<WinApp, Value> {
    if req.app.is_some() || req.pid.is_some() {
        return winapp::find_app(req.app.as_deref(), req.pid).ok_or_else(|| {
            let what = req
                .app
                .clone()
                .unwrap_or_else(|| format!("pid {}", req.pid.unwrap_or(0)));
            fail(
                req.id,
                "app_not_found",
                &format!("找不到 {what} 的窗口"),
                Some("先确认这个应用在跑 (可以先用 launch 打开它), 或者换个名字再试"),
            )
        });
    }
    winapp::foreground_app().ok_or_else(|| {
        fail(
            req.id,
            "no_window",
            "现在没有前台窗口",
            Some("点名一个 app 再试"),
        )
    })
}

fn other_windows_payload(hwnd: windows::Win32::Foundation::HWND, stem: &str) -> (Vec<Value>, Option<String>) {
    let peers = winapp::peer_windows(hwnd, stem);
    if peers.is_empty() {
        return (Vec::new(), None);
    }
    let titles: Vec<String> = peers.iter().take(8).map(|w| format!("「{}」", w.title)).collect();
    let json = peers
        .iter()
        .take(8)
        .map(|w| {
            json!({
                "title": w.title,
                "pid": w.pid,
                "name": w.name,
            })
        })
        .collect();
    (
        json,
        Some(format!(
            "同一套软件还有这些窗口: {}。下次 computer_snapshot / computer_run 的 app 请填窗口标题，不要只填进程名。",
            titles.join("、")
        )),
    )
}

fn merge_note(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => Some(format!("{x} {y}")),
        (a, b) => a.or(b),
    }
}

/// 懒初始化 UIA 会话。失败一次就别再反复试 —— 那只会每次都付一次超时。
fn ensure_uia(st: &mut State) -> Result<(), Value> {
    if st.uia.is_some() {
        return Ok(());
    }
    match uia::Uia::new() {
        Ok(u) => {
            st.uia = Some(u);
            Ok(())
        }
        Err(e) => Err(fail(
            -1,
            "uia_init_failed",
            &format!("UI Automation 起不来: {e}"),
            None,
        )),
    }
}

/// `op=dump` —— 一次给够: 编号元素表 + 文本摘要靠的就是这张表
/// (上层 toSnapshot 的 digest 取的是 `label && !actionable` 那批)。
fn op_dump(st: &mut State, req: &Request) -> Value {
    let t0 = std::time::Instant::now();
    let target = match resolve_target(req) {
        Ok(t) => t,
        Err(v) => return v,
    };
    /* 弹层开着就扫弹层: 继续扫最大主窗的话, 对话框里的控件都不在编号表里。
     * 有对话框就扫对话框, 没有才扫主窗。 */
    let focus = winapp::with_dialog(target.clone());
    let dialog = focus.hwnd.0 != target.hwnd.0;
    if focus.hwnd.0.is_null() {
        return fail(
            req.id,
            "no_window",
            &format!("{} (pid {}) 没有可见窗口", target.name, target.pid),
            Some("等它把窗口画出来再试, 或用 apps 看看它现在是什么状态"),
        );
    }
    let (other_windows, peer_note) = other_windows_payload(focus.hwnd, &target.name);
    if let Err(mut v) = ensure_uia(st) {
        if let Some(o) = v.as_object_mut() {
            o.insert("id".into(), json!(req.id));
        }
        return v;
    }
    let win = winapp::window_rect(focus.hwnd);
    let budget = req.budget.unwrap_or(uia::DEFAULT_BUDGET);
    let java_looking = jab::looks_like_java(focus.hwnd, &target.exe_path)
        || jab::looks_like_java(target.hwnd, &target.exe_path);

    /* Swing 窗的 UIA 几乎一定是瞎的, 问它只会在 Java 对话框上卡住
     * (设置窗实测 16s)。Java 直接走 JAB, 别先付 UIA。 */
    let collect_once = |st: &State, view: uia::View| -> Option<(Vec<uia::Collected>, usize)> {
        let u = st.uia.as_ref()?;
        let root = u.element_from_hwnd(focus.hwnd).ok()?;
        Some(u.collect_view(&root, win, budget, view))
    };
    let informative = |cols: &[uia::Collected]| {
        cols.iter().filter(|c| !uia::is_chrome(&c.row)).count()
    };
    let mut retried = false;
    let mut raw_fallback = false;
    /* WPS 等自绘办公窗: UIA 永远空, 500ms 重试 / Raw / JAB 每次 dump 白烧半秒以上。 */
    let skip_slow_ax = winapp::skip_slow_ax_probe(&target.name);
    let (mut cols, mut visited) = if java_looking {
        (Vec::new(), 0)
    } else {
        match collect_once(st, uia::View::Control) {
            Some(x) => x,
            None => {
                return fail(
                    req.id,
                    "no_window",
                    &format!("拿不到 {} 的 UIA 元素", target.name),
                    None,
                )
            }
        }
    };

    if !java_looking && !skip_slow_ax && informative(&cols) < 3 {
        /* Chromium 要 AT 先连上 / 窗口在前台才会把 UIA 树填满。250ms 不够:
         * QQ NT 实测第一次 dump 0 元素, 点一下之后才有树。 */
        winapp::bring_to_front(focus.hwnd);
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some((cols2, visited2)) = collect_once(st, uia::View::Control) {
            if informative(&cols2) > informative(&cols) {
                cols = cols2;
                visited = visited2;
                retried = true;
            }
        }
    }

    if !java_looking && !skip_slow_ax && informative(&cols) < 3 {
        if let Some((cols2, visited2)) = collect_once(st, uia::View::Raw) {
            if informative(&cols2) > informative(&cols) {
                cols = cols2;
                visited = visited2;
                raw_fallback = true;
            }
        }
    }

    /* Chromium @ 候选经常只在 ContentView。Control 已经很满也要再拼一小截,
     * 否则提及列表永远进不了编号表。预算压在 80, 避免把整页网页再走一遍。 */
    let mut content_merged = 0u32;
    if !java_looking
        && !skip_slow_ax
        && winapp::is_chromium_class(&winapp::window_class(focus.hwnd))
    {
        if let Some(u) = st.uia.as_ref() {
            if let Ok(root) = u.element_from_hwnd(focus.hwnd) {
                let remain = 80.min(budget.saturating_sub(cols.len()).max(24));
                let (extra, vis2) = u.collect_view(&root, win, remain, uia::View::Content);
                visited += vis2;
                let cap = cols.len() + remain;
                content_merged = uia::merge_unique(&mut cols, extra, cap);
                if content_merged > 0 {
                    uia::reindex(&mut cols);
                }
            }
        }
    }

    /* Chromium 表情/@ 弹层是无标题顶层窗, 不能当 dump 主目标 (截图会被抢走)。
     * 把弹层控件拼进主窗元素表, 编号连着排。 */
    let mut flyouts_merged = 0u32;
    if !dialog && !java_looking {
        if let Some(u) = st.uia.as_ref() {
            let flies = winapp::chromium_flyouts(target.pid, focus.hwnd);
            for fly in flies.into_iter().take(4) {
                let remain = budget.saturating_sub(cols.len()).max(48);
                let fr = winapp::window_rect(fly.hwnd);
                let Ok(root) = u.element_from_hwnd(fly.hwnd) else { continue };
                let (mut extra, vis) = u.collect_view(&root, fr, remain, uia::View::Control);
                let extra_info = extra.iter().filter(|c| !uia::is_chrome(&c.row)).count();
                let vis_used = if extra_info < 2 {
                    let (extra2, vis2) = u.collect_view(&root, fr, remain, uia::View::Raw);
                    if extra2.len() > extra.len() {
                        extra = extra2;
                        vis2
                    } else {
                        vis
                    }
                } else {
                    vis
                };
                visited += vis_used;
                if extra.is_empty() {
                    continue;
                }
                flyouts_merged += 1;
                cols.append(&mut extra);
            }
            if flyouts_merged > 0 {
                uia::reindex(&mut cols);
            }
        }
    }
    if content_merged > 0 || flyouts_merged > 0 {
        uia::name_adjacent_split_buttons(&mut cols);
        uia::reindex(&mut cols);
    }

    /* epoch 每次 dump 推进 —— 拿旧编号来动作会明确报 stale_handle,
     * 而不是含糊的"没找到" (这两件事在诊断时完全不同)。 */
    st.epoch += 1;
    let epoch = st.epoch;

    let dialog_note = if dialog {
        let title = if focus.title.is_empty() { "对话框".to_string() } else { focus.title.clone() };
        Some(format!(
            "当前扫的是「{title}」, 不是 {app} 主窗口。关对话框后再 snapshot 才回到主界面。",
            app = target.name
        ))
    } else if flyouts_merged > 0 || content_merged > 0 {
        Some("打开的表情 / @ 列表等弹层已经编进这张元素表，按编号点。".into())
    } else {
        None
    };

    /* Java/Swing: UIA 几乎一定是瞎的 (标题栏 4 个装饰)。JAB 接到同一套编号表,
     * 上层 computer_run 不用换指令。失败时留下 jabHint, 仍然走原来的 UIA/像素路。 */
    let mut tree_source = "uia";
    let mut jab_hint: Option<String> = None;
    let mut skip_jab_release = false;
    if !skip_slow_ax && (java_looking || informative(&cols) < 3) {
        match ensure_jab(st, target.pid, &target.exe_path) {
            Ok(()) => {
                let focus_h = focus.hwnd.0 as isize;
                let skip = st.jab_skip.iter().any(|&h| h == focus_h)
                    || !jab::hwnd_safe_to_attach(focus.hwnd);
                if skip {
                    tree_source = "jab-skipped";
                    skip_jab_release = true;
                    jab_hint = Some(
                        "这个对话框在 Java Access Bridge 上会卡住工作线程 (Swing 模态窗的通用限制)。别硬编编号: 看截图, 用 click_at 按比例点。".into(),
                    );
                    if !st.jab_skip.iter().any(|&h| h == focus_h) {
                        st.jab_skip.push(focus_h);
                    }
                } else {
                    let jab_budget = budget.min(240);
                    let dump = st.jab.as_ref().unwrap().dump(focus.hwnd, win, jab_budget);
                    if matches!(&dump.status, jab::Status::InitFailed { error } if error.contains("超时"))
                    {
                        /* 工作线程可能卡在 fromHWND。丢掉 Sender 让它结束后自尽,
                         * 下次 dump 新开一条。不要把主窗 HWND 永久 jab_skip ——
                         * 第一次冷 dump 慢不等于永远读不到树。 */
                        st.jab = None;
                        skip_jab_release = true;
                        tree_source = "jab-skipped";
                    }
                    let jab_info = dump
                        .items
                        .iter()
                        .filter(|c| c.row.actionable || !c.row.label.is_empty())
                        .count();
                match &dump.status {
                    jab::Status::Ok if jab_info >= 3 => {
                        let rows: Vec<uia::Row> = dump.items.iter().map(|c| c.row.clone()).collect();
                        let els: Vec<El> = dump.items.into_iter().map(|c| El::Jab(c.el)).collect();
                        let elements: Vec<Value> = rows.iter().map(row_json).collect();
                        replace_table(
                            st,
                            Table {
                                epoch,
                                pid: target.pid,
                                app: target.name.clone(),
                                hwnd: focus.hwnd.0 as isize,
                                source: "jab",
                                rows,
                                els,
                            },
                            true,
                        );
                        return ok(
                            req.id,
                            json!({
                                "app": target.name,
                                "pid": target.pid,
                                "epoch": epoch,
                                "ms": t0.elapsed().as_millis() as u64,
                                "window": { "x": win.left, "y": win.top, "w": win.right - win.left, "h": win.bottom - win.top },
                                "windowTitle": focus.title,
                                "windowClass": winapp::window_class(focus.hwnd),
                                "dialog": dialog,
                                "visited": dump.visited,
                                "elements": elements,
                                "accessibilityRetry": retried,
                                "rawViewFallback": raw_fallback,
                                "treeSource": "jab",
                                "axBlind": false,
                                "note": merge_note(dialog_note.clone(), peer_note.clone()),
                                "otherWindows": other_windows,
                                "privilege": privilege::snapshot_json(),
                                "targetIntegrity": privilege::process_integrity(target.pid),
                            }),
                        );
                    }
                    jab::Status::NoTree { reason } => jab_hint = Some(reason.clone()),
                    jab::Status::DllMissing { tried } => {
                        jab_hint = Some(format!("Java Access Bridge DLL 没加载到 ({tried})"))
                    }
                    jab::Status::InitFailed { error } => jab_hint = Some(error.clone()),
                    jab::Status::NotJava => {
                        if java_looking {
                            jab_hint = Some(
                                "JAB DLL 已加载, 但这个 JVM 还没向 Access Bridge 登记窗口。JetBrains IDE 必须打开 Settings → Appearance → Support screen readers 并重启, 才会把 Swing 树交出来 (已写入 idea.properties / early-access-registry, 下次启动生效)。".into(),
                            );
                        }
                    }
                    jab::Status::Ok => {
                        jab_hint = Some(format!("JAB 只拿到 {jab_info} 个有效控件, 不够当元素树用"));
                    }
                }
                }
            }
            Err(e) => jab_hint = Some(e),
        }
    }

    let elements: Vec<Value> = cols.iter().map(element_json).collect();
    /* 「瞎不瞎」要**剔掉窗口装饰**再数: 一个什么都不发布给 UIA 的 Java(Swing) 窗口
     * 也会给出最小化/最大化/关闭/系统菜单这 4 个元素 —— 按 n<3 判会得出"能操作",
     * 而实际上界面里的控件一个都读不到, 模型接着就会按编号点空。 */
    let ax_blind = informative(&cols) < 3;
    let note = if ax_blind {
        let blind = match &jab_hint {
            Some(h) => h.clone(),
            None => "这个窗口读不到元素树 (自绘界面, 或辅助功能没开)。别硬编编号: 看截图, 用 click_at 按比例点。".into(),
        };
        Some(match &dialog_note {
            Some(d) => format!("{d} {blind}"),
            None => blind,
        })
    } else {
        dialog_note
    };
    let note = merge_note(note, peer_note);

    replace_table(
        st,
        Table {
            epoch,
            pid: target.pid,
            app: target.name.clone(),
            hwnd: focus.hwnd.0 as isize,
            source: tree_source,
            rows: cols.iter().map(|c| c.row.clone()).collect(),
            els: cols.into_iter().map(|c| El::Uia(c.el)).collect(),
        },
        !skip_jab_release,
    );

    ok(
        req.id,
        json!({
            "app": target.name,
            "pid": target.pid,
            "epoch": epoch,
            "ms": t0.elapsed().as_millis() as u64,
            "window": { "x": win.left, "y": win.top, "w": win.right - win.left, "h": win.bottom - win.top },
            "windowTitle": focus.title,
            "windowClass": winapp::window_class(focus.hwnd),
            "dialog": dialog,
            "visited": visited,
            "elements": elements,
            /* 懒启用的应用 (Chromium/Electron) 会走到这条: 第一次看着像瞎的, 等 250ms
             * 重探一次才拿到真树。回执里带出来, 便于分辨"它是真自绘"还是"我们探早了"。 */
            "accessibilityRetry": retried,
            /* 换 RawView 才拿到节点的: 说明这个应用在 ControlView 里被过滤光了。
             * 对它做后续动作是安全的 (元素表照样是 UIA 元素), 但值得留痕。 */
            "rawViewFallback": raw_fallback,
            "treeSource": tree_source,
            "jabAttempted": jab_hint.is_some(),
            "jabHint": jab_hint,
            "axBlind": ax_blind,
            "flyoutsMerged": flyouts_merged,
            "contentMerged": content_merged,
            "note": note,
            "otherWindows": other_windows,
            "privilege": privilege::snapshot_json(),
            "targetIntegrity": privilege::process_integrity(target.pid),
        }),
    )
}

fn row_json(r: &uia::Row) -> Value {
    json!({
        "id": r.id,
        "role": r.role,
        "subrole": r.subrole,
        "label": r.label,
        "roleDesc": r.role_desc,
        "value": r.value,
        "x": r.x, "y": r.y, "w": r.w, "h": r.h,
        "actionable": r.actionable,
        "actions": r.actions,
        "enabled": r.enabled,
        "focused": r.focused,
    })
}

fn element_json(c: &uia::Collected) -> Value {
    let r = &c.row;
    json!({
        "id": r.id,
        "role": r.role,
        "subrole": r.subrole,
        "label": r.label,
        "roleDesc": r.role_desc,
        "value": r.value,
        "x": r.x, "y": r.y, "w": r.w, "h": r.h,
        "actionable": r.actionable,
        "actions": r.actions,
        "enabled": r.enabled,
        "focused": r.focused,
    })
}

/// `op=launch` —— 打开一个应用。
///
/// mac 那边用 `open -a`; Windows 对应的是 ShellExecuteW "open": 它认得
/// PATH 上的 exe、App Paths 注册项 (notepad / calc / explorer 这种裸名)、
/// 文档路径、URL, 甚至连 `ms-settings:` 这类协议都能拉起来。
///
/// 已经跑着的应用会被带回前台 —— 跟 mac 的语义一致 (模型说"打开记事本"时
/// 它多半已经开着了, 那时它要的是"到它那儿去", 不是再开一个)。
fn op_launch(req: &Request) -> Value {
    let app = req.app.clone().unwrap_or_default();
    let app = app.trim();
    if app.is_empty() {
        return fail(req.id, "app_not_found", "launch 得说要打开什么", Some("给一个 app 名, 例如 notepad / calc / explorer"));
    }

    if let Some(existing) = winapp::find_app(Some(app), None) {
        winapp::bring_to_front(existing.hwnd);
        return ok(
            req.id,
            json!({ "value": format!("{} 已经在跑, 已切到它", existing.name), "pid": existing.pid }),
        );
    }

    let wide = to_wide(app);
    let h = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    /* ShellExecuteW 的返回值是 HINSTANCE 伪装的错误码: <= 32 就是失败
     * (老 Win32 约定, 文档里写得很清楚但很容易被当成句柄) */
    if h.0 as isize <= 32 {
        let with_exe = if app.to_ascii_lowercase().ends_with(".exe") {
            app.to_string()
        } else {
            format!("{app}.exe")
        };
        let wide2 = to_wide(&with_exe);
        let h2 = unsafe {
            ShellExecuteW(None, windows::core::w!("open"), PCWSTR(wide2.as_ptr()), None, None, SW_SHOWNORMAL)
        };
        if h2.0 as isize <= 32 {
            return fail(
                req.id,
                "launch_failed",
                &format!("打不开 {app}"),
                Some("名字不对或系统里没这个程序。可以先用 apps 看看现在有哪些应用在跑"),
            );
        }
    }

    /* 起窗口要时间 —— 给最多 3 秒把 pid 找出来, 找得到就一并回执里。
     * 找不到也不是错: 上层下一次 dump 会自己按名字重找。 */
    let mut pid: u32 = 0;
    for _ in 0..15 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Some(a) = winapp::find_app(Some(app), None) {
            pid = a.pid;
            winapp::bring_to_front(a.hwnd);
            break;
        }
    }
    ok(
        req.id,
        json!({
            "value": if pid > 0 { format!("已启动 {app} (pid {pid})") } else { format!("已启动 {app}") },
            "pid": pid,
        }),
    )
}

/// Rust 字符串 → 以 NUL 结尾的 UTF-16 (Win32 要的那个形状)
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `op=signature` —— 轻量采集, 只回内容文本 + 各角色计数。
///
/// 断言专用: 上层每 120~1200ms 就探一次 (expectChange), 付完整 dump 的钱
/// 纯属浪费 —— 在 OS 这边那笔钱是 0.6~3 秒 (浏览器那边 30ms, 所以同一套写法
/// 在这儿直接爆炸)。
fn op_signature(st: &mut State, req: &Request) -> Value {
    let t0 = std::time::Instant::now();
    let target = match resolve_target(req) {
        Ok(t) => winapp::with_dialog(t),
        Err(v) => return v,
    };
    if target.hwnd.0.is_null() {
        return fail(req.id, "no_window", &format!("{} 没有可见窗口", target.name), None);
    }
    let win = winapp::window_rect(target.hwnd);
    let budget = req.budget.unwrap_or(uia::DEFAULT_BUDGET);

    /* Java 窗的 expectChange 必须问 JAB, 问 UIA 永远是「没变」(标题栏四个按钮)。
     * 模态 Swing 对话框除外: 对它签名会把 JAB 线程卡死, 改用窗口标题当签名。 */
    if jab::looks_like_java(target.hwnd, &target.exe_path) && !jab::hwnd_safe_to_attach(target.hwnd) {
        return ok(
            req.id,
            json!({
                "ms": t0.elapsed().as_millis() as u64,
                "texts": if target.title.is_empty() { vec!["dialog".to_string()] } else { vec![target.title.clone()] },
                "counts": { "Dialog": 1 },
                "treeSource": "jab-skipped",
            }),
        );
    }
    let use_jab = st.table.as_ref().map(|t| t.source == "jab").unwrap_or(false)
        || jab::looks_like_java(target.hwnd, &target.exe_path);
    if use_jab && ensure_jab(st, target.pid, &target.exe_path).is_ok() {
        if let Some((texts, counts)) = st.jab.as_ref().unwrap().signature(target.hwnd, win, budget.min(160)) {
            let counts: serde_json::Map<String, Value> =
                counts.into_iter().map(|(k, v)| (k, json!(v))).collect();
            return ok(
                req.id,
                json!({
                    "ms": t0.elapsed().as_millis() as u64,
                    "texts": texts,
                    "counts": counts,
                    "treeSource": "jab",
                }),
            );
        }
    }

    if let Err(mut v) = ensure_uia(st) {
        if let Some(o) = v.as_object_mut() {
            o.insert("id".into(), json!(req.id));
        }
        return v;
    }

    let (texts, labels, counts, _visited) = {
        let u = st.uia.as_ref().unwrap();
        let root = match u.element_from_hwnd(target.hwnd) {
            Ok(r) => r,
            Err(e) => {
                return fail(
                    req.id,
                    "no_window",
                    &format!("拿不到 {} 的 UIA 元素: {e}", target.name),
                    None,
                )
            }
        };
        u.signature(&root, win, budget)
    };

    let counts: serde_json::Map<String, Value> = counts
        .into_iter()
        .map(|(k, v)| (k, json!(v)))
        .collect();
    ok(
        req.id,
        json!({
            "ms": t0.elapsed().as_millis() as u64,
            "texts": texts,
            "labels": labels,
            "counts": counts,
        }),
    )
}
