//! UI Automation 感知层 —— 元素树采集 + 编号表
//!
//! ═══════════════════════════════════════════════════════════════════════════
//! 对应 mac 的 `AXTree.swift`。那边的结论一条不改地搬过来了, 因为每一条都是
//! 实测逼出来的 (见那份文件头的三行表格):
//!
//!   ① **BFS, 不是 DFS**。mac 上 DFS 深度 12 在 Electron 应用的 AX 树上只捞到
//!      11 个元素 (全树 691) —— 等于把这类应用整个漏掉, 而且不报错。
//!      浅层就是用户看得见的那批, 先拿它。
//!   ② **视口裁剪**: 整块落在窗口矩形外的子树直接不下钻。省掉的是整条子树的
//!      跨进程往返 (mac 上 Finder 4600 个节点 11s → 72ms 靠的就是这条)。
//!   ③ **一次取完一个节点的所有属性**, 别逐属性问。mac 那边是
//!      AXUIElementCopyMultipleAttributeValues, Windows 这边对应的是 **CacheRequest**:
//!      把要用的属性 + 要探的 pattern 一次性登记, 之后每个元素的属性读取都在本地,
//!      不再跨进程。这条路比 mac 的还干净 —— UIA 是官方为此设计的。
//!
//! ─── Windows 与 mac 的两处必然差异 ──────────────────────────────────────────
//!   · mac 的 AX 树在 Chromium 里不吐网页内容, Windows 的 UIA **吐** —— 所以
//!     浏览器窗口在 Windows 上能读到网页元素。不过网页场景本来就该走 CDP 工具
//!     (computerRun 的分派规则), 这里只是不会瞎。
//!   · mac 的 action 清单是"角色白名单 + actions 数组"; Windows 是
//!     "ControlType 白名单 + pattern 可用性"。语义对齐, 名字本地化
//!     (Button/Edit/ListItem… 而不是 AXButton/AXTextField), 模型看到的编号体系一致。

use windows::core::IUnknown;
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::*;

/// 一次 dump 的节点上限 (对应 mac 的 budget 默认 800)。各个 App 实测都在这以下收敛。
pub const DEFAULT_BUDGET: usize = 800;

/// 会下钻但要防爆炸的遍历上限系数 —— 预算花完就停, 别把整棵树走完。
const VISIT_FACTOR: usize = 4;

/**
 * 走哪棵树。UIA 同一个窗口有三套视图, 过滤规则不同:
 *
 * | 视图 | 留什么 | 我们怎么用 |
 * |---|---|---|
 * | ControlView | 只留"控件" (按钮/输入框/列表项…) | **默认**。用户看得见、能操作的就是这些 |
 * | RawView | 全都要, 不做任何过滤 | **兜底**。ControlView 读空了才来问它 |
 * | ContentView | 控件 + 内容 (文本也算) | Chromium @ 候选经常只活在这棵树上, 拼进主表 |
 *
 * 为什么值得留一条 RawView 的门: 自绘 / 老式应用经常出现"ControlView 一个节点都没有,
 * RawView 里却还挂着节点" —— 那是**我们问错了树**, 不是应用没发布。这一条不需要
 * 截图也不需要 OCR, 仍然按元素编号操作, 精度不打折。
 */
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum View {
    Control,
    Raw,
    Content,
}

/// 真正能点的 ControlType。**只放能点的, 不放容器。**
///
/// mac 那份注释值得照抄一遍: 第一版把 List/Outline/TabGroup 也放进来, 结果 QQ 上
/// "联系人列表"这个容器混进了可交互清单, 跟真的"联系人"tab 长得一样。点容器通常
/// 什么也不发生, 但界面可能因为别的原因变了 → 断言判过 → **假通过**。
const ACTIONABLE_TYPES: &[i32] = &[
    50000, // Button
    50002, // CheckBox
    50003, // ComboBox
    50004, // Edit
    50005, // Hyperlink
    50007, // ListItem
    50011, // MenuItem
    50013, // RadioButton
    50015, // Slider
    50016, // Spinner
    50019, // TabItem
    50024, // TreeItem
    50029, // DataItem
    50031, // SplitButton
];

