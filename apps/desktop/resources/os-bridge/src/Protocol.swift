import Foundation

/*
 * neox-os-bridge —— 协议层
 * ═══════════════════════════════════════════════════════════════════════════
 * 宿主 (Electron 主进程) spawn 本进程, 用 **JSON-lines over stdio** 说话:
 * 一行一条请求, 一行一条回复, 靠 `id` 配对。跟 wakeWord 那座桥同一套形态。
 *
 * ─── 为什么是常驻进程, 不是一次一个命令 ────────────────────────────────────
 * 元素句柄 (AXUIElement) **活在进程里**。dump 一次拿到 200 个元素、编上号,
 * 模型说"点 7 号" —— 7 号必须还能解引用。进程一退这张表就没了, 只能靠
 * (role,label,frame) 反查, 那既慢又会认错人。
 * 常驻还顺带省掉每次动作的进程启动 (实测 swift 冷启 ~30ms, 比动作本身还贵)。
 *
 * 每次 dump 会推进 epoch。拿旧 epoch 的 id 来动作 → 明确报 `stale_handle`,
 * 而不是"没找到" —— 这两件事在诊断时完全不同 (browser_run 上踩过同样的坑)。
 */

// MARK: - 请求

struct Request: Decodable {
    let id: Int
    let op: String

    /* 目标定位 */
    let app: String?          // App 名 (localizedName) 或 bundleId
    let pid: Int32?
    let target: Int?          // 元素编号 (dump 给的)

    /* dump */
    let budget: Int?          // 节点预算, 默认 800 (实测各 App 都在这个数以下收敛)
    let allWindows: Bool?
    /** 增量: 给上一次拿到的 epoch, 只回变化的元素 (见 opDump 的说明)。对不上就全量。 */
    let since: Int?

    /* 动作 */
    let action: String?       // press / setValue / focus / showMenu / confirm / cancel
    let text: String?
    let key: String?
    let modifiers: [String]?
    let dx: Double?
    let dy: Double?
    let dx2: Double?
    let dy2: Double?

    /* select_text: 在元素文本里找哪一段, 以及第几次出现 (1 起)。find 不给 = 全选。 */
    let find: String?
    let occurrence: Int?

    /* 截图 */
    let path: String?
}

// MARK: - 回复

struct Element: Encodable {
    let id: Int
    let role: String
    let subrole: String?
    /** 内容标签: title/desc/value/help 的并集。实测 TextEdit 存储询问 sheet 上三个按钮的
        AXTitle 全是空, 文案只在 AXDescription 里 —— 只看 title 会判成"没找到"。 */
    let label: String
    /** 角色描述 ("close button")。**只用来给没有内容标签的元素兜个显示名, 不参与变化断言** ——
        AXGroup 的 roleDesc 是 "group", 混进签名会让整屏正文变成 "group·group·group"。 */
    let roleDesc: String?
    let value: String?
    let x: Int, y: Int, w: Int, h: Int
    let actionable: Bool
    let actions: [String]
    let enabled: Bool
    let focused: Bool
}

struct DumpResult: Encodable {
    let id: Int
    let ok: Bool
    let app: String
    let pid: Int32
    let epoch: Int
    let ms: Int
    let window: [String: Int]?
    let visited: Int
    let elements: [Element]
    /** AX 判瞎的量化判据 —— 少于阈值就该升到视觉层, 不靠猜。 */
    let axBlind: Bool
    let note: String?
    /* ─── 增量 dump 的三件套 (只在 since 命中时出现) ───────────────────────
     * elements 这时只装**新增和变了的**; 没变的只回编号, 消失的回编号。
     * 为什么没变的也要回编号而不是省掉: 调用方要能区分"这个元素没变"和"它没了" ——
     * 只发变化的话, 两者在回执里长得一模一样。 */
    var unchanged: [Int]? = nil
    var removed: [Int]? = nil
    /** true = 这是一份增量, 调用方得拿它跟上一份合并 */
    var incremental: Bool? = nil
}

/** 轻量签名的回执 —— 只有文本和计数, 没有元素。 */
struct SignatureResult: Encodable {
    let id: Int
    let ok: Bool
    let ms: Int
    let texts: [String]
    /** 全部标签 (含按钮上的字), 给 {label} 断言用 */
    let labels: [String]
    let counts: [String: Int]
}

struct OkResult: Encodable {
    let id: Int
    let ok: Bool
    var ms: Int? = nil
    var trusted: Bool? = nil
    var screenRecording: Bool? = nil
    var apps: [AppInfo]? = nil
    var path: String? = nil
    var value: String? = nil
    var epoch: Int? = nil
    /** op=icon: `data:image/png;base64,…` 的 App 图标。卡片上要有它, 用户才一眼看出在操作哪个 App。 */
    var icon: String? = nil
    /* ─── op=select_text 的回执 ────────────────────────────────────────────
     * 必须回真实选区, 不能只回 ok: 同一段文字在正文里出现多次时, "选错了地方"和
     * "选对了"在一句 ok 里长得一模一样。 */
    var selection: [String: Int]? = nil
    /** op=watch: 收到了哪些辅助功能通知。空 = 睡满了没动静 (**不代表界面没变**)。 */
    var fired: [String]? = nil
    /** op=show_menu: 走的哪条路 —— "ax" (AXShowMenu) 还是 "rightclick" (真发右键)。 */
    var via: String? = nil
}

struct ErrResult: Encodable {
    let id: Int
    let ok: Bool
    let error: String
    /** 机器可判的原因码。宿主按它决定是"回报给模型"还是"引导用户授权"。 */
    let code: String
    var hint: String? = nil
}

struct AppInfo: Encodable {
    let name: String
    let bundleId: String?
    let pid: Int32
    let frontmost: Bool
}

// MARK: - 输出

let stdoutQueue = DispatchQueue(label: "neox.osbridge.out")

/** 非 nil 时回复走它 (socket 模式)。stdio 模式下是 nil, 写 stdout。 */
var emitSink: ((String) -> Void)?

func emit<T: Encodable>(_ payload: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? enc.encode(payload), var s = String(data: data, encoding: .utf8) else { return }
    if let sink = emitSink {
        /* socket 模式: sink 自己加换行 */
        sink(String(s))
        return
    }
    s += "\n"
    stdoutQueue.sync {
        FileHandle.standardOutput.write(s.data(using: .utf8)!)
    }
}

func fail(_ id: Int, _ code: String, _ message: String, hint: String? = nil) {
    emit(ErrResult(id: id, ok: false, error: message, code: code, hint: hint))
}
