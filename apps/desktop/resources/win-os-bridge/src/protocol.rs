//! neox-os-bridge —— 协议层 (Windows)
//!
//! ═══════════════════════════════════════════════════════════════════════════
//! 这是 mac 那座桥 (`resources/os-bridge/src/Protocol.swift`) 的**逐字复刻**:
//! 宿主 (Electron 主进程) spawn 本进程, 用 **JSON-lines over stdio** 说话 ——
//! 一行一条请求, 一行一条回复, 靠 `id` 配对。字段名一个都不能改: 两边共用
//! 同一个 TS 客户端 (`neox-core/src/runtime/computer/osBridgeClient.ts`) 和同一套
//! 上层的 computerRun 动作语义。
//!
//! ─── 为什么 Windows 上不再需要 mac 那套 socket / bundle 戏法 ─────────────────
//! mac 走 unix socket 是因为只有被 `open -a` 拉起的 .app 才有**独立的 TCC 身份**
//! (辅助功能列表里才会出现「Neox Computer Use」这一条)。Windows 没有 TCC,
//! UIA 与 SendInput 不需要任何授权条目, 也没有 Gatekeeper 隔离属性那回事 ——
//! 于是「桥随包走的 exe + stdio」就够了, 少一层就少一处会坏的地方。
//!
//! ─── 为什么是常驻进程 ──────────────────────────────────────────────────────
//! 元素句柄活在进程里: dump 一次拿到 200 个元素、编上号, 模型说"点 7 号" ——
//! 7 号必须还能解引用。进程一退这张表就没了。常驻顺带省掉每次动作的进程启动
//! (exe 冷启 + UIA 初始化在 Windows 上是 100ms 量级, 比动作本身还贵)。
//!
//! 每次 dump 推进 epoch。拿旧 epoch 的编号来动作 → 明确报 `stale_handle`,
//! 而不是"没找到" —— 这两件事在诊断时完全不同。

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::net::TcpStream;
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: i64,
    pub op: String,

    /* 目标定位 */
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub pid: Option<i32>,
    #[serde(default)]
    pub target: Option<i64>,

    /* dump */
    #[serde(default)]
    pub budget: Option<usize>,
    #[serde(default)]
    pub all_windows: Option<bool>,
    /// 增量 dump: 给上一次拿到的 epoch。对不上就全量 (Windows 首版一律全量)。
    #[serde(default)]
    pub since: Option<i64>,

    /* 动作 */
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub modifiers: Option<Vec<String>>,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    /// drag 终点 (窗口内 0~1)。起点仍是 dx/dy。
    #[serde(default)]
    pub dx2: Option<f64>,
    #[serde(default)]
    pub dy2: Option<f64>,

    /* select_text */
    #[serde(default)]
    pub find: Option<String>,
    #[serde(default)]
    pub occurrence: Option<usize>,

    /* 提权握手: 宿主生成, 提升后的监听进程写进 %TEMP% 就绪文件, 防串台 */
    #[serde(default)]
    pub nonce: Option<String>,

    /* 截图 / watch */
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// watch 的目标 (TS 侧可以传 label 文本 / 角色名计数 / "screen")
    #[serde(default)]
    pub watch: Option<Value>,
}

enum Sink {
    Stdout,
    Tcp(TcpStream),
}

/// 回执出口一把锁 —— stdio 默认; `--listen` 提权进程改写到那条 TCP。
static OUT: Mutex<Sink> = Mutex::new(Sink::Stdout);

/// 提权监听进程连上宿主之后, 回执走 TCP, 不再写 stdout (stdout 没人读)。
pub fn set_tcp_sink(stream: TcpStream) {
    *OUT.lock().unwrap_or_else(|e| e.into_inner()) = Sink::Tcp(stream);
}

/// 发一行回执。**必须 flush**: 宿主在等这一行, 攒在缓冲里等于桥卡住。
pub fn emit(v: &Value) {
    let mut s = serde_json::to_string(v).unwrap_or_else(|_| {
        r#"{"id":-1,"ok":false,"code":"encode_failed","error":"回复序列化失败"}"#.to_string()
    });
    s.push('\n');
    let mut g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *g {
        Sink::Stdout => {
            let stdout = io::stdout();
            let mut lock = stdout.lock();
            let _ = lock.write_all(s.as_bytes());
            let _ = lock.flush();
        }
        Sink::Tcp(stream) => {
            let _ = stream.write_all(s.as_bytes());
            let _ = stream.flush();
        }
    }
}

/// 成功回执：`{id, ok:true, ...extra}`
pub fn ok(id: i64, extra: Value) -> Value {
    let mut base = json!({ "id": id, "ok": true });
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

/**
 * 发一条**事件**（不是回执）：没有 `id`，所以不匹配任何 pending 请求。
 *
 * 用途只有一个，但是关键的：把"指针刚刚落在哪"实时告诉宿主，好让它画一层
 * "正在被操控"的叠加层（虚拟光标 + 涟漪）。坐标是**物理屏幕像素**，而且是在
 * 真正点击的那一行算出来的 —— 宿主要靠它把光标画到正确的位置。
 *
 * 为什么走 stdout 而不是新开一条管道：这条流本来就一直开着、一直是 JSON-lines、
 * 已经有锁保证不撕行。老的宿主实现会自然忽略掉（它们按 `id` 找 pending），
 * 所以加这个不会破坏任何现有版本 —— 属于**前向兼容**的加法。
 */
pub fn event(kind: &str, extra: Value) -> Value {
    let mut base = json!({ "event": kind });
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

/// 失败回执。`code` 是机器可判的原因码 —— 宿主按它决定是"回报给模型"还是"引导用户"。
pub fn fail(id: i64, code: &str, message: &str, hint: Option<&str>) -> Value {
    let mut v = json!({ "id": id, "ok": false, "code": code, "error": message });
    if let Some(h) = hint {
        if let Some(o) = v.as_object_mut() {
            o.insert("hint".to_string(), json!(h));
        }
    }
    v
}

/// 启动握手行 (id=0)。mac 用它报 TCC 授权状态; Windows 恒 trusted=true
/// (没有 TCC), 但会另附 `privilege` (完整性 / UIAccess / 能否驱动管理员窗)。
/// **这一行必须照发**: 宿主的 `handleLine` 靠 id=0 判"桥起来了"。
pub fn handshake() -> Value {
    json!({
        "id": 0,
        "ok": true,
        "trusted": true,
        "screenRecording": true,
        "platform": "win32",
    })
}

/// `op=probe` —— 跟握手行同样的内容, 但带请求的 id (宿主在等它)。
pub fn probe(id: i64) -> Value {
    json!({
        "id": id,
        "ok": true,
        "trusted": true,
        "screenRecording": true,
        "platform": "win32",
    })
}