/// 承载"内容文本"的类型 —— 它们不可交互, 但**必须进元素表**:
/// 上层的变化断言与文本摘要都是从这批里取的 (computerRun.ts: `digest` 用的是
/// `label && !actionable`; 轻量签名只收非可交互的内容文本)。
const TEXT_TYPES: &[i32] = &[
    50020, // Text
    50030, // Document
    /* Chromium/Electron (QQ NT) 大量节点只报 Custom。没有 invoke 的当内容文本进 digest,
     * 有 invoke 的走上面 actionable (Custom 不在 NEVER_ACTIONABLE)。 */
    50025, // Custom
];

/// **即便探到 pattern 也不算可交互**的类型 —— 容器与窗口装饰。
///
/// 实测逼出来的: 记事本 dump 第一版把标题栏和滚动条都标成了可交互 —— 因为
/// UIA 在它们身上也报 ValuePattern / RangeValuePattern。给模型一张"标题栏 1 号,
/// 滚动条 2 号"的动作清单, 它就可能去点它们: 点容器通常什么也不发生, 但界面
/// 可能因为别的原因变了 → 断言判过 → **假通过** (mac 在 QQ 的"联系人列表"容器上
/// 踩的是同一个坑, 见 AXTree.swift 的 ACTIONABLE_ROLES 注释)。
const NEVER_ACTIONABLE: &[i32] = &[
    50006, // Image
    50008, // List
    50009, // Menu
    50010, // MenuBar
    50012, // ProgressBar
    50014, // ScrollBar
    50017, // StatusBar
    50018, // Tab
    50021, // ToolBar
    50022, // ToolTip
    50023, // Tree
    50026, // Group
    50027, // Thumb
    50028, // DataGrid
    50033, // Pane
    50034, // Header
    50035, // HeaderItem
    50036, // Table
    50037, // TitleBar
    50038, // Separator
    50039, // SemanticZoom
    50040, // AppBar
];

/// 要探的 pattern —— 名字是给模型看的动作词 (跟 mac 的 actions 数组同口径)。
const PATTERNS: &[(i32, &str)] = &[
    (10000, "invoke"),      // InvokePattern
    (10010, "select"),      // SelectionItemPattern
    (10002, "setValue"),    // ValuePattern
    (10005, "expand"),      // ExpandCollapsePattern
    (10015, "toggle"),      // TogglePattern
    (10017, "scrollTo"),    // ScrollItemPattern
    (10003, "rangeValue"),  // RangeValuePattern
    (10001, "selection"),   // SelectionPattern
    (10014, "text"),        // TextPattern
    (10018, "legacy"),      // LegacyIAccessiblePattern
];

/// 模型能用编号引用的交互 pattern —— 有它就算"可交互"。
/// (`legacy` / `text` / `selection` 只是可读性, 不代表能点。)
const INTERACTIVE_PATTERNS: &[&str] = &["invoke", "select", "setValue", "expand", "toggle", "rangeValue"];

#[derive(Clone, Debug)]
pub struct Row {
    pub id: i64,
    pub role: String,
    pub subrole: Option<String>,
    pub label: String,
    pub role_desc: Option<String>,
    pub value: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub actionable: bool,
    pub actions: Vec<String>,
    pub enabled: bool,
    pub focused: bool,
}

pub struct Uia {
    pub auto: IUIAutomation,
}

/// 采集到的一个元素 —— 属性 (给模型看) + 句柄 (给后续动作解引用)。
/// 两个都要: 上层只认编号, 真正点的时候得回到元素本身。
pub struct Collected {
    pub row: Row,
    pub el: IUIAutomationElement,
}

impl Uia {
    /// 起一个 UIA 会话。**进程内只做一次** —— COM 初始化 + CUIAutomation 实例
    /// 都是进程级的, 而桥是常驻进程。
    pub fn new() -> windows::core::Result<Self> {
        unsafe {
            /* UIA 要求 STA (单线程套间)。返回 S_FALSE 也算成功 (已初始化过) */
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let auto: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            Ok(Self { auto })
        }
    }

