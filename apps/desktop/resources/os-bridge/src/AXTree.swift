import Cocoa
import ApplicationServices

/*
 * 元素树采集 —— 这套遍历策略是实测逼出来的, 别随手改回"全树 DFS"。
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-09 在本机三个真实 App 上量的:
 *
 *   策略                        Finder      Cursor(Electron)   Chrome 外壳
 *   ────────────────────────    ─────────   ────────────────   ───────────
 *   DFS 全树 (深度40/预算8000)   11013ms         166ms              —
 *   DFS 深度12 + 预算400           742ms           4ms  ← 只拿到 11 个元素!
 *   BFS + 视口裁剪 + 预算800        72ms          47ms            28ms
 *
 * 两条结论:
 *  ① **深度上限是错的**。Electron/Web 类应用的 AX 树很深, 深度 12 在 Cursor 上
 *     只捞到 11 个元素 (全树有 691 个) —— 等于把这类 App 整个漏掉, 而且不报错。
 *  ② **BFS + 视口裁剪**才是对的: 先拿浅层 (浅层就是用户看得见的那批), 预算花完为止;
 *     整块在窗口矩形外的子树直接不下钻 —— 省掉的是**整条子树的跨进程往返**,
 *     Finder 那 4600 个节点的列表就是这么从 11 秒压到 72ms 的。
 *
 * AX 属性读取全是跨进程 IPC。唯一的省法是"少问", 不是"问得快"。
 */

/**
 * 算"可交互"的角色。**只放真正能点的东西, 不放容器。**
 *
 * 第一版把 AXList / AXOutline / AXTabGroup / AXSegmentedControl 也放了进来,
 * 结果在 QQ 上"联系人列表"这个 AXList 容器混进了可交互清单, 跟真的"联系人"
 * tab 长得一样。点容器通常什么也不发生, 但界面可能因为别的原因变了 → 断言判过 →
 * **假通过**。容器的价值在它的子节点上, 它自己不该出现在动作清单里。
 */
let ACTIONABLE_ROLES: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuItem", "AXMenuButton", "AXComboBox", "AXSlider",
    "AXCell", "AXRow", "AXDisclosureTriangle", "AXIncrementor", "AXSearchField",
    "AXColorWell", "AXStepper",
]

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return false }
    return (v as? NSNumber)?.boolValue ?? false
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var v: CFArray?
    guard AXUIElementCopyActionNames(el, &v) == .success else { return [] }
    return (v as? [String]) ?? []
}

/*
 * 一次 IPC 取完一个节点的所有属性 —— 这套东西唯一真正的性能规矩。
 * ═══════════════════════════════════════════════════════════════════════════
 * AX 属性读取全是跨进程 IPC。一个节点要 role/subrole/title/desc/value/help/
 * roleDesc/pos/size/enabled/focused —— 逐个取就是 11 趟, 300 个节点 3300 趟。
 *
 * 这跟 CDP 那边的规矩是同一条 (见 COMPUTER_USE_DESIGN §4.6):
 * **别对每个节点往返, 一次把该看的看完**。AXUIElementCopyMultipleAttributeValues
 * 就是 AX 版的"一次 evaluate"。
 *
 * 实测 (5 次取中位数 —— 单次采样会被噪声骗, 我第一版就是这么误判成"批量更慢"的):
 *
 *   取法                              Finder    Cursor
 *   ──────────────────────────────    ──────    ──────
 *   逐属性 (裁剪后才读其余)             540ms     392ms
 *   一次批量 11 个属性                  269ms     163ms
 *   **先批量 2 个裁剪 + 通过的再批量 9**  261ms     144ms   ← 用这个
 *
 * 先只问 position+size 是因为**大部分节点会被视口裁掉**, 给它们读 11 个属性是白读。
 */
let GEO_ATTRS: [String] = [
    kAXPositionAttribute as String,      // 0
    kAXSizeAttribute as String,          // 1
]

let REST_ATTRS: [String] = [
    kAXRoleAttribute as String,          // 0
    "AXSubrole",                         // 1
    kAXTitleAttribute as String,         // 2
    kAXDescriptionAttribute as String,   // 3
    kAXValueAttribute as String,         // 4
    "AXHelp",                            // 5
    kAXRoleDescriptionAttribute as String, // 6
    kAXEnabledAttribute as String,       // 7
    kAXFocusedAttribute as String,       // 8
]