    /// 一次登记所有要读的属性与要探的 pattern —— 这套东西唯一真正的性能规矩。
    fn cache_request(&self) -> windows::core::Result<IUIAutomationCacheRequest> {
        let cache = unsafe { self.auto.CreateCacheRequest()? };
        unsafe {
            for p in [
                UIA_BoundingRectanglePropertyId,
                UIA_ControlTypePropertyId,
                UIA_NamePropertyId,
                UIA_LocalizedControlTypePropertyId,
                UIA_HelpTextPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_ValueValuePropertyId,
            ] {
                cache.AddProperty(p)?;
            }
            for (id, _) in PATTERNS {
                cache.AddPattern(UIA_PATTERN_ID(*id))?;
            }
        }
        Ok(cache)
    }

    /// 某个句柄对应的 UIA 元素 (实时, 不带缓存)。
    pub fn element_from_hwnd(&self, hwnd: windows::Win32::Foundation::HWND) -> windows::core::Result<IUIAutomationElement> {
        unsafe { self.auto.ElementFromHandle(hwnd) }
    }

    /// 从窗口开始 BFS 采集。
    ///
    /// 返回 (元素表, 访问过的节点数)。`win` 是目标窗口矩形 (视口裁剪的边界)。
    ///
    /// `raw = true` 时改用 **RawView** 遍历 —— 见 [`View`] 的说明。
    pub fn collect(
        &self,
        root: &IUIAutomationElement,
        win: RECT,
        budget: usize,
    ) -> (Vec<Collected>, usize) {
        self.collect_view(root, win, budget, View::Control)
    }

    /// 按视图采集。ControlView 是默认 (用户看到的控件), RawView 是"全都要"。
    pub fn collect_view(
        &self,
        root: &IUIAutomationElement,
        win: RECT,
        budget: usize,
        view: View,
    ) -> (Vec<Collected>, usize) {
        let budget = if budget == 0 { DEFAULT_BUDGET } else { budget };
        /* UIA 有三棵树 (同一个窗口, 三套可见性规则):
         *   RawView     —— 全都要。ControlView/ContentView 过滤掉的东西它都留着。
         *   ControlView —— 默认。只留"控件" (按钮/输入框/列表项…), 用户能操作的那些。
         *   ContentView —— 控件 + 内容。
         * 自绘 / 老式应用经常是"ControlView 全被过滤光, RawView 里其实还有节点" ——
         * 这就是"读不到元素"的第一种可救情况 (不是没发布, 是我们问的那棵树不对)。 */
        let walker = match unsafe {
            match view {
                View::Control => self.auto.ControlViewWalker(),
                View::Raw => self.auto.RawViewWalker(),
                View::Content => self.auto.ContentViewWalker(),
            }
        } {
            Ok(w) => w,
            Err(_) => return (Vec::new(), 0),
        };
        let cache = match self.cache_request() {
            Ok(c) => c,
            Err(_) => return (Vec::new(), 0),
        };

        let mut rows: Vec<Collected> = Vec::new();
        let mut queue: std::collections::VecDeque<IUIAutomationElement> =
            std::collections::VecDeque::new();
        queue.push_back(root.clone());

        let mut visited: usize = 0;
        let mut next_id: i64 = 0;

        while let Some(el) = queue.pop_front() {
            if rows.len() >= budget || visited >= budget * VISIT_FACTOR {
                break;
            }
            visited += 1;

            if let Some(row) = self.read_row(&el, next_id) {
                next_id += 1;
                rows.push(Collected { row, el: el.clone() });
            }

            /* 子节点: 带缓存取 (一次 IPC 拿到这个节点的全部登记属性) */
            let mut child = match unsafe { walker.GetFirstChildElementBuildCache(&el, &cache) } {
                Ok(c) => c,
                Err(_) => continue,
            };
            loop {
                let r = unsafe { child.CachedBoundingRectangle() }.unwrap_or_default();
                /* 视口裁剪: 整块在窗口外的子树直接不下钻 —— 省的是整条子树 */
                if in_window(r, win) {
                    queue.push_back(child.clone());
                }
                match unsafe { walker.GetNextSiblingElementBuildCache(&child, &cache) } {
                    Ok(n) => child = n,
                    Err(_) => break,
                }
            }
        }

        name_adjacent_split_buttons(&mut rows);
        (rows, visited)
    }

    /// 轻量采集: 只要"内容文本 + 各角色计数", 不构造元素表、不探 actions。
    /// 断言专用的开销必须比完整 dump 小一个量级 (mac 那边同一个理由)。
    pub fn signature(&self, root: &IUIAutomationElement, win: RECT, budget: usize) -> (Vec<String>, Vec<String>, Vec<(String, usize)>, usize) {
        let (rows, visited) = self.collect(root, win, budget);
        let mut texts: Vec<String> = Vec::new();
        /* 全部标签, 含可交互元素 —— {label:"发送"} 断言等的往往是个按钮 (mac 桥同款) */
        let mut labels: Vec<String> = Vec::new();
        let mut counts: Vec<(String, usize)> = Vec::new();
        for c in &rows {
            let r = &c.row;
            if let Some(i) = counts.iter().position(|(k, _)| *k == r.role) {
                counts[i].1 += 1;
            } else {
                counts.push((r.role.clone(), 1));
            }
            /* 断言看的是"界面上有没有这段文字" —— 只收非可交互的内容文本,
             * 跟上层 signatureFromProbe 的口径严格一致 (它明说按钮上的字看不到)。 */
            if !r.actionable && !r.label.is_empty() && !texts.contains(&r.label) {
                texts.push(r.label.clone());
            }
            if !r.label.is_empty() && !labels.contains(&r.label) {
                labels.push(r.label.clone());
            }
        }
        (texts, labels, counts, visited)
    }

    /// 元素表里第 id 号那个元素的**实时**句柄。dump 的缓存句柄只用来显示,
    /// 真动作要拿实时 pattern, 否则可能点到过期的位置。
    pub fn live_pattern<'a, T: windows::core::Interface>(&self, el: &'a IUIAutomationElement, pattern: i32) -> Option<T> {
        unsafe { el.GetCurrentPatternAs::<T>(UIA_PATTERN_ID(pattern)).ok() }
    }

    /// 读一个元素的属性, 判它该不该进元素表。
    fn read_row(&self, el: &IUIAutomationElement, id: i64) -> Option<Row> {
        let ct = unsafe { el.CachedControlType() }.map(|c| c.0).unwrap_or(0);
        let offscreen = unsafe { el.CachedIsOffscreen() }
            .map(|b| b.as_bool())
            .unwrap_or(false);
        if offscreen {
            return None;
        }
        let rect = unsafe { el.CachedBoundingRectangle() }.unwrap_or_default();
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }

        let name = bstr(unsafe { el.CachedName() });
        let help = bstr(unsafe { el.CachedHelpText() });
        let role_desc = {
            let s = bstr(unsafe { el.CachedLocalizedControlType() });
            if s.is_empty() { None } else { Some(s) }
        };
        let actions = self.patterns_of(el);
        let has_interactive = actions
            .iter()
            .any(|a| INTERACTIVE_PATTERNS.contains(&a.as_str()));
        let value = if actions.iter().any(|a| a == "setValue") {
            unsafe {
                el.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .ok()
                    .and_then(|p| p.CachedValue().ok())
                    .map(|b| b.to_string())
                    .filter(|s| !s.is_empty())
            }
        } else {
            None
        };

        let label = if !name.is_empty() { name } else { help };
        let mut actionable = !NEVER_ACTIONABLE.contains(&ct)
            && (ACTIONABLE_TYPES.contains(&ct) || has_interactive);
        let is_text = TEXT_TYPES.contains(&ct);
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        /* IM/浏览器工具栏: 「图片」「文件」经常是带名字的小 Image, 进了 NEVER_ACTIONABLE
         * 就从元素表消失, 模型只能猜 click_at. 小且有名字的当按钮收. */
        if named_toolbar_image(ct, w, h, &label) {
            actionable = true;
        }
        /* 会话行 / @ 候选经常是 Text/Custom: 不进 actionable 模型就只能猜 click_at. */
        if named_content_row(ct, w, h, &label) {
            actionable = true;
        }

        let include = if actionable {
            true
        } else {
            is_text && !label.is_empty()
        };
        if !include {
            return None;
        }

        Some(Row {
            id,
            role: role_name(ct),
            subrole: None,
            label,
            role_desc,
            value,
            x: rect.left,
            y: rect.top,
            w,
            h,
            actionable,
            actions,
            enabled: unsafe { el.CachedIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true),
            focused: unsafe { el.CachedHasKeyboardFocus() }
                .map(|b| b.as_bool())
                .unwrap_or(false),
        })
    }

    /// 探这个元素有哪些 pattern 可用。**读的是缓存**, 不产生逐元素的跨进程往返。
    fn patterns_of(&self, el: &IUIAutomationElement) -> Vec<String> {
        let mut out = Vec::new();
        for (id, name) in PATTERNS {
            if unsafe {
                el.GetCachedPatternAs::<IUnknown>(UIA_PATTERN_ID(*id))
            }
            .is_ok()
            {
                out.push((*name).to_string());
            }
        }
        out
    }

    /* ─── 动作侧用到的实时 pattern 取用 (b3) ───────────────────────────────
     * 跟上面 patterns_of 的差别: 这里走 GetCurrentPatternAs —— dump 出来的缓存元素
     * 只用来"显示", 真动作要拿实时 pattern, 否则会点到过期的位置。 */
    pub fn invoke(&self, el: &IUIAutomationElement) -> bool {
        unsafe {
            match el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                Ok(p) => p.Invoke().is_ok(),
                Err(_) => false,
            }
        }
    }

    pub fn select_item(&self, el: &IUIAutomationElement) -> bool {
        unsafe {
            match el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            {
                Ok(p) => p.Select().is_ok(),
                Err(_) => false,
            }
        }
    }

    pub fn set_value(&self, el: &IUIAutomationElement, text: &str) -> bool {
        unsafe {
            match el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                Ok(p) => p.SetValue(&windows::core::BSTR::from(text)).is_ok(),
                Err(_) => false,
            }
        }
    }

    /// 元素的实时值 (ValuePattern.CurrentValue)。读不出来返回 None ——
    /// 大多数静态文本控件没有 ValuePattern, 这时"值"要去看 name。
    pub fn live_value(&self, el: &IUIAutomationElement) -> Option<String> {
        unsafe {
            el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
                .and_then(|p| p.CurrentValue().ok())
                .map(|b| b.to_string())
        }
    }

    /// 元素当前是否还能解析 (dump 之后界面可能已经变了)。
    pub fn is_alive(&self, el: &IUIAutomationElement) -> bool {
        unsafe { el.CurrentBoundingRectangle() }.is_ok()
    }

    /// 元素的实时矩形 —— 坐标点击的落点。
    pub fn live_rect(&self, el: &IUIAutomationElement) -> Option<RECT> {
        unsafe { el.CurrentBoundingRectangle() }.ok()
    }
}