/** 明确不可交互的角色 —— 对它们再问一次 actions 是纯浪费的一趟 IPC。 */
let INERT_ROLES: Set<String> = [
    "AXStaticText", "AXImage", "AXGroup", "AXSplitter", "AXProgressIndicator",
    "AXScrollBar", "AXUnknown", "AXLayoutArea", "AXLayoutItem", "AXHeading",
]

struct NodeAttrs {
    var role = "?"
    var subrole: String?
    var title: String?
    var desc: String?
    var value: String?
    var help: String?
    var roleDesc: String?
    var frame: CGRect?
    var enabled = false
    var focused = false

    /**
     * 内容标签 —— title/desc/value/help 的并集, **不含 roleDescription**。
     *
     * 为什么要把 roleDesc 摘出去 (2026-09-09 在 QQ 上抓到):
     * AXGroup 这类无名容器的 roleDescription 是 "group"。把它当标签, 整屏正文
     * 就变成 "group · group · group · group…" —— 变化断言拿这种签名去比,
     * 界面明明换了一整页, 前后签名一模一样, 于是报"点了没反应"。**假失败比假成功更劝退**:
     * 模型会去改一个本来就对的步骤。
     *
     * roleDesc 仍然保留 (见 Element.roleDesc), 但只用来给**没有内容标签的可交互元素**
     * 兜个显示名 ("close button"), 不参与签名。
     */
    var label: String {
        for s in [title, desc, value, help] {
            if let s, !s.isEmpty { return String(s.prefix(120)) }
        }
        return ""
    }
}