/// 多根采集之后把编号重排成 0..n, 模型只认这一套。
pub fn reindex(cols: &mut [Collected]) {
    for (i, c) in cols.iter_mut().enumerate() {
        c.row.id = i as i64;
    }
}

fn same_element(a: &Row, b: &Row) -> bool {
    a.role == b.role
        && a.label == b.label
        && (a.x - b.x).abs() <= 2
        && (a.y - b.y).abs() <= 2
        && (a.w - b.w).abs() <= 2
        && (a.h - b.h).abs() <= 2
}

/// 把另一棵视图里多出来的节点拼进主表。返回新增条数。
pub fn merge_unique(dst: &mut Vec<Collected>, extra: Vec<Collected>, cap: usize) -> u32 {
    let mut added = 0u32;
    for c in extra {
        if dst.len() >= cap {
            break;
        }
        if dst.iter().any(|d| same_element(&d.row, &c.row)) {
            continue;
        }
        dst.push(c);
        added += 1;
    }
    added
}

/// 「发送」右边那个没名字的小按钮 = 发送菜单。不补名字模型会拿错编号。
pub fn name_adjacent_split_buttons(cols: &mut [Collected]) {
    let n = cols.len();
    for i in 0..n {
        if cols[i].row.role != "Button" || !cols[i].row.label.trim().is_empty() {
            continue;
        }
        let y = cols[i].row.y;
        let x = cols[i].row.x;
        let mut left: Option<usize> = None;
        for j in 0..n {
            if i == j || cols[j].row.role != "Button" {
                continue;
            }
            let lab = cols[j].row.label.trim();
            if lab.is_empty() {
                continue;
            }
            if (cols[j].row.y - y).abs() > 8 {
                continue;
            }
            if cols[j].row.x >= x {
                continue;
            }
            if cols[j].row.x + cols[j].row.w + 12 < x {
                continue;
            }
            left = Some(j);
        }
        if let Some(j) = left {
            cols[i].row.label = format!("{}菜单", cols[j].row.label.trim());
        }
    }
}

fn bstr(v: windows::core::Result<windows::core::BSTR>) -> String {
    v.map(|b| b.to_string()).unwrap_or_default()
}

/// 一个矩形是不是落/交在窗口内 (视口裁剪的判据)。
fn in_window(r: RECT, win: RECT) -> bool {
    if r.right <= r.left || r.bottom <= r.top {
        return false; /* 空矩形: 不可见或不可布局 */
    }
    !(r.right <= win.left || r.left >= win.right || r.bottom <= win.top || r.top >= win.bottom)
}

/// 窗口装饰 (非客户区) —— 最小化/最大化/关闭/系统菜单。
///
/// 为什么要单独认它们: 实测一个**什么都没发布给 UIA** 的 Java(Swing) 窗口, dump 出来是
/// 4 个元素, 全是这四个装饰 —— 界面里的 label / 输入框 / 按钮一个都读不到。如果把它们
/// 算进"有元素", axBlind 就会判成 false, 模型会以为这个应用能按编号操作, 然后每次
/// 都点空。所以判"瞎不瞎"要把装饰元素剔掉 (它们照旧留在元素表里 —— 关窗口还是有用的)。
pub fn is_chrome(row: &Row) -> bool {
    if row.role == "TitleBar" {
        return true;
    }
    let l = row.label.trim();
    matches!(
        l,
        "最小化" | "最大化" | "关闭" | "还原" | "系统"
            | "Minimize" | "Maximize" | "Close" | "Restore" | "System"
    )
}

/// UIA ControlType → 短角色名。名字是给模型看的, 跟 mac 的 AXButton/AXTextField
/// 同口径但用 Windows 的词汇 (上层 toSnapshot 会去掉开头的 AX, 这里是中性名)。
pub fn role_name(ct: i32) -> String {
    let n = match ct {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => return format!("Type{ct}"),
    };
    n.to_string()
}

/// 带名字的小 Image —— 聊天工具栏「图片/文件/表情」常见形态。
/// 大图（头像、消息里的照片）不收, 避免模型去点内容图.
pub fn named_toolbar_image(ct: i32, w: i32, h: i32, label: &str) -> bool {
    const IMAGE: i32 = 50006;
    const MAX: i32 = 48;
    if ct != IMAGE || w <= 0 || h <= 0 || w > MAX || h > MAX {
        return false;
    }
    let l = label.trim();
    if l.is_empty() {
        return false;
    }
    let lower = l.to_ascii_lowercase();
    if lower.contains("avatar") || lower.contains("logo") {
        return false;
    }
    l.chars().count() <= 4
}

/// 聊天会话 / @ 候选: 有名字的一行 Text/Custom, 点中心就能选中。
pub fn named_content_row(ct: i32, w: i32, h: i32, label: &str) -> bool {
    const TEXT: i32 = 50020;
    const CUSTOM: i32 = 50025;
    if ct != TEXT && ct != CUSTOM {
        return false;
    }
    let l = label.trim();
    if l.is_empty() || l.chars().count() > 80 {
        return false;
    }
    h >= 16 && h <= 88 && w >= 40
}

#[cfg(test)]
mod tests {
    use super::{named_content_row, named_toolbar_image};

    #[test]
    fn named_small_image_is_toolbar() {
        assert!(named_toolbar_image(50006, 32, 28, "图片"));
        assert!(named_toolbar_image(50006, 32, 28, "文件"));
        assert!(!named_toolbar_image(50006, 32, 28, "   "));
        assert!(!named_toolbar_image(50006, 200, 160, "照片"));
        assert!(!named_toolbar_image(50000, 32, 28, "图片"));
        assert!(!named_toolbar_image(50006, 40, 40, "avatar"));
        assert!(!named_toolbar_image(50006, 40, 40, "快易修助手"));
    }

    #[test]
    fn chat_row_text_is_clickable() {
        assert!(named_content_row(50020, 220, 32, "快易修助手"));
        assert!(named_content_row(50025, 180, 28, "机器人群"));
        assert!(!named_content_row(50020, 220, 8, "小字"));
        assert!(!named_content_row(50020, 20, 32, "x"));
        assert!(!named_content_row(50000, 220, 32, "快易修助手"));
    }
}