private func asString(_ v: CFTypeRef?) -> String? {
    guard let v else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

private func multiValues(_ el: AXUIElement, _ attrs: [String]) -> [CFTypeRef]? {
    var values: CFArray?
    /* options 0 = 遇到不支持的属性不中断, 那一格返回一个 error 型 AXValue */
    guard AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
          let arr = values as? [CFTypeRef], arr.count == attrs.count
    else { return nil }
    return arr
}

/**
 * 只问几何 —— 大部分节点会被裁掉, 给它们读全套属性是白读。
 *
 * ⚠️ `CFGetTypeID(v) == AXValueGetTypeID()` **不足以说明取到了值**。
 * 批量取在属性不支持时会返回一个**错误包装**的 AXValue: CFTypeID 一样是 AXValue,
 * 但 `AXValueGetType` 是 `.axError` (rawValue 5)。
 *
 * 2026-09-09 真机: QQ 的窗口元素单独取 AXPosition 返回 -25205, 批量取则 err=0 但
 * 两个值都是 axError。我先写了个诊断程序只打印 CFTypeID, 于是得出"批量取是成功的"
 * 这个错误结论, 然后照着这个方向找了好几轮 —— **自己的诊断骗了自己**。
 * 判 AXValue 一律要看 AXValueGetType, 不能只看 CFTypeID。
 */
func geoOnly(_ el: AXUIElement) -> CGRect? {
    guard let arr = multiValues(el, GEO_ATTRS),
          CFGetTypeID(arr[0]) == AXValueGetTypeID(), CFGetTypeID(arr[1]) == AXValueGetTypeID()
    else { return nil }
    let pv = arr[0] as! AXValue
    let sv = arr[1] as! AXValue
    guard AXValueGetType(pv) == .cgPoint, AXValueGetType(sv) == .cgSize else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    guard AXValueGetValue(pv, .cgPoint, &p), AXValueGetValue(sv, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}

/** 过了裁剪的节点才读这一批。 */
func restAttrs(_ el: AXUIElement, frame: CGRect) -> NodeAttrs {
    var out = NodeAttrs()
    out.frame = frame
    guard let arr = multiValues(el, REST_ATTRS) else { return out }
    out.role = asString(arr[0]) ?? "?"
    out.subrole = asString(arr[1])
    out.title = asString(arr[2])
    out.desc = asString(arr[3])
    out.value = asString(arr[4])
    out.help = asString(arr[5])
    out.roleDesc = asString(arr[6])
    out.enabled = (arr[7] as? NSNumber)?.boolValue ?? false
    out.focused = (arr[8] as? NSNumber)?.boolValue ?? false
    return out
}

/**
 * 元素矩形。**必须走批量取**, 不能逐个问 AXPosition / AXSize。
 *
 * ─── 为什么 (2026-09-09 真机, 找了很久) ────────────────────────────────────
 * 实测 QQ / 备忘录 的窗口元素:
 *     单独取 AXPosition → err=-25205 (attributeUnsupported)
 *     单独取 AXSize     → err=-25205
 *     **批量取两个     → err=0, 两个 AXValue 都在**
 * 同一个元素、同一对属性, 取法不同结果不同。
 *
 * 后果非常具有迷惑性: opDump 的守卫是 `wins.first` **且** `axFrame(win)`, 第二段
 * 悄悄失败, 于是明明窗口就在屏幕上, 桥一路报 `no_window`。我先后怀疑过 NSWorkspace
 * 陈旧、findApp 匹配错进程、Catalyst 应用不暴露 AX —— 全不是, 就是这一行的取法。
 *
 * 遍历那条路 (geoOnly) 一直是批量取, 所以从来没暴露过 —— 一个东西两套口径, 坏的
 * 那套正好在入口上。现在统一。
 */
func axFrame(_ el: AXUIElement) -> CGRect? {
    return geoOnly(el)
}

/** 旧的逐个取法, 留着仅供对照 —— 别用它, 见上面 axFrame 的说明。 */
func axFrameSingleAttr(_ el: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?
    var sv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sv) == .success
    else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

/**
 * 元素标签。**四个来源取并集**, 不是只看 AXTitle。
 *
 * 实测 (TextEdit 的"是否存储"询问 sheet): 三个按钮的 AXTitle 全是空字符串,
 * 文案只在 AXDescription 里 ("Delete"/"Cancel"/"Save")。只按 title 找 →
 * 报"没找到不存储按钮" → 整条流程断在最后一步。
 */
func axLabel(_ el: AXUIElement) -> String {
    for attr in [kAXTitleAttribute as String, kAXDescriptionAttribute as String,
                 kAXValueAttribute as String, "AXHelp", kAXRoleDescriptionAttribute as String] {
        if let s = axString(el, attr), !s.isEmpty { return String(s.prefix(120)) }
    }
    return ""
}

/**
 * 编号 → 句柄。句柄只在本进程内有效, 所以进程必须常驻。
 *
 * ─── 编号一旦发出去就**永久**指向同一个元素 ────────────────────────────────
 * 第一版每次 dump 清空重编号 (1,2,3…), 结果在 QQ 上抓到一个**假通过**:
 * 脚本第 0 步带 expectChange, 断言内部会反复 dump 去看界面变了没 —— 那些 dump
 * 把表重建了。等第 1 步拿着模型看到的 `#18` 去点, `#18` 已经是另一个元素了。
 * 它点了个别的东西, 界面确实也变了, 于是**报成功**。假通过比假失败糟得多。
 *
 * 所以表只增不清: 每次 dump 从上次的号往后接着编。元素没了就在动作时明确
 * 报 stale_handle (AXError.invalidUIElement) —— 那是清清楚楚的失败, 不是猜。
 * 只有换了目标 App 才整表清空 (另一个进程的句柄留着没有意义)。
 */
final class ElementTable {
    private(set) var epoch = 0
    private var handles: [Int: AXUIElement] = [:]
    private var order: [Int] = []
    private(set) var ownerPid: pid_t = 0
    private var nextId = 1

    /**
     * 身份 → 编号。**同一个元素在两次 dump 里必须是同一个号** (2026-09-09)。
     *
     * 原来是按遍历顺序从 nextId 往后编, 于是同一个「发送」按钮这次是 #12 下次是 #47。
     * 后果有两层:
     *   ① 模型每次都得重新记编号 —— 它拿上一轮看到的号来点, 点的是别的东西
     *      (句柄表没清, 所以**能点成功**, 只是点错了 —— 假通过比假失败糟得多);
     *   ② 没法做 diff: 全表的号每次都变, "哪些变了"根本无从谈起。
     *
     * 身份 = 角色 + 标签 + 角色描述 + **窗口内的粗略格位**。
     * 为什么要格位: 计算器上 0-9 十个按钮的 role/label 各不相同没问题, 但列表里
     * 十行同名的「打开」就全撞一起了。格位按 32px 取整 —— 细了会因为一像素抖动
     * 认不出是同一个 (滚动条、动画), 粗了又会把相邻两个当成一个。
     */
    private var idByIdentity: [String: Int] = [:]

    /** 上限。长会话里一直 dump 会无限涨, 到顶就按先进先出淘汰最老的。 */
    private let capacity = 5000

    /** 开始一次 dump。返回这次该从哪个号开始编 (只用于身份查不到时的新号)。 */
    func beginDump(pid: pid_t) -> Int {
        epoch += 1
        if pid != ownerPid {
            handles.removeAll(keepingCapacity: true)
            order.removeAll(keepingCapacity: true)
            idByIdentity.removeAll(keepingCapacity: true)
            ownerPid = pid
        }
        return nextId
    }

    /** 身份字符串 —— 只由这一处生成, 别在别的地方再拼一份 */
    static func identity(role: String, label: String, roleDesc: String?, x: Int, y: Int) -> String {
        "\(role)|\(label)|\(roleDesc ?? "")|\(x / 32),\(y / 32)"
    }

    /**
     * 拿这个身份该用的编号: 见过就复用, 没见过发新号。
     * 复用时**句柄要换成这一次拿到的那个** —— 旧句柄可能已经失效 (界面重建过),
     * 只保留编号的连续性, 不保留过期的引用。
     */
    func idFor(identity: String, element: AXUIElement) -> Int {
        if let existing = idByIdentity[identity] {
            handles[existing] = element
            return existing
        }
        let id = nextId
        nextId += 1
        idByIdentity[identity] = id
        put(id, element)
        return id
    }

    func put(_ id: Int, _ el: AXUIElement) {
        handles[id] = el
        order.append(id)
        nextId = max(nextId, id + 1)
        while order.count > capacity {
            let dropped = order.removeFirst()
            handles.removeValue(forKey: dropped)
            /* 身份映射也要跟着淘汰, 否则表越缩它越大, 而且会指向一个没有句柄的号 */
            if let key = idByIdentity.first(where: { $0.value == dropped })?.key {
                idByIdentity.removeValue(forKey: key)
            }
        }
    }

    func get(_ id: Int) -> AXUIElement? { handles[id] }

    var count: Int { handles.count }
}

let table = ElementTable()

struct DumpOutcome {
    var elements: [Element]
    var visited: Int
    var ms: Int
    var window: CGRect?
}

/**
 * BFS + 视口裁剪 + 节点预算。
 *
 * - `clip`: 窗口矩形。跟它不相交的元素**连同整棵子树**跳过。
 * - `budget`: 访问节点上限。实测 800 足够 —— Finder/Cursor/Chrome 都在这个数以下收敛,
 *   给 1500 拿到的结果一模一样。给太大只是把最坏情况的时间放回来。
 */
/**
 * 只采"界面签名"要用的东西 —— 内容文本 + 各角色计数, **不构造元素、不进编号表**。
 *
 * ─── 为什么单独一条路 (2026-09-09 真机) ────────────────────────────────────
 * 变化断言每隔几百毫秒就要看一眼界面变了没有, 而它只需要文本。走完整 dump 的话,
 * 每一轮都要额外付: 每个节点多一趟 actions 的 IPC、构造几百个 Element、序列化成
 * JSON、TS 侧再解析回来、还要往编号表里塞几百条。
 * QQ 上一次完整 dump 0.6~3 秒, 一个两步脚本十几次 —— 界面上就是 31.6s 那种数字。
 *
 * 这里省掉的是**每节点一趟 actions IPC** 和整个序列化, 遍历本身还是那套
 * BFS + 视口裁剪 + 预算, 所以签名口径跟 dump 完全一致 (口径不一致会造出
 * "我这边说变了那边说没变"的假象, 比慢更糟)。
 */
func collectSignature(_ root: AXUIElement, clip: CGRect, budget: Int) -> (texts: [String], labels: [String], counts: [String: Int], ms: Int) {
    let t0 = Date()
    var texts: [String] = []
    /* 全部标签, **含可交互元素** —— {label:"发送"} 这类断言等的往往就是一个按钮。
     * texts 不收按钮上的字 ('screen' 断言要的是正文), 所以 label 断言以前只能退回完整 dump。 */
    var labels: [String] = []
    var counts: [String: Int] = [:]
    var visited = 0
    var queue = [root]

    while !queue.isEmpty && visited < budget {
        var next: [AXUIElement] = []
        for el in queue {
            if visited >= budget { break }
            visited += 1
            guard let f = geoOnly(el), f.width > 1, f.height > 1 else {
                next += axChildren(el)
                continue
            }
            if !f.intersects(clip) { continue }
            let a = restAttrs(el, frame: f)
            counts[a.role, default: 0] += 1
            /* 跟 dump 的 label 同口径: 内容标签, 不含 roleDescription。
             * 可交互与否也要跟 dump 一致 —— TS 那边的 contentLabels 只收非可交互的。 */
            let label = a.label
            if !label.isEmpty {
                let short = String(label.replacingOccurrences(of: "\n", with: " ").prefix(40))
                labels.append(short)
                if !ACTIONABLE_ROLES.contains(a.role) { texts.append(short) }
            }
            next += axChildren(el)
        }
        queue = next
    }
    return (texts, labels, counts, Int(Date().timeIntervalSince(t0) * 1000))
}

func dumpWindow(_ root: AXUIElement, clip: CGRect, budget: Int, into table: ElementTable, startId: Int) -> DumpOutcome {
    let t0 = Date()
    var out: [Element] = []
    var visited = 0
    _ = startId   /* 编号现在由 ElementTable.idFor 按身份给, 不再按遍历顺序递增 */
    var queue = [root]

    while !queue.isEmpty && visited < budget {
        var next: [AXUIElement] = []
        for el in queue {
            if visited >= budget { break }
            visited += 1

            /* 第一趟只问几何 (2 个属性) —— 多数节点会被下一行裁掉, 读全套是白读 */
            guard let f = geoOnly(el), f.width > 1, f.height > 1 else {
                /* 没有几何信息的容器照样要下钻 —— 有些 App 的中间层不报 frame */
                next += axChildren(el)
                continue
            }
            /* 整块在视口外 → 连同子树一起丢。这一条是 Finder 从 11s 到 72ms 的全部原因 */
            if !f.intersects(clip) { continue }

            /* 过了裁剪才读其余 9 个属性, 仍然是一趟 IPC */
            let a = restAttrs(el, frame: f)
            let label = a.label
            let roleActionable = ACTIONABLE_ROLES.contains(a.role)
            /* actions 又是一趟 IPC (Finder 上 183 个可交互节点 = 183 趟, 实测多花 ~260ms)。
             * 所以只对**角色认不出来**的节点问 —— 那才是唯一需要靠 actions 判定的情况。
             * 角色已经在白名单里的, 直接给 AXPress, 不必再问一遍系统。 */
            let actions: [String]
            if roleActionable {
                actions = ["AXPress"]
            } else if !label.isEmpty && !INERT_ROLES.contains(a.role) {
                actions = axActions(el)
            } else {
                actions = []
            }
            let isActionable = roleActionable || actions.contains("AXPress")

            if isActionable || !label.isEmpty {
                /* 稳定编号: 同一个元素跨 dump 拿同一个号 (见 ElementTable.idFor) */
                let id = table.idFor(
                    identity: ElementTable.identity(role: a.role, label: label, roleDesc: a.roleDesc,
                                                    x: Int(f.minX), y: Int(f.minY)),
                    element: el)
                out.append(Element(
                    id: id,
                    role: a.role,
                    subrole: a.subrole,
                    label: label,
                    roleDesc: a.roleDesc,
                    value: a.value.map { String($0.prefix(200)) },
                    x: Int(f.minX), y: Int(f.minY), w: Int(f.width), h: Int(f.height),
                    actionable: isActionable,
                    actions: actions,
                    enabled: a.enabled,
                    focused: a.focused
                ))
            }
            next += axChildren(el)
        }
        queue = next
    }

    return DumpOutcome(elements: out, visited: visited, ms: Int(Date().timeIntervalSince(t0) * 1000), window: clip)
}
